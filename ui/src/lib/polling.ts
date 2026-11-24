// A shared read service: one request and one timer, regardless of the number of views.
// Inspired by VS Code's Throttler/RunOnceScheduler: repeated refreshes during an active read
// request one trailing read; releasing or hiding a service cancels work that is no longer useful.
export type PollSnapshot<T> = { value: T | null; error: unknown; reading: boolean; updatedAt: number }
export type PollClock = { now: () => number; set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void }
const clock: PollClock = { now: Date.now, set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) }

export function createPollingResource<T>(load: (signal: AbortSignal) => Promise<T>, time: PollClock = clock) {
  let snapshot: PollSnapshot<T> = { value: null, error: null, reading: false, updatedAt: 0 }
  let active: { controller: AbortController; promise: Promise<T | null> } | null = null
  let trailing: { promise: Promise<T | null>; resolve: (value: T | null) => void } | null = null
  let timer: unknown = null
  let visible = true
  const listeners = new Set<() => void>()
  const watchers = new Map<symbol, () => number>()
  const publish = (next: PollSnapshot<T>) => { snapshot = next; for (const listener of listeners) listener() }
  const clearTimer = () => { if (timer !== null) time.clear(timer); timer = null }
  const cadence = () => Math.max(100, Math.min(...[...watchers.values()].map((read) => read())))
  function schedule() {
    clearTimer()
    if (!visible || !watchers.size || active) return
    const wait = Math.max(0, snapshot.updatedAt + cadence() - time.now())
    timer = time.set(() => { timer = null; void start() }, wait)
  }
  function stop() {
    clearTimer()
    const old = active
    active = null
    old?.controller.abort()
    trailing?.resolve(null)
    trailing = null
    if (snapshot.reading) publish({ ...snapshot, reading: false })
  }
  function start(): Promise<T | null> {
    if (active) return active.promise
    if (!visible) return Promise.resolve(null)
    clearTimer()
    const controller = new AbortController()
    const request = { controller, promise: Promise.resolve<T | null>(null) }
    let onAbort!: () => void
    const cancelled = new Promise<null>((resolve) => { onAbort = () => resolve(null); controller.signal.addEventListener('abort', onAbort, { once: true }) })
    active = request
    const read = Promise.resolve().then(() => controller.signal.aborted ? null : load(controller.signal))
    request.promise = Promise.race([read, cancelled]).then((value) => {
      if (active !== request || controller.signal.aborted || trailing) return null
      publish({ value, error: null, reading: false, updatedAt: time.now() })
      return value
    }, (error: unknown) => {
      if (active === request && !controller.signal.aborted && !trailing) publish({ ...snapshot, error, reading: false, updatedAt: time.now() })
      return null
    }).finally(() => {
      controller.signal.removeEventListener('abort', onAbort)
      if (active !== request) return
      active = null
      const next = trailing
      trailing = null
      if (next) void start().then(next.resolve)
      else schedule()
    })
    publish({ ...snapshot, reading: true })
    return request.promise
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** A visible consumer leases a cadence. More consumers share the existing timer/read. */
    watch(interval: number | (() => number)) {
      const key = Symbol()
      const first = watchers.size === 0
      watchers.set(key, typeof interval === 'number' ? () => interval : interval)
      if (first && (snapshot.value === null || time.now() - snapshot.updatedAt >= cadence())) void start()
      else schedule()
      return () => { watchers.delete(key); if (!watchers.size) stop(); else schedule() }
    },
    /** Explicit refresh after a mutation must run after an older active read, not reuse it. */
    refresh(): Promise<T | null> {
      if (!active) return start()
      if (!trailing) {
        let resolve!: (value: T | null) => void
        const promise = new Promise<T | null>((done) => { resolve = done })
        trailing = { promise, resolve }
      }
      return trailing.promise
    },
    setVisible(next: boolean) {
      if (visible === next) return
      visible = next
      if (!visible) stop()
      else if (watchers.size) void start()
    },
    /** Reevaluate a dynamic cadence after state changes without making a duplicate request. */
    reschedule: schedule,
    /** Advance the next background read, for completion events. */
    soon(ms: number) {
      if (!visible || !watchers.size || active) return
      clearTimer()
      timer = time.set(() => { timer = null; void start() }, Math.min(Math.max(0, ms), Math.max(0, snapshot.updatedAt + cadence() - time.now())))
    },
    dispose() { watchers.clear(); stop(); listeners.clear() },
  }
}
