import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const ui = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(ui, '.markdown-dom-test-'))
const dom = new JSDOM('<!doctype html><html><body><div id="test"></div></body></html>', { url: 'http://markdown.test/', pretendToBeVisual: true })
const { window } = dom
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : (window as any)[name] })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act, createElement: h } = React
const copied: string[] = []
Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })

await build({
  stdin: { contents: "export { Markdown } from './src/components/Markdown'; export { parseMarkdown } from './src/components/markdown/processor'; export { createBlockEncoder } from './src/components/markdown/blocks'; export { MARKDOWN_PARSE_TIMEOUT_MS } from './src/components/markdown/client'; export { api } from './src/lib/api';", resolveDir: ui },
  outfile: join(temporary, 'entry.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], loader: { '.css': 'empty' }, logLevel: 'silent',
})
const { Markdown, parseMarkdown, createBlockEncoder, api } = await import(pathToFileURL(join(temporary, 'entry.mjs')).href)
const calls: { kind: string; text: string }[] = []
let hold = false
let fail = false
const held: Array<() => void> = []

class FakeWorker {
  onmessage: ((event: { data: any }) => void) | null = null
  onerror: (() => void) | null = null
  kind: string
  blocks = createBlockEncoder()
  stopped = false
  constructor(url: URL) { this.kind = url.pathname.includes('markdown.worker') ? 'markdown' : 'highlight' }
  terminate() { this.stopped = true }
  postMessage(request: any) {
    if ('release' in request) { this.blocks.release(request.release); return }
    if (fail && this.kind === 'markdown') { queueMicrotask(() => this.onerror?.()); return }
    calls.push({ kind: this.kind, text: request.source ?? request.text })
    const deliver = async () => {
      if (this.stopped) return
      if (this.kind === 'markdown') {
        const result = await parseMarkdown(request.source, request.streaming)
        this.onmessage?.({ data: { id: request.id, document: this.blocks.encode(request.owner, result.tree, result.math) } })
      } else {
        const hljs = (await import('highlight.js/lib/common')).default
        const html = request.language ? hljs.highlight(request.text, { language: request.language }).value : hljs.highlightAuto(request.text).value
        this.onmessage?.({ data: { id: request.id, html } })
      }
    }
    if (hold && this.kind === 'markdown') held.push(() => void deliver())
    else queueMicrotask(() => void deliver())
  }
}
Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
const container = window.document.getElementById('test')!
let root = createRoot(container)
const render = async (source: string, streaming = false, visible = true) => {
  await act(async () => root.render(h(React.Activity, { mode: visible ? 'visible' : 'hidden' }, h(Markdown, { children: source, streaming }))))
}
const settle = async (condition: () => boolean = () => !container.querySelector('[data-markdown-pending]')) => {
  for (let round = 0; round < 100 && !condition(); round++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
  assert.ok(condition(), 'Asynchronous Markdown reaches the expected DOM state')
}
const reset = async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  copied.length = 0
  calls.length = 0
}

test('streamed code avoids highlighting; finished blocks keep copy/wrap state across appended text and completion', async () => {
  const source = 'A completed paragraph.\n\n```js\nconst answer = 42\n```\n\nStill writing'
  await render(source, true)
  await settle()
  const wrap = container.querySelector<HTMLButtonElement>('button[aria-label="Wrap long lines"]')!
  assert.ok(wrap)
  await act(async () => { wrap.click(); (container.querySelector('button[aria-label="Copy code"]') as HTMLButtonElement).click() })
  assert.equal(copied[0], 'const answer = 42\n')
  assert.equal(wrap.getAttribute('aria-pressed'), 'true')
  await render(`${source} more`, true)
  await settle()
  assert.ok(container.querySelector('button[aria-label="Wrap long lines"]') === wrap, 'An unchanged code block keeps its DOM')
  assert.equal(wrap.getAttribute('aria-pressed'), 'true')
  assert.ok(container.querySelector('button[aria-label="Copied"]'))
  assert.equal(calls.filter((call) => call.kind === 'highlight').length, 0)
  await render(`${source} more`, false)
  await settle(() => !container.querySelector('[data-markdown-pending]') && !!container.querySelector('code.hljs'))
  assert.equal(calls.filter((call) => call.kind === 'highlight').length, 1)
  assert.ok(container.querySelector('button[aria-label="Wrap long lines"]') === wrap)
  assert.equal(wrap.getAttribute('aria-pressed'), 'true')
})

test('safe links keep the external-open route, images never load, raw HTML stays inert, and math still renders', async () => {
  await reset()
  const opened: string[] = []
  api.web.open = async (url: string) => { opened.push(url) }
  await render('[docs](https://example.com/docs)\n\n![tracking picture](https://example.com/pixel.png)\n\n[unsafe](javascript:alert%281%29)\n\n<script>alert("unsafe")</script>\n\n$$\nx = \\frac{1}{2}\n$$')
  await settle()
  assert.equal(container.querySelector('img'), null)
  assert.equal(container.querySelector('script'), null)
  assert.equal([...container.querySelectorAll('a')].some((link) => (link.getAttribute('href') ?? '').startsWith('javascript:')), false)
  assert.ok(container.querySelector('.katex'))
  assert.ok(container.querySelector('math'), 'Accessible MathML is preserved')
  const link = [...container.querySelectorAll('a')].find((link) => link.textContent === 'docs')!
  assert.equal(link.target, '_blank')
  assert.equal(link.rel, 'noreferrer noopener')
  await act(async () => link.click())
  assert.deepEqual(opened, ['https://example.com/docs'])
  assert.equal(window.location.href, 'http://markdown.test/')
})

test('a late parse cannot inject old content after a replacement or an Activity hide/show', async () => {
  await reset()
  hold = true
  await render('OLD answer that should never return', true)
  await render('NEW answer', true, false)
  await render('NEW answer', true, true)
  assert.ok(container.textContent?.includes('NEW answer'))
  assert.equal(container.textContent?.includes('OLD answer'), false)
  hold = false
  await act(async () => { for (const deliver of held.splice(0)) deliver() })
  await settle()
  assert.ok(container.textContent?.includes('NEW answer'))
  assert.equal(container.textContent?.includes('OLD answer'), false)
})

test('a failed worker leaves a large answer readable and asynchronously formats bounded completed answers', async () => {
  await reset()
  const prefix = 'A formatted **prefix**.\n\n'
  await render(prefix, true)
  await settle()
  assert.equal(container.querySelector('strong')?.textContent, 'prefix')
  fail = true
  const source = `${prefix}A large readable answer.\n${'plain source '.repeat(5000)}\nTHE END`
  await render(source)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
  assert.equal(container.textContent, source)
  await render('Compatibility **formatting** still works.\n\n<script>unsafe()</script>')
  await settle()
  assert.equal(container.querySelector('strong')?.textContent, 'formatting')
  assert.equal(container.querySelector('script'), null)
})

test('a non-responsive worker times out to the complete plain answer and releases queued updates', async () => {
  await reset()
  fail = false
  const fresh = await import(`${pathToFileURL(join(temporary, 'entry.mjs')).href}?timeout`)
  const renderFresh = async (source: string) => act(async () => root.render(h(fresh.Markdown, { children: source, streaming: true })))
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timers = new Map<number, () => void>()
  let timerId = 100000
  globalThis.setTimeout = ((callback: () => void, delay: number, ...args: unknown[]) => {
    if (delay === fresh.MARKDOWN_PARSE_TIMEOUT_MS) { const id = timerId++; timers.set(id, callback); return id }
    return originalSet(callback, delay, ...args)
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: any) => { if (!timers.delete(Number(id))) originalClear(id) }) as typeof clearTimeout
  try {
    await renderFresh('A **visible prefix**.\n\n')
    await settle()
    assert.equal(timers.size, 0, 'A normal reply clears its watchdog')
    hold = true
    const latest = 'A **visible prefix**.\n\nThe full answer after the worker stopped replying.'
    await renderFresh(`${latest} waiting`)
    await renderFresh(latest)
    assert.equal(timers.size, 1)
    await act(async () => { [...timers.values()][0]!() })
    await settle(() => container.textContent === latest && !container.querySelector('[data-markdown-pending]'))
    assert.equal(container.textContent, latest)
    assert.equal(timers.size, 0)
  } finally {
    hold = false
    held.length = 0
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
})

after(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  await rm(temporary, { recursive: true, force: true })
})
