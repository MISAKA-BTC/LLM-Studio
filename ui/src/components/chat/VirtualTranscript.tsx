import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { splitThinking } from '../../lib/reasoning'
import type { ChatMessage } from '../../lib/types'
import { captureTranscriptAnchor, TranscriptHeights, transcriptWindow } from '../../lib/transcriptWindow'
import { useStudio } from '../../store/studio'
import { Message } from './Message'
import type { TranscriptSnapshot } from './TranscriptCache'

export type TranscriptHandle = {
  scrollToEnd: () => void
  scrollToMessage: (id: string, approvalId?: string) => void
}

export type TranscriptScroll = {
  element: RefObject<HTMLDivElement | null>
  following: { current: boolean }
  lastTop: { current: number }
  handle: { current: TranscriptHandle | null }
  saved: (key: string) => { top: number; following: boolean; anchor?: { id: string; offset: number } } | undefined
  record: (key: string, position: { top: number; following: boolean; anchor?: { id: string; offset: number } }) => void
}

type Measurement = { message: ChatMessage; width: number; height: number }
type Geometry = { heights: TranscriptHeights; rows: ChatMessage[]; indices: Map<string, number> }
type Anchor = { id: string; offset: number; beforeTop: number }
const PADDING = 24
const DEFAULT_VIEWPORT = 600

function estimateHeight(message: ChatMessage, width: number): number {
  const columns = Math.max(25, Math.floor(width / 8))
  const inline = splitThinking(message.content)
  const reasoningText = message.reasoning ?? inline.thinking
  // Finished reasoning blocks render collapsed as a single ~32px summary row; counting all
  // reasoning characters inflated collapsed turns by thousands of pixels on resize.
  const reasoningHeight = reasoningText
    ? message.streaming
      ? Math.min(360, 36 + Math.ceil(reasoningText.length / columns) * 20)
      : 36
    : 0
  const text = inline.answer.length
  return Math.min(16_000, 88 + reasoningHeight + Math.ceil(text / columns) * 23 + (message.toolCalls?.length ?? 0) * 96)
}

function predictedRowHeight(message: ChatMessage, measured: Measurement | undefined, width: number): number {
  if (measured?.message === message && measured.height > 0) {
    if (Math.abs(measured.width - width) < 2) return measured.height
    if (measured.width > 0 && width > 0) {
      const ratio = Math.min(1.35, Math.max(0.72, measured.width / width))
      return Math.max(40, Math.round(measured.height * ratio))
    }
    return measured.height
  }
  return estimateHeight(message, width)
}

function anchorAt(geometry: Geometry, top: number): Anchor | null {
  const anchor = captureTranscriptAnchor(geometry.heights, Math.max(0, top - PADDING))
  const row = geometry.rows[anchor.index]
  return row ? { id: row.id, offset: anchor.offset, beforeTop: top } : null
}

function anchoredTop(geometry: Geometry, anchor: Anchor | null, fallback: number): number {
  const index = anchor ? geometry.indices.get(anchor.id) : undefined
  return index === undefined || !anchor ? fallback : PADDING + geometry.heights.top(index) + anchor.offset
}

/** Variable-height rows: only the viewport, a small overscan, and an open edit have DOM. */
export const VirtualTranscript = memo(function VirtualTranscript({ threadKey, active, snapshot, scroll }: {
  threadKey: string
  active: boolean
  snapshot: TranscriptSnapshot
  scroll: TranscriptScroll
}) {
  const { rows, editingId } = snapshot
  const measurements = useRef(new Map<string, Measurement>())
  const initialWidth = Math.round(Math.max(200, Math.min(760, scroll.element.current?.clientWidth || 760) - 32))
  const [width, setWidth] = useState(initialWidth)
  const geometry = useMemo<Geometry>(() => {
    const indices = new Map(rows.map((message, index) => [message.id, index]))
    // Deleted/edited turns must not leave an unbounded measurement cache behind.
    for (const key of measurements.current.keys()) if (!indices.has(key)) measurements.current.delete(key)
    return {
      rows,
      indices,
      heights: new TranscriptHeights(rows.map((message) => predictedRowHeight(message, measurements.current.get(message.id), width))),
    }
  }, [rows, width])
  const [viewport, setViewport] = useState(() => ({
    top: scroll.saved(threadKey)?.following === false ? scroll.saved(threadKey)!.top : Math.max(0, geometry.heights.total + PADDING * 2 - DEFAULT_VIEWPORT),
    height: scroll.element.current?.clientHeight || DEFAULT_VIEWPORT,
  }))
  const [revision, setRevision] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const elements = useRef(new Map<string, HTMLDivElement>())
  const observer = useRef<ResizeObserver | null>(null)
  const ready = useRef(false)
  const current = useRef({ geometry, viewport, width })
  current.current = { geometry, viewport, width }
  const committed = useRef(geometry)
  const pendingAnchor = useRef<Anchor | null>(null)
  const pendingFocus = useRef<{ messageId: string; approvalId: string } | null>(null)

  const getScroll = useCallback(() => scroll.element.current ?? list.current?.closest<HTMLDivElement>('[data-transcript-scroll]') ?? null, [scroll])
  const readViewport = useCallback(() => {
    const element = getScroll()
    if (!element) return
    const next = { top: element.scrollTop, height: element.clientHeight || DEFAULT_VIEWPORT }
    const anchor = anchorAt(current.current.geometry, next.top)
    scroll.record(threadKey, { top: next.top, following: scroll.following.current, ...(anchor ? { anchor: { id: anchor.id, offset: anchor.offset } } : {}) })
    setViewport((before) => before.top === next.top && before.height === next.height ? before : next)
    const measuredWidth = Math.round(list.current?.getBoundingClientRect().width ?? 0)
    if (measuredWidth > 0) setWidth((before) => Math.abs(before - measuredWidth) < 2 ? before : measuredWidth)
  }, [getScroll, scroll, threadKey])
  const applyTop = useCallback((top: number) => {
    const element = getScroll()
    if (!element) return
    const height = element.clientHeight || DEFAULT_VIEWPORT
    const max = Math.max(0, current.current.geometry.heights.total + PADDING * 2 - height)
    element.scrollTop = Math.max(0, Math.min(top, max))
    // The resulting native scroll event is a layout correction, not the person scrolling up.
    scroll.lastTop.current = element.scrollTop
    readViewport()
  }, [getScroll, readViewport, scroll])

  const measureElements = useCallback((nodes: Iterable<HTMLDivElement>) => {
    if (!ready.current) return
    const element = getScroll()
    if (!element) return
    const { geometry: layout } = current.current
    const liveWidth = Math.round(list.current?.getBoundingClientRect().width || current.current.width)
    let changed = false
    const anchor = pendingAnchor.current ?? anchorAt(layout, element.scrollTop)
    for (const node of nodes) {
      const id = node.dataset.virtualRow
      const index = id ? layout.indices.get(id) : undefined
      if (index === undefined) continue
      const height = node.getBoundingClientRect().height
      // display:none (Activity) and DOM test environments report zero: neither is a row height.
      if (height <= 0) continue
      measurements.current.set(id!, { message: layout.rows[index]!, width: liveWidth, height })
      if (layout.heights.measure(index, height)) changed = true
    }
    if (changed) {
      pendingAnchor.current = anchor
      setRevision((value) => value + 1)
    }
  }, [getScroll])

  const register = useCallback((id: string, node: HTMLDivElement) => {
    elements.current.set(id, node)
    observer.current?.observe(node)
    measureElements([node])
    return () => {
      observer.current?.unobserve(node)
      if (elements.current.get(id) === node) elements.current.delete(id)
    }
  }, [measureElements])

  useLayoutEffect(() => {
    if (!active) return
    const element = getScroll()
    if (!element) return
    ready.current = true
    const saved = scroll.saved(threadKey)
    scroll.following.current = saved?.following ?? true
    const handle: TranscriptHandle = {
      scrollToEnd() {
        scroll.following.current = true
        applyTop(current.current.geometry.heights.total + PADDING * 2)
      },
      scrollToMessage(id, approvalId) {
        const index = current.current.geometry.indices.get(id)
        if (index === undefined) return
        scroll.following.current = false
        pendingFocus.current = approvalId ? { messageId: id, approvalId } : null
        applyTop(PADDING + current.current.geometry.heights.top(index))
        if (approvalId) setRevision((value) => value + 1)
      },
    }
    scroll.handle.current = handle
    const restoredAnchor = saved?.anchor ? { ...saved.anchor, beforeTop: saved.top } : null
    applyTop(scroll.following.current ? current.current.geometry.heights.total + PADDING * 2 : anchoredTop(current.current.geometry, restoredAnchor, saved?.top ?? viewport.top))
    if (restoredAnchor && !scroll.following.current) pendingAnchor.current = { ...restoredAnchor, beforeTop: element.scrollTop }

    let frame: number | null = null
    const onScroll = () => {
      if (Math.abs(element.scrollTop - scroll.lastTop.current) >= 1) pendingAnchor.current = null
      if (frame !== null) return
      frame = requestAnimationFrame(() => { frame = null; readViewport() })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver((entries) => {
      const liveWidth = Math.round(list.current?.getBoundingClientRect().width ?? 0)
      if (liveWidth > 0 && Math.abs(liveWidth - current.current.width) >= 2) {
        // Column width changed (e.g. toggling a side panel). Capture the reading anchor from the
        // untouched previous geometry and record every mounted row's reflowed DOM height under
        // `liveWidth` BEFORE rebuilding `geometry`, so the next render has exact heights immediately.
        const { geometry: prevGeometry } = current.current
        if (!pendingAnchor.current) pendingAnchor.current = anchorAt(prevGeometry, element.scrollTop)
        for (const node of elements.current.values()) {
          const id = node.dataset.virtualRow
          const index = id ? prevGeometry.indices.get(id) : undefined
          if (index === undefined) continue
          const height = node.getBoundingClientRect().height
          if (height > 0) measurements.current.set(id!, { message: prevGeometry.rows[index]!, width: liveWidth, height })
        }
        readViewport()
        return
      }
      readViewport()
      measureElements(entries.flatMap((entry) => (entry.target as HTMLDivElement).dataset.virtualRow ? [entry.target as HTMLDivElement] : []))
    })
    observer.current = resize
    resize.observe(element)
    if (list.current) resize.observe(list.current)
    for (const node of elements.current.values()) resize.observe(node)
    measureElements(elements.current.values())
    return () => {
      ready.current = false
      element.removeEventListener('scroll', onScroll)
      if (frame !== null) cancelAnimationFrame(frame)
      resize.disconnect()
      observer.current = null
      if (scroll.handle.current === handle) scroll.handle.current = null
      pendingFocus.current = null
    }
    // Activity reconnects this effect on reveal. Geometry updates are handled below, without
    // restoring the saved position on every token or resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, threadKey, scroll, getScroll, applyTop, readViewport, measureElements])

  const saved = !ready.current ? scroll.saved(threadKey) : undefined
  const following = ready.current ? scroll.following.current : saved?.following ?? true
  const sourceTop = !ready.current && saved ? anchoredTop(geometry, saved.anchor ? { ...saved.anchor, beforeTop: saved.top } : null, saved.top) : viewport.top
  const rebuilding = committed.current !== geometry
  const anchor = pendingAnchor.current ?? (rebuilding ? anchorAt(committed.current, sourceTop) : null)
  const renderTop = following ? Math.max(0, geometry.heights.total + PADDING * 2 - viewport.height) : anchoredTop(geometry, anchor, sourceTop)

  useLayoutEffect(() => {
    if (!active || !ready.current) return
    // Do not compare against `element.scrollTop` after DOM commit: shrinking `list.style.height`
    // (e.g. closing a side panel so rows unwrap shorter) causes WebKit to clamp `element.scrollTop`
    // before `useLayoutEffect` runs, which previously discarded `pendingAnchor.current`.
    const currentTop = getScroll()?.scrollTop ?? viewport.top
    const updateAnchor = pendingAnchor.current ?? (committed.current !== geometry ? anchorAt(committed.current, viewport.top) : null)

    // Synchronously measure any mounted rows (including newly-mounted overscan rows after a width
    // change) before paint so no row stays stuck on an estimate.
    let remeasured = false
    if (committed.current !== geometry && elements.current.size > 0) {
      const liveWidth = Math.round(list.current?.getBoundingClientRect().width || width)
      for (const node of elements.current.values()) {
        const id = node.dataset.virtualRow
        const index = id ? geometry.indices.get(id) : undefined
        if (index === undefined) continue
        const height = node.getBoundingClientRect().height
        if (height <= 0) continue
        measurements.current.set(id!, { message: geometry.rows[index]!, width: liveWidth, height })
        if (geometry.heights.measure(index, height)) remeasured = true
      }
    }

    if (scroll.following.current) applyTop(geometry.heights.total + PADDING * 2)
    else if (updateAnchor) applyTop(anchoredTop(geometry, updateAnchor, currentTop))
    pendingAnchor.current = null
    committed.current = geometry
    if (remeasured) setRevision((value) => value + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, geometry, revision, viewport.height])

  const range = transcriptWindow(geometry.heights, Math.max(0, renderTop - PADDING), viewport.height)
  const indices = Array.from({ length: range.end - range.start }, (_, offset) => range.start + offset)
  // An editor is stateful: scrolling it outside the viewport must not throw its draft away.
  const editingIndex = editingId ? geometry.indices.get(editingId) : undefined
  if (editingIndex !== undefined && !indices.includes(editingIndex)) indices.push(editingIndex)
  // An evicted transcript has estimates again. Mount its saved anchor even if those estimates
  // initially put a long row outside the predicted window; its first measurement restores it.
  const restoringIndex = !ready.current && saved?.anchor ? geometry.indices.get(saved.anchor.id) : undefined
  if (restoringIndex !== undefined && !indices.includes(restoringIndex)) indices.push(restoringIndex)
  indices.sort((a, b) => a - b)

  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (!target || !active) return
    const row = elements.current.get(target.messageId)
    const approval = row && Array.from(row.querySelectorAll<HTMLElement>('[data-approval-bar]')).find((node) => node.dataset.approvalBar === target.approvalId)
    if (!approval) return
    pendingFocus.current = null
    approval.scrollIntoView({ block: 'nearest' })
    approval.focus({ preventScroll: true })
  })

  return (
    <div data-transcript-key={threadKey} data-transcript-active={active} className="mx-auto w-full max-w-[760px] px-4 py-6">
      <div ref={list} className="relative" role="list" aria-label="Conversation messages" data-virtual-transcript data-total-messages={rows.length} style={{ height: geometry.heights.total, overflowAnchor: 'none' }}>
        {indices.map((index) => {
          const message = rows[index]!
          const previous = rows[index - 1]
          const continuing = message.role !== 'user' && previous !== undefined && previous.role !== 'user'
          return <VirtualRow key={message.id} message={message} threadKey={threadKey} index={index} count={rows.length} top={geometry.heights.top(index)} continuing={continuing} snapshot={snapshot} register={register} />
        })}
      </div>
    </div>
  )
})

const VirtualRow = memo(function VirtualRow({ message, threadKey, index, count, top, continuing, snapshot, register }: {
  message: ChatMessage; threadKey: string; index: number; count: number; top: number; continuing: boolean
  snapshot: TranscriptSnapshot; register: (id: string, element: HTMLDivElement) => () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => ref.current ? register(message.id, ref.current) : undefined, [register, message.id])
  return (
    <div ref={ref} data-virtual-row={message.id} data-virtual-index={index} role="listitem" aria-posinset={index + 1} aria-setsize={count} className="absolute inset-x-0 flow-root" style={{ top, paddingTop: index === 0 ? 0 : continuing ? 4 : 12 }}>
      <LiveMessage message={message} threadKey={threadKey} agent={snapshot.agent} generating={snapshot.generating} editing={snapshot.editingId === message.id} last={index === count - 1} showAvatar={message.role !== 'user' && !continuing} actions={snapshot.actions} />
    </div>
  )
})

/** Token updates stop here: history indexing and the window do not rerender per streamed token. */
const LiveMessage = memo(function LiveMessage({ message, threadKey, ...props }: {
  message: ChatMessage; threadKey: string; agent: boolean; generating: boolean; editing: boolean; last: boolean; showAvatar: boolean; actions: TranscriptSnapshot['actions']
}) {
  const stream = useStudio((state) => state.streaming?.conversationId === threadKey && state.streaming.assistantId === message.id ? state.streaming : null)
  return <Message {...props} message={stream ? { ...message, content: stream.content, streaming: true } : message} agent={props.agent || !!message.toolCalls?.length} live={stream ? { reasoning: stream.reasoning, startedAt: stream.startedAt, answerStartedAt: stream.answerStartedAt } : null} />
})
