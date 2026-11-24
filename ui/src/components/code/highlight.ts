// A single lazily started worker and a bounded cache are shared by all file previews. A WebView
// without worker support still displays plain text; it never falls back to blocking the UI.
let worker: Worker | null = null
let unavailable = false
let nextId = 0
const pending = new Map<number, (html: string | null) => void>()
const inflight = new Map<string, Promise<string | null>>()
const cache = new Map<string, string | null>()
const MAX_ENTRIES = 16
const MAX_CACHE_CHARS = 2_000_000
let cacheChars = 0
const keyOf = (text: string, language: string) => `${language}\n${text}`

function remember(key: string, html: string | null) {
  if (cache.has(key)) cacheChars -= key.length + (cache.get(key)?.length ?? 0)
  cache.delete(key)
  cache.set(key, html)
  cacheChars += key.length + (html?.length ?? 0)
  while (cache.size > MAX_ENTRIES || cacheChars > MAX_CACHE_CHARS) {
    const oldest = cache.keys().next().value!
    cacheChars -= oldest.length + (cache.get(oldest)?.length ?? 0)
    cache.delete(oldest)
  }
}

export function cachedHighlight(text: string, language: string): string | null | undefined {
  const key = keyOf(text, language)
  const found = cache.get(key)
  if (found !== undefined) {
    cache.delete(key)
    cache.set(key, found)
  }
  return found
}

function getWorker(): Worker | null {
  if (unavailable) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; html: string | null }>) => {
      pending.get(event.data.id)?.(event.data.html)
      pending.delete(event.data.id)
    }
    worker.onerror = () => {
      unavailable = true
      worker?.terminate()
      worker = null
      for (const resolve of pending.values()) resolve(null)
      pending.clear()
    }
    return worker
  } catch {
    unavailable = true
    return null
  }
}

export function highlightFile(text: string, language: string): Promise<string | null> {
  const cached = cachedHighlight(text, language)
  if (cached !== undefined) return Promise.resolve(cached)
  const key = keyOf(text, language)
  const running = inflight.get(key)
  if (running) return running
  const parser = getWorker()
  if (!parser) return Promise.resolve(null)
  const request = new Promise<string | null>((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    try { parser.postMessage({ id, text, language }) }
    catch {
      pending.delete(id)
      resolve(null)
    }
  }).then((html) => {
    remember(key, html)
    return html
  }).finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}
