import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} })

const compiled = await build({
  stdin: {
    contents: `
      export { queueFollowUp, removeFollowUp, sendFromComposer } from './src/components/chat/followUps';
      export { useStudio } from './src/store/studio';
      export { api } from './src/lib/api';
      export { fakeWorkspace } from './src/lib/agent/fakeWorkspace';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
})
const { queueFollowUp, removeFollowUp, sendFromComposer, useStudio, api, fakeWorkspace } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0]!.text).toString('base64')}`)

const runtime = { model_id: 'local', context_size: 32768, backend: 'llamacpp' }
const draft = (text: string) => ({ text, attachments: [] })
const reply = (content: string) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}\n\n' +
  'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } },
)

function reset(mode: 'chat' | 'agent') {
  const thread = (id: string) => ({ id, title: id, mode, modelId: 'local', workspace: '/fake', messages: [], createdAt: 0, updatedAt: 0 })
  useStudio.setState({
    models: [{ id: 'local', path: '/local.gguf', fit: { verdict: 'fits' } }], connected: true, runtime,
    activeConversationId: 'first', conversations: [thread('first'), thread('other')],
  })
  api.runtime = async () => runtime
}

function gate() {
  return Promise.withResolvers<void>()
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await delay(5)
  }
  assert.fail('the expected conversation state was never reached')
}

const history = (id: string) => useStudio.getState().conversations.find((c: { id: string }) => c.id === id)?.messages

test('Chat sends queued follow-ups in order to the original conversation and skips removed items', async (t) => {
  reset('chat')
  const first = gate()
  const requests: Array<{ messages: { role: string; content: string }[] }> = []
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options!.body as string))
    if (requests.length === 1) await first.promise
    return reply(`Answer ${requests.length}`)
  }

  const initial = sendFromComposer('first', draft('First question'))
  await until(() => requests.length === 1)
  queueFollowUp('first', { text: 'Follow-up A', attachments: [{ id: 'file', name: 'notes.txt', size: 8, content: 'my notes' }] })
  const removed = queueFollowUp('first', draft('Remove this'))
  queueFollowUp('first', draft('Follow-up B'))
  removeFollowUp('first', removed)
  useStudio.getState().selectConversation('other')
  await delay(0)
  assert.equal(requests.length, 1)
  first.resolve()
  await initial
  await until(() => history('first').at(-1)?.content === 'Answer 3')

  assert.deepEqual(history('first').map((m: { content: string }) => m.content), [
    'First question', 'Answer 1', 'Follow-up A', 'Answer 2', 'Follow-up B', 'Answer 3',
  ])
  assert.deepEqual(history('other'), [])
  assert.equal(useStudio.getState().activeConversationId, 'other')
  assert.ok(requests[1]!.messages.some((m) => m.role === 'assistant' && m.content === 'Answer 1'))
  assert.match(requests[1]!.messages.at(-1)!.content, /Follow-up A[\s\S]*my notes/)
  assert.ok(requests[2]!.messages.some((m) => m.role === 'assistant' && m.content === 'Answer 2'))
})

test('Code waits for the tool and the final answer before running a queued follow-up', async (t) => {
  reset('agent')
  const toolStarted = gate()
  const toolFinished = gate()
  const workspace = fakeWorkspace({ 'notes.txt': 'Existing notes\n' })
  t.mock.method(api.workspace, 'open', async () => ({ root: '/fake', name: 'fake', is_git: false }))
  t.mock.method(api.workspace, 'read', async (...args: Parameters<typeof workspace.read>) => {
    toolStarted.resolve()
    await toolFinished.promise
    return workspace.read(...args)
  })

  const requests: Array<{ messages: { role: string; content: string }[] }> = []
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options!.body as string))
    if (requests.length === 1) return reply('<tool_call>\n<function=read_file>\n<parameter=path>\nnotes.txt\n</parameter>\n</function>\n')
    return reply(requests.length === 2 ? 'I read the notes.' : 'Here is the follow-up.')
  }

  const initial = sendFromComposer('first', draft('Read the notes'))
  await toolStarted.promise
  assert.equal(useStudio.getState().streaming, null)
  queueFollowUp('first', draft('続けて'))
  await delay(0)
  assert.equal(requests.length, 1)
  toolFinished.resolve()
  await initial
  await until(() => history('first').at(-1)?.content === 'Here is the follow-up.')
  assert.equal(requests.length, 3)
  assert.ok(requests[2]!.messages.some((m) => m.role === 'assistant' && m.content === 'I read the notes.'))
  assert.equal(requests[2]!.messages.at(-1)!.content, '続けて')
})
