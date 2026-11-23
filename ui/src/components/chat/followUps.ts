import { create } from 'zustand'
import { activeAgentConversation, startAgentRun, useAgent } from '../../lib/agent/run'
import { isWebTask } from '../../lib/web'
import { uid, useStudio } from '../../store/studio'
import type { Draft } from './composerStore'

type FollowUp = Draft & { id: string; afterMessageId?: string; paused?: boolean }
const EMPTY: FollowUp[] = []

const useFollowUpStore = create<{
  queues: Record<string, FollowUp[]>
  sendingIn: string | null
}>(() => ({ queues: {}, sendingIn: null }))

export function useFollowUps(conversationId: string | undefined) {
  return useFollowUpStore((s) => (conversationId && s.queues[conversationId]) || EMPTY)
}

export function useSendingIn() {
  return useFollowUpStore((s) => s.sendingIn)
}

export function busyConversation(): string | null {
  return useFollowUpStore.getState().sendingIn ?? activeAgentConversation() ?? useStudio.getState().streaming?.conversationId ?? null
}

function updateQueue(conversationId: string, update: (items: FollowUp[]) => FollowUp[]) {
  useFollowUpStore.setState(({ queues }) => {
    const items = update(queues[conversationId] ?? EMPTY)
    const next = { ...queues }
    if (items.length) next[conversationId] = items
    else delete next[conversationId]
    return { queues: next }
  })
}

export function queueFollowUp(conversationId: string, draft: Draft) {
  const thread = useStudio.getState().conversations.find((c) => c.id === conversationId)
  if (!thread) return
  const item = { ...draft, id: uid(), afterMessageId: thread.messages[0]?.id }
  updateQueue(conversationId, (items) => [...items, item])
  scheduleDrain()
  return item.id
}

export function removeFollowUp(conversationId: string, id: string) {
  updateQueue(conversationId, (items) => items.filter((item) => item.id !== id))
  scheduleDrain()
}

export function retryFollowUp(conversationId: string, id: string) {
  updateQueue(conversationId, (items) => items.map((item) => (item.id === id ? { ...item, paused: false } : item)))
  scheduleDrain()
}

export async function sendFromComposer(conversationId: string, { text, attachments }: Draft, onRefused?: () => void) {
  const studio = useStudio.getState()
  const thread = studio.conversations.find((c) => c.id === conversationId)
  if (!thread) return
  useFollowUpStore.setState({ sendingIn: conversationId })
  try {
    const files = attachments.length ? attachments : undefined
    if (thread.mode === 'agent' || isWebTask(text) || thread.web) {
      await startAgentRun(conversationId, text.trim(), files, { onRefused })
    } else {
      await studio.send(text, files, conversationId)
    }
  } catch (error) {
    onRefused?.()
    studio.toast('error', (error as Error).message)
  } finally {
    useFollowUpStore.setState({ sendingIn: null })
    scheduleDrain()
  }
}

// Drain independently of the visible composer. Wait until both the agent and its stream have
// committed their last messages. Once a send claims the slot, keep it through async preparation.
let scheduled = false
function scheduleDrain() {
  if (scheduled || Object.keys(useFollowUpStore.getState().queues).length === 0) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const studio = useStudio.getState()
    for (const [id, items] of Object.entries(useFollowUpStore.getState().queues)) {
      const thread = studio.conversations.find((c) => c.id === id)
      // Clearing or deleting the source transcript also removes its pending follow-ups.
      const valid = thread ? items.filter((item) => !item.afterMessageId || thread.messages.some((m) => m.id === item.afterMessageId)) : EMPTY
      if (valid.length !== items.length) updateQueue(id, () => valid)
      const item = valid[0]
      if (!studio.connected || busyConversation() || !item || item.paused) continue
      updateQueue(id, (items) => items.slice(1))
      const pause = () => updateQueue(id, (items) => [{ ...item, paused: true }, ...items])
      void sendFromComposer(id, item, pause)
      break
    }
  })
}

useStudio.subscribe((state, previous) => {
  if (state.streaming?.conversationId !== previous.streaming?.conversationId || state.connected !== previous.connected || state.conversations !== previous.conversations) {
    scheduleDrain()
  }
})
useAgent.subscribe(scheduleDrain)
