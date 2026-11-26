// Antigravity-style "Create Project" dialog — Drop-first + Native OS Folder Picker.
//
// Zero overwhelming in-app filesystem trees: users either drag & drop a folder directly
// onto the drop card or click "+ Add Folder" to choose via Finder's native OS dialog.

import { useState } from 'react'
import { api } from '../../lib/api'
import { useAgent } from '../../lib/agent/run'
import { folderName, rememberWorkspace } from '../../lib/agent/workspace'
import { useFileDrop } from '../../lib/fileDrop'
import { useStudio } from '../../store/studio'
import { useUi } from '../../store/ui'
import { Icon, Spinner } from '../common'
import { Modal } from '../ui'

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx <= 0) return null
  return trimmed.slice(0, idx)
}

function PickerBody({ conversationId, onClose }: { conversationId: string | null; onClose: () => void }) {
  const conversation = useStudio((s) => (conversationId ? (s.conversations.find((c) => c.id === conversationId) ?? null) : null))
  const runHere = useAgent((s) => s.run !== null && s.run.conversationId === conversationId)

  const [tab, setTab] = useState<'local' | 'remote'>('local')
  const [selectedFolder, setSelectedFolder] = useState<string | null>(conversation?.workspace ?? null)
  const [remotePath, setRemotePath] = useState('')
  const [pickingNative, setPickingNative] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [confirmMove, setConfirmMove] = useState<string | null>(null)

  const choose = async (raw: string, confirmed = false) => {
    const path = raw.trim()
    if (!path || opening) return
    if (runHere) {
      setOpenError('The agent is currently running in this thread. Stop it before changing folders.')
      return
    }
    setOpening(path)
    setOpenError(null)
    try {
      let info
      try {
        info = await api.workspace.open(path)
      } catch (err) {
        // If the user dropped a file inside a project folder, open its parent folder automatically!
        const parent = parentDirectory(path)
        if (!parent) throw err
        info = await api.workspace.open(parent)
      }
      const studio = useStudio.getState()
      const ui = useUi.getState()
      const thread = conversationId ? studio.conversations.find((c) => c.id === conversationId) : undefined
      if (thread && (thread.changes?.length ?? 0) > 0 && thread.workspace && thread.workspace !== info.root && !confirmed) {
        setConfirmMove(info.root)
        return
      }
      rememberWorkspace(info)
      ui.setNoProject(false)
      if (ui.appMode !== 'code') ui.setAppMode('code')
      if (thread) {
        if ((thread.mode ?? 'chat') !== 'agent') studio.setConversationMode(thread.id, 'agent')
        if (thread.workspace !== info.root) {
          studio.setConversationWorkspace(thread.id, info.root)
          if (thread.workspace) studio.updateConversation(thread.id, { changes: [] })
        }
      } else {
        studio.newConversation({ mode: 'agent', workspace: info.root })
      }
      ui.addRecentWorkspace(info.root)
      studio.setView('chat')
      onClose()
      ui.focusComposer()
    } catch (error) {
      setOpenError((error as Error).message)
    } finally {
      setOpening(null)
    }
  }

  const { dragging, dropHandlers, dropRef } = useFileDrop({
    kind: 'folder',
    onPaths: (paths) => {
      if (opening) return
      const valid = paths.filter((p): p is string => Boolean(p && p.trim()))
      if (valid.length === 0) {
        setOpenError('Drop a folder from Finder in the desktop app, or click "+ Add Folder".')
        return
      }
      setConfirmMove(null)
      setOpenError(null)
      void choose(valid[0]!)
    },
  })

  const handleNativePick = async () => {
    if (pickingNative || opening) return
    setPickingNative(true)
    setOpenError(null)
    try {
      const { path } = await api.workspace.pickFolder()
      if (path) {
        setSelectedFolder(path)
        await choose(path)
      }
    } catch (error) {
      setOpenError((error as Error).message)
    } finally {
      setPickingNative(false)
    }
  }

  const handleSkip = () => {
    const ui = useUi.getState()
    const studio = useStudio.getState()
    ui.setNoProject(true)
    if (conversation && conversation.messages.length === 0) {
      studio.setConversationWorkspace(conversation.id, null)
      studio.setConversationMode(conversation.id, 'chat')
      ui.setAppMode('chat')
    }
    onClose()
    ui.focusComposer()
  }

  return (
    <div ref={dropRef} className="relative flex flex-col p-5 select-none" {...dropHandlers}>
      {/* Header: Create Project + circular close button */}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink-900 dark:text-white">Create Project</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex size-8 items-center justify-center rounded-full border border-ink-200 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-arc-500 dark:border-[#323236] dark:text-[#a1a1aa] dark:hover:bg-[#27272a] dark:hover:text-white"
        >
          <Icon name="x" className="size-4" />
        </button>
      </div>

      {/* Segmented Mode Bar: This Computer | Remote */}
      <div
        className="mt-4 grid grid-cols-2 rounded-full border border-ink-200 bg-ink-100/80 p-1 dark:border-[#2a2a2e] dark:bg-[#141417]"
        role="tablist"
        aria-label="Project location"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'local'}
          onClick={() => setTab('local')}
          className={`inline-flex h-8 items-center justify-center gap-2 rounded-full text-[13px] font-medium transition-colors ${
            tab === 'local'
              ? 'border border-ink-300/80 bg-white text-ink-900 shadow-xs dark:border-[#38383d] dark:bg-[#242429] dark:text-white'
              : 'text-ink-500 hover:text-ink-900 dark:text-[#a1a1aa] dark:hover:text-white'
          }`}
        >
          <Icon name="monitor" className="size-3.5" />
          <span>This Computer</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'remote'}
          onClick={() => setTab('remote')}
          className={`inline-flex h-8 items-center justify-center gap-2 rounded-full text-[13px] font-medium transition-colors ${
            tab === 'remote'
              ? 'border border-ink-300/80 bg-white text-ink-900 shadow-xs dark:border-[#38383d] dark:bg-[#242429] dark:text-white'
              : 'text-ink-500 hover:text-ink-900 dark:text-[#a1a1aa] dark:hover:text-white'
          }`}
        >
          <Icon name="cloud" className="size-3.5" />
          <span>Remote</span>
        </button>
      </div>

      {tab === 'local' ? (
        <div className="mt-4">
          <div className="text-[13px] font-medium text-ink-600 dark:text-[#a1a1aa]">Select Folder(s)</div>

          {/* Drop Zone */}
          <div
            className={`mt-2.5 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
              dragging
                ? 'border-arc-500 bg-arc-500/10 text-arc-600 dark:text-arc-300'
                : 'border-ink-300 bg-ink-50/50 text-ink-500 dark:border-[#323238] dark:bg-[#141417] dark:text-[#a1a1aa]'
            }`}
          >
            <div className="rounded-lg border border-ink-200 bg-white p-2 text-ink-500 dark:border-[#2e2e34] dark:bg-[#202024] dark:text-[#d4d4d8]">
              {opening ? <Spinner className="size-5 text-arc-500" /> : <Icon name="upload" className="size-5" />}
            </div>
            <div className="text-[13px] font-medium text-ink-800 dark:text-[#e4e4e7]">
              フォルダをここにドラッグ＆ドロップ
            </div>
            <div className="text-[11.5px] text-ink-500 dark:text-[#71717a]">
              Finder からプロジェクトのフォルダ（または中のファイル）をそのままドロップできます
            </div>
          </div>

          {selectedFolder && (
            <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2 text-[13px] dark:border-[#2e2e34] dark:bg-[#202024]">
              <div className="flex min-w-0 items-center gap-2">
                <Icon name="folder" className="size-4 shrink-0 text-arc-500" />
                <span className="font-medium text-ink-900 dark:text-white">{folderName(selectedFolder)}</span>
                <span className="mono truncate text-xs text-ink-400">{selectedFolder}</span>
              </div>
              <button
                type="button"
                aria-label="Clear selected folder"
                onClick={() => setSelectedFolder(null)}
                className="icon-btn size-6"
              >
                <Icon name="x" className="size-3.5" />
              </button>
            </div>
          )}

          {/* + Add Folder button (launches native macOS Finder folder chooser) */}
          <button
            type="button"
            disabled={pickingNative || opening !== null}
            onClick={() => void handleNativePick()}
            className="mt-2.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-ink-200 bg-ink-50/80 text-[13.5px] font-medium text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50 dark:border-[#2d2d32] dark:bg-[#222226] dark:text-[#d4d4d8] dark:hover:bg-[#2a2a30] dark:hover:text-white"
          >
            {pickingNative ? <Spinner className="size-4" /> : <Icon name="plus" className="size-4" />}
            <span>Add Folder</span>
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="text-[13px] font-medium text-ink-600 dark:text-[#a1a1aa]">Remote / Mounted Workspace Path</div>
          <input
            className="input mono py-2 text-[13px]"
            placeholder="/Volumes/remote-project or mounted SSHFS path"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && remotePath.trim()) {
                e.preventDefault()
                void choose(remotePath)
              }
            }}
          />
          <p className="text-xs leading-relaxed text-ink-500 dark:text-[#71717a]">
            Connect any mounted remote filesystem (SSHFS / SMB / NFS) accessible to the runtime.
          </p>
        </div>
      )}

      {openError && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <Icon name="warning" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{openError}</span>
        </p>
      )}

      {confirmMove && (
        <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p>
            Moving from <span className="mono">{folderName(conversation?.workspace ?? '')}</span> to{' '}
            <span className="mono">{folderName(confirmMove)}</span> clears the thread&apos;s revertable change tracking.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setConfirmMove(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary px-2.5 py-1 text-xs"
              onClick={() => {
                const target = confirmMove
                setConfirmMove(null)
                void choose(target, true)
              }}
            >
              Switch Project
            </button>
          </div>
        </div>
      )}

      {/* Footer Actions: Skip + Select */}
      <div className="mt-5 flex items-center justify-end gap-2">
        {(selectedFolder || (tab === 'remote' && remotePath.trim())) && (
          <button
            type="button"
            disabled={opening !== null}
            onClick={() => {
              const target = tab === 'remote' ? remotePath : (selectedFolder ?? '')
              if (target) void choose(target)
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-arc-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-arc-500 disabled:opacity-50"
          >
            {opening ? <Spinner className="size-3.5" /> : <Icon name="check" className="size-3.5" />}
            <span>Create Project</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleSkip}
          className="inline-flex h-9 items-center justify-center rounded-full border border-ink-200 bg-ink-100 px-4 text-[13px] font-medium text-ink-700 transition-colors hover:bg-ink-200 hover:text-ink-950 dark:border-[#323236] dark:bg-[#232328] dark:text-[#e4e4e7] dark:hover:bg-[#2d2d33] dark:hover:text-white"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

export function WorkspacePicker() {
  const picker = useUi((s) => s.workspacePicker)
  const close = useUi((s) => s.closeWorkspacePicker)
  return (
    <Modal
      open={picker !== null}
      onClose={close}
      label="Create Project"
      className="max-w-[500px] !rounded-2xl dark:!border-[#2c2c30] dark:!bg-[#18181b]"
    >
      {picker && <PickerBody key={picker.conversationId ?? 'new'} conversationId={picker.conversationId} onClose={close} />}
    </Modal>
  )
}
