import assert from 'node:assert/strict'

// DOM/lifecycle regressions, not browser paint-time measurements. The final two checks give
// ResizeObserver deterministic variable heights so scroll anchoring is exercised in jsdom.
export async function checkVirtualTranscripts({ act, check, change, flush, visible, findVisible, document, window, useStudio, useUi, useAgent, go }) {
  const state = useStudio.getState()
  const saved = { conversations: state.conversations, activeConversationId: state.activeConversationId, streaming: state.streaming, view: state.view }
  const ui = useUi.getState()
  const savedUi = { appMode: ui.appMode, lastThread: ui.lastThread, rightPanel: ui.rightPanel }
  const savedAgent = useAgent.getState()
  const messages = Array.from({ length: 2000 }, (_, index) => ({ id: `virtual-${index}`, role: index % 2 ? 'assistant' : 'user', content: `History message ${index}`, createdAt: index }))
  let historyFilters = 0
  Object.defineProperty(messages, 'filter', { value(...args) { historyFilters++; return Array.prototype.filter.apply(this, args) } })
  const thread = { id: 'virtual-thread', title: 'Virtual transcript fixture', createdAt: 1, updatedAt: 1, modelId: null, messages }
  const settle = async () => { for (let count = 0; count < 3; count++) await flush() }
  let scroller
  let originalScrollHeight
  let originalClientHeight
  const list = () => findVisible('[data-virtual-transcript]')
  const rows = () => [...(list()?.querySelectorAll('[data-virtual-row]') ?? [])]
  const row = (id) => rows().find((node) => node.dataset.virtualRow === id)
  const scrollTo = async (top) => {
    await act(async () => {
      if (top < scroller.scrollTop) scroller.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -1, bubbles: true }))
      scroller.scrollTop = top
      scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }))
    })
    await settle()
  }
  const previousObserver = globalThis.ResizeObserver
  const previousRect = window.HTMLElement.prototype.getBoundingClientRect
  const measuredHeights = new Map()
  const observers = new Set()
  let deterministicGeometry = false
  let simulatedWidth = 728

  try {
    await act(async () => {
      useStudio.setState({ conversations: [...saved.conversations, thread], activeConversationId: thread.id, streaming: null })
      useUi.setState({ appMode: 'chat', rightPanel: null })
    })
    await go('chat')
    scroller = findVisible('[data-transcript-scroll]')
    originalScrollHeight = Object.getOwnPropertyDescriptor(scroller, 'scrollHeight')
    originalClientHeight = Object.getOwnPropertyDescriptor(scroller, 'clientHeight')
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, get: () => Number.parseFloat(list()?.style.height || '0') + 48 },
    })

    await check('a 2,000-message thread mounts a bounded initial viewport without truncating history', async () => {
      assert.ok(list())
      assert.equal(Number(list().dataset.totalMessages), 2000)
      assert.ok(rows().length > 0 && rows().length < 40, `${rows().length} rows mounted`)
      console.log(`Virtual transcript DOM: ${rows().length} of 2000 message rows mounted initially.`)
      assert.ok(row('virtual-1999'), 'The initial viewport contains the latest message')
      assert.equal(useStudio.getState().conversations.find((entry) => entry.id === thread.id).messages.length, 2000)
    })

    await check('scrolling a virtual transcript reaches its oldest, middle and newest messages', async () => {
      await scrollTo(0)
      assert.ok(row('virtual-0'), 'The oldest message is reachable')
      assert.equal(row('virtual-1999'), undefined, 'Offscreen history releases its DOM')
      await scrollTo(scroller.scrollHeight / 2)
      assert.ok(rows().some((node) => Number(node.dataset.virtualIndex) > 900 && Number(node.dataset.virtualIndex) < 1100))
      assert.ok(rows().length < 40)
      await scrollTo(scroller.scrollHeight - scroller.clientHeight)
      assert.ok(row('virtual-1999'))
    })

    await check('live tokens update one row without filtering history again or moving an upward-scrolled reader', async () => {
      await act(async () => useStudio.setState({ streaming: { conversationId: thread.id, assistantId: 'virtual-live', content: '', startedAt: 0 } }))
      await settle()
      const before = historyFilters
      for (let index = 1; index <= 12; index++) {
        await act(async () => useStudio.setState({ streaming: { conversationId: thread.id, assistantId: 'virtual-live', content: `Live ${index}`, startedAt: 0 } }))
      }
      assert.equal(historyFilters, before, 'Token updates must not rerun the history filter')
      assert.match(row('virtual-live').textContent, /Live 12/)
      await scrollTo(0)
      const top = scroller.scrollTop
      const first = row('virtual-0')
      await act(async () => useStudio.setState({ streaming: { conversationId: thread.id, assistantId: 'virtual-live', content: 'More text below the reader', startedAt: 0 } }))
      await settle()
      assert.equal(scroller.scrollTop, top)
      assert.ok(row('virtual-0') === first)
      assert.equal(historyFilters, before)
      await act(async () => useStudio.setState({ streaming: null }))
    })

    await check('editing the last user message reaches an unmounted row and preserves its draft while scrolled away', async () => {
      await scrollTo(0)
      const composer = findVisible('textarea[aria-label="Message"]')
      await change(composer, '')
      await act(async () => composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
      await settle()
      const editor = findVisible('textarea[aria-label="Edit message"]')
      assert.ok(editor)
      assert.ok(editor.closest('[data-virtual-row]').dataset.virtualRow === 'virtual-1998')
      await change(editor, 'Preserved virtual edit draft')
      await scrollTo(0)
      assert.equal(editor.isConnected, true, 'An open editor is pinned outside the window')
      assert.equal(editor.value, 'Preserved virtual edit draft')
      assert.ok(rows().length < 41)
      await act(async () => editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    })

    await check('pending approval remains reachable through an explicit review action after virtualization', async () => {
      const call = { id: 'virtual-approval', name: 'run_command', args: { command: 'echo fixture' }, status: 'awaiting_approval' }
      const nextMessages = messages.map((message, index) => index === 81 ? { ...message, toolCalls: [call] } : message)
      await act(async () => {
        useStudio.getState().updateConversation(thread.id, { messages: nextMessages })
        useAgent.setState({ pendingApproval: call.id, run: { conversationId: thread.id, status: 'awaiting_approval', step: 1 } })
      })
      await scrollTo(scroller.scrollHeight - scroller.clientHeight)
      assert.equal(row('virtual-81'), undefined)
      const review = [...document.querySelectorAll('button')].find((button) => visible(button) && button.textContent.includes('Review pending approval'))
      assert.ok(review)
      await act(async () => review.click())
      await settle()
      const approval = row('virtual-81')?.querySelector('[data-approval-bar="virtual-approval"]')
      assert.ok(approval)
      assert.ok(document.activeElement === approval, 'Focus moves only after the explicit review action')
      assert.equal(useAgent.getState().pendingApproval, call.id, 'Review does not approve a command')
      await act(async () => useAgent.setState({ pendingApproval: null, run: null }))
    })

    globalThis.ResizeObserver = class {
      constructor(callback) { this.callback = callback; this.nodes = new Set(); observers.add(this) }
      observe(node) { this.nodes.add(node) }
      unobserve(node) { this.nodes.delete(node) }
      disconnect() { this.nodes.clear(); observers.delete(this) }
    }
    deterministicGeometry = true
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (deterministicGeometry && (this.dataset.virtualRow || this.hasAttribute('data-virtual-transcript'))) {
        const height = this.dataset.virtualRow ? measuredHeights.get(this.dataset.virtualRow) ?? 120 : Number.parseFloat(this.style.height || '0')
        return { x: 0, y: 0, top: 0, left: 0, right: simulatedWidth, bottom: height, width: simulatedWidth, height, toJSON() {} }
      }
      return previousRect.call(this)
    }
    const resize = async (node, height) => {
      measuredHeights.set(node.dataset.virtualRow, height)
      await act(async () => {
        for (const observer of [...observers]) if (observer.nodes.has(node)) observer.callback([{ target: node }])
      })
      await settle()
    }
    const measuredThread = { ...thread, id: 'virtual-measured', title: 'Measured fixture', messages: messages.slice(0, 200).map((message, index) => ({ ...message, id: `measured-${index}` })) }
    await act(async () => {
      useStudio.setState({ conversations: [...useStudio.getState().conversations, measuredThread], activeConversationId: measuredThread.id })
    })
    await settle()

    await check('measuring a row above the viewport preserves the reading anchor', async () => {
      await scrollTo(scroller.scrollHeight / 2)
      const before = scroller.scrollTop
      const above = rows().filter((node) => Number.parseFloat(node.style.top) + 24 + 120 <= before).at(-1)
      assert.ok(above, 'Overscan includes a row above the visible viewport')
      await resize(above, 220)
      assert.equal(scroller.scrollTop, before + 100, 'The same visible text stays in place after an earlier row grows')
    })

    await check('measured content growth follows the bottom only while the user is following', async () => {
      await scrollTo(scroller.scrollHeight - scroller.clientHeight)
      const last = row('measured-199')
      assert.ok(last)
      const before = scroller.scrollTop
      await resize(last, 280)
      assert.equal(scroller.scrollTop, before + 160)
      assert.equal(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight)
    })

    await check('toggling side panels reflows collapsed-reasoning transcripts without blank gaps or anchor loss', async () => {
      const longThinking = '思考プロセス '.repeat(2500)
      const reasoningMessages = Array.from({ length: 40 }, (_, index) => ({
        id: `reasoning-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        content: index % 2 ? `<think>${longThinking}</think>\n了解しました。ステップ ${index} を確認します。` : `ステップ ${index} を進めて`,
        reasoning: index % 2 ? longThinking : undefined,
        reasoningMs: index % 2 ? 180_000 : undefined,
        createdAt: index + 1,
      }))
      for (const message of reasoningMessages) measuredHeights.set(message.id, 150)
      const reasoningThread = { ...thread, id: 'virtual-reasoning-resize', title: 'Reasoning resize fixture', mode: 'agent', messages: reasoningMessages }
      await act(async () => {
        useStudio.setState({ conversations: [...useStudio.getState().conversations, reasoningThread], activeConversationId: reasoningThread.id })
      })
      await settle()

      // Scroll to middle (message ~20) so `following` is false.
      await scrollTo(scroller.scrollHeight / 2)
      const visibleBefore = rows().find((node) => {
        const top = Number.parseFloat(node.style.top) + 24
        return top <= scroller.scrollTop && top + 150 > scroller.scrollTop
      })
      assert.ok(visibleBefore, 'A visible anchor message straddles scrollTop before toggling the side panel')
      const anchorId = visibleBefore.dataset.virtualRow
      const offsetBefore = scroller.scrollTop - (Number.parseFloat(visibleBefore.style.top) + 24)

      // Open right side panel -> column narrows from 728px to 520px and mounted rows wrap to 210px.
      simulatedWidth = 520
      for (const message of reasoningMessages) measuredHeights.set(message.id, 210)
      await act(async () => {
        useUi.getState().setRightPanel('session')
        const listNode = list()
        for (const observer of [...observers]) {
          const targets = [...observer.nodes].filter((n) => n === listNode || n.dataset?.virtualRow)
          if (targets.length) observer.callback(targets.map((target) => ({ target })))
        }
      })
      await settle()

      // Verify consecutive mounted rows have exact 210px spacing (zero thousands-of-pixels reasoning gap).
      const narrowedRows = rows().sort((a, b) => Number(a.dataset.virtualIndex) - Number(b.dataset.virtualIndex))
      assert.ok(narrowedRows.length >= 4)
      for (let i = 1; i < narrowedRows.length; i++) {
        if (Number(narrowedRows[i].dataset.virtualIndex) === Number(narrowedRows[i - 1].dataset.virtualIndex) + 1) {
          const gap = Number.parseFloat(narrowedRows[i].style.top) - Number.parseFloat(narrowedRows[i - 1].style.top)
          assert.equal(gap, 210, `Adjacent mounted rows must sit 210px apart without blank gaps, got ${gap}px`)
        }
      }
      const afterNarrow = row(anchorId)
      assert.ok(afterNarrow, 'Anchor message stays mounted in view after opening side panel')
      assert.ok(Math.abs((scroller.scrollTop - (Number.parseFloat(afterNarrow.style.top) + 24)) - offsetBefore) <= 2, 'Anchor offset preserved on narrow')

      // Close right side panel -> column widens back to 728px (150px rows) even if browser clamps scrollTop.
      simulatedWidth = 728
      for (const message of reasoningMessages) measuredHeights.set(message.id, 150)
      await act(async () => {
        useUi.getState().setRightPanel(null)
        const listNode = list()
        for (const observer of [...observers]) {
          const targets = [...observer.nodes].filter((n) => n === listNode || n.dataset?.virtualRow)
          if (targets.length) observer.callback(targets.map((target) => ({ target })))
        }
      })
      await settle()
      const afterWiden = row(anchorId)
      assert.ok(afterWiden, 'Anchor message stays mounted in view after closing side panel')
      const widenedRows = rows().sort((a, b) => Number(a.dataset.virtualIndex) - Number(b.dataset.virtualIndex))
      for (let i = 1; i < widenedRows.length; i++) {
        if (Number(widenedRows[i].dataset.virtualIndex) === Number(widenedRows[i - 1].dataset.virtualIndex) + 1) {
          const gap = Number.parseFloat(widenedRows[i].style.top) - Number.parseFloat(widenedRows[i - 1].style.top)
          assert.equal(gap, 150, `Adjacent mounted rows return to 150px spacing without blank gaps, got ${gap}px`)
        }
      }
    })
  } finally {
    deterministicGeometry = false
    window.HTMLElement.prototype.getBoundingClientRect = previousRect
    globalThis.ResizeObserver = previousObserver
    if (scroller) {
      if (originalScrollHeight) Object.defineProperty(scroller, 'scrollHeight', originalScrollHeight)
      else delete scroller.scrollHeight
      if (originalClientHeight) Object.defineProperty(scroller, 'clientHeight', originalClientHeight)
      else delete scroller.clientHeight
    }
    await act(async () => {
      useStudio.setState(saved)
      useUi.setState(savedUi)
      useAgent.setState(savedAgent)
    })
    await settle()
  }
}
