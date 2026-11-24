import { createLatestQueue } from './queue'
import { createBlockEncoder } from './blocks'
import type { MarkdownDocument, MarkdownInput, ParseResponse } from './types'

let worker: Worker | null = null
let unavailable = false
let plainOnly = false
let nextId = 0
const pending = new Map<number, { resolve: (document: MarkdownDocument | null) => void; reject: () => void; timer: ReturnType<typeof setTimeout> }>()
const lastByOwner = new Map<string, MarkdownDocument>()
const activeOwners = new Set<string>()
const completed = new Map<string, MarkdownDocument>()
const fallbackBlocks = createBlockEncoder()
let cacheWeight = 0
const MAX_CACHED_MESSAGES = 32
const MAX_CACHE_CHARS = 4_000_000
const MAX_FALLBACK_CHARS = 50_000
export const MARKDOWN_PARSE_TIMEOUT_MS = 30_000

function disableWorker(unresponsive = false): void {
  unavailable = true
  plainOnly ||= unresponsive
  worker?.terminate()
  worker = null
  // A new encoder's numeric ids must not accidentally reuse an old worker's unrelated tree.
  lastByOwner.clear()
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject()
  }
  pending.clear()
}

function getWorker(): Worker | null {
  if (unavailable) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      const request = pending.get(event.data.id)
      if (request) {
        clearTimeout(request.timer)
        request.resolve(event.data.document)
      }
      pending.delete(event.data.id)
    }
    worker.onerror = () => disableWorker()
    return worker
  } catch {
    unavailable = true
    return null
  }
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 500 })
    else setTimeout(resolve, 16)
  })
}

async function fallback(owner: string, input: MarkdownInput): Promise<MarkdownDocument | null> {
  // Plain text is already on screen. The compatibility parser is a separate chunk and runs only
  // after yielding input; it is never the ordinary first render of a message.
  // A broken/unsupported worker is no reason to parse an ever-growing stream on the UI thread.
  // Large answers remain readable as plain source in that compatibility mode as well.
  if (plainOnly || input.streaming || input.source.length > MAX_FALLBACK_CHARS) return null
  await idle()
  if (!activeOwners.has(owner)) return null
  try {
    const { parseMarkdown } = await import('./processor')
    await idle()
    if (!activeOwners.has(owner)) return null
    const { tree, math } = await parseMarkdown(input.source, input.streaming)
    return fallbackBlocks.encode(owner, tree, math)
  } catch { return null }
}

function reuseBlocks(owner: string, document: MarkdownDocument): MarkdownDocument {
  const previous = lastByOwner.get(owner)
  const blocks = document.blocks.map((block, index) => previous?.blocks[index]?.id === block.id ? previous.blocks[index]! : block)
  const result = { ...document, blocks }
  lastByOwner.set(owner, result)
  return result
}

const queue = createLatestQueue<MarkdownInput, MarkdownDocument>(async (owner, input) => {
  const parser = getWorker()
  let document: MarkdownDocument | null
  if (parser) {
    try {
      document = await new Promise<MarkdownDocument | null>((resolve, reject) => {
        const id = nextId++
        // A missing reply must not hold this window's parse queue forever. A timed-out input is
        // never retried on the UI thread: plain text remains available until the window restarts.
        const timer = setTimeout(() => disableWorker(true), MARKDOWN_PARSE_TIMEOUT_MS)
        pending.set(id, { resolve, reject: () => reject(new Error('Markdown worker unavailable')), timer })
        try { parser.postMessage({ id, owner, ...input }) }
        catch { disableWorker() }
      })
    } catch { document = await fallback(owner, input) }
  } else document = await fallback(owner, input)
  if (!activeOwners.has(owner)) {
    fallbackBlocks.release(owner)
    return null
  }
  return document ? reuseBlocks(owner, document) : null
})

export function cachedMarkdown(source: string): MarkdownDocument | null {
  const result = completed.get(source)
  if (!result) return null
  completed.delete(source)
  completed.set(source, result)
  return result
}

export function requestMarkdown(owner: string, source: string, streaming: boolean): Promise<MarkdownDocument | null> {
  activeOwners.add(owner)
  const cached = !streaming && cachedMarkdown(source)
  if (cached) return Promise.resolve(cached)
  return queue.request(owner, { source, streaming }, streaming ? 1 : 0).then((document) => {
    if (document && !streaming) {
      const before = completed.get(source)
      if (before) cacheWeight -= source.length + before.weight
      completed.delete(source)
      completed.set(source, document)
      cacheWeight += source.length + document.weight
      while (completed.size > MAX_CACHED_MESSAGES || cacheWeight > MAX_CACHE_CHARS) {
        const oldest = completed.keys().next().value!
        cacheWeight -= oldest.length + completed.get(oldest)!.weight
        completed.delete(oldest)
      }
    }
    return document
  })
}

export function releaseMarkdown(owner: string): void {
  activeOwners.delete(owner)
  queue.release(owner)
  lastByOwner.delete(owner)
  fallbackBlocks.release(owner)
  try { worker?.postMessage({ release: owner }) }
  catch { disableWorker() }
}
