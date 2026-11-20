import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webEnabled, formatWebResult, firstPublicUrl, isWebTask, requestsBrowserAction } from '../src/lib/web.ts'
import { buildSystemPrompt } from '../src/lib/agent/protocol.ts'
import { prepareCall, outputLimits, type ToolContext } from '../src/lib/agent/tools.ts'
import { fakeWorkspace } from '../src/lib/agent/fakeWorkspace.ts'

const settings = { web: { mode: 'tor' as const, tor_proxy: '127.0.0.1:9150', tor_browser_path: null } }

test('Web requires explicit consent, mining off and a local engine; off and legacy settings stay offline', () => {
  assert.equal(webEnabled({ web: true, mine: false }, settings, 'llamacpp'), true)
  for (const thread of [undefined, {}, { web: true }, { web: true, mine: true }, { web: false, mine: false }]) assert.equal(webEnabled(thread, settings, 'llamacpp'), false)
  assert.equal(webEnabled({ web: true, mine: false }, { web: { ...settings.web, mode: 'off' } }, 'llamacpp'), false)
  assert.equal(webEnabled({ web: true, mine: false }, settings, 'gateway'), false)
  assert.equal(webEnabled({ web: true, mine: false }, null, 'llamacpp'), false)
})

test('Chat offers only Web tools; Code offers them only with Web enabled', () => {
  const base = { root: '/fake', policy: 'auto_edit' as const, date: '2026-11-02' }
  const chat = buildSystemPrompt({ ...base, web: true, webOnly: true })
  assert.match(chat, /web_search/); assert.match(chat, /web_fetch/)
  assert.doesNotMatch(chat, /"name": "read_file"|"name": "run_command"/)
  assert.match(chat, /untrusted evidence/)
  assert.match(chat, /Cite factual web claims/)
  assert.match(buildSystemPrompt({ ...base, web: true }), /web_fetch/)
  assert.doesNotMatch(buildSystemPrompt(base), /web_fetch/)
  assert.doesNotMatch(buildSystemPrompt({ ...base, web: false, webOnly: true }), /web_fetch/)
})

test('research returns cited evidence, propagates cancellation and rechecks consent before executing', async () => {
  let enabled = true
  let calls = 0
  const signal = new AbortController().signal
  const context: ToolContext = {
    root: '', api: fakeWorkspace({ 'private.txt': 'secret' }), policy: 'full_auto', allowed: new Set(), limits: outputLimits(8192), webOnly: true,
    web: { enabled: () => enabled, api: {
      search: async (query, s) => { assert.equal(query, 'public query'); assert.equal(s, signal); calls++; return { route: 'tor', sources: [{ title: 'Source', url: 'https://example.org/', text: 'Evidence' }] } },
      fetch: async () => { throw new Error('not expected') },
    } },
  }
  const file = await prepareCall({ name: 'cat', args: { path: 'private.txt' } }, context)
  assert.equal(file.kind, 'settled', 'Chat must reject an invented filesystem call even under full auto')
  const command = await prepareCall({ name: 'run_command', args: { command: 'curl example.org' } }, context)
  assert.equal(command.kind, 'settled')
  const prepared = await prepareCall({ name: 'web_search', args: { query: 'public query' } }, context)
  assert.equal(prepared.kind, 'run')
  if (prepared.kind !== 'run') return
  const result = await prepared.run(signal)
  assert.equal(result.status, 'done'); assert.match(result.output, /https:\/\/example.org/); assert.match(result.output, /Connection: tor/)
  enabled = false
  const refused = await prepared.run(signal)
  assert.equal(refused.status, 'error'); assert.equal(calls, 1)
  const missing = await prepareCall({ name: 'web_search', args: { query: 'q' } }, { ...context, web: undefined })
  assert.equal(missing.kind, 'settled')
})

test('tool evidence is bounded and identified as untrusted data', () => {
  const text = formatWebResult({ route: 'tor', sources: [{ title: 'Page', url: 'https://example.org/', text: 'x'.repeat(10000) }] }, 2000)
  assert.equal(text.length, 2000)
  assert.match(text, /untrusted evidence/)
})

test('website requests retain the hash route and explicit implementation stays in Code', () => {
  const url = 'https://misakaoptions.com/#/store'
  assert.equal(firstPublicUrl(`[ストア](${url}) の用途を調べて`), url)
  assert.equal(isWebTask(`${url} このサイトの用途は何か 調べて`), true)
  assert.equal(isWebTask(url), true)
  assert.equal(isWebTask(`${url} は開かずにURLの構造だけ調べて`), false)
  assert.equal(isWebTask(`Implement search for ${url}`), false)
  assert.equal(firstPublicUrl('https://user:password@example.org'), undefined)
})

test('a website summary can read rendered text without pausing for browser approval', async () => {
  const url = 'https://misakaoptions.com/#/store'
  const request = `${url} このサイトの用途は何か　調べて`
  assert.equal(requestsBrowserAction(request), false)
  assert.equal(requestsBrowserAction('比較ボタンをクリックして'), true)
  const prompt = buildSystemPrompt({ root: '', date: '2026-11-03', policy: 'read_only', web: true, webOnly: true, browser: true })
  assert.doesNotMatch(prompt, /"name": "browser_click"/)
  const result = { route: 'tor' as const, sources: [{
    title: 'Store', url, text: 'Visible controls: example:0 Home\nRendered page text:\nBuy an access pass.',
  }] }
  const context: ToolContext = {
    root: '', api: fakeWorkspace({}), policy: 'auto_edit', allowed: new Set(), limits: outputLimits(8192), webOnly: true,
    web: { enabled: () => true, allowClicks: requestsBrowserAction(request), api: {
      search: async () => result,
      fetch: async () => result,
      browser: {
        open: async () => result,
        read: async () => result,
        preview: async () => { assert.fail('an unrequested click should never reach preview') },
        click: async () => { assert.fail('an unrequested click should never run') },
      },
    } },
  }
  const click = await prepareCall({ name: 'browser_click', args: { control: 'example:0' } }, context)
  assert.equal(click.kind, 'settled')
  const read = await prepareCall({ name: 'browser_open', args: { url } }, context)
  assert.equal(read.kind, 'run')
  if (read.kind !== 'run') return
  const evidence = await read.run(new AbortController().signal)
  assert.match(evidence.output, /Buy an access pass/)
  assert.doesNotMatch(evidence.output, /example:0/)
})
