import type { ChatMessage, Conversation, MiningJob, MiningQueueView, MessageMining } from './types'

type MessageIndex = { jobs: Map<string, number[]>; pendingAt: number }
const messageIndexes = new WeakMap<ChatMessage[], MessageIndex>()
const pendingTimes = new WeakMap<Conversation[], number>()

function index(messages: ChatMessage[]): MessageIndex {
  const cached = messageIndexes.get(messages)
  if (cached) return cached
  const result: MessageIndex = { jobs: new Map(), pendingAt: 0 }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (!message.mining) continue
    const positions = result.jobs.get(message.mining.jobId)
    if (positions) positions.push(i)
    else result.jobs.set(message.mining.jobId, [i])
    if (message.mining.status === 'queued' || message.mining.status === 'running') result.pendingAt = Math.max(result.pendingAt, message.createdAt ?? 0)
  }
  messageIndexes.set(messages, result)
  return result
}

/** A retained message-array identity is indexed once, not on every background status tick. */
export function hasRecentLocalMining(conversations: Conversation[], now: number, windowMs: number): boolean {
  let latest = pendingTimes.get(conversations)
  if (latest === undefined) {
    latest = 0
    for (const conversation of conversations) latest = Math.max(latest, index(conversation.messages).pendingAt)
    pendingTimes.set(conversations, latest)
  }
  return latest > 0 && latest > now - windowMs
}

function same(job: MiningJob, mining: MessageMining): boolean {
  return job.status === mining.status && job.claim_id === mining.claimId && job.error === mining.error && job.answer === mining.answer
}

/** Preserve all history and trimmed jobs; replace only messages whose authoritative job changed. */
export function reconcileMining(conversations: Conversation[], queue: MiningQueueView): Conversation[] {
  if (!queue.jobs.length) return conversations
  const jobs = new Map(queue.jobs.map((job) => [job.id, job]))
  let result = conversations
  for (let ci = 0; ci < conversations.length; ci++) {
    const conversation = conversations[ci]!
    const current = index(conversation.messages)
    let messages = conversation.messages
    for (const [jobId, positions] of current.jobs) {
      const job = jobs.get(jobId)
      if (!job) continue
      for (const position of positions) {
        const message = messages[position]!
        if (!message.mining || same(job, message.mining)) continue
        if (messages === conversation.messages) messages = messages.slice()
        messages[position] = { ...message, mining: { jobId: job.id, status: job.status, claimId: job.claim_id, error: job.error, answer: job.answer } }
      }
    }
    if (messages === conversation.messages) continue
    // Job identities and positions are unchanged; only recalculate the pending time on indexed rows.
    let pendingAt = 0
    for (const positions of current.jobs.values()) for (const position of positions) {
      const message = messages[position]!
      if (message.mining?.status === 'queued' || message.mining?.status === 'running') pendingAt = Math.max(pendingAt, message.createdAt ?? 0)
    }
    messageIndexes.set(messages, { jobs: current.jobs, pendingAt })
    if (result === conversations) result = conversations.slice()
    result[ci] = { ...conversation, messages }
  }
  return result
}
