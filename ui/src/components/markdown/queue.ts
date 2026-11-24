// One running parse, and at most the newest waiting parse for each mounted message. In particular,
// a fast token stream cannot leave a worker processing hundreds of obsolete full-message copies.
type Job<Input, Output> = { owner: string; input: Input; priority: number; resolve: (value: Output | null) => void; cancelled: boolean }

export function createLatestQueue<Input, Output>(run: (owner: string, input: Input) => Promise<Output | null>) {
  const waiting = new Map<string, Job<Input, Output>>()
  let active: Job<Input, Output> | null = null

  const drain = () => {
    if (active || waiting.size === 0) return
    let next: Job<Input, Output> | undefined
    for (const candidate of waiting.values()) if (!next || candidate.priority > next.priority) next = candidate
    if (!next) return
    waiting.delete(next.owner)
    const job = next
    active = job
    void Promise.resolve().then(() => run(job.owner, job.input)).then(
      (value) => { if (!job.cancelled) job.resolve(value) },
      () => { if (!job.cancelled) job.resolve(null) },
    ).finally(() => {
      active = null
      drain()
    })
  }

  return {
    request(owner: string, input: Input, priority = 0): Promise<Output | null> {
      waiting.get(owner)?.resolve(null)
      const promise = new Promise<Output | null>((resolve) => waiting.set(owner, { owner, input, priority, resolve, cancelled: false }))
      drain()
      return promise
    },
    release(owner: string): void {
      waiting.get(owner)?.resolve(null)
      waiting.delete(owner)
      if (active?.owner === owner) {
        active.cancelled = true
        active.resolve(null)
      }
    },
    /** Observable work counts for regression tests; no source text or message content is exposed. */
    size: () => ({ running: active ? 1 : 0, waiting: waiting.size }),
  }
}
