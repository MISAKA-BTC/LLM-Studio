// The chat surface.
//
// Three behaviours here are worth more than they look:
//
// * **Auto-scroll that stops when you scroll up.** A view that yanks itself back to the bottom
//   while someone is reading the middle of a long answer is unusable; one that never follows the
//   stream is equally so. So it follows only while the user is already at the bottom.
// * **Editing a message re-runs from that point.** The turns after it answered a question that no
//   longer exists, so they go. The alternative — leaving them — produces a transcript the model
//   never actually produced.
// * **Stop keeps what was generated.** The user asked it to stop, not to undo.
//
// And one about layout: there is one composer, and it moves. An empty thread has it in the middle,
// under the question of what to ask; a thread with history has it at the bottom. The draft lives in
// `chat/composerStore`, per thread, so nothing typed is lost when it moves or when someone looks at
// another thread and comes back.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { startAgentRun, stopAgentRun, useAgent } from '../lib/agent/run'
import { useFileDrop } from '../lib/fileDrop'
import type { ChatMessage, Conversation } from '../lib/types'
import { useStudio } from '../store/studio'
import { useUi } from '../store/ui'
import { Icon } from './common'
import { ChatHeader } from './chat/ChatHeader'
import { Composer } from './chat/Composer'
import { attachFiles, draftKey } from './chat/composerStore'
import { EmptyHero } from './chat/EmptyHero'
import { busyConversation, useSendingIn } from './chat/followUps'
import type { TranscriptActions } from './chat/Message'
import { ParametersDrawer } from './chat/ParametersDrawer'
import { RightPanel } from './chat/RightPanel'
import { TranscriptCache, type TranscriptSnapshot } from './chat/TranscriptCache'
import type { TranscriptHandle, TranscriptScroll } from './chat/VirtualTranscript'

const NO_MESSAGES: ChatMessage[] = []
/** scrollTop may be fractional while the scroll height is rounded. */
const BOTTOM_EPSILON_PX = 2
type ScrollPosition = { top: number; following: boolean; atBottom: boolean; anchor?: { id: string; offset: number } }
// Reading positions outlive the three recently mounted transcripts. Bound this lightweight
// per-window history too, so opening many threads cannot retain unbounded UI state.
const scrollPositions = new Map<string, ScrollPosition>()
const MAX_SCROLL_POSITIONS = 128

function rememberScroll(key: string, position: ScrollPosition): void {
  const previous = scrollPositions.get(key)
  scrollPositions.delete(key)
  scrollPositions.set(key, { ...previous, ...position })
  if (scrollPositions.size > MAX_SCROLL_POSITIONS) scrollPositions.delete(scrollPositions.keys().next().value!)
}

/**
 * Whether another thread holds the engine. There is one live overlay and one request in flight; a
 * second request would take the overlay from the first, whose answer would then never be committed.
 */
function busyElsewhere(conversationId: string): boolean {
  const busy = busyConversation()
  return busy !== null && busy !== conversationId
}

/** The index of the last message the person typed (not a tool result), or -1. */
function lastTypedIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && !m.toolResults) return i
  }
  return -1
}

export function ChatView() {
  const conversation = useStudio((s) => s.conversations.find((c) => c.id === s.activeConversationId) ?? null)
  // The window only needs the live row's identity. Its text is subscribed to by that row alone.
  const streamingId = useStudio((s) => s.streaming?.conversationId === s.activeConversationId ? s.streaming.assistantId : null)
  const agentRunIn = useAgent((s) => s.run?.conversationId ?? null)
  const pendingApproval = useAgent((s) => s.pendingApproval)
  const sendingIn = useSendingIn()
  const appMode = useUi((s) => s.appMode)
  const threadKey = draftKey(conversation?.id, appMode)

  const messages = conversation?.messages ?? NO_MESSAGES
  // The pending reply is a render-only overlay. It joins the transcript exactly once, when the
  // request ends, and therefore can never leak an incomplete answer into the next model request.
  const rows = useMemo(() => {
    // A tool result is history the agent sends back to the model, not something the person wrote.
    const visibleMessages = messages.filter((m) => m.role !== 'system' && !(m.role === 'user' && m.toolResults))
    return streamingId && !visibleMessages.some((m) => m.id === streamingId)
      ? [...visibleMessages, { id: streamingId, role: 'assistant' as const, content: '', streaming: true }]
      : visibleMessages
  }, [messages, streamingId])
  const agent = conversation?.mode === 'agent'
  const generating = streamingId !== null || (conversation !== null && (agentRunIn === conversation.id || sendingIn === conversation.id))
  const empty = rows.length === 0
  const approvalMessage = useMemo(() => pendingApproval ? rows.find((message) => message.toolCalls?.some((call) => call.id === pendingApproval)) : undefined, [rows, pendingApproval])

  const [editingId, setEditingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastScrollTop = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const lastThreadKey = useRef<string | null>(null)
  const transcriptHandle = useRef<TranscriptHandle | null>(null)
  const transcriptScroll = useMemo<TranscriptScroll>(() => ({
    element: scrollRef,
    following: followRef,
    lastTop: lastScrollTop,
    handle: transcriptHandle,
    saved: (key) => scrollPositions.get(key),
    record: (key, position) => {
      const element = scrollRef.current
      rememberScroll(key, { ...position, atBottom: element ? element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_EPSILON_PX : position.following })
    },
  }), [])

  // The latest of what the transcript's actions read — so the actions themselves never change and
  // a memoised message is not redrawn for every token of the reply below it.
  const latest = useRef({ conversation, generating })
  latest.current = { conversation, generating }

  // A first visit follows the end. Returning to a thread (or revealing this Activity) restores
  // the reading position instead of rerunning a mount effect that jumps to the latest reply.
  useLayoutEffect(() => {
    const saved = scrollPositions.get(threadKey)
    followRef.current = saved?.following ?? true
    atBottomRef.current = saved?.atBottom ?? true
    setAtBottom(atBottomRef.current)
    if (lastThreadKey.current !== threadKey) setEditingId(null)
    lastThreadKey.current = threadKey
    const element = scrollRef.current
    if (element && empty) {
      element.scrollTop = followRef.current ? element.scrollHeight : saved?.top ?? 0
      lastScrollTop.current = element.scrollTop
    }
    return () => rememberScroll(threadKey, {
      top: lastScrollTop.current,
      following: followRef.current,
      atBottom: atBottomRef.current,
    })
  }, [threadKey])

  // The virtual transcript follows measured row heights itself; the empty hero only needs to
  // follow its composer as it grows. Neither path subscribes this component to token text.
  useEffect(() => {
    if (!empty) return
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (!followRef.current) return
      element.scrollTop = element.scrollHeight
      lastScrollTop.current = element.scrollTop
    })
    observer.observe(element)
    // The cache has one wrapper whose height follows its visible transcript. When empty, the
    // hero is its sibling; observe both so keeping hidden transcripts cannot break auto-scroll.
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [conversation?.id, empty])

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    const delta = element.scrollTop - lastScrollTop.current
    lastScrollTop.current = element.scrollTop
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_EPSILON_PX
    if (!bottom || delta < 0) followRef.current = false
    else if (delta > 0) followRef.current = true
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }

  const jumpToBottom = () => {
    const element = scrollRef.current
    if (!element) return
    followRef.current = true
    if (transcriptHandle.current) transcriptHandle.current.scrollToEnd()
    else element.scrollTop = element.scrollHeight
    lastScrollTop.current = element.scrollTop
    atBottomRef.current = true
    setAtBottom(true)
  }

  const follow = useCallback(() => {
    followRef.current = true
  }, [])

  const actions = useMemo<TranscriptActions>(() => {
    const toast = (text: string) => useStudio.getState().toast('info', text)
    const elsewhere = 'Another thread is still answering. Stop it there, or wait, then try again.'

    /** Agent threads re-run the agent: the message and everything after it go, and it runs again. */
    const rerunAgent = async (thread: Conversation, index: number, text: string) => {
      const original = thread.messages[index]
      if (!original) return
      if (useAgent.getState().run?.conversationId === thread.id) stopAgentRun()
      useStudio.getState().updateConversation(thread.id, (c) => ({ messages: c.messages.slice(0, index), updatedAt: Date.now() }))
      // The same words again (regenerate) were mined when they were first sent: the job carries
      // over rather than the prompt being queued a second time. Edited words are a new prompt.
      const same = text.trim() === original.content.trim() && original.mining
      await startAgentRun(thread.id, text, original.attachments, same ? { mining: original.mining } : {})
    }

    return {
      startEdit: (id) => setEditingId(id),
      cancelEdit: () => {
        setEditingId(null)
        useUi.getState().focusComposer()
      },
      saveEdit: (id, content) => {
        const thread = latest.current.conversation
        if (!thread) return
        if (busyElsewhere(thread.id)) return toast(elsewhere)
        setEditingId(null)
        useUi.getState().focusComposer()
        followRef.current = true
        const studio = useStudio.getState()
        // Stop keeps what was generated — but an edit replaces it, so the reply in flight stops first.
        if (studio.streaming?.conversationId === thread.id) studio.stop()
        if (thread.mode === 'agent' || thread.web) {
          void rerunAgent(thread, thread.messages.findIndex((m) => m.id === id), content.trim())
          return
        }
        void studio.editMessage(id, content)
      },
      regenerate: (hint = false) => {
        const { conversation: thread, generating: busy } = latest.current
        if (!thread || busy) return
        if (busyElsewhere(thread.id)) return toast(elsewhere)
        followRef.current = true
        useUi.getState().focusComposer()
        if (thread.mode === 'agent' || thread.web) {
          const index = lastTypedIndex(thread.messages)
          const original = thread.messages[index]
          if (original) void rerunAgent(thread, index, original.content)
          return
        }
        void useStudio.getState().regenerate(hint)
      },
      continueReply: () => {
        const { conversation: thread, generating: busy } = latest.current
        if (!thread || busy || thread.mode === 'agent' || thread.web) return
        if (busyElsewhere(thread.id)) return toast(elsewhere)
        followRef.current = true
        useUi.getState().focusComposer()
        void useStudio.getState().continueGeneration()
      },
    }
  }, [])

  const transcript = useMemo<TranscriptSnapshot>(() => ({ rows, agent, generating, editingId, actions }), [rows, agent, generating, editingId, actions])

  // ↑ in an empty composer: edit the last thing the person wrote.
  const editLast = useCallback(() => {
    const { conversation: thread, generating: busy } = latest.current
    if (!thread || busy) return
    const last = thread.messages[lastTypedIndex(thread.messages)]
    if (!last) return
    setEditingId(last.id)
    transcriptHandle.current?.scrollToMessage(last.id)
  }, [])

  // --- files dropped anywhere on the chat go to the composer --------------------------------------

  const { dragging, dropHandlers, dropRef } = useFileDrop({
    kind: 'text',
    onFiles: (files) => {
      void attachFiles(threadKey, files)
      useUi.getState().focusComposer()
    },
  })

  return (
    <div className="relative flex h-full min-w-0 bg-white dark:bg-ink-900">
      <div ref={dropRef} className="relative flex min-w-0 flex-1 flex-col" {...dropHandlers}>
        <ChatHeader conversation={conversation} generating={generating} />
        <ParametersDrawer />

        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} data-transcript-scroll onScroll={onScroll} onWheelCapture={(event) => {
            // Wheel input arrives before the scroll event, so the next token cannot undo it.
            if (event.deltaY < 0 && event.currentTarget.scrollHeight > event.currentTarget.clientHeight) {
              followRef.current = false
            }
          }} className="h-full overflow-y-auto" style={{ overflowAnchor: 'none' }}>
            <TranscriptCache threadKey={threadKey} active={!empty} snapshot={transcript} scroll={transcriptScroll} />
            {empty && (
              <EmptyHero conversation={conversation}>
                <Composer conversation={conversation} variant="hero" onSend={follow} />
              </EmptyHero>
            )}
          </div>

          {approvalMessage && pendingApproval && (
            <button
              type="button"
              className="absolute right-3 top-2.5 z-10 inline-flex items-center gap-1.5 rounded-[4px] border border-amber-400 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900 shadow-sm dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
              onClick={() => transcriptHandle.current?.scrollToMessage(approvalMessage.id, pendingApproval)}
            >
              <Icon name="shield" className="size-3.5" />
              Review pending approval
            </button>
          )}

          {!empty && !atBottom && (
            <button
              type="button"
              className="absolute bottom-3 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1 rounded-[4px] border border-ink-300 bg-ink-50 px-2.5 text-xs text-ink-700 shadow-md transition-colors hover:bg-white hover:text-ink-900 dark:border-[#454545] dark:bg-ink-850 dark:text-[#cccccc] dark:shadow-black/50 dark:hover:text-white"
              onClick={jumpToBottom}
              aria-label="Jump to the latest message"
              title="Jump to the latest message"
            >
              <Icon name="arrowDown" className="size-3.5" />
              <span>Latest</span>
            </button>
          )}
        </div>

        {!empty && (
          <div className="shrink-0 border-t border-ink-200/80 bg-ink-50/40 px-4 py-3 dark:border-ink-800 dark:bg-ink-950/30">
            <div className="mx-auto w-full max-w-[820px]">
              <Composer conversation={conversation} variant="dock" onSend={follow} onEditLast={editLast} />
            </div>
          </div>
        )}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-[6px] border border-dashed border-arc-500 bg-arc-500/5">
            <div className="flex flex-col items-center gap-1.5 rounded-[4px] border border-ink-300 bg-white px-5 py-3.5 text-center shadow-lg dark:border-[#454545] dark:bg-ink-850">
              <Icon name="upload" className="size-5 text-arc-600 dark:text-arc-400" />
              <span className="text-xs font-semibold">Drop to attach</span>
              <span className="text-[11px] text-ink-500 dark:text-ink-400">Text files, up to 200 KB each — never mined</span>
            </div>
          </div>
        )}
      </div>

      <RightPanel conversation={conversation} />
    </div>
  )
}
