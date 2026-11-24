// Prompt mining, as the window's chrome sees it: one poll, one summary.
//
// The status bar, the palette and the sidebar all say something about mining, and they must say
// the same thing. So the reading of the runtime's two mining sources — the queue (`miningQueue`,
// background mining) and the prompt stack (the node-free gateway + rail) — happens once, here,
// and every surface draws `miningSummary`.

import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { miningQueueResource, promptStackResource } from '../../lib/runtimeResources'
import { hasRecentLocalMining } from '../../lib/miningReconcile'
import type { createPollingResource } from '../../lib/polling'
import type { MiningQueueView, PromptStackView } from '../../lib/types'
import { useStudio } from '../../store/studio'

type PromptStackState = {
  /** Last successful read, retained while temporarily disconnected. */
  stack: PromptStackView | null
  error: string | null
}
export const usePromptStack = create<PromptStackState>(() => ({ stack: null, error: null }))

export function acceptPromptStack(stack: PromptStackView): void {
  if (usePromptStack.getState().stack !== stack) usePromptStack.setState({ stack, error: null })
}
export async function refreshPromptStack(): Promise<void> {
  const stack = await promptStackResource.refresh()
  if (stack) acceptPromptStack(stack)
}
export async function refreshMiningState(): Promise<void> {
  await Promise.all([refreshPromptStack(), useStudio.getState().refreshMining()])
}

const IDLE_MS = 15_000
const ACTIVE_MS = 5_000
const SETTLE_MS = 1_500
const LOCAL_PENDING_WINDOW_MS = 10 * 60_000

function jobsInFlight(): boolean {
  const { miningQueue, conversations } = useStudio.getState()
  if (miningQueue && miningQueue.counts.queued + miningQueue.counts.running > 0) return true
  return hasRecentLocalMining(conversations, Date.now(), LOCAL_PENDING_WINDOW_MS)
}
const cadence = () => jobsInFlight() ? ACTIVE_MS : IDLE_MS
const acceptQueue = (queue: MiningQueueView) => useStudio.getState().acceptMiningQueue(queue)
const stackFailed = (error: unknown) => usePromptStack.setState({ error: error instanceof Error ? error.message : String(error) })

/** All chrome and visible panels lease the same read service, with the fastest requested cadence. */
function useResourceLease<T>(resource: ReturnType<typeof createPollingResource<T>>, interval: number | (() => number), accept: (value: T) => void, fail?: (error: unknown) => void): void {
  useEffect(() => {
    let value = resource.getSnapshot().value
    let error = resource.getSnapshot().error
    const changed = () => {
      const snapshot = resource.getSnapshot()
      if (snapshot.reading) return
      if (snapshot.error && snapshot.error !== error) fail?.(snapshot.error)
      else if (!snapshot.error && snapshot.value !== null && snapshot.value !== value) accept(snapshot.value)
      value = snapshot.value
      error = snapshot.error
    }
    const unsubscribe = resource.subscribe(changed)
    const visibility = () => resource.setVisible(document.visibilityState !== 'hidden')
    visibility()
    const unwatch = resource.watch(interval)
    document.addEventListener('visibilitychange', visibility)
    return () => { unsubscribe(); unwatch(); document.removeEventListener('visibilitychange', visibility) }
  }, [resource, interval, accept, fail])
}

export function usePromptStackPolling(): void {
  useResourceLease(promptStackResource, ACTIVE_MS, acceptPromptStack, stackFailed)
}
export function useMiningQueuePolling(): void {
  useResourceLease(miningQueueResource, 10_000, acceptQueue)
}

/** One window service; Activity panel leases pause without duplicating the chrome's reads. */
export function useMiningPoll(): void {
  useResourceLease(promptStackResource, cadence, acceptPromptStack, stackFailed)
  useResourceLease(miningQueueResource, cadence, acceptQueue)
  useEffect(() => useStudio.subscribe((state, previous) => {
    if (state.conversations !== previous.conversations || state.miningQueue !== previous.miningQueue) {
      miningQueueResource.reschedule()
      promptStackResource.reschedule()
    }
    if (previous.streaming !== null && state.streaming === null) {
      miningQueueResource.soon(SETTLE_MS)
      promptStackResource.soon(SETTLE_MS)
    }
  }), [])
}

export type MiningSummary = {
  /**
   * What happens to the next prompt — the effective mode, not the setting:
   * - `inline`: the chat engine is the mining gateway, so the answer IS the mined work;
   * - `background`: the chat answers here and the prompt is queued and mined behind it;
   * - `off`: this chat's prompts are not mined.
   */
  mode: 'inline' | 'background' | 'off'
  /** The mode setting as written, which can say background while background is not in effect. */
  setting: MiningQueueView['mode'] | null
  /** Why background mining is not in effect, in the runtime's words. */
  blocker: string | null
  backgroundAvailable: boolean
  queued: number
  running: number
  committed: number
  /** Refused or failed: the lane said no, or the attempt broke. */
  notMined: number
  /** The node-free stack: gateway and rail both up. */
  stackRunning: boolean
  /** One of the two is up and the other is not — worth saying, it mines nothing that way. */
  stackPartial: boolean
  /** The runtime can start the stack as configured (its plan resolves). */
  stackReady: boolean
  /** Why it cannot, when it cannot. */
  stackProblem: string | null
  carriers: number
  /** Something is being mined right now: a queued job's turn, or an inline answer streaming. */
  busy: boolean
  /** Whether nothing has been read yet — the runtime has not answered either poll. */
  unknown: boolean
}

export function miningSummary(queue: MiningQueueView | null, stack: PromptStackView | null, backend: string | null | undefined, generating: boolean): MiningSummary {
  const inline = backend === 'gateway'
  const background = queue?.mode === 'background' && queue.background_available
  // Background wins when it is in effect: the runtime only reports it available when the chat is
  // answered by an engine other than the gateway, so the two cannot both be true of one prompt.
  const mode = background ? 'background' : inline ? 'inline' : 'off'
  const counts = queue?.counts ?? { queued: 0, running: 0, committed: 0, refused: 0, failed: 0 }
  const gateway = stack?.gateway.running ?? false
  const rail = stack?.rail.running ?? false
  return {
    mode,
    setting: queue?.mode ?? null,
    blocker: queue && !queue.background_available ? queue.background_blocker : null,
    backgroundAvailable: queue?.background_available ?? false,
    queued: counts.queued,
    running: counts.running,
    committed: counts.committed,
    notMined: counts.refused + counts.failed,
    stackRunning: gateway && rail,
    stackPartial: gateway !== rail,
    stackReady: stack !== null && 'Ok' in stack.planned,
    stackProblem: stack !== null && 'Err' in stack.planned ? stack.planned.Err : null,
    carriers: stack?.carriers.length ?? 0,
    busy: counts.running > 0 || (mode === 'inline' && generating),
    unknown: queue === null && stack === null,
  }
}

/** The summary, live. Re-renders only when what it says changes, not on every token. */
export function useMiningSummary(): MiningSummary {
  const queue = useStudio((s) => s.miningQueue)
  const backend = useStudio((s) => s.runtime?.backend)
  const generating = useStudio((s) => s.streaming !== null)
  const stack = usePromptStack((s) => s.stack)
  return useMemo(() => miningSummary(queue, stack, backend, generating), [queue, stack, backend, generating])
}

export const MINING_MODE_LABEL: Record<MiningSummary['mode'], string> = {
  inline: 'Inline',
  background: 'Background',
  off: 'Off',
}
