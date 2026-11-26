// Antigravity-style top context selector strip mounted above the composer box:
//   [monitor] This Computer ⌄   [folder] misaka-studio ⌄   [gitBranch] main ⌄
//
// Popovers match Antigravity's exact menu structure:
// 1. Project selector: project list (checkmark on right) -> New Project -> No Project
// 2. Branch selector: muted folder header -> branch list (checkmark on right) -> Work in a New Worktree

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { folderName, useWorkspaceInfo } from '../../lib/agent/workspace'
import { bytes } from '../../lib/format'
import type { Conversation } from '../../lib/types'
import { useStudio } from '../../store/studio'
import { useUi } from '../../store/ui'
import { refreshGit, useGitStatus } from '../code/gitStore'
import { Icon, Spinner } from '../common'
import { goTo, switchAppMode } from '../shell/actions'
import { Popover } from '../ui'

const PILL =
  'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-ink-600 transition-colors hover:bg-ink-200/70 hover:text-ink-900 focus-visible:outline-1 focus-visible:outline-arc-500 dark:text-[#a1a1aa] dark:hover:bg-white/6 dark:hover:text-white'

const POPOVER_SURFACE =
  '!rounded-[14px] !border-ink-200 !bg-white !p-1.5 shadow-2xl dark:!border-[#2e2e32] dark:!bg-[#18181b]'

const ROW_ITEM =
  'flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2 text-left text-[13px] text-ink-800 transition-colors hover:bg-ink-100 focus-visible:bg-ink-100 focus-visible:outline-none disabled:opacity-50 dark:text-[#e4e4e7] dark:hover:bg-[#27272a] dark:focus-visible:bg-[#27272a]'

export function ComposerContextBar({
  conversation,
  workspace,
}: {
  conversation: Conversation | null
  workspace: string | null
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-1.5 pt-1 select-none"
      role="toolbar"
      aria-label="Workspace and branch context"
    >
      <MachineSelector />
      <WorkspaceSelector conversation={conversation} workspace={workspace} />
      {workspace && <BranchSelector conversation={conversation} workspace={workspace} />}
    </div>
  )
}

function MachineSelector() {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const system = useStudio((s) => s.system)
  const hw = system?.hardware
  const close = () => setOpen(false)

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Execution environment: This Computer"
        aria-label="Execution environment: This Computer"
        className={`${PILL} shrink-0`}
      >
        <Icon name="monitor" className="size-3.5 shrink-0 opacity-80" />
        <span>This Computer</span>
        <Icon name="chevronDown" className="size-3 shrink-0 opacity-60" />
      </button>

      <Popover anchor={anchor} open={open} onClose={close} placement="top-start" className={`w-64 ${POPOVER_SURFACE}`}>
        <div className="flex items-center gap-2.5 rounded-[9px] px-3 py-2 text-[13px] font-medium text-ink-900 dark:text-white">
          <Icon name="monitor" className="size-4 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate">This Computer</span>
          <Icon name="check" className="size-4 shrink-0 text-ink-900 dark:text-white" />
        </div>
        {hw && (
          <div className="px-3 pb-2 text-[11px] text-ink-500 dark:text-[#a1a1aa]">
            <div className="truncate">{hw.cpu_name}</div>
            <div>
              {hw.os} · {hw.arch} · {bytes(hw.total_memory)} RAM
            </div>
          </div>
        )}
        <div className="my-1 h-px bg-ink-200 dark:bg-[#27272a]" />
        <button
          type="button"
          className={ROW_ITEM}
          onClick={() => {
            close()
            useUi.getState().setBottomPanelOpen(true)
            useUi.getState().setBottomPanelTab('terminal')
          }}
        >
          <Icon name="terminal" className="size-4 shrink-0 opacity-75" />
          <span>Open Terminal</span>
        </button>
        <button
          type="button"
          className={ROW_ITEM}
          onClick={() => {
            close()
            goTo('monitor')
          }}
        >
          <Icon name="gauge" className="size-4 shrink-0 opacity-75" />
          <span>System Monitor</span>
        </button>
      </Popover>
    </>
  )
}

function WorkspaceSelector({
  conversation,
  workspace,
}: {
  conversation: Conversation | null
  workspace: string | null
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const entry = useWorkspaceInfo(workspace)
  const recent = useUi((s) => s.recentWorkspaces)
  const conversations = useStudio((s) => s.conversations)
  const info = entry?.status === 'ok' ? entry.info : null
  const missing = entry?.status === 'error'
  const label = workspace ? (info?.name ?? folderName(workspace)) : 'No Project'
  const close = () => setOpen(false)

  const allFolders = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (p: string | null | undefined) => {
      if (p && !seen.has(p)) {
        seen.add(p)
        out.push(p)
      }
    }
    push(workspace)
    for (const p of recent) push(p)
    for (const c of conversations) push(c.workspace)
    return out
  }, [workspace, recent, conversations])

  const selectProject = (path: string) => {
    close()
    const ui = useUi.getState()
    const studio = useStudio.getState()
    ui.setNoProject(false)
    ui.addRecentWorkspace(path)
    if (ui.appMode !== 'code') ui.setAppMode('code')
    if (conversation) {
      if (conversation.mode !== 'agent') studio.setConversationMode(conversation.id, 'agent')
      studio.setConversationWorkspace(conversation.id, path)
    } else {
      studio.newConversation({ mode: 'agent', workspace: path })
    }
    ui.focusComposer()
  }

  const selectNoProject = () => {
    close()
    const ui = useUi.getState()
    const studio = useStudio.getState()
    ui.setNoProject(true)
    if (conversation && conversation.messages.length === 0) {
      studio.setConversationWorkspace(conversation.id, null)
      studio.setConversationMode(conversation.id, 'chat')
      ui.setAppMode('chat')
    } else if (!conversation) {
      switchAppMode('chat')
    } else {
      studio.setConversationWorkspace(conversation.id, null)
    }
    ui.focusComposer()
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={workspace ? `${info?.root ?? workspace} — click to switch project` : 'Select a project folder'}
        aria-label={`Workspace folder: ${label}`}
        className={`${PILL} max-w-[14rem] ${missing ? 'text-amber-700 dark:text-amber-300' : ''}`}
      >
        <Icon
          name={missing ? 'warning' : workspace ? 'folder' : 'folderOff'}
          className={`size-3.5 shrink-0 ${missing ? 'text-amber-500' : 'opacity-80'}`}
        />
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="chevronDown" className="size-3 shrink-0 opacity-60" />
      </button>

      <Popover anchor={anchor} open={open} onClose={close} placement="top-start" className={`w-64 ${POPOVER_SURFACE}`}>
        {allFolders.length > 0 && (
          <>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {allFolders.map((path) => {
                const active = path === workspace
                return (
                  <button
                    key={path}
                    type="button"
                    title={path}
                    onClick={() => selectProject(path)}
                    className={`${ROW_ITEM} ${active ? 'font-medium text-ink-950 dark:text-white' : 'text-ink-600 dark:text-[#a1a1aa]'}`}
                  >
                    <Icon name="folder" className="size-4 shrink-0 opacity-85" />
                    <span className="min-w-0 flex-1 truncate">{folderName(path)}</span>
                    {active && <Icon name="check" className="size-4 shrink-0 text-ink-900 dark:text-white" />}
                  </button>
                )
              })}
            </div>
            <div className="my-1.5 h-px bg-ink-200 dark:bg-[#27272a]" />
          </>
        )}

        <button
          type="button"
          onClick={() => {
            close()
            useUi.getState().openWorkspacePicker(conversation?.id ?? null)
          }}
          className={`${ROW_ITEM} font-medium`}
        >
          <Icon name="folderPlus" className="size-4 shrink-0 opacity-85" />
          <span>New Project</span>
        </button>

        <div className="my-1.5 h-px bg-ink-200 dark:bg-[#27272a]" />

        <button
          type="button"
          onClick={selectNoProject}
          className={`${ROW_ITEM} ${!workspace ? 'font-medium text-ink-950 dark:text-white' : 'text-ink-500 dark:text-[#a1a1aa]'}`}
        >
          <Icon name="folderOff" className="size-4 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate">No Project</span>
          {!workspace && <Icon name="check" className="size-4 shrink-0 text-ink-900 dark:text-white" />}
        </button>
      </Popover>
    </>
  )
}

function BranchSelector({
  conversation,
  workspace,
}: {
  conversation: Conversation | null
  workspace: string
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const entry = useWorkspaceInfo(workspace)
  const git = useGitStatus(workspace)
  const info = entry?.status === 'ok' ? entry.info : null
  const isGit = git?.status ? git.status.is_git : Boolean(info?.is_git)
  const branch = git?.status?.is_git ? (git.status.branch ?? git.status.head) : (info?.branch ?? null)
  const dirtyCount = git?.status?.is_git ? git.status.files.length : 0
  const projectTitle = info?.name ?? folderName(workspace)

  useEffect(() => {
    if (!open || !isGit) return
    let alive = true
    const controller = new AbortController()
    setLoading(true)
    void api.workspace
      .gitBranches(workspace, controller.signal)
      .then((res) => {
        if (alive) setBranches(res.branches)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [open, workspace, isGit])

  if (!isGit && !branch) return null

  const close = () => setOpen(false)

  const checkout = async (target: string) => {
    const trimmed = target.trim()
    if (!trimmed || trimmed === branch || busy) {
      close()
      return
    }
    setBusy(true)
    try {
      await api.workspace.gitCheckout(workspace, trimmed, false)
      await refreshGit(workspace)
      useStudio.getState().toast('success', `Switched to branch ${trimmed}`)
      close()
    } catch (error) {
      useStudio.getState().toast('error', (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const createWorktree = async () => {
    if (busy) return
    setBusy(true)
    try {
      const created = await api.workspace.gitWorktree(workspace)
      const ui = useUi.getState()
      const studio = useStudio.getState()
      ui.setNoProject(false)
      ui.addRecentWorkspace(created.path)
      if (conversation) {
        if (conversation.mode !== 'agent') studio.setConversationMode(conversation.id, 'agent')
        studio.setConversationWorkspace(conversation.id, created.path)
      } else {
        studio.newConversation({ mode: 'agent', workspace: created.path })
      }
      studio.toast('success', `Working in new worktree (${created.branch}) — main checkout stays untouched.`)
      close()
    } catch (error) {
      useStudio.getState().toast('error', (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const list = branches.length > 0 ? branches : branch ? [branch] : []

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Git branch: ${branch ?? 'HEAD'}${dirtyCount > 0 ? ` (${dirtyCount} uncommitted changes)` : ''}`}
        className={`${PILL} max-w-[13rem]`}
      >
        {busy ? <Spinner className="size-3.5 shrink-0" /> : <Icon name="gitBranch" className="size-3.5 shrink-0 opacity-80" />}
        <span className="min-w-0 truncate">{branch ?? 'HEAD'}</span>
        {dirtyCount > 0 && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-label={`${dirtyCount} changed files`} />}
        <Icon name="chevronDown" className="size-3 shrink-0 opacity-60" />
      </button>

      <Popover anchor={anchor} open={open} onClose={close} placement="top-start" className={`w-72 ${POPOVER_SURFACE}`}>
        {/* Muted repository folder header matching Antigravity */}
        <div className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-ink-400 dark:text-[#71717a]">
          <Icon name="folder" className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{projectTitle}</span>
        </div>

        {loading && list.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-ink-500">
            <Spinner className="size-3.5" />
            <span>Reading branches…</span>
          </div>
        ) : (
          <div className="max-h-52 space-y-0.5 overflow-y-auto">
            {list.map((item) => {
              const active = item === branch
              return (
                <button
                  key={item}
                  type="button"
                  disabled={busy}
                  onClick={() => void checkout(item)}
                  className={`${ROW_ITEM} ${active ? 'font-medium text-ink-950 dark:text-white' : 'text-ink-600 dark:text-[#a1a1aa]'}`}
                >
                  <Icon name="gitBranch" className="size-4 shrink-0 opacity-85" />
                  <span className="min-w-0 flex-1 truncate">{item}</span>
                  {active && <Icon name="check" className="size-4 shrink-0 text-ink-900 dark:text-white" />}
                </button>
              )
            })}
          </div>
        )}

        <div className="my-1.5 h-px bg-ink-200 dark:bg-[#27272a]" />

        <button
          type="button"
          disabled={busy}
          onClick={() => void createWorktree()}
          className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2 text-left transition-colors hover:bg-ink-100 focus-visible:bg-ink-100 focus-visible:outline-none disabled:opacity-50 dark:hover:bg-[#27272a] dark:focus-visible:bg-[#27272a]"
        >
          <Icon name="worktree" className="size-4 shrink-0 text-ink-500 dark:text-[#a1a1aa]" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-ink-800 dark:text-[#e4e4e7]">Work in a New Worktree</span>
            <span className="block text-[11.5px] text-ink-500 dark:text-[#71717a]">Keeps your checkout untouched</span>
          </span>
        </button>
      </Popover>
    </>
  )
}
