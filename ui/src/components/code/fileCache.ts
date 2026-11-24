// File bytes and a bounded set of in-flight reads belong to the workspace, not to a mounted
// viewer. A panel can resume an almost finished read, while rapid selections do not leave the
// newest preview behind an unbounded queue of obsolete reads.
import { api } from '../../lib/api'
import type { WorkspaceFile } from '../../lib/types'

export const VIEW_MAX_BYTES = 512 * 1024
type Position = { top: number; left: number }
type Entry = { file: WorkspaceFile; position: Position; stale?: boolean }
type ReadFile = (root: string, path: string, signal: AbortSignal) => Promise<WorkspaceFile>
type Pending = { request: Promise<WorkspaceFile>; controller: AbortController }

const cancellationError = (signal: AbortSignal) => signal.reason ?? new DOMException('File read cancelled', 'AbortError')
function checkCancelled(signal: AbortSignal): void {
  // The desktop supports WebViews older than AbortSignal.throwIfAborted/reason.
  if (signal.aborted) throw cancellationError(signal)
}

export function createFileCache(read: ReadFile, limit = 12, pendingLimit = 2) {
  const files = new Map<string, Entry>()
  const pending = new Map<string, Pending>()
  const maxPending = Math.max(1, Math.floor(pendingLimit))
  const keyOf = (root: string, path: string) => JSON.stringify([root, path])

  const peek = (root: string, path: string): Entry | undefined => {
    const key = keyOf(root, path)
    const entry = files.get(key)
    if (entry) {
      files.delete(key)
      files.set(key, entry)
    }
    return entry
  }

  return {
    peek,
    read(root: string, path: string, force = false): Promise<WorkspaceFile> {
      const key = keyOf(root, path)
      if (!force) {
        const running = pending.get(key)
        if (running) {
          // Returning to an existing request makes it current again; evict the least recently
          // requested pending file, not a shared request the user just selected.
          pending.delete(key)
          pending.set(key, running)
          return running.request
        }
        const cached = peek(root, path)
        if (cached && !cached.stale) return Promise.resolve(cached.file)
      }
      // Keep the last display/scroll position while refreshing, but a cancelled refresh must
      // not make a later read silently accept those old bytes as a fresh response.
      const cached = files.get(key)
      if (force && cached) cached.stale = true
      const previous = pending.get(key)
      pending.delete(key)
      previous?.controller.abort()
      const controller = new AbortController()
      let abort: () => void
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(cancellationError(controller.signal))
        controller.signal.addEventListener('abort', abort, { once: true })
      })
      const transport = Promise.resolve().then(() => {
        // An invalidation/selection can cancel this read before it has even been dispatched.
        checkCancelled(controller.signal)
        return read(root, path, controller.signal)
      })
      const request = Promise.race([transport, cancelled]).then((file) => {
        checkCancelled(controller.signal)
        // A later refresh or invalidation owns the cache now; an older response cannot undo it.
        if (pending.get(key)?.request === request) {
          const position = files.get(key)?.position ?? { top: 0, left: 0 }
          files.delete(key)
          files.set(key, { file, position })
          while (files.size > limit) files.delete(files.keys().next().value!)
        }
        return file
      }).finally(() => {
        controller.signal.removeEventListener('abort', abort)
        if (pending.get(key)?.request === request) pending.delete(key)
      })
      pending.set(key, { request, controller })
      while (pending.size > maxPending) {
        const [oldKey, old] = pending.entries().next().value!
        pending.delete(oldKey)
        old.controller.abort()
      }
      return request
    },
    rememberPosition(root: string, path: string, position: Position): void {
      const entry = files.get(keyOf(root, path))
      if (entry) entry.position = position
    },
    invalidate(root: string): void {
      for (const key of files.keys()) {
        if ((JSON.parse(key) as [string, string])[0] === root) files.delete(key)
      }
      for (const [key, entry] of pending) {
        if ((JSON.parse(key) as [string, string])[0] !== root) continue
        pending.delete(key)
        entry.controller.abort()
      }
    },
  }
}

export const fileCache = createFileCache((root, path, signal) => api.workspace.read(root, path, { max_bytes: VIEW_MAX_BYTES }, signal))
