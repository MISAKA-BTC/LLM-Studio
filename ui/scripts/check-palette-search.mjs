import assert from 'node:assert/strict'

// Hold browser idle tasks to check what is visible before and after a search slice, including
// callbacks that had already been queued when another keystroke cancelled their search.
export async function checkPaletteSearch({ act, check, change, flush, findVisible, window, document, useStudio, useUi }) {
  const studio = useStudio.getState()
  const savedStudio = { conversations: studio.conversations, activeConversationId: studio.activeConversationId, view: studio.view }
  const ui = useUi.getState()
  const savedUi = { appMode: ui.appMode, lastThread: ui.lastThread, rightPanel: ui.rightPanel, paletteOpen: ui.paletteOpen, paletteQuery: ui.paletteQuery }
  const idleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback')
  const cancelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback')
  const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  const jobs = []
  let nextId = 0
  globalThis.requestIdleCallback = (run, options) => {
    const job = { id: ++nextId, run, options, cancelled: false }
    jobs.push(job)
    return job.id
  }
  globalThis.cancelIdleCallback = (id) => {
    const job = jobs.find((item) => item.id === id)
    if (job) job.cancelled = true
  }
  // jsdom does not supply CSS.escape; these fixtures use ordinary identifiers and punctuation.
  if (!globalThis.CSS) globalThis.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`) }
  const restore = (name, descriptor) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  const drain = async () => {
    let budget = 500
    while (jobs.length > 0) {
      assert.ok(budget-- > 0, 'idle search eventually completes')
      const job = jobs.shift()
      if (!job.cancelled) await act(async () => job.run({ timeRemaining: () => 50, didTimeout: false }))
    }
  }
  const latestSearch = () => jobs.findLast((job) => !job.cancelled && job.options?.timeout === 100)
  const fixture = (id, title, body = '') => ({
    id: `palette-${id}`, title, mode: 'chat', createdAt: 1, updatedAt: 100, modelId: null,
    messages: body ? [{ id: `palette-${id}-message`, role: 'assistant', content: body }] : [],
  })
  const empty = fixture('empty', 'Search test')
  const named = fixture('named', 'zzpneedle named thread')
  const old = fixture('old', 'Archive entry A', 'First zzpneedle hit and zzoldtoken')
  const recent = fixture('new', 'Archive entry B', 'Later zznewtoken match')
  const row = (thread) => document.querySelector(`#command-palette-list [data-key="thread:${thread.id}"]`)
  try {
    await act(async () => {
      useStudio.setState({ conversations: [...savedStudio.conversations, empty, named, old, recent], activeConversationId: empty.id, view: 'chat' })
      useUi.setState({ appMode: 'chat', rightPanel: null, paletteOpen: false, paletteQuery: '' })
    })
    await flush()

    await check('command palette shows titles immediately, then merges body matches without changing an explicit keyboard selection', async () => {
      await act(async () => useUi.getState().setPaletteOpen(true))
      const input = findVisible('[role="combobox"][aria-label="Search commands and threads"]')
      await change(input, 'zzpneedle')
      assert.ok(row(named), 'Title result exists before any idle task')
      assert.equal(row(old), null, 'Message search has not run on the input path')
      assert.equal(document.getElementById('command-palette-list').getAttribute('aria-busy'), 'true')
      await act(async () => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
      const selected = document.querySelector('#command-palette-list [data-active="true"]').dataset.key
      await drain()
      assert.ok(row(old))
      assert.match(row(old).textContent, /First zzpneedle hit/)
      assert.ok(row(named))
      assert.equal(document.querySelector('#command-palette-list [data-active="true"]').dataset.key, selected)
      assert.equal(document.getElementById('command-palette-list').getAttribute('aria-busy'), 'false')
    })

    await check('command palette discards previous-query results immediately and cancels queued searches on query change or close', async () => {
      const input = findVisible('[role="combobox"][aria-label="Search commands and threads"]')
      await change(input, 'zzoldtoken')
      assert.equal(row(old), null, 'The previous query snapshot is not rendered')
      const stale = latestSearch()
      assert.ok(stale)
      await change(input, 'zznewtoken')
      assert.equal(stale.cancelled, true)
      await act(async () => stale.run({ timeRemaining: () => 50, didTimeout: false }))
      assert.equal(row(old), null, 'An already queued old callback cannot publish a match')
      await drain()
      assert.ok(row(recent))
      assert.equal(row(old), null)
      await change(input, 'zzunfound')
      const afterClose = latestSearch()
      assert.ok(afterClose)
      await act(async () => useUi.getState().setPaletteOpen(false))
      assert.equal(afterClose.cancelled, true)
      await act(async () => afterClose.run({ timeRemaining: () => 50, didTimeout: false }))
      assert.equal(findVisible('[role="combobox"][aria-label="Search commands and threads"]'), undefined)
    })
  } finally {
    await act(async () => useUi.getState().setPaletteOpen(false))
    await drain()
    restore('requestIdleCallback', idleDescriptor)
    restore('cancelIdleCallback', cancelDescriptor)
    restore('CSS', cssDescriptor)
    await act(async () => {
      useStudio.setState(savedStudio)
      useUi.setState(savedUi)
    })
    await flush()
  }
}
