import { Activity, useMemo, useState } from 'react'
import type { ChatMessage } from '../../lib/types'
import { useStudio } from '../../store/studio'
import type { TranscriptActions } from './Message'
import { VirtualTranscript, type TranscriptScroll } from './VirtualTranscript'

export type TranscriptSnapshot = {
  rows: ChatMessage[]
  agent: boolean
  generating: boolean
  editingId: string | null
  actions: TranscriptActions
}

type Entry = { key: string; snapshot: TranscriptSnapshot }
const MAX_TRANSCRIPTS = 3

/**
 * Keep just the three most recently viewed transcripts mounted. Returning to a recent thread
 * reuses its Markdown, code blocks and DOM; the shared composer, scroll area and panels stay
 * outside this cache. Eviction releases UI only — conversation history remains in the store.
 */
export function TranscriptCache({ threadKey, active, snapshot, scroll }: { threadKey: string; active: boolean; snapshot: TranscriptSnapshot; scroll: TranscriptScroll }) {
  const conversations = useStudio((s) => s.conversations)
  const validKeys = useMemo(() => new Set(conversations.map((thread) => thread.id)), [conversations])
  // The store may delete a thread before the parent's selection prop catches up.
  const showingCurrent = active && validKeys.has(threadKey)
  const [cached, setCached] = useState<Entry[]>([])
  // A deleted conversation should release its hidden DOM immediately, not wait for eviction.
  let entries = cached.some((entry) => !validKeys.has(entry.key))
    ? cached.filter((entry) => validKeys.has(entry.key))
    : cached

  if (showingCurrent) {
    const current = entries.find((entry) => entry.key === threadKey)
    if (entries[0]?.key !== threadKey || current?.snapshot !== snapshot) {
      entries = [{ key: threadKey, snapshot }, ...entries.filter((entry) => entry.key !== threadKey)].slice(0, MAX_TRANSCRIPTS)
    }
  } else if (entries.some((entry) => entry.key === threadKey)) {
    // Clearing the current thread must not retain its old messages. Merely visiting a new empty
    // thread does not match any entry, so the other recent transcripts remain available.
    entries = entries.filter((entry) => entry.key !== threadKey)
  }

  // Update this component's own state conditionally during render so a rapid switch cannot hide
  // a transcript before its newest committed snapshot was recorded by a passive effect.
  if (entries !== cached) setCached(entries)

  return (
    <div data-transcript-cache hidden={!showingCurrent}>
      {entries.map((entry) => {
        const showing = showingCurrent && entry.key === threadKey
        return (
          <Activity key={entry.key} mode={showing ? 'visible' : 'hidden'}>
            <VirtualTranscript threadKey={entry.key} active={showing} snapshot={showing ? snapshot : entry.snapshot} scroll={scroll} />
          </Activity>
        )
      })}
    </div>
  )
}
