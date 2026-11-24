/** Coalesce render-only snapshots; the producer still consumes every event immediately. */
export function createFrameBatch<T extends object>(
  publish: (patch: Partial<T>) => void,
  schedule: (callback: () => void) => () => void = scheduleFrame,
) {
  let pending: Partial<T> | null = null
  let cancel: (() => void) | null = null

  const flush = () => {
    cancel?.()
    cancel = null
    const patch = pending
    pending = null
    if (patch) publish(patch)
  }

  return {
    push(patch: Partial<T>) {
      pending = { ...pending, ...patch }
      cancel ??= schedule(flush)
    },
    // Completion and Stop flush synchronously, including when background tabs suspend frames.
    flush,
  }
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(callback)
    return () => cancelAnimationFrame(frame)
  }
  const timer = setTimeout(callback, 16)
  return () => clearTimeout(timer)
}
