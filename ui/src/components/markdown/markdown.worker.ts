import { createBlockEncoder } from './blocks'
import { parseMarkdown } from './processor'
import type { ParseRequest } from './types'

const blocks = createBlockEncoder()
const running = new Map<string, { cancelled: boolean }>()
self.onmessage = (event: MessageEvent<ParseRequest | { release: string }>) => {
  const request = event.data
  if ('release' in request) {
    blocks.release(request.release)
    const job = running.get(request.release)
    if (job) job.cancelled = true
    return
  }
  const job = { cancelled: false }
  running.set(request.owner, job)
  void parseMarkdown(request.source, request.streaming).then(
    ({ tree, math }) => self.postMessage({ id: request.id, document: job.cancelled ? null : blocks.encode(request.owner, tree, math) }),
    () => self.postMessage({ id: request.id, document: null }),
  ).finally(() => { if (running.get(request.owner) === job) running.delete(request.owner) })
}
