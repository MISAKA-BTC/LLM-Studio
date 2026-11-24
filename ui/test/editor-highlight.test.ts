import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const resolveDir = fileURLToPath(new URL('..', import.meta.url))
const compiledWorker = await build({
  stdin: { contents: "import './src/components/code/highlight.worker'", resolveDir },
  bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent',
})

test('the worker highlights source text while escaping HTML and handles unknown languages', () => {
  const responses: any[] = []
  const self: any = { postMessage: (response: any) => responses.push(response) }
  runInNewContext(compiledWorker.outputFiles[0]!.text, { self })
  self.onmessage({ data: { id: 1, text: 'const html = "<script>alert(1)</script>"', language: 'javascript' } })
  assert.equal(responses[0].id, 1)
  assert.match(responses[0].html, /hljs-keyword/)
  assert.match(responses[0].html, /&lt;script&gt;/)
  assert.doesNotMatch(responses[0].html, /<script>/)
  self.onmessage({ data: { id: 2, text: 'plain', language: 'unknown-language' } })
  assert.equal(responses[1].html, null)
})

const compiledClient = await build({
  stdin: { contents: "export { highlightFile, cachedHighlight } from './src/components/code/highlight'", resolveDir },
  define: { 'import.meta.url': '"file:///editor/highlight.ts"' },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
})

test('file previews share one worker, reuse pending parses and cached colours, and survive worker failure', async () => {
  const instances: FakeWorker[] = []
  const posted: any[] = []
  class FakeWorker {
    onmessage: ((event: { data: { id: number; html: string | null } }) => void) | null = null
    onerror: (() => void) | null = null
    terminated = false
    constructor() { instances.push(this) }
    postMessage(message: any) { posted.push(message) }
    terminate() { this.terminated = true }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
  try {
    const { highlightFile, cachedHighlight } = await import(`data:text/javascript;base64,${Buffer.from(compiledClient.outputFiles[0]!.text).toString('base64')}`)
    const first = highlightFile('const n = 1', 'javascript')
    const same = highlightFile('const n = 1', 'javascript')
    assert.equal(first, same)
    assert.equal(instances.length, 1)
    assert.equal(posted.length, 1)
    instances[0]!.onmessage!({ data: { id: posted[0].id, html: '<span>const</span> n = 1' } })
    assert.equal(await first, '<span>const</span> n = 1')
    assert.equal(await highlightFile('const n = 1', 'javascript'), '<span>const</span> n = 1')
    assert.equal(cachedHighlight('const n = 1', 'javascript'), '<span>const</span> n = 1')
    assert.equal(posted.length, 1, 'returning to a preview does not parse it again')
    const failed = highlightFile('const n = 2', 'javascript')
    instances[0]!.onerror!()
    assert.equal(await failed, null)
    assert.equal(instances[0]!.terminated, true)
    assert.equal(await highlightFile('const n = 3', 'javascript'), null)
  } finally {
    if (original) Object.defineProperty(globalThis, 'Worker', original)
    else Reflect.deleteProperty(globalThis, 'Worker')
  }
})
