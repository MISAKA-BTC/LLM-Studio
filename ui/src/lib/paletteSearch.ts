import { findSnippet, foldCase, fuzzyMatch, queryWords, type Range, type Snippet } from './fuzzy.ts'
import type { ChatMessage, Conversation } from './types.ts'

export const MAX_PALETTE_THREADS = 40
const MIN_TITLE_QUALITY = 0.45
const SEARCH_SLICE_MS = 4
const SEARCH_SLICE_STEPS = 32

export type ThreadTitleMatch = { conversation: Conversation; ranges: Range[]; score: number }
export type ThreadContentMatch = { conversation: Conversation; snippet: Snippet }
export type ThreadSearchPlan = {
  query: string
  words: string[]
  /** Sorted once per conversation snapshot, not once per keypress. */
  byRecency: readonly Conversation[]
  titles: ThreadTitleMatch[]
  candidates: Conversation[]
}

/** Only names are read on the input/render path. A title match must be excluded from body
 *  searching even if the command palette's relative score floor later hides that title. */
export function planThreadSearch(
  byRecency: readonly Conversation[],
  query: string,
  labelFor: (conversation: Conversation) => string,
): ThreadSearchPlan {
  const words = queryWords(query)
  const plan: ThreadSearchPlan = { query, words, byRecency, titles: [], candidates: [] }
  if (words.length === 0) return plan
  const whole = words.join(' ')
  for (const conversation of byRecency) {
    const label = labelFor(conversation)
    const title = fuzzyMatch(query, label, { minQuality: MIN_TITLE_QUALITY })
    if (title) {
      plan.titles.push({ conversation, ranges: title.ranges, score: title.score + 0.25 })
      continue
    }
    // Scripts without word breaks retain the palette's literal-title fallback.
    const at = foldCase(label).indexOf(whole)
    if (at >= 0) {
      plan.titles.push({ conversation, ranges: [[at, at + whole.length]], score: 0.5 })
      continue
    }
    if (whole.length >= 2) plan.candidates.push(conversation)
  }
  return plan
}

export type SearchDeadline = { timeRemaining: () => number }
/** Schedules a later task and returns its cancellation function. */
export type SearchScheduler = (task: (deadline: SearchDeadline) => void) => () => void

const scheduleSearchSlice: SearchScheduler = (task) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const id = globalThis.requestIdleCallback(task, { timeout: 100 })
    return () => globalThis.cancelIdleCallback(id)
  }
  // A task (rather than a microtask) lets keystrokes and paint run between slices in webviews
  // without requestIdleCallback. The scan also enforces its own time and step budgets.
  const id = globalThis.setTimeout(() => task({ timeRemaining: () => SEARCH_SLICE_MS }), 0)
  return () => globalThis.clearTimeout(id)
}

const foldedContent = new WeakMap<ChatMessage, string>()
function folded(message: ChatMessage): string {
  let value = foldedContent.get(message)
  if (value === undefined) {
    value = foldCase(message.content)
    foldedContent.set(message, value)
  }
  return value
}

/** Search oldest-to-newest messages within each thread, and threads in the supplied recency
 *  order, exactly as the synchronous palette did. Work yields between bounded batches and
 *  stops as soon as the visible result slots are full. Cancellation also guards an idle
 *  callback that was already queued when the query changed or the palette closed. */
export function searchThreadContents(
  candidates: readonly Conversation[],
  query: string,
  onUpdate: (matches: readonly ThreadContentMatch[], complete: boolean) => void,
  options: { limit?: number; schedule?: SearchScheduler; now?: () => number } = {},
): () => void {
  const schedule = options.schedule ?? scheduleSearchSlice
  const now = options.now ?? (() => performance.now())
  const limit = Math.max(0, Math.min(MAX_PALETTE_THREADS, Math.floor(options.limit ?? MAX_PALETTE_THREADS)))
  const searchable = queryWords(query).join(' ').length >= 2
  const matches: ThreadContentMatch[] = []
  let conversationIndex = 0
  let messageIndex = 0
  let cancelled = false
  let cancelScheduled: (() => void) | null = null

  const scan = (deadline: SearchDeadline) => {
    cancelScheduled = null
    if (cancelled) return
    const started = now()
    const previousCount = matches.length
    let steps = 0
    while (searchable && conversationIndex < candidates.length && matches.length < limit) {
      // Always make one step when an idle callback times out, but never monopolize a task.
      if (steps > 0 && (steps >= SEARCH_SLICE_STEPS || now() - started >= SEARCH_SLICE_MS || deadline.timeRemaining() <= 1)) break
      steps++
      const conversation = candidates[conversationIndex]!
      const message = conversation.messages[messageIndex++]
      if (!message) {
        conversationIndex++
        messageIndex = 0
        continue
      }
      if (message.toolResults || message.role === 'system' || !message.content) continue
      const snippet = findSnippet(message.content, query, { folded: folded(message) })
      if (snippet) {
        matches.push({ conversation, snippet })
        conversationIndex++
        messageIndex = 0
      }
    }
    const complete = !searchable || conversationIndex >= candidates.length || matches.length >= limit
    if (complete || matches.length !== previousCount) onUpdate([...matches], complete)
    if (!complete && !cancelled) cancelScheduled = schedule(scan)
  }
  cancelScheduled = schedule(scan)
  return () => {
    cancelled = true
    cancelScheduled?.()
    cancelScheduled = null
  }
}
