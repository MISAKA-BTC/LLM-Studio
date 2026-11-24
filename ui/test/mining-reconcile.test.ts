import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasRecentLocalMining, reconcileMining } from '../src/lib/miningReconcile.ts'
import type { ChatMessage, Conversation, MiningJob, MiningQueueView } from '../src/lib/types.ts'

const conversation = (id: string, messages: ChatMessage[]): Conversation => ({ id, title: id, createdAt: 0, updatedAt: 0, modelId: null, messages })
const job = (status: MiningJob['status'] = 'queued'): MiningJob => ({ id: 'job', conversation_id: 'c', message_id: 'm', prompt: 'hello', created_ms: 1000, status, attempts: 1, not_before_ms: 0, started_ms: null, finished_ms: null, fp_job_id: null, claim_id: null, answer: null, prompt_tokens: null, completion_tokens: null, error: null, gateway_url: 'fixture' })
const queue = (jobs: MiningJob[]): MiningQueueView => ({ mode: 'background', background_available: true, background_blocker: null, gateway_url: null, counts: { queued: jobs.length, running: 0, committed: 0, refused: 0, failed: 0 }, jobs })
const message = (): ChatMessage => ({ id: 'm', role: 'user', content: 'hello', createdAt: 1000, mining: { jobId: 'job', status: 'queued', claimId: null, answer: null, error: null } })

test('an empty queue does not visit message arrays or rewrite history', () => {
  const conversations = [conversation('c', [])]
  Object.defineProperty(conversations[0], 'messages', { get() { throw new Error('history was read') } })
  assert.equal(reconcileMining(conversations, queue([])), conversations)
})

test('an unchanged poll reuses the history index instead of visiting 100,000 message positions', () => {
  let reads = 0
  const conversations = Array.from({ length: 200 }, (_, ci) => {
    const messages = Array.from({ length: 500 }, (_, mi): ChatMessage => ci === 0 && mi === 0 ? message() : ({ id: `${ci}-${mi}`, role: 'assistant', content: 'retained history' }))
    return conversation(String(ci), new Proxy(messages, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver) } }))
  })
  const status = queue([job()])
  assert.equal(reconcileMining(conversations, status), conversations)
  assert.ok(reads >= 100_000)
  reads = 0
  for (let i = 0; i < 100; i++) assert.equal(reconcileMining(conversations, status), conversations)
  assert.equal(reads, 100, 'one indexed message read per poll; no repeated full traversal')
})

test('only changed messages and conversations are replaced, including duplicate references to a job', () => {
  const untouched: ChatMessage = { id: 'other', role: 'assistant', content: 'keep me' }
  const conversations = [conversation('c', [message(), untouched, { ...message(), id: 'm2' }]), conversation('unrelated', [untouched])]
  const completed = { ...job('committed'), claim_id: 'claim', answer: 'answer' }
  const next = reconcileMining(conversations, queue([completed]))
  assert.notEqual(next, conversations)
  assert.notEqual(next[0], conversations[0])
  assert.equal(next[1], conversations[1])
  assert.equal(next[0]!.messages[1], untouched)
  assert.equal(next[0]!.messages[0]!.mining!.answer, 'answer')
  assert.equal(next[0]!.messages[2]!.mining!.claimId, 'claim')
  assert.equal(conversations[0]!.messages[0]!.mining!.status, 'queued')
  assert.equal(reconcileMining(next, queue([completed])), next)
  assert.equal(reconcileMining(next, queue([])), next, 'trimmed jobs keep their last authoritative state')
})

test('pending cadence expires by time and indexes a new message array after a real history change', () => {
  const conversations = [conversation('c', [message()])]
  assert.equal(hasRecentLocalMining(conversations, 1500, 1000), true)
  assert.equal(hasRecentLocalMining(conversations, 2000, 1000), false)
  const completed = reconcileMining(conversations, queue([job('committed')]))
  assert.equal(hasRecentLocalMining(completed, 1500, 1000), false)
  const added = [{ ...completed[0]!, messages: [...completed[0]!.messages, { ...message(), createdAt: 10_000 }] }]
  assert.equal(hasRecentLocalMining(added, 10_001, 1000), true)
})
