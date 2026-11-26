// VS Code-style docked Bottom Panel (Terminal & Runtime Output).
//
// Lives underneath `<main id="workbench-content">` without altering `appMode` or
// `activeConversationId`, so toggling the bottom panel from Chat or any other view
// keeps the current conversation and sidebar untouched.

import { useLayoutEffect, useRef, type PointerEvent } from 'react'
import { folderName } from '../../lib/agent/workspace'
import { bytes } from '../../lib/format'
import { useStudio } from '../../store/studio'
import { useUi, type BottomPanelTab } from '../../store/ui'
import { useHomeDir } from '../code/shared'
import { Terminal } from '../code/TerminalPanel'
import { clearTerminal, stopCommand, useTerminal, useTerminalBusy } from '../code/terminalStore'
import { Icon } from '../common'
import { IconButton, StatusDot } from '../ui'
import { RetainedView } from './RetainedView'

const MIN_HEIGHT = 140
const MAX_HEIGHT = 480
const DEFAULT_HEIGHT = 220

export function BottomPanel() {
  const open = useUi((s) => s.bottomPanelOpen)
  return (
    <RetainedView active={open}>
      <ResizableBottomPanel />
    </RetainedView>
  )
}

function ResizableBottomPanel() {
  const savedHeight = useUi((s) => s.bottomPanelHeight)
  const height = Number.isFinite(savedHeight) ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, savedHeight)) : DEFAULT_HEIGHT
  const tab = useUi((s) => s.bottomPanelTab)
  const setTab = useUi((s) => s.setBottomPanelTab)
  const close = () => useUi.getState().setBottomPanelOpen(false)

  const conversation = useStudio((s) => s.conversations.find((c) => c.id === s.activeConversationId) ?? null)
  const recentWorkspaces = useUi((s) => s.recentWorkspaces)
  const home = useHomeDir()
  const root = conversation?.workspace ?? recentWorkspaces[0] ?? home
  const terminalBusy = useTerminalBusy(root)
  const session = useTerminal(root)
  const running = session.running !== null
  const runningLocal = running && session.blocks.find((b) => b.id === session.running)?.local === true

  const pane = useRef<HTMLElement>(null)
  const stop = useRef<(() => void) | null>(null)
  useLayoutEffect(() => () => stop.current?.(), [])

  const onResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    stop.current?.()
    const startY = event.clientY
    const initial = pane.current?.getBoundingClientRect().height || height
    const cursor = document.body.style.cursor
    const select = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    let next = initial
    const move = (e: globalThis.PointerEvent) => {
      next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, initial + (startY - e.clientY)))
      if (pane.current) pane.current.style.height = `${next}px`
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
    const done = () => {
      cleanup()
      useUi.getState().setBottomPanelHeight(next)
    }
    const cancel = () => {
      cleanup()
      if (pane.current) pane.current.style.height = `${height}px`
    }
    stop.current = cancel
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
  }

  return (
    <section
      ref={pane}
      aria-label="Workbench bottom panel"
      style={{ height, maxHeight: '55vh' }}
      className="relative flex shrink-0 flex-col border-t border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-950"
    >
      <div
        role="separator"
        aria-label="Resize bottom panel"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={MAX_HEIGHT}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onResize}
        onDoubleClick={() => useUi.getState().setBottomPanelHeight(DEFAULT_HEIGHT)}
        onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? MIN_HEIGHT
              : event.key === 'End'
                ? MAX_HEIGHT
                : height + (event.key === 'ArrowUp' ? 20 : -20)
          useUi.getState().setBottomPanelHeight(next)
        }}
        className="absolute -top-1 inset-x-0 z-20 h-2 cursor-row-resize hover:bg-arc-500/40 focus-visible:bg-arc-500 focus-visible:outline-none"
      />

      <div className="flex h-8 shrink-0 items-stretch gap-1 border-b border-ink-200 px-2.5 select-none dark:border-ink-800" role="tablist" aria-label="Bottom panel tabs">
        <BottomTab id="terminal" active={tab === 'terminal'} label="Terminal" dot={terminalBusy} onSelect={setTab} />
        <BottomTab id="output" active={tab === 'output'} label="Output" onSelect={setTab} />

        <div className="ml-auto flex items-center gap-1.5">
          {tab === 'terminal' && root && (
            <>
              <span className="mono hidden max-w-52 items-center gap-1 truncate text-[11px] text-ink-500 sm:inline-flex dark:text-ink-400" title={root}>
                <Icon name="folder" className="size-3 shrink-0" />
                <span className="truncate">{folderName(root)}{session.cwd ? `/${session.cwd}` : ''}</span>
              </span>
              {running && !runningLocal && (
                <button
                  type="button"
                  className="btn-outline h-5 gap-1 px-1.5 py-0 text-[11px]"
                  onClick={() => stopCommand(root)}
                  title="Stop command (Ctrl+C)"
                >
                  <Icon name="stop" className="size-3" />
                  Stop
                </button>
              )}
              <button
                type="button"
                className="btn-ghost h-5 px-1.5 py-0 text-[11px]"
                onClick={() => clearTerminal(root)}
                disabled={session.blocks.length === 0 || (running && session.blocks.length === 1)}
                title="Clear terminal (Ctrl+L)"
              >
                Clear
              </button>
            </>
          )}
          <IconButton icon="x" label="Close Bottom Panel" onClick={close} className="!size-[22px]" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <RetainedView active={tab === 'terminal'}>
          <div className="h-full min-h-0 overflow-hidden">
            {root ? (
              <Terminal root={root} conversationId={conversation?.id ?? null} idPrefix="bottom-terminal-input" hideHeader />
            ) : (
              <div className="flex h-full items-center justify-between gap-3 px-4 text-xs text-ink-500 dark:text-ink-400">
                <span>Runtime workspace is connecting or no folder is selected yet.</span>
                <button
                  type="button"
                  className="btn-outline px-2.5 py-1 text-xs"
                  onClick={() => useUi.getState().openWorkspacePicker(conversation?.mode === 'agent' ? conversation.id : null)}
                >
                  <Icon name="folderOpen" className="size-3.5" />
                  Open folder…
                </button>
              </div>
            )}
          </div>
        </RetainedView>

        <RetainedView active={tab === 'output'}>
          <RuntimeOutputPane />
        </RetainedView>
      </div>
    </section>
  )
}

function BottomTab({
  id,
  active,
  label,
  dot,
  onSelect,
}: {
  id: BottomPanelTab
  active: boolean
  label: string
  dot?: boolean
  onSelect: (tab: BottomPanelTab) => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={`relative inline-flex h-full items-center gap-1.5 border-b-2 px-2 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
        active
          ? 'border-arc-500 text-ink-900 dark:text-white'
          : 'border-transparent text-ink-500 hover:text-ink-800 dark:text-[#969696] dark:hover:text-white'
      }`}
    >
      <span>{label}</span>
      {dot && <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />}
    </button>
  )
}

function RuntimeOutputPane() {
  const connected = useStudio((s) => s.connected)
  const runtime = useStudio((s) => s.runtime)
  const sample = useStudio((s) => s.sample)
  const downloads = useStudio((s) => s.downloads)
  const queue = useStudio((s) => s.miningQueue)
  const activeDownloads = downloads.filter((d) => d.status === 'downloading' || d.status === 'verifying')

  return (
    <div className="mono h-full space-y-1.5 overflow-y-auto px-3.5 py-2.5 text-[11.5px] leading-relaxed text-ink-700 dark:text-[#cccccc]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <StatusDot tone={connected ? 'green' : 'red'} />
          {connected ? 'Runtime connected' : 'Runtime unreachable'}
        </span>
        <span>Backend: {runtime?.backend ?? '—'}</span>
        <span>Model: {runtime?.model_id ?? 'none loaded'}</span>
        {runtime?.context_size ? <span>Context: {runtime.context_size.toLocaleString()} tok</span> : null}
      </div>

      {sample && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-500 dark:text-ink-400">
          <span>CPU: {sample.hardware.cpu_percent.toFixed(0)}%</span>
          <span>RAM: {bytes(sample.hardware.memory_used)} / {bytes(sample.hardware.memory_total)}</span>
          <span>Speed: {sample.generation.last_tokens_per_second ? `${sample.generation.last_tokens_per_second.toFixed(1)} tok/s` : 'idle'}</span>
          <span>Total generated: {sample.generation.total_tokens.toLocaleString()} tok</span>
        </div>
      )}

      {queue && (
        <div className="text-ink-500 dark:text-ink-400">
          Mining ({queue.mode}): {queue.counts.running} running · {queue.counts.queued} queued · {queue.counts.committed} committed
        </div>
      )}

      {activeDownloads.length > 0 && (
        <div className="pt-1 text-arc-600 dark:text-arc-400">
          {activeDownloads.map((d) => (
            <div key={d.id}>
              Downloading {d.repo}/{d.file}: {bytes(d.downloaded)}
              {d.total ? ` / ${bytes(d.total)}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
