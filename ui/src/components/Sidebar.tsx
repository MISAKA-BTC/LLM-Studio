// A permanent Activity Bar and a separately retained, resizable navigation sidebar.
// Chat conversations and Code project sessions share a bounded row viewport; switching sides
// pauses the hidden list without discarding its scroll position or in-progress rename.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { useAgent } from '../lib/agent/run'
import { useWorkspaceInfo } from '../lib/agent/workspace'
import { formatShortcut } from '../lib/keys'
import type { Conversation } from '../lib/types'
import { useStudio, type View } from '../store/studio'
import { useUi, type AppMode } from '../store/ui'
import { useGitStatus } from './code/gitStore'
import { Icon, Spinner, type IconName } from './common'
import { IconButton, Kbd, MenuItem, MenuSeparator, Popover, StatusDot } from './ui'
import {
  deleteThread,
  exportThread,
  goTo,
  newChat,
  newSession,
  newSessionIn,
  nextTheme,
  openFolder,
  openThread,
  setTheme,
  switchAppMode,
  type Theme,
} from './shell/actions'
import { dirtySummary, folderLabel, groupProjects, sessionTitle, shortAge, type Project } from './shell/projects'
import { NEW_CHAT_HINT, SHORTCUTS, SIDE_ICONS, SIDE_LABELS, SIDE_SHORTCUTS, VIEW_ICONS, VIEW_LABELS, VIEW_SHORTCUTS } from './shell/shortcuts'
import { sideOf, threadsOf } from './shell/sides'
import { groupThreads, threadMining } from './shell/threads'
import { useNewSessionProject } from './shell/useSessionProject'
import { RetainedView } from './shell/RetainedView'
import { VirtualSidebar, type SidebarItem } from './shell/VirtualSidebar'

/** The views beside the threads. The thread view itself is the switch's; Settings is in the footer. */
const NAV: View[] = ['models', 'image', 'network', 'monitor']

const SIDES: AppMode[] = ['chat', 'code']

/** The small buttons a row shows under the pointer or the keyboard: a row's menu, a project's `+`. */
const ROW_BUTTON =
  'inline-flex size-5 items-center justify-center rounded-[3px] text-ink-500 hover:bg-ink-200 hover:text-ink-900 focus-visible:outline-1 focus-visible:outline-arc-500 dark:text-[#9d9d9d] dark:hover:bg-[#3c3c3c] dark:hover:text-white'

const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' } as const
const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function Sidebar() {
  const open = useUi((s) => s.sidebarOpen)
  return <><SidebarRail /><RetainedView active={open}><ResizableSidebar /></RetainedView></>
}

function ResizableSidebar() {
  const savedWidth = useUi((s) => s.sidebarWidth)
  const width = Number.isFinite(savedWidth) ? Math.max(200, Math.min(420, savedWidth)) : 256
  const pane = useRef<HTMLDivElement>(null)
  const stop = useRef<(() => void) | null>(null)
  useLayoutEffect(() => () => stop.current?.(), [])
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    stop.current?.()
    const start = event.clientX
    const initial = pane.current?.getBoundingClientRect().width || width
    const cursor = document.body.style.cursor
    const select = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    let next = initial
    const move = (e: globalThis.PointerEvent) => {
      next = Math.max(200, Math.min(420, initial + e.clientX - start))
      if (pane.current) pane.current.style.width = `${next}px`
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      document.body.style.cursor = cursor
      document.body.style.userSelect = select
      stop.current = null
    }
    const done = () => { cleanup(); useUi.getState().setSidebarWidth(next) }
    const cancel = () => { cleanup(); if (pane.current) pane.current.style.width = `${width}px` }
    stop.current = cancel
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }
  return <div ref={pane} className="relative h-full shrink-0" style={{ width, maxWidth: 'calc(100vw - 96px)' }}>
    <ExpandedSidebar />
    <div role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={420} aria-valuenow={width} tabIndex={0}
      className="absolute -right-0.5 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-arc-500 focus-visible:bg-arc-500 focus-visible:outline-none"
      onPointerDown={resize} onDoubleClick={() => useUi.getState().setSidebarWidth(256)}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        useUi.getState().setSidebarWidth(event.key === 'Home' ? 200 : event.key === 'End' ? 420 : width + (event.key === 'ArrowRight' ? 10 : -10))
      }} />
  </div>
}

function useActiveDownloads(): number {
  return useStudio((s) => s.downloads.filter((d) => d.status === 'downloading' || d.status === 'verifying').length)
}

type Activity = 'running' | 'approval' | null

/** What is happening on each side — for a side not in view, so work going on there is not missed. */
function useSideActivity(): Record<AppMode, Activity> {
  const run = useAgent((s) => s.run)
  const streamingSide = useStudio((s) => {
    const id = s.streaming?.conversationId
    if (!id) return null
    const thread = s.conversations.find((c) => c.id === id)
    return thread ? sideOf(thread) : null
  })
  return {
    chat: streamingSide === 'chat' ? 'running' : null,
    code: run ? (run.status === 'awaiting_approval' ? 'approval' : 'running') : streamingSide === 'code' ? 'running' : null,
  }
}

function sideTitle(mode: AppMode, activity: Activity): string {
  const base = `${SIDE_LABELS[mode]} (${formatShortcut(SIDE_SHORTCUTS[mode])})`
  if (activity === 'approval') return `${base} — the agent is waiting for your approval`
  if (activity === 'running') return mode === 'code' ? `${base} — the agent is working` : `${base} — a reply is being written`
  return base
}

/** A light on a side that is not in view: something is going on over there. */
function ActivityDot({ activity, className = '' }: { activity: Activity; className?: string }) {
  if (!activity) return null
  return <StatusDot tone={activity === 'approval' ? 'amber' : 'arc'} pulse className={`pointer-events-none absolute ${className}`} />
}

function ExpandedSidebar() {
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const side = useUi((s) => s.appMode)
  const project = useNewSessionProject()
  return (
    <aside className="flex h-full w-full flex-col border-r border-ink-200 bg-ink-50 select-none dark:border-ink-800 dark:bg-ink-950" aria-label="Sidebar">
      <div className="flex h-[35px] shrink-0 items-center gap-1 border-b border-ink-200 pl-3 pr-1.5 dark:border-ink-800">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-ink-600 dark:text-[#bbbbbb]">
          {side === 'code' ? 'Explorer · Sessions' : 'Conversations'}
        </span>
        {side === 'chat' ? (
          <IconButton icon="plus" label="New chat" shortcut={NEW_CHAT_HINT} onClick={newChat} className="!size-[22px]" />
        ) : (
          <>
            <IconButton
              icon="plus"
              label={project ? `New session in ${folderLabel(project)}` : 'New session'}
              shortcut={NEW_CHAT_HINT}
              onClick={newSession}
              className="!size-[22px]"
            />
            <IconButton icon="folderOpen" label="Open folder…" onClick={openFolder} className="!size-[22px]" />
          </>
        )}
        <IconButton
          icon="search"
          label="Find files and conversations"
          shortcut={SHORTCUTS.quickOpen}
          onClick={() => useUi.getState().setQuickOpen(true)}
          className="!size-[22px]"
        />
        <IconButton icon="panelLeft" label="Collapse sidebar" shortcut={SHORTCUTS.toggleSidebar} onClick={toggleSidebar} className="!size-[22px]" />
      </div>
      <div className="shrink-0 space-y-px border-b border-ink-200/70 px-1.5 py-1.5 dark:border-ink-800/80">
        {side === 'chat' ? (
          <SidebarButton icon="compose" label="New chat" shortcut={NEW_CHAT_HINT} onClick={newChat} />
        ) : (
          <>
            <NewSessionButton />
            <SidebarButton icon="folderOpen" label="Open folder…" title="Open a folder and start a session in it" onClick={openFolder} />
          </>
        )}
        <SidebarButton icon="search" label="Find files and conversations" shortcut={SHORTCUTS.quickOpen} onClick={() => useUi.getState().setQuickOpen(true)} />
      </div>
      <RetainedView active={side === 'chat'}><ChatThreadList /></RetainedView>
      <RetainedView active={side === 'code'}><ProjectList /></RetainedView>
    </aside>
  )
}

function SidebarButton({
  icon,
  label,
  shortcut,
  title,
  onClick,
}: {
  icon: IconName
  label: string
  shortcut?: string
  /** The tooltip, when it should say more than the label and its key. */
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? (shortcut ? `${label} (${formatShortcut(shortcut)})` : label)}
      className="flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-[12px] text-ink-700 transition-colors hover:bg-ink-200/70 hover:text-ink-900 focus-visible:bg-ink-200/70 focus-visible:outline-1 focus-visible:outline-arc-500 dark:text-[#cccccc] dark:hover:bg-[#2a2d2e] dark:hover:text-white dark:focus-visible:bg-[#2a2d2e]"
    >
      <Icon name={icon} className="size-3.5 shrink-0 opacity-80" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {shortcut && <Kbd shortcut={shortcut} className="shrink-0" />}
    </button>
  )
}

function NewSessionButton() {
  const project = useNewSessionProject()
  const keys = formatShortcut(NEW_CHAT_HINT)
  return (
    <SidebarButton
      icon="plus"
      label="New session"
      shortcut={NEW_CHAT_HINT}
      title={project ? `New session in ${folderLabel(project)} (${keys})\n${project}` : `New session — choose its folder first (${keys})`}
      onClick={newSession}
    />
  )
}

// --- the lists -------------------------------------------------------------------------------------

function runningOf(id: string, agentRun: { conversationId: string; status: string } | null, streamingId: string | null): Activity {
  if (agentRun?.conversationId === id) return agentRun.status === 'awaiting_approval' ? 'approval' : 'running'
  return streamingId === id ? 'running' : null
}

/** Chat's side: the conversations, starred first and then by date — as the sidebar always listed them. */
type ChatNavItem = SidebarItem & ({ kind: 'heading'; label: string } | { kind: 'thread'; conversation: Conversation })

function ChatThreadList() {
  const conversations = useStudio((s) => s.conversations)
  const activeId = useStudio((s) => s.activeConversationId)
  const view = useStudio((s) => s.view)
  const streamingId = useStudio((s) => s.streaming?.conversationId ?? null)
  const agentRun = useAgent((s) => s.run)
  const items = useMemo(() => groupThreads(threadsOf(conversations, 'chat')).flatMap<ChatNavItem>((group) => [
    { key: `heading:${group.id}`, kind: 'heading', label: group.label, selectable: false },
    ...group.threads.map((conversation): ChatNavItem => ({ key: conversation.id, kind: 'thread', conversation, selectable: true })),
  ]), [conversations])
  if (!items.length) return <p className="flex-1 px-4 py-4 text-xs text-ink-500">No chats yet. Start one with <Kbd shortcut={NEW_CHAT_HINT} />.</p>
  return <VirtualSidebar items={items} label="Conversations" activeKey={view === 'chat' ? activeId : null} render={(item) => {
    if (item.kind === 'heading') return <h3 className="flex h-8 items-center px-2.5 text-[0.65rem] font-semibold uppercase tracking-wide text-ink-400">{item.label}</h3>
    const conversation = item.conversation
    const mining = threadMining(conversation)
    return <ThreadRow conversation={conversation} kind="chat" active={view === 'chat' && conversation.id === activeId} running={runningOf(conversation.id, agentRun, streamingId)} pending={mining.pending} committed={mining.committed} />
  }} />
}

/** A clock that moves once a minute — enough for "5m" to become "6m" without a timer per row. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Code's side: every folder with a session, and the folders opened recently, sessions beneath. */
type ProjectNavItem = SidebarItem & ({ kind: 'project'; project: Project; folded: boolean; busy: boolean } | { kind: 'session'; conversation: Conversation })
function ProjectList() {
  const conversations = useStudio((s) => s.conversations)
  const activeId = useStudio((s) => s.activeConversationId)
  const view = useStudio((s) => s.view)
  const streamingId = useStudio((s) => s.streaming?.conversationId ?? null)
  const agentRun = useAgent((s) => s.run)
  const recent = useUi((s) => s.recentWorkspaces)
  const collapsed = useUi((s) => s.collapsedProjects)
  const now = useMinuteClock()
  const projects = useMemo(() => groupProjects(threadsOf(conversations, 'code'), recent), [conversations, recent])
  const items = useMemo(() => projects.flatMap<ProjectNavItem>((project) => {
    const folded = collapsed.includes(project.key)
    const shown = folded ? project.sessions.filter((s) => view === 'chat' && s.id === activeId) : project.sessions
    const key = `project:${project.key}`
    return [
      { key, kind: 'project', project, folded, busy: project.sessions.some((s) => s.id === agentRun?.conversationId || s.id === streamingId), selectable: true },
      ...shown.map((conversation): ProjectNavItem => ({ key: conversation.id, kind: 'session', conversation, parent: key, selectable: true })),
    ]
  }), [projects, collapsed, view, activeId, agentRun?.conversationId, streamingId])
  if (!items.length) return <div className="flex-1 px-4 py-4 text-xs text-ink-500"><p>No projects yet. Open a folder to start an agent session.</p><button type="button" className="btn-outline mt-3 px-2.5 py-1 text-xs" onClick={openFolder}><Icon name="folderOpen" className="size-3.5" />Open folder…</button></div>
  return <VirtualSidebar items={items} label="Projects" activeKey={view === 'chat' ? activeId : null} render={(item) => {
    if (item.kind === 'project') return <ProjectHeader project={item.project} collapsed={item.folded} busy={item.busy} />
    const session = item.conversation
    const mining = threadMining(session)
    return <ThreadRow conversation={session} kind="session" active={view === 'chat' && session.id === activeId} running={runningOf(session.id, agentRun, streamingId)} pending={mining.pending} committed={mining.committed} age={shortAge(session.updatedAt, now)} changes={session.changes?.length ?? 0} />
  }} />
}

/** A project's name row: folds its sessions; on hover, a new session there and the folder's menu. */
function ProjectHeader({ project, collapsed, busy }: { project: Project; collapsed: boolean; busy: boolean }) {
  // The runtime's account of the folder — its branch — cached app-wide and asked again only once
  // it is stale (`lib/agent/workspace`), not on every render of this row.
  const entry = useWorkspaceInfo(project.path)
  const [menuOpen, setMenuOpen] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const info = entry?.status === 'ok' ? entry.info : null
  const path = project.path
  const count = project.sessions.length
  // The working tree, from the one reading the Code panes share (`code/gitStore`) — refreshed after
  // agent steps and terminal commands, so the branch follows a checkout made there. Asked only for
  // folders with sessions: a folder merely opened once is not worth a `git status` per visit.
  const git = useGitStatus(path && count > 0 ? path : null)
  const repo = git?.status?.is_git ? git.status : null
  const branch = repo?.branch ?? repo?.head ?? info?.branch ?? null
  const dirty = repo ? dirtySummary(repo) : null
  const toggle = () => useUi.getState().toggleProject(project.key)

  const title = path
    ? [`${info?.root ?? path}${branch ? ` · ${branch}` : ''}`, dirty, entry?.status === 'error' ? entry.error : null, count === 0 ? 'No sessions yet' : null]
        .filter(Boolean)
        .join('\n')
    : 'Sessions without a folder — choose one from the folder chip in the composer'

  return (
    <div className="group/header relative">
      <button
        type="button"
        data-project-row
        aria-expanded={!collapsed}
        title={title}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' && !collapsed) {
            event.preventDefault()
            toggle()
          } else if (event.key === 'ArrowRight' && collapsed) {
            event.preventDefault()
            toggle()
          }
        }}
        className={`peer flex h-7 w-full items-center gap-1.5 rounded-[3px] pl-2 pr-2 text-left text-[12px] font-semibold transition-colors hover:bg-ink-200/60 focus-visible:bg-ink-200/60 focus-visible:outline-1 focus-visible:outline-arc-500 dark:hover:bg-[#2a2d2e] dark:focus-visible:bg-[#2a2d2e] ${
          menuOpen ? 'bg-ink-200/60 dark:bg-[#2a2d2e]' : ''
        } ${path ? 'text-ink-800 dark:text-[#cccccc]' : 'text-ink-500 dark:text-ink-400'}`}
      >
        {/* The folder, open or shut; under the pointer, the chevron that says a click folds it. */}
        <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-400 dark:text-ink-500" aria-hidden>
          <Icon name={collapsed ? 'folder' : 'folderOpen'} className="size-4 transition-opacity group-hover/header:opacity-0" />
          <Icon
            name="chevronDown"
            className={`absolute size-3.5 opacity-0 transition-[opacity,transform] group-hover/header:opacity-100 ${collapsed ? '-rotate-90' : ''}`}
          />
        </span>
        <span className="min-w-0 shrink truncate">{project.name}</span>
        {branch && (
          <span className="flex min-w-0 flex-1 items-center gap-0.5 text-[0.7rem] font-normal text-ink-400 dark:text-ink-500">
            <Icon name="gitBranch" className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{branch}</span>
            {dirty && <span className="ml-1 size-1.5 shrink-0 rounded-full bg-amber-500" role="img" aria-label={dirty} />}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center pl-1 text-[0.7rem] font-normal tabular-nums text-ink-400 transition-opacity group-hover/header:opacity-0 dark:text-ink-500">
          {collapsed && busy ? <Spinner className="size-3 text-arc-600 dark:text-arc-400" /> : collapsed && count > 0 ? count : null}
        </span>
      </button>

      {path && (
        <div
          className={`absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-lg bg-gradient-to-l from-ink-100 from-60% to-transparent pl-5 pr-1 transition-opacity dark:from-ink-800 ${
            menuOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/header:pointer-events-auto group-hover/header:opacity-100 peer-focus-visible:pointer-events-auto peer-focus-visible:opacity-100'
          }`}
        >
          <button
            type="button"
            className={ROW_BUTTON}
            aria-label={`New session in ${project.name}`}
            title={`New session in ${project.name}`}
            onClick={() => newSessionIn(path)}
          >
            <Icon name="plus" className="size-3.5" />
          </button>
          <button
            ref={more}
            type="button"
            className={ROW_BUTTON}
            aria-label={`More actions for ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="more" className="size-4" />
          </button>
        </div>
      )}

      {path && (
        <Popover anchor={more} open={menuOpen} onClose={() => setMenuOpen(false)} placement="bottom-end" className="w-60">
          <MenuItem
            icon="plus"
            label="New session here"
            onSelect={() => {
              setMenuOpen(false)
              newSessionIn(path)
            }}
          />
          <MenuItem
            icon="copy"
            label="Copy path"
            onSelect={() => {
              setMenuOpen(false)
              void copyPath(path)
            }}
          />
          {/* Only a folder with no sessions leaves the list: one with sessions is listed because of
              them, and would be back the moment it was removed. */}
          {count === 0 && project.recent && (
            <>
              <MenuSeparator />
              <MenuItem
                icon="x"
                label="Remove from recent"
                onSelect={() => {
                  setMenuOpen(false)
                  useUi.getState().removeRecentWorkspace(path)
                }}
              />
            </>
          )}
        </Popover>
      )}
    </div>
  )
}

async function copyPath(path: string) {
  const toast = useStudio.getState().toast
  try {
    await navigator.clipboard.writeText(path)
    toast('success', `Copied ${path}`)
  } catch {
    toast('error', 'The clipboard is not available here.')
  }
}

// --- one thread ------------------------------------------------------------------------------------

type RowProps = {
  conversation: Conversation
  /** A chat row leads with the chat mark; a session's lead is empty until it runs, and it says how
   *  long ago it changed and what the agent changed. */
  kind: 'chat' | 'session'
  active: boolean
  running: Activity
  pending: number
  committed: number
  age?: string
  changes?: number
}

/** Only what a row draws: a poll that rewrites every conversation object must not redraw them all. */
function sameRow(a: RowProps, b: RowProps): boolean {
  const x = a.conversation
  const y = b.conversation
  return (
    a.kind === b.kind &&
    a.active === b.active &&
    a.running === b.running &&
    a.pending === b.pending &&
    a.committed === b.committed &&
    a.age === b.age &&
    a.changes === b.changes &&
    x.id === y.id &&
    x.title === y.title &&
    x.mode === y.mode &&
    x.workspace === y.workspace &&
    x.starred === y.starred &&
    x.mine === y.mine &&
    x.messages.length === y.messages.length
  )
}

const ThreadRow = memo(function ThreadRow({ conversation, kind, active, running, pending, committed, age, changes = 0 }: RowProps) {
  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const more = useRef<HTMLButtonElement>(null)
  const row = useRef<HTMLButtonElement>(null)
  const session = kind === 'session'
  const title = session ? sessionTitle(conversation) : conversation.title
  const mining = conversation.mine !== false
  const noun = session ? 'session' : 'thread'

  const closeMenu = () => {
    setMenuOpen(false)
    setConfirmDelete(false)
  }
  const finishRename = (next: string | null, byKeyboard: boolean) => {
    setRenaming(false)
    if (next !== null && next.trim() && next.trim() !== title) useStudio.getState().renameConversation(conversation.id, next)
    // After Enter or Escape the keyboard carries on from the row. After a click elsewhere the focus
    // is wherever that click put it, and taking it back would be a surprise.
    if (byKeyboard) requestAnimationFrame(() => row.current?.focus({ preventScroll: true }))
  }

  return (
    <div className="group relative">
      {renaming ? (
        <RenameField initial={title} label={session ? 'Session name' : 'Thread name'} onDone={finishRename} />
      ) : (
        <button
          ref={row}
          type="button"
          data-thread-row
          onClick={() => openThread(conversation.id)}
          onDoubleClick={() => setRenaming(true)}
          onKeyDown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              setRenaming(true)
            }
          }}
          aria-current={active ? 'page' : undefined}
          title={title}
          className={`peer group/row flex h-7 w-full items-center gap-2 rounded-[3px] pl-2 pr-2 text-left text-[12px] transition-colors focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-arc-500 ${
            active || menuOpen
              ? 'bg-arc-600/12 font-medium text-ink-900 dark:bg-[#04395e] dark:text-white'
              : 'text-ink-700 hover:bg-ink-200/60 hover:text-ink-900 dark:text-[#cccccc] dark:hover:bg-[#2a2d2e] dark:hover:text-white'
          }`}
        >
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
            {running === 'running' ? (
              <Spinner className="size-3.5 text-arc-600 dark:text-arc-400" />
            ) : running === 'approval' ? (
              <StatusDot tone="amber" pulse />
            ) : session ? null : (
              <Icon name="chat" className="size-3.5 text-ink-400 dark:text-ink-500" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {/* The trailing marks give way to the row's menu button on hover, in the same space,
              so nothing in the row moves when the pointer crosses it. */}
          <span
            className={`flex shrink-0 items-center gap-1.5 transition-opacity group-hover:opacity-0 group-focus-visible/row:opacity-0 ${menuOpen ? 'opacity-0' : ''}`}
          >
            {session && conversation.starred && (
              <span title="Starred" className="flex">
                <Icon name="star" className="size-3 text-amber-500" />
              </span>
            )}
            {session && changes > 0 && (
              <span
                className="flex items-center gap-0.5 text-[0.7rem] tabular-nums text-ink-400 dark:text-ink-500"
                title={`The agent changed ${changes} file${changes === 1 ? '' : 's'} — review them in Changes`}
              >
                <Icon name="diff" className="size-3" />
                {changes}
              </span>
            )}
            {pending > 0 ? (
              <span title={`${pending} prompt${pending === 1 ? '' : 's'} from this ${noun} waiting to be mined`} className="flex">
                <Icon name="pickaxe" className="size-3 animate-pulse text-amber-600 dark:text-amber-400" />
              </span>
            ) : committed > 0 ? (
              <span title={`${committed} prompt${committed === 1 ? '' : 's'} from this ${noun} committed by the mining lane`} className="flex">
                <Icon name="pickaxe" className="size-3 text-emerald-600 dark:text-emerald-400" />
              </span>
            ) : null}
            {age && (
              <span className="min-w-[1.6rem] text-right text-[0.7rem] tabular-nums text-ink-400 dark:text-ink-500" title={new Date(conversation.updatedAt).toLocaleString()}>
                {age}
              </span>
            )}
          </span>
        </button>
      )}

      {!renaming && (
        <div
          className={`absolute inset-y-0 right-0 flex items-center rounded-r-lg bg-gradient-to-l from-ink-100 from-60% to-transparent pl-4 pr-1 transition-opacity dark:from-ink-800 ${
            menuOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 peer-focus-visible:pointer-events-auto peer-focus-visible:opacity-100'
          }`}
        >
          <button
            ref={more}
            type="button"
            className={ROW_BUTTON}
            aria-label={`More actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="More"
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          >
            <Icon name="more" className="size-4" />
          </button>
        </div>
      )}

      <Popover anchor={more} open={menuOpen} onClose={closeMenu} placement="bottom-end" className="w-72">
        <MenuItem
          icon="edit"
          label="Rename"
          hint="F2"
          onSelect={() => {
            closeMenu()
            setRenaming(true)
          }}
        />
        <MenuItem
          icon="star"
          label={conversation.starred ? 'Unstar' : 'Star'}
          onSelect={() => {
            closeMenu()
            useStudio.getState().starConversation(conversation.id, !conversation.starred)
          }}
        />
        <MenuItem
          icon="pickaxe"
          label={`Mine prompts from this ${noun}`}
          hint={mining ? 'on' : 'off'}
          onSelect={() => {
            closeMenu()
            useStudio.getState().setConversationMining(conversation.id, !mining)
          }}
        />
        <MenuItem
          icon="download"
          label="Export as Markdown"
          onSelect={() => {
            closeMenu()
            // Read at the click: this row redraws only for what it shows, so the conversation it
            // holds can be a reply behind the one in the store.
            const latest = useStudio.getState().conversations.find((c) => c.id === conversation.id)
            if (latest) exportThread(latest)
          }}
        />
        <MenuSeparator />
        {confirmDelete ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 text-[0.8rem]" role="group" aria-label="Confirm delete">
            <Icon name="trash" className="size-4 shrink-0 text-red-600 opacity-80 dark:text-red-400" />
            <span className="min-w-0 flex-1 font-medium text-red-600 dark:text-red-400">Delete?</span>
            <button
              type="button"
              className="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500"
              autoFocus
              onClick={() => {
                closeMenu()
                deleteThread(conversation.id)
              }}
            >
              Yes
            </button>
            <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setConfirmDelete(false)}>
              No
            </button>
          </div>
        ) : (
          <MenuItem icon="trash" label="Delete" danger onSelect={() => setConfirmDelete(true)} />
        )}
      </Popover>
    </div>
  )
}, sameRow)

/** The title in place, editable. Enter or leaving the field saves; Escape puts it back. */
function RenameField({ initial, label, onDone }: { initial: string; label: string; onDone: (title: string | null, byKeyboard: boolean) => void }) {
  const [value, setValue] = useState(initial)
  const finished = useRef(false)
  const finish = (title: string | null, byKeyboard = false) => {
    if (finished.current) return
    finished.current = true
    onDone(title, byKeyboard)
  }
  return (
    <input
      autoFocus
      value={value}
      aria-label={label}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(value, true)
        } else if (event.key === 'Escape') {
          // Claimed here, so the window's Escape (stop generating) leaves it alone.
          event.preventDefault()
          finish(null, true)
        }
      }}
      className="h-8 w-full rounded-lg border border-arc-500 bg-white px-2.5 text-[0.8rem] text-ink-900 outline-none ring-2 ring-arc-500/20 dark:bg-ink-950 dark:text-ink-50"
    />
  )
}

// --- the rest of the window ----------------------------------------------------------------------

/** Models, Image, Network, Monitor — two by two, so the threads above keep the height. */
function ConnectionStatus({ compact = false }: { compact?: boolean }) {
  const connected = useStudio((s) => s.connected)
  const modelId = useStudio((s) => s.runtime?.model_id ?? null)
  const text = connected ? (modelId ? 'Model loaded' : 'Runtime ready') : 'Runtime unreachable'
  const title = connected ? (modelId ? `Model loaded: ${modelId}` : 'Runtime ready — no model loaded') : 'The LLM Studio Runtime is not answering; what the window shows may be stale'
  if (compact) {
    return (
      <span className="flex size-7 items-center justify-center" title={title} role="status" aria-label={text}>
        <StatusDot tone={connected ? 'green' : 'red'} />
      </span>
    )
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-[0.75rem] text-ink-500 dark:text-ink-400" title={title} role="status">
      <StatusDot tone={connected ? 'green' : 'red'} />
      <span className="truncate">{text}</span>
    </div>
  )
}

function ThemeButton() {
  const theme = useStudio((s) => s.settings?.ui.theme ?? 'system')
  const available = useStudio((s) => s.settings !== null)
  const next = nextTheme(theme)
  return (
    <IconButton
      icon={THEME_ICON[theme]}
      label={available ? `Theme: ${THEME_LABEL[theme]} — switch to ${THEME_LABEL[next]}` : 'Theme (the runtime is not reachable)'}
      disabled={!available}
      onClick={() => void setTheme(next)}
    />
  )
}

function RailSlot({
  icon,
  label,
  title,
  active,
  badge,
  dot,
  onClick,
}: {
  icon: IconName
  label: string
  title?: string
  active: boolean
  badge?: number
  dot?: Activity
  onClick: () => void
}) {
  return (
    <span className="relative flex w-full justify-center">
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        title={title ?? label}
        onClick={onClick}
        className={`relative inline-flex h-11 w-full items-center justify-center border-l-2 transition-colors focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-arc-500 ${
          active
            ? 'border-arc-500 text-ink-900 dark:text-white'
            : 'border-transparent text-ink-400 hover:text-ink-800 dark:text-[#858585] dark:hover:text-white'
        }`}
      >
        <Icon name={icon} className="size-5" />
      </button>
      {badge !== undefined && badge > 0 && (
        <span
          className="pointer-events-none absolute bottom-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-arc-600 px-1 text-[9px] font-semibold leading-none text-white"
          title={`${badge} active`}
        >
          {badge}
        </span>
      )}
      {!active && dot && <ActivityDot activity={dot} className="right-2 top-2" />}
    </span>
  )
}

function SidebarRail() {
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const side = useUi((s) => s.appMode)
  const modelsTab = useUi((s) => s.modelsTab)
  const setModelsTab = useUi((s) => s.setModelsTab)
  const view = useStudio((s) => s.view)
  const downloads = useActiveDownloads()
  const activity = useSideActivity()

  return (
    <aside
      className="flex h-full w-12 shrink-0 flex-col items-center border-r border-ink-200 bg-ink-50 py-1 select-none dark:border-ink-800 dark:bg-ink-950"
      aria-label="Activity bar"
    >
      <div className="flex w-full flex-col" role="group" aria-label="Chat or Code">
        {SIDES.map((mode) => {
          const on = view === 'chat' && side === mode
          return (
            <RailSlot
              key={mode}
              icon={SIDE_ICONS[mode]}
              label={SIDE_LABELS[mode]}
              title={sideTitle(mode, on ? null : activity[mode])}
              active={on && sidebarOpen}
              dot={activity[mode]}
              onClick={() => {
                if (view === 'chat' && side === mode) {
                  toggleSidebar()
                } else {
                  switchAppMode(mode)
                  useUi.getState().setSidebarOpen(true)
                }
              }}
            />
          )
        })}
      </div>

      <RailSlot
        icon="search"
        label="Search"
        title={`Search files and conversations (${formatShortcut(SHORTCUTS.quickOpen)})`}
        active={false}
        onClick={() => useUi.getState().setQuickOpen(true)}
      />

      <div className="my-1 h-px w-6 bg-ink-200 dark:bg-ink-800" />

      <nav className="flex w-full flex-col items-center" aria-label="Views">
        <RailSlot
          icon="modelSearch"
          label="Model Search"
          title="Model Search — Discover & download GGUF / MLX models"
          active={view === 'models' && modelsTab === 'discover'}
          onClick={() => {
            setModelsTab('discover')
            goTo('models')
          }}
        />
        {NAV.map((item) => {
          const active = item === 'models' ? view === 'models' && modelsTab === 'installed' : view === item
          return (
            <RailSlot
              key={item}
              icon={VIEW_ICONS[item]}
              label={VIEW_LABELS[item]}
              title={`${VIEW_LABELS[item]} (${formatShortcut(VIEW_SHORTCUTS[item])})`}
              active={active}
              badge={item === 'models' ? downloads : undefined}
              onClick={() => {
                if (item === 'models') setModelsTab('installed')
                goTo(item)
              }}
            />
          )
        })}
      </nav>

      <div className="flex-1" />
      <ConnectionStatus compact />
      <ThemeButton />
      <RailSlot
        icon="settings"
        label="Settings"
        title={`Settings (${formatShortcut(SHORTCUTS.settings)})`}
        active={view === 'settings'}
        onClick={() => goTo('settings')}
      />
    </aside>
  )
}
