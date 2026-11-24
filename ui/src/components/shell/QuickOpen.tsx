import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useStudio } from '../../store/studio'
import { useUi } from '../../store/ui'
import { selectFile } from '../code/filesStore'
import { Icon, Spinner } from '../common'
import { Modal } from '../ui'
import { openSidePanel, openThread } from './actions'
import { useRestoreFocus } from './focus'

type Match = { key: string; title: string; detail: string; kind: 'file' | 'chat' | 'code'; run: () => void }
const fileQueries = new Map<string, { paths: string[]; at: number }>()

export function QuickOpen() {
  const open = useUi((s) => s.quickOpen)
  const close = () => useUi.getState().setQuickOpen(false)
  return <Modal open={open} onClose={close} position="top" className="max-w-[640px] !rounded-md" label="Quick Open"><QuickOpenBody close={close} /></Modal>
}

/** Title-only search is deliberately independent from the full transcript search palette. */
function QuickOpenBody({ close }: { close: () => void }) {
  useRestoreFocus()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const conversations = useStudio((s) => s.conversations)
  const root = useStudio((s) => s.conversations.find((c) => c.id === s.activeConversationId && c.mode === 'agent')?.workspace ?? null)
  const queryText = query.trim().toLocaleLowerCase()
  const titles = useMemo(() => conversations.map((c) => ({ id: c.id, title: c.title || 'Untitled', search: `${c.title}\n${c.workspace ?? ''}`.toLocaleLowerCase(), workspace: c.workspace, code: c.mode === 'agent', at: c.updatedAt })).sort((a, b) => b.at - a.at), [conversations])
  useEffect(() => input.current?.focus({ preventScroll: true }), [])
  useEffect(() => {
    setFiles([])
    setError('')
    if (!root || queryText.startsWith('>')) { setLoading(false); return }
    const key = JSON.stringify([root, queryText])
    const cached = fileQueries.get(key)
    // Paint a recent result immediately, then revalidate. A second cache must not extend the
    // runtime index's freshness window or hide changes made by this Studio in the meantime.
    if (cached && Date.now() - cached.at < 2_000) setFiles(cached.paths)
    const controller = new AbortController()
    let current = true
    setLoading(true)
    const timer = setTimeout(() => {
      void api.workspace.files(root, queryText, 24, controller.signal, { cache: true }).then(({ paths }) => {
        if (!current) return
        fileQueries.delete(key)
        fileQueries.set(key, { paths, at: Date.now() })
        if (fileQueries.size > 32) fileQueries.delete(fileQueries.keys().next().value!)
        setFiles(paths)
      }).catch((err: unknown) => {
        if (current && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not search files')
      }).finally(() => { if (current) setLoading(false) })
    }, queryText ? 120 : 0)
    return () => { current = false; clearTimeout(timer); controller.abort() }
  }, [root, queryText])

  const matches = useMemo(() => {
    const result: Match[] = []
    if (root) for (const path of files) result.push({ key: `file:${path}`, title: path.split('/').pop() ?? path, detail: path, kind: 'file', run: () => { selectFile(root, path); openSidePanel('files') } })
    let count = 0
    for (const thread of titles) {
      if (queryText && !thread.search.includes(queryText)) continue
      result.push({ key: `thread:${thread.id}`, title: thread.title, detail: thread.workspace || 'Chat', kind: thread.code ? 'code' : 'chat', run: () => openThread(thread.id) })
      if (++count >= 20) break
    }
    return result
  }, [files, root, titles, queryText])
  const active = Math.min(cursor, Math.max(0, matches.length - 1))
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, matches])
  function run(match: Match | undefined) { if (match) { close(); match.run() } }
  return <>
    <div className="flex items-center gap-2 p-2">
      <Icon name="search" className="ml-1 size-4 shrink-0 text-ink-400" />
      <input ref={input} value={query} role="combobox" aria-label="Search files and conversations" aria-controls="quick-open-results" aria-expanded aria-autocomplete="list" aria-activedescendant={matches[active] ? `quick-open-${active}` : undefined}
        className="h-8 min-w-0 flex-1 rounded-sm border border-ink-200 bg-transparent px-2 text-sm outline-none focus:border-arc-500 dark:border-ink-700" placeholder={root ? 'Search files or conversations…' : 'Search conversations…'}
        onChange={(event) => { setQuery(event.target.value); setCursor(0) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setCursor(matches.length ? (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0) }
          else if (event.key === 'Enter') { event.preventDefault(); if (queryText.startsWith('>')) useUi.getState().openPalette(query.slice(query.indexOf('>') + 1).trim()); else run(matches[active]) }
          else if (event.key === 'Tab') { event.preventDefault(); input.current?.focus() }
        }} />
      {loading && <Spinner className="size-3.5 shrink-0 text-ink-400" />}
      <button type="button" className="icon-btn" aria-label="Close Quick Open" onClick={close}><Icon name="x" className="size-3.5" /></button>
    </div>
    <div ref={list} id="quick-open-results" role="listbox" aria-label="Files and conversations" className="max-h-[50vh] overflow-y-auto py-1">
      {matches.map((match, index) => <div role="option" id={`quick-open-${index}`} key={match.key} aria-selected={index === active} className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs ${index === active ? 'bg-arc-500/15 text-ink-900 dark:text-ink-50' : 'text-ink-600 dark:text-ink-300'}`} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setCursor(index)} onClick={() => run(match)}>
        <Icon name={match.kind === 'file' ? 'file' : match.kind === 'code' ? 'code' : 'chat'} className="size-3.5 shrink-0" />
        <span className="max-w-[55%] truncate">{match.title}</span><span className="min-w-0 flex-1 truncate text-ink-400">{match.detail}</span>
      </div>)}
      {matches.length === 0 && <p className="px-4 py-5 text-xs text-ink-500">{queryText.startsWith('>') ? 'Press Enter to search commands' : loading ? 'Searching…' : 'No matching files or conversations'}</p>}
    </div>
    <div className="flex items-center gap-3 border-t border-ink-200 px-3 py-2 text-[0.65rem] text-ink-500 dark:border-ink-800"><span>↑ ↓ Select · Enter Open · Esc Close</span><span className="ml-auto">&gt; Commands</span></div>
    {error && <p className="border-t border-ink-200 px-3 py-2 text-xs text-amber-700 dark:border-ink-800 dark:text-amber-400" role="status">File search unavailable: {error}. Conversations are still searchable.</p>}
  </>
}
