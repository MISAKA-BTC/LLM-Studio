import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import type { WorkspaceFile } from '../src/lib/types.ts'

const ui = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(ui, '.file-viewer-test-'))
const dom = new JSDOM('<!doctype html><div id="test"></div>', { url: 'http://files.test/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : (dom.window as any)[name] })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act, createElement: h } = React
await build({
  stdin: { contents: "export { FilesPanel } from './src/components/code/FilesPanel'; export { fileCache } from './src/components/code/fileCache'; export { selectFile } from './src/components/code/filesStore'; export { api } from './src/lib/api';", resolveDir: ui },
  outfile: join(temporary, 'entry.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], loader: { '.css': 'empty' }, logLevel: 'silent',
})
const { FilesPanel, fileCache, selectFile, api } = await import(pathToFileURL(join(temporary, 'entry.mjs')).href)
type Call = { folder: string; path: string; signal: AbortSignal; resolve: (value: WorkspaceFile) => void; reject: (error: Error) => void; settled: boolean }
const calls: Call[] = []
api.workspace.read = (folder: string, path: string, _range: unknown, signal: AbortSignal) => new Promise<WorkspaceFile>((resolve, reject) => {
  // No abort listener: exercise the production cache's abort race even when a transport never
  // settles, or delivers obsolete bytes after its consumer has already been released.
  const call: Call = { folder, path, signal, resolve: (value) => { call.settled = true; resolve(value) }, reject: (error) => { call.settled = true; reject(error) }, settled: false }
  calls.push(call)
})
const file = (path: string, content: string): WorkspaceFile => ({ path, content, size: content.length, binary: false, truncated: false, total_lines: 1, start_line: 1, end_line: 1 })
const forFolder = (folder: string) => calls.filter((call) => call.folder === folder)
const container = document.getElementById('test')!
let root = createRoot(container)

// Advance retry timers deterministically. No wall-clock assumptions, sleeps or browser paint
// measurements: these checks concern the real component's request/lifecycle state only.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const timers = new Map<object, { delay: number; run: () => void }>()
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
  if (delay === 0) return realSetTimeout(callback, delay, ...args)
  const token = {}
  timers.set(token, { delay, run: () => callback(...args) })
  return token
}) as typeof setTimeout
globalThis.clearTimeout = ((token: object) => {
  if (!timers.delete(token)) realClearTimeout(token as any)
}) as typeof clearTimeout
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const advanceRetry = async () => {
  assert.equal(timers.size, 1, `only one retry is pending; timer delays: ${[...timers.values()].map((timer) => timer.delay).join(', ')}`)
  const [token, timer] = timers.entries().next().value!
  timers.delete(token)
  await act(async () => timer.run())
  return timer.delay
}
const render = async (folder: string, visible = true) => {
  const conversation = { id: folder, title: folder, mode: 'agent', workspace: folder, messages: [], modelId: null, createdAt: 1, updatedAt: 1 }
  await act(async () => root.render(h(React.Activity, { mode: visible ? 'visible' : 'hidden' }, h(FilesPanel, { conversation }))))
}
const open = async (folder: string, path = 'a.ts') => {
  await act(async () => selectFile(folder, path))
  await render(folder)
}
const preview = (path = 'a.ts') => container.querySelector(`[aria-label="Contents of ${path}"]`)!
const refresh = () => container.querySelector<HTMLButtonElement>('button[aria-label="Read the file again"]')!
const reset = async () => {
  await act(async () => root.unmount())
  for (const folder of new Set(calls.map((call) => call.folder))) fileCache.invalidate(folder)
  for (const call of calls.filter((call) => !call.settled)) call.resolve(file(call.path, 'discarded'))
  await flush()
  assert.equal(timers.size, 0, 'unmount cancels scheduled retries')
  root = createRoot(container)
}

test('an invalidated visible preview waits for one fresh retry without an abort error or obsolete content', async () => {
  const folder = '/visible-file'
  await open(folder)
  assert.equal(forFolder(folder).length, 1)
  await act(async () => fileCache.invalidate(folder))
  assert.equal(forFolder(folder)[0].signal.aborted, true)
  assert.equal(refresh().disabled, true, 'cancel does not leave loading prematurely')
  assert.doesNotMatch(preview().textContent!, /abort|cancel/i)
  await act(async () => { for (let n = 0; n < 20; n++) fileCache.invalidate(folder) })
  assert.equal(forFolder(folder).length, 1, 'an invalidation burst does not issue an immediate retry loop')
  const delay = await advanceRetry()
  assert.ok(delay > 0)
  assert.equal(forFolder(folder).length, 2)
  await act(async () => forFolder(folder)[0].resolve(file('a.ts', 'obsolete content')))
  assert.doesNotMatch(preview().textContent!, /obsolete content/)
  await act(async () => forFolder(folder)[1].resolve(file('a.ts', 'current content')))
  assert.match(preview().textContent!, /current content/)
  assert.equal(refresh().disabled, false)
  assert.equal(timers.size, 0)
})

test('hiding the retained preview cancels its retry; reopening starts only the current read', async () => {
  await reset()
  const folder = '/hidden-file'
  await open(folder)
  await act(async () => fileCache.invalidate(folder))
  assert.equal(timers.size, 1)
  await render(folder, false)
  assert.equal(timers.size, 0)
  await flush()
  assert.equal(forFolder(folder).length, 1)
  await act(async () => forFolder(folder)[0].resolve(file('a.ts', 'hidden old bytes')))
  await render(folder)
  assert.equal(forFolder(folder).length, 2)
  await act(async () => forFolder(folder)[1].resolve(file('a.ts', 'reopened current bytes')))
  assert.match(preview().textContent!, /reopened current bytes/)
  assert.doesNotMatch(preview().textContent!, /hidden old bytes/)
})

test('changing the selected path stops the old retry and never restarts its hidden I/O', async () => {
  await reset()
  const folder = '/different-file'
  await open(folder)
  await act(async () => fileCache.invalidate(folder))
  assert.equal(timers.size, 1)
  await act(async () => selectFile(folder, 'b.ts'))
  assert.equal(timers.size, 0)
  assert.deepEqual(forFolder(folder).map((call) => call.path), ['a.ts', 'b.ts'])
  await act(async () => forFolder(folder)[0].resolve(file('a.ts', 'wrong file')))
  await act(async () => forFolder(folder)[1].resolve(file('b.ts', 'selected file')))
  assert.match(preview('b.ts').textContent!, /selected file/)
  assert.doesNotMatch(preview('b.ts').textContent!, /wrong file/)
  assert.equal(forFolder(folder).length, 2)
})

test('repeated in-flight invalidations back off with one timer, and genuine errors still finish loading', async () => {
  await reset()
  const folder = '/repeated-invalidation'
  await open(folder)
  const delays: number[] = []
  for (let attempt = 0; attempt < 7; attempt++) {
    await act(async () => fileCache.invalidate(folder))
    delays.push(await advanceRetry())
    assert.equal(timers.size, 0, 'a running request has no extra scheduled retry')
  }
  assert.ok(delays[1] > delays[0])
  assert.equal(delays.at(-1), delays.at(-2), 'backoff is capped')
  assert.equal(forFolder(folder).length, 8)
  await act(async () => forFolder(folder).at(-1)!.reject(new Error('disk unavailable')))
  assert.match(preview().textContent!, /disk unavailable/)
  assert.equal(refresh().disabled, false)
  assert.equal(timers.size, 0, 'a genuine I/O error does not enter the cancellation retry loop')
})

after(async () => {
  await reset()
  await act(async () => root.unmount())
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  dom.window.close()
  await rm(temporary, { recursive: true, force: true })
})
