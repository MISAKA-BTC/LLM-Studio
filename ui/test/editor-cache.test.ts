import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import type { WorkspaceFile } from '../src/lib/types.ts'

// Compile the production modules: reads, invalidation and race handling exercise the real cache.
const compiled = await build({
  stdin: {
    contents: "export { createFileCache } from './src/components/code/fileCache'; export { treeWindow, TREE_ROW_HEIGHT } from './src/components/code/treeWindow'; export { useFiles, loadDir } from './src/components/code/filesStore'; export { api } from './src/lib/api';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
})
const { createFileCache, treeWindow, TREE_ROW_HEIGHT, useFiles, loadDir, api } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0]!.text).toString('base64')}`)
const file = (content: string): WorkspaceFile => ({ path: 'file.ts', content, size: content.length, binary: false, truncated: false, total_lines: 1, start_line: 1, end_line: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('leaving and returning to a file shares the read and retains its completed bytes', async () => {
  const response = deferred<WorkspaceFile>()
  let calls = 0
  const cache = createFileCache(() => { calls++; return response.promise })
  const first = cache.read('/project', 'file.ts')
  const second = cache.read('/project', 'file.ts')
  assert.equal(first, second)
  response.resolve(file('const answer = 42'))
  await first
  assert.equal((await cache.read('/project', 'file.ts')).content, 'const answer = 42')
  assert.equal(calls, 1)
})

test('the latest forced refresh owns the cache even when an older request finishes last', async () => {
  const old = deferred<WorkspaceFile>()
  const fresh = deferred<WorkspaceFile>()
  let calls = 0
  const cache = createFileCache(() => calls++ === 0 ? old.promise : fresh.promise)
  const first = cache.read('/project', 'file.ts')
  const firstCancelled = assert.rejects(first, { name: 'AbortError' })
  await Promise.resolve()
  const second = cache.read('/project', 'file.ts', true)
  fresh.resolve(file('new'))
  await second
  await firstCancelled // The consumer is released even though the old transport has not settled.
  old.resolve(file('old'))
  await Promise.resolve()
  assert.equal(cache.peek('/project', 'file.ts').file.content, 'new')
})

test('a workspace invalidation also prevents pending old bytes from repopulating it', async () => {
  const old = deferred<WorkspaceFile>()
  const cache = createFileCache(() => old.promise)
  const read = cache.read('/project', 'file.ts')
  const cancelled = assert.rejects(read, { name: 'AbortError' })
  await Promise.resolve() // The mocked transport has started and deliberately ignores abort.
  cache.invalidate('/project')
  await cancelled
  old.resolve(file('obsolete'))
  await Promise.resolve()
  assert.equal(cache.peek('/project', 'file.ts'), undefined)
})

test('rapid selections keep only two pending reads and preserve a shared request that was selected again', async () => {
  const requests = new Map<string, { signal: AbortSignal; complete: (value: WorkspaceFile) => void }>()
  let active = 0
  let peak = 0
  const cache = createFileCache((_root: string, path: string, signal: AbortSignal) => {
    active++
    peak = Math.max(peak, active)
    return new Promise<WorkspaceFile>((resolve, reject) => {
      requests.set(path, { signal, complete: (value) => { active--; resolve(value) } })
      signal.addEventListener('abort', () => { active--; reject(signal.reason) }, { once: true })
    })
  })
  const first = cache.read('/project', 'first.ts')
  const second = cache.read('/project', 'second.ts')
  const secondCancelled = assert.rejects(second, { name: 'AbortError' })
  await Promise.resolve()
  assert.ok(cache.read('/project', 'first.ts') === first, 'same-key consumers still share one request')
  const latest = cache.read('/project', 'latest.ts')
  await Promise.resolve()
  await secondCancelled
  assert.equal(requests.get('first.ts')!.signal.aborted, false)
  assert.equal(requests.get('second.ts')!.signal.aborted, true, 'least recently requested pending file stops')
  assert.equal(requests.get('latest.ts')!.signal.aborted, false)
  assert.equal(peak, 2)
  requests.get('first.ts')!.complete(file('first'))
  requests.get('latest.ts')!.complete(file('latest'))
  await Promise.all([first, latest])
  assert.equal(cache.peek('/project', 'first.ts').file.content, 'first')
  assert.equal(cache.peek('/project', 'latest.ts').file.content, 'latest')
})

test('force and root invalidation abort pending I/O without touching another root or its completed cache', async () => {
  const requests: Array<{ path: string; signal: AbortSignal; complete: (value: WorkspaceFile) => void }> = []
  const cache = createFileCache((_root: string, path: string, signal: AbortSignal) => new Promise<WorkspaceFile>((resolve, reject) => {
    requests.push({ path, signal, complete: resolve })
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const other = cache.read('/other', 'kept.ts')
  await Promise.resolve()
  requests[0].complete(file('kept'))
  await other
  const old = cache.read('/project', 'file.ts')
  const oldCancelled = assert.rejects(old, { name: 'AbortError' })
  await Promise.resolve()
  const fresh = cache.read('/project', 'file.ts', true)
  const freshCancelled = assert.rejects(fresh, { name: 'AbortError' })
  await Promise.resolve()
  await oldCancelled
  assert.equal(requests[1].signal.aborted, true)
  assert.equal(requests[2].signal.aborted, false)
  cache.invalidate('/project')
  await freshCancelled
  assert.equal(requests[2].signal.aborted, true)
  assert.equal(cache.peek('/other', 'kept.ts').file.content, 'kept')
})

test('a read invalidated before dispatch never starts the API call', async () => {
  let calls = 0
  const cache = createFileCache(async () => { calls++; return file('unused') })
  const read = cache.read('/project', 'file.ts')
  cache.invalidate('/project')
  await assert.rejects(read, { name: 'AbortError' })
  assert.equal(calls, 0)
})

test('cancellation also works on WebViews without AbortSignal.reason or throwIfAborted', async () => {
  const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')!
  const throwIfAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted')!
  Object.defineProperty(AbortSignal.prototype, 'reason', { configurable: true, get: () => undefined })
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined })
  try {
    const cache = createFileCache(async () => file('unused'))
    const read = cache.read('/old-webview', 'file.ts')
    cache.invalidate('/old-webview')
    await assert.rejects(read, { name: 'AbortError' })
  } finally {
    Object.defineProperty(AbortSignal.prototype, 'reason', reason)
    Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', throwIfAborted)
  }
})

test('a cancelled forced refresh keeps display bytes but never treats them as a fresh read', async () => {
  const requests: Array<ReturnType<typeof deferred<WorkspaceFile>>> = []
  const cache = createFileCache(() => {
    const request = deferred<WorkspaceFile>()
    requests.push(request)
    return request.promise // A transport that does not implement AbortSignal.
  }, 12, 1)
  const initial = cache.read('/project', 'file.ts')
  await Promise.resolve()
  requests[0].resolve(file('old display'))
  await initial
  const refresh = cache.read('/project', 'file.ts', true)
  const cancelled = assert.rejects(refresh, { name: 'AbortError' })
  await Promise.resolve()
  const another = cache.read('/project', 'other.ts')
  await Promise.resolve()
  await cancelled
  assert.equal(cache.peek('/project', 'file.ts').file.content, 'old display')
  requests[2].resolve(file('other'))
  await another
  const retry = cache.read('/project', 'file.ts')
  await Promise.resolve()
  assert.equal(requests.length, 4, 'returning to the cancelled refresh starts a new read')
  requests[3].resolve(file('current'))
  await retry
  requests[1].resolve(file('obsolete late refresh'))
  await Promise.resolve()
  assert.equal(cache.peek('/project', 'file.ts').file.content, 'current')
})

test('same paths in different projects never share file bytes', async () => {
  const cache = createFileCache(async (root: string) => file(root))
  await cache.read('/one', 'src/index.ts')
  await cache.read('/two', 'src/index.ts')
  assert.equal(cache.peek('/one', 'src/index.ts').file.content, '/one')
  assert.equal(cache.peek('/two', 'src/index.ts').file.content, '/two')
  cache.invalidate('/one')
  assert.equal(cache.peek('/one', 'src/index.ts'), undefined)
  assert.equal(cache.peek('/two', 'src/index.ts').file.content, '/two')
})

test('failed reads can retry, and cached files retain their scroll positions', async () => {
  let calls = 0
  const cache = createFileCache(async () => {
    if (calls++ === 0) throw new Error('offline')
    return file('loaded')
  })
  await assert.rejects(cache.read('/project', 'file.ts'), /offline/)
  await cache.read('/project', 'file.ts')
  cache.rememberPosition('/project', 'file.ts', { top: 900, left: 25 })
  await cache.read('/project', 'file.ts', true)
  assert.deepEqual(cache.peek('/project', 'file.ts').position, { top: 900, left: 25 })
})

test('the file cache evicts the least recently used file at its bound', async () => {
  const cache = createFileCache(async (_root: string, path: string) => file(path), 2)
  await cache.read('/project', 'a')
  await cache.read('/project', 'b')
  cache.peek('/project', 'a')
  await cache.read('/project', 'c')
  assert.ok(cache.peek('/project', 'a'))
  assert.equal(cache.peek('/project', 'b'), undefined)
  assert.ok(cache.peek('/project', 'c'))
})

test('a 5000-entry explorer renders a bounded window and can reach its last row', () => {
  const first = treeWindow(5000, 0, 560)
  assert.equal(first.start, 0)
  assert.ok(first.end - first.start < 40)
  const last = treeWindow(5000, 5000 * TREE_ROW_HEIGHT - 560, 560)
  assert.equal(last.end, 5000)
  assert.ok(last.end - last.start < 40)
  const middle = treeWindow(5000, 2000 * TREE_ROW_HEIGHT, 560)
  assert.ok(middle.start <= 2000 && middle.end > 2020)
  assert.ok(middle.end - middle.start < 40)
  assert.deepEqual(treeWindow(0, 0, 560), { start: 0, end: 0 })
})

test('directory reads share in-flight work and a late response cannot replace a refresh', async () => {
  useFiles.setState({ byRoot: {} })
  const old = deferred<any>()
  const fresh = deferred<any>()
  let calls = 0
  api.workspace.tree = () => calls++ === 0 ? old.promise : fresh.promise
  const first = loadDir('/directory')
  const same = loadDir('/directory')
  assert.equal(calls, 1)
  const second = loadDir('/directory', '.', true)
  fresh.resolve({ entries: [{ path: 'new', is_dir: false, size: 1 }], truncated: false })
  await second
  old.resolve({ entries: [{ path: 'old', is_dir: false, size: 1 }], truncated: false })
  await Promise.all([first, same])
  assert.equal(useFiles.getState().byRoot['/directory'].dirs['.'].entries[0].path, 'new')
})
