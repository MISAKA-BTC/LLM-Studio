import { useCallback, useEffect, useMemo } from 'react'
import { createPollingResource } from '../../lib/polling'

/** A view owns its read work. Hidden windows and retained Activity views cancel the request. */
export function useVisiblePolling<T>(load: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, interval: number, fail?: (error: unknown) => void, enabled = true) {
  const resource = useMemo(() => createPollingResource(load), [load])
  useEffect(() => {
    if (!enabled) { resource.setVisible(false); return }
    let value = resource.getSnapshot().value
    let error = resource.getSnapshot().error
    const unlisten = resource.subscribe(() => {
      const state = resource.getSnapshot()
      if (state.reading) return
      if (state.error && state.error !== error) fail?.(state.error)
      else if (!state.error && state.value !== null && state.value !== value) accept(state.value)
      value = state.value
      error = state.error
    })
    const visibility = () => resource.setVisible(document.visibilityState !== 'hidden')
    const unwatch = resource.watch(interval)
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => { unlisten(); unwatch(); resource.setVisible(false); document.removeEventListener('visibilitychange', visibility) }
  }, [resource, accept, interval, fail, enabled])
  return useCallback(() => resource.refresh(), [resource])
}
