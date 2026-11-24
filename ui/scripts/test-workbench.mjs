// Runs real React components and Activity boundaries in a DOM without starting the runtime.
// This checks lifecycle/state invariants. jsdom does not measure paint, layout or input latency.
// Run: npm run test:workbench
// Optional comparison: WORKBENCH_SOURCE_ROOT=/path/to/original/ui npm run test:workbench

import assert from 'node:assert/strict'
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build, defaultClientConditions } from 'vite'
import React, { act, useEffect, useState } from 'react'

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(process.env.WORKBENCH_SOURCE_ROOT || uiRoot)
const temporary = await mkdtemp(join(uiRoot, '.workbench-test-'))
const h = React.createElement
const results = []
const intervals = new Map()
let intervalId = 0
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://workbench.test/',
  pretendToBeVisual: true,
})
const { window } = dom
for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'MutationObserver', 'DOMParser', 'XMLSerializer', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? window : window[name] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 0)
globalThis.cancelAnimationFrame = clearTimeout
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
window.matchMedia = (media) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} })
window.HTMLElement.prototype.scrollIntoView = function () {}
const { createRoot } = await import('react-dom/client')
globalThis.setInterval = (callback, delay) => {
  const id = ++intervalId
  intervals.set(id, { callback, delay })
  return id
}
globalThis.clearInterval = (id) => intervals.delete(id)

// The window-level subscriptions must outlive navigation. No actual socket is opened.
const streams = []
globalThis.EventSource = class {
  constructor(url) { this.url = url; this.closed = false; streams.push(this) }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true }
}

const settings = {
  models_dir: '/fixture/models', load_on_start: null,
  web: { mode: 'off', tor_proxy: '127.0.0.1:9150', tor_browser_path: null },
  server: { host: '127.0.0.1', port: 1338, api_key: null, cors_origins: [] },
  backend: {
    kind: 'mock', llama_server_path: null, mlx_server_path: null,
    strata: { config_path: null, python_path: null, arena_gb: null, io_threads: 4, prefetch_experts: 4 },
    misaka_serve_path: null, misaka_tokenizer_path: null, gpu_layers: { mode: 'auto' },
    threads: null, flash_attention: 'auto', use_mmap: true, use_mlock: false,
    extra_args: [], startup_timeout_secs: 120,
  },
  image_backend: { kind: 'none', python_path: null, diffusion_server_path: null, device: null, startup_timeout_secs: 120 },
  context: { summarizer_model: null, tokenizer_path: null, fetch_class_tokenizer: false },
  generation: { system_prompt: '', context_size: 8192, temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.1, max_tokens: 512, seed: null },
  node: {
    misaka_rpc: null, misaka_cli_path: null, network: 'testnet12', producer_key_path: null,
    install_default_class_artifact: false, pool_url: null, pool_slot_id: null, pool_slot_token: null,
    palw_gateway_url: null, mining_mode: 'inline',
    remote: { remote_miner_path: null, attempt_exec_path: null, rpc: [], bond: null, class: null, artifact: null, pay_address: null, key_path: null, checkpoint: null, state_dir: null, verify_headers: true, accept_unverified: null, poll_secs: null },
    free_prompt: { gateway_path: null, rail_path: null, worker_path: null, listen: '127.0.0.1:1339', artifact: null, tokenizer: null, bond: null, evidence_provider: null, accept_unverified: false },
  },
  huggingface: { endpoint: 'https://huggingface.co', token: null, max_concurrent_downloads: 1 },
  ui: { theme: 'light', show_provenance: false, show_performance: false },
  provenance: { record_inferences: false, keep_transcripts: false, max_records: 100 },
}
const runtime = { backend: 'mock', backend_available: true, model_id: null, context_size: null, gpu_layers: null, offload: null, offload_note: null, load_ms: null, runtime_hash: null, runtime_class_id: null, model_hash: null, descriptor: null }
const install = { state: 'downloading', flavor: 'fixture', tag: null, detail: 'Fixture install', download_ids: [], installed: null, error: null, started_ms: 0 }
const fixtures = {
  '/api/v1/system': { hardware: { os: 'linux', arch: 'x86_64', cpu_name: 'Fixture CPU', physical_cores: 4, logical_cores: 8, total_memory: 16 * 1024 ** 3, available_memory: 8 * 1024 ** 3, accelerators: [] }, data_dir: '/fixture', models_dir: settings.models_dir, records_path: '/fixture/records', catalog_endpoint: settings.huggingface.endpoint },
  '/api/v1/settings': settings,
  '/api/v1/models': [],
  '/api/v1/downloads': [],
  '/api/v1/runtime': runtime,
  '/api/v1/runtime/backends': [],
  '/api/v1/images/models': [],
  '/api/v1/images/runtime': { backend: 'none', backend_available: false, model_id: null, device: null, dtype: null },
  '/api/v1/images/runtime/backends': [],
  '/api/v1/network/mining-queue': { mode: 'inline', background_available: false, background_blocker: 'Fixture', gateway_url: null, counts: { queued: 0, running: 0, committed: 0, refused: 0, failed: 0 }, jobs: [] },
  '/api/v1/network/prompt-stack': { gateway: { running: false, exited: null, command_line: null }, rail: { running: false, exited: null, command_line: null }, planned: { Err: 'Fixture' }, carriers: [], gateway_log: [], rail_log: [], identity: 'fixture', outbox: '/fixture/outbox', label: 'Fixture' },
  '/api/v1/network/classes': [],
  '/api/v1/network/published': [],
  '/api/v1/catalog/search': [],
  '/api/v1/engines': { program: 'fixture', source: 'missing', version: null, error: null, devices: [], verdict: 'missing', summary: 'Fixture', hardware_gpu: null, flavors: [], recommendation: null, release: { tag: null, error: null }, install, installed: [] },
  '/api/v1/engines/install': install,
}
const requests = []
globalThis.fetch = async (url, options = {}) => {
  const pathname = new URL(String(url), window.location.origin).pathname
  requests.push({ pathname, method: options.method || 'GET', body: options.body, signal: options.signal })
  if (!(pathname in fixtures)) throw new Error(`Unmocked endpoint: ${pathname}`)
  const fixture = fixtures[pathname]
  const body = typeof fixture === 'function' ? await fixture(url, options) : fixture
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

const visible = (element) => {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.style.display === 'none') return false
  }
  return element.isConnected
}
const findVisible = (selector) => [...document.querySelectorAll(selector)].find(visible)
const field = (label) => [...document.querySelectorAll('label')].find((element) => visible(element) && element.querySelector('span')?.textContent === label)?.querySelector('input')
const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const waitFor = async (condition, message) => {
  for (let turn = 0; turn < 150; turn++) {
    if (condition()) return
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  }
  assert.ok(condition(), message)
}
const change = async (element, value) => {
  assert.ok(element, 'The input exists')
  await act(async () => {
    const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
    element.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}
const check = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`) }
}

let root
try {
  const retainedPath = join(sourceRoot, 'src/components/shell/RetainedView.tsx')
  const hasRetainedView = await access(retainedPath).then(() => true, () => false)
  const workbenchPath = join(sourceRoot, 'src/components/shell/workbenchState.ts')
  const hasWorkbench = await access(workbenchPath).then(() => true, () => false)
  const resourcesPath = join(sourceRoot, 'src/lib/runtimeResources.ts')
  const hasResources = await access(resourcesPath).then(() => true, () => false)
  const entry = [
    `export { default as App } from ${JSON.stringify(join(sourceRoot, 'src/App.tsx'))}`,
    `export { useStudio } from ${JSON.stringify(join(sourceRoot, 'src/store/studio.ts'))}`,
    `export { useUi } from ${JSON.stringify(join(sourceRoot, 'src/store/ui.ts'))}`,
    `export { useComposer } from ${JSON.stringify(join(sourceRoot, 'src/components/chat/composerStore.ts'))}`,
    `export { useFiles, selectFile } from ${JSON.stringify(join(sourceRoot, 'src/components/code/filesStore.ts'))}`,
    `export { useCodeUi } from ${JSON.stringify(join(sourceRoot, 'src/components/code/codeStore.ts'))}`,
    `export { useAgent } from ${JSON.stringify(join(sourceRoot, 'src/lib/agent/run.ts'))}`,
    `export { ToolCallCard } from ${JSON.stringify(join(sourceRoot, 'src/components/agent/AgentMessage.tsx'))}`,
    ...(hasRetainedView ? [`export { RetainedView } from ${JSON.stringify(retainedPath)}`] : []),
    ...(hasWorkbench ? [`export { useWorkbench, closeTab, cycleTab, activateTab } from ${JSON.stringify(workbenchPath)}`] : []),
    ...(hasResources ? [`export { promptStackResource, miningQueueResource } from ${JSON.stringify(resourcesPath)}`] : []),
  ].join('\n')
  const entryPath = join(temporary, 'entry.ts')
  await writeFile(entryPath, entry)
  await build({
    root: sourceRoot, configFile: false, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    resolve: { conditions: ['worker', ...defaultClientConditions] },
    build: {
      outDir: temporary, emptyOutDir: false, minify: false, sourcemap: false,
      lib: { entry: entryPath, formats: ['es'], fileName: () => 'app.mjs' },
      rollupOptions: { external: (id) => /^react(?:-dom)?(?:\/|$)/.test(id) },
    },
  })
  const { App, useStudio, useUi, useComposer, useFiles, selectFile, useCodeUi, useAgent, ToolCallCard, RetainedView, useWorkbench, closeTab, cycleTab, activateTab, promptStackResource, miningQueueResource } = await import(pathToFileURL(join(temporary, 'app.mjs')).href)
  const container = document.getElementById('root')

  if (RetainedView) {
    await check('retained panes mount on first visit and keep their DOM/state while pausing effects', async () => {
      let setups = 0
      let cleanups = 0
      function Probe() {
        const [value, setValue] = useState(0)
        useEffect(() => { setups++; return () => { cleanups++ } }, [])
        return h('button', { 'data-probe': '', onClick: () => setValue((n) => n + 1) }, String(value))
      }
      root = createRoot(container)
      const render = (active) => act(async () => root.render(h(RetainedView, { active }, h(Probe))))
      await render(false)
      assert.ok(document.querySelector('[data-probe]') === null, 'An unvisited pane has no DOM')
      assert.equal(setups, 0)
      await render(true)
      const button = document.querySelector('[data-probe]')
      await act(async () => button.click())
      assert.equal(button.textContent, '1')
      await render(false)
      assert.ok(document.querySelector('[data-probe]') === button, 'Hidden pane retains its DOM node')
      assert.equal(visible(button), false)
      assert.equal(cleanups, setups)
      await render(true)
      assert.ok(document.querySelector('[data-probe]') === button, 'Shown pane reuses its DOM node')
      assert.equal(button.textContent, '1')
      assert.equal(visible(button), true)
      assert.equal(setups - cleanups, 1)
      await act(async () => root.unmount())
      root = null
      assert.equal(cleanups, setups)
    })

    await check('revealing an existing approval does not move keyboard focus onto Approve', async () => {
      const call = { id: 'pending-fixture', name: 'run_command', args: { command: 'echo fixture' }, status: 'awaiting_approval' }
      useAgent.setState({ pendingApproval: call.id })
      root = createRoot(container)
      const render = (active) => act(async () => root.render(h('div', null,
        h('button', { 'data-navigation': '' }, 'Navigation'),
        h(RetainedView, { active }, h(ToolCallCard, { call, segment: null, streaming: false })),
      )))
      try {
        await render(true)
        assert.ok(document.querySelector('[role="group"][aria-label^="Run this command"]'))
        await render(false)
        const navigation = document.querySelector('[data-navigation]')
        navigation.focus()
        await render(true)
        assert.ok(document.activeElement === navigation, 'View restoration must not focus a command approval')
        assert.equal(useAgent.getState().pendingApproval, call.id)
        assert.equal(requests.filter((request) => /workspace\/exec/.test(request.pathname)).length, 0)
      } finally {
        await act(async () => root.unmount())
        root = null
        useAgent.setState({ pendingApproval: null })
      }
    })
  }

  const thread = {
    id: 'workbench-thread', title: 'Workbench fixture', createdAt: 1, updatedAt: 1, modelId: null,
    messages: Array.from({ length: 24 }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', content: index % 2 ? `## Answer ${index}\n\nA **saved** answer.\n\n\`\`\`js\nconst value = ${index}\n\`\`\`` : `Question ${index}`, createdAt: index + 1 })),
  }
  useStudio.setState({ view: 'chat', conversations: [thread], activeConversationId: thread.id, settings, runtime, models: [], connected: true })
  useUi.setState({ appMode: 'chat', rightPanel: null, sidebarOpen: true, lastThread: { chat: thread.id, code: null } })
  root = createRoot(container)
  await act(async () => root.render(h(React.StrictMode, null, h(App))))
  await flush()
  const go = async (view) => {
    await act(async () => useStudio.getState().setView(view))
    await flush()
  }

  await check('unvisited screens do not eagerly load their APIs', async () => {
    assert.equal(requests.filter((r) => r.pathname === '/api/v1/engines').length, 0)
    assert.equal(requests.filter((r) => r.pathname === '/api/v1/network/classes').length, 0)
  })

  if (hasResources) await check('StrictMode startup shares the core bootstrap instead of sending it twice', async () => {
    for (const pathname of ['/api/v1/system', '/api/v1/settings', '/api/v1/models', '/api/v1/runtime', '/api/v1/downloads']) {
      assert.equal(requests.filter((request) => request.pathname === pathname).length, 1, pathname)
    }
  })

  await check('chat draft, selection, transcript node and reading position survive navigation', async () => {
    const textarea = findVisible('textarea[aria-label="Message"]')
    await change(textarea, 'Keep this unsent draft')
    // The native input path should have updated React's controlled value.
    assert.equal(useComposer.getState().drafts[thread.id]?.text, 'Keep this unsent draft')
    textarea.setSelectionRange(5, 9)
    await waitFor(() => findVisible('main pre'), 'The visible Markdown is formatted asynchronously')
    const scroll = findVisible('[data-transcript-scroll]') || [...document.querySelectorAll('main div')].find((node) => visible(node) && node.classList.contains('overflow-y-auto') && node.querySelector('pre'))
    assert.ok(scroll, 'The transcript scroll container exists')
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 500 } })
    await act(async () => {
      scroll.scrollTop = 320
      scroll.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    })
    await waitFor(() => scroll.querySelector('pre') && ![...scroll.querySelectorAll('[data-markdown-pending="true"]')].some(visible), 'The current transcript window finishes formatting')
    const firstCode = scroll.querySelector('pre')
    await go('models')
    assert.equal(visible(textarea), false)
    await go('chat')
    assert.ok(findVisible('textarea[aria-label="Message"]') === textarea, 'Chat reuses the mounted composer')
    assert.equal(textarea.value, 'Keep this unsent draft')
    assert.equal(textarea.selectionStart, 5)
    assert.equal(textarea.selectionEnd, 9)
    assert.equal(scroll.scrollTop, 320)
    assert.equal(firstCode.isConnected, true)
    assert.equal(visible(firstCode), true)
  })

  await check('Model Search keeps its filter, search draft and result scroll', async () => {
    await go('models')
    const discover = [...document.querySelectorAll('main button')].find((button) => visible(button) && button.textContent.trim().toLowerCase() === 'model search')
    assert.ok(discover)
    await act(async () => discover.click())
    const search = findVisible('input[placeholder^="Model name"]')
    await change(search, 'qwen performance fixture')
    const scroller = findVisible('section[aria-label="Model results"]')
    const format = findVisible('select[aria-label="Model format"]')
    await act(async () => {
      format.value = 'mlx'
      format.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    scroller.scrollTop = 260
    const installed = [...document.querySelectorAll('main button')].find((button) => visible(button) && button.textContent.trim().toLowerCase() === 'installed')
    await act(async () => installed.click())
    assert.equal(visible(search), false)
    await act(async () => discover.click())
    assert.ok(findVisible('input[placeholder^="Model name"]') === search, 'Model Search survives switching its own tabs')
    assert.equal(scroller.scrollTop, 260)
    const section = (name) => [...document.querySelectorAll('nav[aria-label="Model collections"] button')].find((button) => button.textContent.trim() === name)
    await act(async () => section('Mining classes').click())
    assert.equal(visible(search), false)
    await act(async () => section('Local inference').click())
    assert.equal(visible(search), true)
    assert.equal(scroller.scrollTop, 260)
    await go('chat')
    await go('models')
    const current = findVisible('input[placeholder^="Model name"]')
    assert.ok(current === search, 'Model Search reuses its search input')
    assert.equal(current.value, 'qwen performance fixture')
    assert.equal(format.value, 'mlx')
  })

  await check('an unsaved message edit keeps its text and selection when the chat is restored', async () => {
    await go('chat')
    const edit = findVisible('button[aria-label="Edit and re-run from here"]')
    assert.ok(edit)
    await act(async () => edit.click())
    const textarea = findVisible('textarea[aria-label="Edit message"]')
    try {
      await change(textarea, 'An unsaved edit, with a selection')
      textarea.setSelectionRange(3, 10)
      await go('models')
      await go('chat')
      assert.ok(findVisible('textarea[aria-label="Edit message"]') === textarea, 'An open edit remains mounted')
      assert.equal(textarea.value, 'An unsaved edit, with a selection')
      assert.equal(textarea.selectionStart, 3)
      assert.equal(textarea.selectionEnd, 10)
      assert.equal(useStudio.getState().conversations[0].messages[0].content, 'Question 0')
    } finally {
      const current = findVisible('textarea[aria-label="Edit message"]')
      if (current) await act(async () => current.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    }
  })

  await check('Monitor keeps the newest 120 samples while hidden without recording again on reveal', async () => {
    await go('chat')
    const samples = Array.from({ length: 130 }, (_, index) => ({
      hardware: { cpu_percent: index % 100, process_cpu_percent: 1, memory_used: 4 * 1024 ** 3, memory_total: 16 * 1024 ** 3, process_memory: 1024 ** 3, accelerators: [] },
      generation: { active: 0, last_tokens_per_second: index, last_time_to_first_token_ms: 20, total_tokens: index, total_generations: index },
    }))
    await act(async () => { for (const sample of samples) useStudio.getState().setSample(sample) })
    const history = useStudio.getState().sampleHistory
    assert.ok(Array.isArray(history), 'Sample history is kept at window scope')
    assert.equal(history.length, 120)
    assert.equal(history[0].generation.total_tokens, 10)
    assert.ok(history.at(-1) === samples.at(-1))
    for (let round = 0; round < 2; round++) {
      await go('monitor')
      await go('chat')
    }
    assert.ok(useStudio.getState().sampleHistory === history, 'Rendering does not append another sample')
    assert.ok(useStudio.getState().sample === samples.at(-1))
  })

  await check('Settings preserves unsaved values and its scroll container', async () => {
    await go('settings')
    const input = field('Model directory')
    await change(input, '/fixture/unsaved-models')
    const scroller = input.closest('.overflow-y-auto')
    assert.ok(scroller)
    scroller.scrollTop = 480
    await go('chat')
    await go('settings')
    assert.ok(field('Model directory') === input, 'Settings reuses its input')
    assert.equal(input.value, '/fixture/unsaved-models')
    assert.equal(scroller.scrollTop, 480)
    assert.equal(useStudio.getState().settings.models_dir, '/fixture/models')
  })

  await check('hidden Settings stops install polling and resumes exactly one poll on return', async () => {
    await go('settings')
    const polls = () => [...intervals.values()].filter((timer) => timer.delay === 1500)
    assert.equal(polls().length, 1)
    const before = requests.filter((r) => r.pathname === '/api/v1/engines/install').length
    await act(async () => { await polls()[0].callback() })
    assert.equal(requests.filter((r) => r.pathname === '/api/v1/engines/install').length, before + 1)
    await go('chat')
    assert.equal(polls().length, 0)
    await go('settings')
    assert.equal(polls().length, 1)
    await go('chat')
    await go('settings')
    assert.equal(polls().length, 1)
    assert.equal(requests.filter((r) => r.pathname === '/api/v1/engines/install' && r.method !== 'GET').length, 0)
  })

  await check('one main surface is visible and window subscriptions survive repeated navigation', async () => {
    const sourceCount = streams.length
    for (let round = 0; round < 3; round++) {
      for (const view of ['chat', 'models', 'settings']) {
        await go(view)
        const visibleChildren = [...document.querySelector('main').children].filter(visible)
        assert.equal(visibleChildren.length, 1, `Exactly one main view for ${view}`)
      }
    }
    assert.equal(streams.length, sourceCount)
    assert.equal(streams.filter((stream) => !stream.closed).length, 2)
    assert.equal(useStudio.getState().conversations[0].messages.length, 24)
  })

  const editorChecks = join(uiRoot, 'scripts/check-editor-panels.mjs')
  if (hasRetainedView) {
    const { checkTranscripts } = await import('./check-transcripts.mjs')
    await checkTranscripts({ act, check, change, flush, visible, findVisible, document, useStudio, useUi, go })
  }
  if (hasRetainedView && await access(editorChecks).then(() => true, () => false)) {
    const { checkEditorPanels } = await import(pathToFileURL(editorChecks).href)
    await checkEditorPanels({ React, act, check, change, flush, visible, findVisible, window, document, useStudio, useUi, useComposer, useFiles, selectFile, useCodeUi, fixtures, requests, intervals, go })
  }
  const virtualChecks = join(sourceRoot, 'scripts/check-virtual-transcripts.mjs')
  if (await access(virtualChecks).then(() => true, () => false)) {
    const { checkVirtualTranscripts } = await import(pathToFileURL(virtualChecks).href)
    await checkVirtualTranscripts({ act, check, change, flush, visible, findVisible, document, window, useStudio, useUi, useAgent, go })
  }
  if (hasWorkbench) {
    const { checkWorkbenchShell } = await import('./check-workbench-shell.mjs')
    await checkWorkbenchShell({ act, check, change, flush, visible, findVisible, window, document, useStudio, useUi, useComposer, useFiles, useWorkbench, closeTab, cycleTab, activateTab, fixtures, requests, go })
  }
  const paletteChecks = join(sourceRoot, 'scripts/check-palette-search.mjs')
  if (await access(paletteChecks).then(() => true, () => false)) {
    const { checkPaletteSearch } = await import(pathToFileURL(paletteChecks).href)
    await checkPaletteSearch({ act, check, change, flush, visible, findVisible, window, document, useStudio, useUi, go })
  }

  const pollingChecks = join(sourceRoot, 'scripts/check-runtime-polling.mjs')
  if (hasResources && await access(pollingChecks).then(() => true, () => false)) {
    const { checkRuntimePolling } = await import(pathToFileURL(pollingChecks).href)
    await checkRuntimePolling({ act, check, flush, findVisible, window, document, fixtures, requests, go, promptStackResource, miningQueueResource })
  }

  await act(async () => root.unmount())
  root = null
  assert.equal(intervals.size, 0, 'All view intervals are disposed at shutdown')
  assert.equal(streams.filter((stream) => !stream.closed).length, 0, 'Window streams close at shutdown')
} finally {
  if (root) await act(async () => root.unmount())
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  dom.window.close()
  await rm(temporary, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.passed)
console.log(`\nWorkbench DOM checks: ${results.length - failed.length}/${results.length} passed.`)
console.log('These are state/lifecycle checks; no browser latency measurement is claimed.')
if (failed.length) process.exitCode = 1
