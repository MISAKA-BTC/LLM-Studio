// Compare actual App DOM volume without a browser or runtime server.
// WORKBENCH_SOURCE_ROOT=/path/to/phase1/ui node scripts/bench-workbench.mjs --label phase1 --output ../docs/phase2-dom-before.json
// node scripts/bench-workbench.mjs --label phase2 --output ../docs/phase2-dom-after.json
// Timings describe Node + jsdom + lazy module/formatting waits, never input latency or FPS.
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { cpus, platform, arch } from 'node:os'
import { JSDOM } from 'jsdom'
import { build, defaultClientConditions } from 'vite'
import React, { act } from 'react'

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || uiRoot)
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const label = option('--label') || (sourceRoot === uiRoot ? 'phase2' : 'baseline')
const output = option('--output')
const temporary = await mkdtemp(join(uiRoot, '.workbench-benchmark-'))
const checksum = (value) => createHash('sha256').update(value).digest('hex')
const threadCount = 1000
const messageCount = 1000
const h = React.createElement
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let root
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://workbench-benchmark.test/', pretendToBeVisual: true })
const { window } = dom
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'MutationObserver', 'DOMParser', 'XMLSerializer', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} }
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.scrollIntoView = function () {}
// A fixed synthetic viewport makes the virtualized row count reproducible. jsdom has no layout.
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.hasAttribute('data-transcript-scroll') ? 600 : this.hasAttribute('data-virtual-sidebar') ? 480 : 0 } })
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.hasAttribute('data-transcript-scroll') ? 760 : 0 } })
let intervalId = 0
globalThis.setInterval = () => ++intervalId
globalThis.clearInterval = () => {}
const requests = []
globalThis.fetch = async (url) => {
  const pathname = new URL(String(url), window.location.origin).pathname
  requests.push(pathname)
  assert.equal(pathname, '/api/v1/network/prompt-stack', 'Only the mocked window-level status poll is allowed')
  return new Response('null', { headers: { 'content-type': 'application/json' } })
}
const { createRoot } = await import('react-dom/client')

try {
  const entryPath = join(temporary, 'entry.ts')
  const hasWorkbench = await access(join(sourceRoot, 'src/components/shell/workbenchState.ts')).then(() => true, () => false)
  await writeFile(entryPath, [
    `export { default as App } from ${JSON.stringify(join(sourceRoot, 'src/App.tsx'))}`,
    `export { useStudio } from ${JSON.stringify(join(sourceRoot, 'src/store/studio.ts'))}`,
    `export { useUi } from ${JSON.stringify(join(sourceRoot, 'src/store/ui.ts'))}`,
    ...(hasWorkbench ? [`export { useWorkbench } from ${JSON.stringify(join(sourceRoot, 'src/components/shell/workbenchState.ts'))}`] : []),
  ].join('\n'))
  await build({
    root: sourceRoot, configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' },
    worker: { format: 'es' }, resolve: { conditions: ['worker', ...defaultClientConditions] },
    build: {
      outDir: temporary, emptyOutDir: false, minify: false, sourcemap: false,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'app.mjs' },
      rollupOptions: { external: (id) => /^react(?:-dom)?(?:\/|$)/.test(id) },
    },
  })
  const { App, useStudio, useUi, useWorkbench } = await import(pathToFileURL(join(temporary, 'app.mjs')).href)
  // Keep persistence out of this DOM-only workload; it is measured separately by bench-storage.
  const noStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  useStudio.persist.setOptions({ storage: noStorage })
  useUi.persist.setOptions({ storage: noStorage })
  useWorkbench?.persist.setOptions({ storage: noStorage })
  const conversations = Array.from({ length: threadCount }, (_, index) => ({
    id: `dom-thread-${index}`, title: `Synthetic conversation ${index}`, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 - index, modelId: null,
    messages: Array.from({ length: index === 0 ? messageCount : 1 }, (_, message) => ({
      id: `dom-${index}-${message}`, role: message % 2 ? 'assistant' : 'user',
      content: message % 2 ? `## Reply ${message}\n\nA **saved** answer with [a source](https://example.com/).` : `Question ${message}: please preserve this conversation.`,
      createdAt: 1_700_000_000_000 + message,
    })),
  }))
  const fixtureSha256 = checksum(JSON.stringify(conversations))
  useStudio.setState({ view: 'chat', conversations, activeConversationId: conversations[0].id, connected: true, settings: null, runtime: null, models: [], bootstrap: async () => {}, refreshMining: async () => {} })
  useUi.setState({ appMode: 'chat', rightPanel: null, sidebarOpen: true, lastThread: { chat: conversations[0].id, code: null } })
  root = createRoot(document.getElementById('root'))
  const started = performance.now()
  await act(async () => root.render(h(React.StrictMode, null, h(App))))
  let settled = false
  let stable = 0
  let priorElements = -1
  // Wait for lazy ChatView and visible asynchronous Markdown. Worker is absent in jsdom.
  for (let turn = 0; turn < 250; turn++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    const elements = document.querySelectorAll('#root *').length
    const ready = document.querySelector('[data-transcript-active="true"] [id^="message-"]') && !document.querySelector('.prose-chat[data-markdown-pending]')
    stable = ready && elements === priorElements ? stable + 1 : 0
    priorElements = elements
    if (stable >= 3) { settled = true; break }
  }
  assert.ok(settled, 'Initial active transcript and Markdown must settle before counting')
  const nodeJsdomMountAndSettleMs = +(performance.now() - started).toFixed(3)
  const container = document.getElementById('root')
  const active = document.querySelector('[data-transcript-active="true"]')
  const counts = {
    conversationsInStore: useStudio.getState().conversations.length,
    messagesInActiveConversation: useStudio.getState().conversations[0].messages.length,
    sidebarThreadRows: container.querySelectorAll('[data-thread-row]').length,
    mountedActiveMessages: active.querySelectorAll('[id^="message-"]').length,
    mountedAllMessages: container.querySelectorAll('[id^="message-"]').length,
    virtualTranscriptRows: container.querySelectorAll('[data-virtual-row]').length,
    activeTranscriptElements: active.querySelectorAll('*').length,
    totalAppElements: container.querySelectorAll('*').length,
    formattedMarkdownBlocks: active.querySelectorAll('.prose-chat').length,
    pendingMarkdownBlocks: active.querySelectorAll('.prose-chat[data-markdown-pending]').length,
  }
  assert.equal(counts.conversationsInStore, threadCount)
  assert.equal(counts.messagesInActiveConversation, messageCount)
  assert.ok(counts.sidebarThreadRows > 0 && counts.mountedActiveMessages > 0)
  const sourceHashes = {}
  for (const path of ['src/App.tsx', 'src/components/Sidebar.tsx', 'src/components/ChatView.tsx', 'src/components/Markdown.tsx', 'src/components/chat/TranscriptCache.tsx', 'src/components/chat/VirtualTranscript.tsx']) {
    try { sourceHashes[path] = checksum(await readFile(join(sourceRoot, path))) } catch { sourceHashes[path] = null }
  }
  const report = {
    schema: 1, label, measuredAt: new Date().toISOString(),
    environment: { node: process.version, react: React.version, jsdom: JSON.parse(await readFile(join(uiRoot, 'node_modules/jsdom/package.json'), 'utf8')).version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    methodology: {
      fixture: '1000 conversations; active conversation has 1000 alternating user/assistant messages, other conversations have one user message. Assistant content has a heading, bold text and link. All history remains in the store.',
      fixtureSha256,
      execution: 'Actual App and stores, Vite module bundle, React.StrictMode, fresh jsdom process. Source bundling is outside the reported time. Bootstrap and persistence are stubbed; the status-poll API and EventSource are mocked.',
      geometry: 'Synthetic transcript clientHeight 600, clientWidth 760; virtual sidebar clientHeight 480. ResizeObserver reports no measurements; jsdom has no CSS layout, paint or native scrolling.',
      markdown: 'No Web Worker in jsdom. Phase 2 uses its idle asynchronous fallback; count taken after visible Markdown finishes.',
      timing: 'One observation of Node/jsdom React mount + lazy imports + asynchronous formatting + 20ms settle polling. Not browser startup time, input latency, animation FPS or a statistically estimated speedup.',
      count: 'Element counts include actual mounted DOM. No CSS visibility approximation is used; active transcript is identified by data-transcript-active. The new shell can add fixed elements while lists remove offscreen rows.',
    },
    counts,
    nodeJsdomMountAndSettleMs,
    mockedRequests: requests,
    sourceHashes,
    scriptSha256: checksum(await readFile(fileURLToPath(import.meta.url))),
  }
  if (output) {
    const destination = resolve(output)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (root) await act(async () => root.unmount())
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  dom.window.close()
  await rm(temporary, { recursive: true, force: true })
}
