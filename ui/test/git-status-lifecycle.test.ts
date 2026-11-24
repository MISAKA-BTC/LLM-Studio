import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import type { GitStatus } from '../src/lib/types.ts'

const ui = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(ui, '.git-status-test-'))
const dom = new JSDOM('<!doctype html><div id="test"></div>', { url: 'http://git.test/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : (dom.window as any)[name] })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act, createElement: h } = React
await build({
  stdin: { contents: "export { useGit, useGitStatus, refreshGit } from './src/components/code/gitStore'; export { api } from './src/lib/api';", resolveDir: ui },
  outfile: join(temporary, 'entry.mjs'), bundle: true, platform: 'node', format: 'esm',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], logLevel: 'silent',
})
const { useGit, useGitStatus, refreshGit, api } = await import(pathToFileURL(join(temporary, 'entry.mjs')).href)

type Pending = { root: string; signal: AbortSignal; counts: boolean; resolve: (status: GitStatus) => void; settled: boolean }
const pending: Pending[] = []
api.workspace.gitStatus = (root: string, signal: AbortSignal, options: { includeCounts: boolean }) =>
  new Promise<GitStatus>((resolve) => {
    // Intentionally ignore abort at the transport layer: stale results must still be rejected
    // by the store when an older server/mock eventually resolves its response.
    const call: Pending = { root, signal, counts: options.includeCounts, resolve: (status) => { call.settled = true; resolve(status) }, settled: false }
    pending.push(call)
  })
const fixture = (counts: boolean, branch = 'main'): GitStatus => ({
  is_git: true, branch, head: '1234567', upstream: null, ahead: 0, behind: 0,
  files: [{ path: 'file.ts', orig_path: null, index: '.', worktree: 'M', status: 'modified', added: counts ? 2 : null, removed: counts ? 1 : null, binary: false }],
  added: counts ? 2 : 0, removed: counts ? 1 : 0,
  ...(counts ? {} : { counts_included: false }),
})
const calls = (folder: string) => pending.filter((call) => call.root === folder)
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const container = document.getElementById('test')!
let root = createRoot(container)
function Reader({ folder, counts = false }: { folder: string; counts?: boolean }) {
  const value = useGitStatus(folder, counts)
  return h('output', { 'data-reader': counts ? 'detail' : 'summary' }, value?.status?.branch ?? 'loading')
}
const render = async (folder: string, detail: 'visible' | 'hidden', second = false) => {
  await act(async () => root.render(h(React.Fragment, null,
    h(Reader, { folder, key: 'header' }),
    h(React.Activity, { mode: detail, key: 'changes' }, h(Reader, { folder, counts: true })),
    second && h(Reader, { folder, counts: true, key: 'second' }),
  )))
}
const reset = async () => {
  await act(async () => root.unmount())
  for (const call of pending.filter((call) => !call.settled)) call.resolve(fixture(call.counts))
  await flush()
  for (const call of pending.filter((call) => !call.settled)) call.resolve(fixture(call.counts))
  await flush()
  root = createRoot(container)
}

test('background refreshes request only summary data and coalesce a burst into one trailing request', async () => {
  const folder = '/summary-workspace'
  const first = refreshGit(folder)
  assert.equal(calls(folder).length, 1)
  assert.equal(calls(folder)[0].counts, false)
  assert.ok(refreshGit(folder) === first)
  assert.ok(refreshGit(folder) === first)
  calls(folder)[0].resolve(fixture(false))
  await first
  assert.equal(calls(folder).length, 2)
  calls(folder)[1].resolve(fixture(false, 'latest'))
  await flush()
  assert.equal(useGit.getState().byRoot[folder].status.branch, 'latest')
  assert.equal(useGit.getState().byRoot[folder].status.counts_included, false)
})

test('only a visible Changes consumer asks for counts; hiding it cancels the obsolete request and rejects late data', async () => {
  await reset()
  const folder = '/activity-workspace'
  await render(folder, 'hidden')
  assert.equal(calls(folder).length, 1)
  assert.equal(calls(folder)[0].counts, false)
  await act(async () => calls(folder)[0].resolve(fixture(false)))
  await render(folder, 'visible')
  assert.equal(calls(folder).length, 2)
  const detailed = calls(folder)[1]
  assert.equal(detailed.counts, true, 'fresh summary data still needs an explicit detail request')
  await render(folder, 'hidden')
  assert.equal(detailed.signal.aborted, true)
  await act(async () => detailed.resolve(fixture(true, 'obsolete')))
  assert.equal(useGit.getState().byRoot[folder].status.branch, 'main', 'late detailed response does not replace current state')
  assert.equal(calls(folder).length, 3)
  assert.equal(calls(folder)[2].counts, false)
  await act(async () => calls(folder)[2].resolve(fixture(false, 'updated')))
  assert.equal(useGit.getState().byRoot[folder].status.branch, 'updated')
  assert.equal(useGit.getState().byRoot[folder].error, null, 'cancel is not an error banner')
  await render(folder, 'visible')
  const reopened = calls(folder)[3]
  assert.equal(reopened.counts, true)
  await act(async () => reopened.resolve(fixture(true, 'updated')))
  assert.equal(useGit.getState().byRoot[folder].status.added, 2)
})

test('a shared detailed read stays alive until the last visible Changes consumer leaves', async () => {
  await reset()
  const folder = '/shared-workspace'
  await render(folder, 'hidden')
  await act(async () => calls(folder)[0].resolve(fixture(false)))
  await render(folder, 'visible', true)
  const detailed = calls(folder)[1]
  assert.equal(detailed.counts, true)
  await render(folder, 'hidden', true)
  assert.equal(detailed.signal.aborted, false, 'another detailed reader still uses the request')
  await render(folder, 'hidden', false)
  assert.equal(detailed.signal.aborted, true)
  await act(async () => detailed.resolve(fixture(true)))
  const summary = calls(folder)[2]
  assert.equal(summary.counts, false)
  await act(async () => summary.resolve(fixture(false)))
})

after(async () => {
  await reset()
  await act(async () => root.unmount())
  dom.window.close()
  await rm(temporary, { recursive: true, force: true })
})
