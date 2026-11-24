import assert from 'node:assert/strict'

// Exercise the actual ChatView cache. Conversation data remains owned by the studio store;
// only the mounted transcript views are bounded and may be evicted.
export async function checkTranscripts({ act, check, change, flush, visible, findVisible, document, useStudio, useUi, go }) {
  const state = useStudio.getState()
  const saved = { conversations: state.conversations, activeConversationId: state.activeConversationId, view: state.view }
  const ui = useUi.getState()
  const savedUi = { appMode: ui.appMode, lastThread: ui.lastThread, rightPanel: ui.rightPanel }
  const threads = ['a', 'b', 'c', 'd'].map((key) => ({
    id: `cache-${key}`, title: `Cached transcript ${key}`, createdAt: 1, updatedAt: 1, modelId: null,
    messages: [{ id: `cache-${key}-user`, role: 'user', content: `Transcript ${key}`, createdAt: 1 }],
  }))
  const [a, b, c, d] = threads
  const select = async (thread) => {
    await act(async () => useStudio.getState().selectConversation(thread.id))
    await flush()
  }
  const node = (thread) => document.getElementById(`message-${thread.messages[0].id}`)
  const retained = () => document.querySelectorAll('[data-transcript-key]')

  try {
    await act(async () => {
      useStudio.setState({ conversations: [...saved.conversations, ...threads] })
      useUi.setState({ rightPanel: null })
    })
    await go('chat')

    let nodeA
    let nodeB
    await check('returning to a recent conversation reuses its transcript and shows updates made while hidden', async () => {
      await select(a)
      nodeA = node(a)
      assert.ok(nodeA)
      await select(b)
      nodeB = node(b)
      assert.ok(nodeB)
      assert.ok(node(a) === nodeA, 'The previous transcript stays mounted')
      assert.equal(visible(nodeA), false)
      await act(async () => useStudio.getState().updateConversation(a.id, { messages: [{ ...a.messages[0], content: 'Updated while hidden' }] }))
      await select(a)
      assert.ok(node(a) === nodeA, 'A → B → A retains the same message DOM')
      assert.equal(visible(nodeA), true)
      assert.match(nodeA.textContent, /Updated while hidden/)
      assert.ok(retained().length <= 3)
    })

    await check('a fourth recent transcript evicts only the least recently viewed DOM, preserving all messages', async () => {
      await select(c)
      await select(d)
      assert.equal(nodeB.isConnected, false, 'B was the least recently viewed transcript')
      assert.equal(nodeA.isConnected, true, 'A was revisited more recently than B')
      assert.equal(visible(node(d)), true)
      assert.equal(retained().length, 3)
      const conversations = useStudio.getState().conversations
      for (const thread of threads) {
        assert.equal(conversations.find((conversation) => conversation.id === thread.id)?.messages.length, 1)
      }
      assert.equal(conversations.find((conversation) => conversation.id === b.id).messages[0].content, 'Transcript b')
    })

    await check('visiting an empty new chat retains recent transcripts and its own unsent draft', async () => {
      await select(a)
      const previous = node(a)
      let emptyId
      await act(async () => { emptyId = useStudio.getState().newConversation({ mode: 'chat' }) })
      await flush()
      assert.ok(previous.isConnected, 'Opening an empty chat does not destroy the transcript cache')
      assert.equal(visible(previous), false)
      const draft = findVisible('textarea[aria-label="Message"]')
      await change(draft, 'Draft in a new empty conversation')
      await select(a)
      assert.ok(node(a) === previous)
      assert.match(previous.textContent, /Updated while hidden/)
      await select({ id: emptyId })
      assert.equal(findVisible('textarea[aria-label="Message"]').value, 'Draft in a new empty conversation')
      assert.ok(retained().length <= 3)
    })
  } finally {
    await act(async () => {
      useStudio.setState(saved)
      useUi.setState(savedUi)
    })
    await flush()
  }
}
