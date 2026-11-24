import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSnippet, foldCase, fuzzyMatch, queryWords } from '../src/lib/fuzzy.ts'
import { MAX_PALETTE_THREADS, planThreadSearch, searchThreadContents, type SearchDeadline, type SearchScheduler, type ThreadContentMatch } from '../src/lib/paletteSearch.ts'
import type { ChatMessage, Conversation } from '../src/lib/types.ts'

const message = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', content, ...extra })
const thread = (id: string, messages: ChatMessage[] = [], title = `Thread ${id}`, updatedAt = 0): Conversation => ({
  id, title, createdAt: 0, updatedAt, modelId: null, messages,
})
const label = (conversation: Conversation) => conversation.title

function scheduler() {
  const jobs: { run: (deadline: SearchDeadline) => void; cancelled: boolean }[] = []
  const schedule: SearchScheduler = (run) => {
    const job = { run, cancelled: false }
    jobs.push(job)
    return () => { job.cancelled = true }
  }
  const step = (remaining = 50) => {
    const job = jobs.shift()
    assert.ok(job, 'a later search task was scheduled')
    if (!job.cancelled) job.run({ timeRemaining: () => remaining })
    return job
  }
  const flush = () => {
    let remaining = 1000
    while (jobs.length > 0) {
      assert.ok(remaining-- > 0, 'search eventually completes')
      step()
    }
  }
  return { jobs, schedule, step, flush }
}

function search(candidates: Conversation[], query: string, limit?: number) {
  const clock = scheduler()
  const updates: { matches: readonly ThreadContentMatch[]; complete: boolean }[] = []
  const cancel = searchThreadContents(candidates, query, (matches, complete) => updates.push({ matches, complete }), {
    schedule: clock.schedule, now: () => 0, limit,
  })
  return { ...clock, updates, cancel }
}

test('the input-path search reads names only, including the exact display label of Code sessions', () => {
  const threads = [thread('named', [], 'Needle title'), thread('body')]
  for (const conversation of threads) Object.defineProperty(conversation, 'messages', { get() { throw new Error('body read during input') } })
  const plan = planThreadSearch(threads, 'needle', label)
  assert.deepEqual(plan.titles.map((match) => match.conversation.id), ['named'])
  assert.deepEqual(plan.candidates.map((conversation) => conversation.id), ['body'])
  const code = { ...thread('code', [], 'New session'), mode: 'agent' as const, workspace: '/work/Needle' }
  const codePlan = planThreadSearch([code], 'needle', (conversation) => conversation.workspace!)
  assert.deepEqual(codePlan.titles.map((match) => match.conversation.id), ['code'])
})

test('split search preserves the previous title/body scope, snippets, first-message choice and result order', () => {
  const conversations = [
    thread('title', [message('t1', 'cache content')], 'Cache report', 10),
    thread('system', [message('s1', 'cache foo bar 東京', { role: 'system' })], 'Internal', 9),
    thread('tool', [message('t1', 'cache foo bar 東京', { toolResults: true })], 'Tool output', 8),
    thread('first', [message('f1', 'First\n\tCACHE entry'), message('f2', 'Later cache entry')], 'Notes', 7),
    thread('separate', [message('p1', 'foo only'), message('p2', 'bar only')], 'Split words', 6),
    thread('together', [message('b1', 'foo and then BAR')], 'Other notes', 5),
    thread('unicode', [message('u1', 'İ and an uppercase CACHE')], 'Unicode', 4),
    thread('japanese', [message('j1', '東京の設計について話す')], '議事録', 3),
    thread('literal-title', [], `${'記録'.repeat(100)}東京議事録`, 2),
    thread('empty', [message('e1', '')], 'Blank', 1),
  ]
  for (const query of ['cache', 'CACHE', 'foo bar', 'İ cache', '東京', 'nothing here', 'a', ' ']) {
    // The old synchronous search is the compatibility oracle: title matches (before score
    // filtering) exclude a thread from literal search, whose first eligible message wins.
    const words = queryWords(query)
    const whole = words.join(' ')
    const titles: { id: string; score: number; ranges: readonly (readonly [number, number])[] }[] = []
    const bodies: { id: string; snippet: ReturnType<typeof findSnippet> }[] = []
    if (words.length > 0) for (const conversation of conversations) {
      const title = fuzzyMatch(query, conversation.title, { minQuality: 0.45 })
      const at = foldCase(conversation.title).indexOf(whole)
      if (title || at >= 0) {
        titles.push({ id: conversation.id, score: title ? title.score + 0.25 : 0.5, ranges: title?.ranges ?? [[at, at + whole.length]] })
        continue
      }
      if (whole.length < 2) continue
      for (const item of conversation.messages) {
        if (item.toolResults || item.role === 'system' || !item.content) continue
        const snippet = findSnippet(item.content, query)
        if (snippet) { bodies.push({ id: conversation.id, snippet }); break }
      }
    }
    const plan = planThreadSearch(conversations, query, label)
    const job = search(plan.candidates, query)
    job.flush()
    const result = job.updates.at(-1)!
    assert.equal(result.complete, true)
    assert.deepEqual(plan.titles.map(({ conversation, ...match }) => ({ id: conversation.id, ...match })), titles, query)
    assert.deepEqual(result.matches.map(({ conversation, snippet }) => ({ id: conversation.id, snippet })), bodies, query)
    if (query === 'cache') {
      assert.deepEqual(result.matches.map((match) => match.conversation.id), ['first', 'unicode'])
      assert.equal(result.matches[0]?.snippet.text, 'First CACHE entry')
    }
    if (query === 'foo bar') assert.deepEqual(result.matches.map((match) => match.conversation.id), ['together'])
  }
})

test('empty and one-character queries never scan messages; title search still works', () => {
  const conversation = thread('guard', [], 'X title')
  Object.defineProperty(conversation, 'messages', { get() { throw new Error('unneeded body read') } })
  for (const query of ['', '  ', 'x']) {
    const plan = planThreadSearch([conversation], query, label)
    assert.equal(plan.candidates.length, 0)
    const job = search([conversation], query)
    job.flush()
    assert.deepEqual(job.updates, [{ matches: [], complete: true }])
  }
  assert.equal(planThreadSearch([conversation], 'x', label).titles.length, 1)
})

test('large no-match histories do no synchronous work and yield repeatedly between bounded slices', () => {
  const visited = new Set<number>()
  const messages = Array.from({ length: 500 }, (_, index) => ({
    ...message(String(index), ''),
    get content() { visited.add(index); return 'No matching word here' },
  }))
  const job = search([thread('long', messages)], 'needle')
  assert.equal(visited.size, 0)
  assert.equal(job.updates.length, 0)
  job.step()
  assert.ok(visited.size > 0 && visited.size <= 32)
  assert.equal(job.jobs.length, 1)
  assert.equal(job.updates.length, 0, 'no redundant React update for a no-hit slice')
  job.flush()
  assert.equal(visited.size, 500)
  assert.deepEqual(job.updates, [{ matches: [], complete: true }])
})

test('an expired idle deadline makes one step and yields; wall-clock budget also yields', () => {
  const visited = new Set<number>()
  const messages = Array.from({ length: 100 }, (_, index) => ({
    ...message(String(index), ''),
    get content() { visited.add(index); return 'No match' },
  }))
  const job = search([thread('long', messages)], 'needle')
  job.step(0)
  assert.equal(visited.size, 1, 'timeout callbacks make progress without running a whole batch')
  job.cancel()
  visited.clear()
  const clock = scheduler()
  let now = 0
  const cancel = searchThreadContents([thread('time', messages)], 'needle', () => {}, { schedule: clock.schedule, now: () => { now += 5; return now } })
  clock.step()
  assert.equal(visited.size, 1)
  cancel()
})

test('only the newest 40 body matches are searched, or fewer when title matches occupy slots', () => {
  for (const limit of [MAX_PALETTE_THREADS, 5, 0]) {
    const conversations = Array.from({ length: 100 }, (_, index) => thread(String(index), [message(String(index), 'needle')], 'Notes', index)).reverse()
    for (const conversation of conversations.slice(limit)) Object.defineProperty(conversation, 'messages', { get() { throw new Error('searched beyond visible result slots') } })
    const job = search(conversations, 'needle', limit)
    job.flush()
    assert.deepEqual(job.updates.at(-1)?.matches.map((match) => match.conversation.id), Array.from({ length: limit }, (_, index) => String(99 - index)))
    assert.equal(job.updates.at(-1)?.complete, true)
  }
})

test('partial result snapshots are cumulative, immutable and stay in recency order', () => {
  const conversations = Array.from({ length: 40 }, (_, index) => thread(String(index), [message(String(index), 'needle')]))
  const job = search(conversations, 'needle')
  job.step()
  const partial = job.updates[0]!
  assert.equal(partial.complete, false)
  assert.ok(partial.matches.length > 0 && partial.matches.length < 40)
  const previousIds = partial.matches.map((match) => match.conversation.id)
  job.flush()
  assert.deepEqual(partial.matches.map((match) => match.conversation.id), previousIds)
  assert.deepEqual(job.updates.at(-1)?.matches.map((match) => match.conversation.id), conversations.map((conversation) => conversation.id))
})

test('cancelling before or between slices prevents queued callbacks from reading or publishing stale results', () => {
  const unread = thread('unread')
  Object.defineProperty(unread, 'messages', { get() { throw new Error('cancelled search was read') } })
  const before = search([unread], 'old query')
  const oldCallback = before.jobs[0]!.run
  before.cancel()
  before.flush()
  oldCallback({ timeRemaining: () => 50 })
  assert.deepEqual(before.updates, [])

  const conversations = Array.from({ length: 40 }, (_, index) => thread(String(index), [message(String(index), 'old query')]))
  const during = search(conversations, 'old query')
  during.step()
  const queued = during.jobs[0]!.run
  const updateCount = during.updates.length
  during.cancel()
  during.flush()
  queued({ timeRemaining: () => 50 })
  assert.equal(during.updates.length, updateCount)
  const replacement = search([thread('new', [message('new', 'new query')])], 'new query')
  replacement.flush()
  assert.deepEqual(replacement.updates.at(-1)?.matches.map((match) => match.conversation.id), ['new'])
})
