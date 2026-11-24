// Antigravity / VS Code Command Center top bar.
//
// Organizes the IDE window into three clear regions:
// 1. Left: Brand + Agent/Chat mode switcher + active workspace badge
// 2. Center: Command Center bar (Quick Open files/threads + Command Palette trigger)
// 3. Right: Model status indicator + VS Code layout toggles (Primary Sidebar, Terminal, Secondary Panel)

import logo from '../../assets/llm-studio.png'
import { useAgent } from '../../lib/agent/run'
import { folderName } from '../../lib/agent/workspace'
import { formatShortcut } from '../../lib/keys'
import { chatModelId, useStudio } from '../../store/studio'
import { useUi, type AppMode } from '../../store/ui'
import { effectivePanel, togglePane } from '../code/shared'
import { Icon } from '../common'
import { IconButton, Kbd, StatusDot } from '../ui'
import { goTo, switchAppMode } from './actions'
import { SHORTCUTS, SIDE_ICONS, SIDE_LABELS, SIDE_SHORTCUTS } from './shortcuts'

const MODES: AppMode[] = ['code', 'chat']

export function TitleBar() {
  const view = useStudio((s) => s.view)
  const connected = useStudio((s) => s.connected)
  const modelId = useStudio(chatModelId)
  const loadingModelId = useStudio((s) => s.loadingModelId)
  const workspace = useStudio((s) => {
    const active = s.conversations.find((c) => c.id === s.activeConversationId)
    return active?.mode === 'agent' ? (active.workspace ?? null) : null
  })
  const agentRun = useAgent((s) => s.run)
  const appMode = useUi((s) => s.appMode)
  const sidebarOpen = useUi((s) => s.sidebarOpen)
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const rightPanel = useUi((s) => s.rightPanel)
  const setQuickOpen = useUi((s) => s.setQuickOpen)
  const openPalette = useUi((s) => s.openPalette)
  const setModelsTab = useUi((s) => s.setModelsTab)

  const defaultRight = appMode === 'code' ? 'session' : 'context'
  const activeRight = effectivePanel(rightPanel, appMode)
  const terminalActive = appMode === 'code' && activeRight === 'terminal' && view === 'chat'
  const rightOpen = activeRight !== null && view === 'chat'

  const openModelSearch = () => {
    setModelsTab('discover')
    goTo('models')
  }

  return (
    <header
      className="flex h-[34px] shrink-0 items-center justify-between gap-2 border-b border-ink-200 bg-ink-50 px-2.5 select-none dark:border-ink-800 dark:bg-ink-950"
      aria-label="Workbench title bar"
    >
      {/* Left: Brand & Antigravity Agent / Chat workspace switcher */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex items-center gap-1.5 pl-0.5 pr-1">
          <img src={logo} alt="" className="size-4 shrink-0 object-contain" />
          <span className="hidden text-[12px] font-semibold tracking-tight text-ink-900 sm:inline dark:text-[#cccccc]">
            LLM Studio
          </span>
        </div>

        <div
          className="inline-flex h-[22px] items-center rounded-[3px] border border-ink-300 bg-ink-100 p-px dark:border-ink-700 dark:bg-[#252526]"
          role="group"
          aria-label="Workspace mode"
        >
          {MODES.map((mode) => {
            const active = view === 'chat' && appMode === mode
            const busy = mode === 'code' && agentRun !== null
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                title={`${SIDE_LABELS[mode]} (${formatShortcut(SIDE_SHORTCUTS[mode])})`}
                onClick={() => switchAppMode(mode)}
                className={`relative inline-flex h-[18px] items-center gap-1 rounded-[2px] px-2 text-[11px] font-medium transition-colors ${
                  active
                    ? 'bg-arc-600 text-white'
                    : 'text-ink-600 hover:text-ink-900 dark:text-[#9d9d9d] dark:hover:text-white'
                }`}
              >
                <Icon name={SIDE_ICONS[mode]} className="size-3" />
                <span>{mode === 'code' ? 'Agent' : 'Chat'}</span>
                {busy && !active && <StatusDot tone="arc" pulse className="ml-0.5" />}
              </button>
            )
          })}
        </div>

        {appMode === 'code' && workspace && (
          <span
            className="hidden max-w-36 items-center gap-1 truncate rounded-[3px] border border-ink-200 bg-white px-1.5 py-0.5 text-[11px] text-ink-600 lg:inline-flex dark:border-ink-800 dark:bg-[#252526] dark:text-[#cccccc]"
            title={workspace}
          >
            <Icon name="folder" className="size-3 shrink-0 text-arc-500" />
            <span className="truncate">{folderName(workspace)}</span>
          </span>
        )}
      </div>

      {/* Center: VS Code Command Center search bar */}
      <div className="flex min-w-0 flex-1 justify-center px-2">
        <div className="flex h-[24px] w-full max-w-[440px] items-center overflow-hidden rounded-[4px] border border-ink-300 bg-white text-[11.5px] text-ink-500 transition-colors hover:border-ink-400 dark:border-ink-700 dark:bg-[#252526] dark:text-[#9d9d9d] dark:hover:border-[#505050]">
          <button
            type="button"
            onClick={() => setQuickOpen(true)}
            title={`Search files and conversations (${formatShortcut(SHORTCUTS.quickOpen)})`}
            className="flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 px-2.5 hover:bg-ink-100/70 hover:text-ink-900 dark:hover:bg-[#2a2d2e] dark:hover:text-white"
          >
            <Icon name="search" className="size-3.5 shrink-0 opacity-75" />
            <span className="truncate">
              {workspace ? `${folderName(workspace)} — Search files & threads` : 'Search threads, models & commands'}
            </span>
            <Kbd shortcut={SHORTCUTS.quickOpen} className="ml-1 hidden md:inline-flex" />
          </button>
          <span className="h-3.5 w-px shrink-0 bg-ink-200 dark:bg-ink-700" aria-hidden />
          <button
            type="button"
            onClick={() => openPalette()}
            title={`Command Palette (${formatShortcut(SHORTCUTS.palette)})`}
            aria-label="Open Command Palette"
            className="inline-flex h-full shrink-0 items-center gap-1 px-2 text-[11px] hover:bg-ink-100 hover:text-ink-900 dark:hover:bg-[#2a2d2e] dark:hover:text-white"
          >
            <Icon name="terminal" className="size-3" />
            <Kbd shortcut={SHORTCUTS.palette} className="hidden sm:inline-flex" />
          </button>
        </div>
      </div>

      {/* Right: Model quick button + VS Code layout controls */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={openModelSearch}
          title="Open Model Search (Hugging Face GGUF & MLX catalog)"
          className={`hidden h-[22px] items-center gap-1 rounded-[3px] border px-2 text-[11px] font-medium transition-colors md:inline-flex ${
            view === 'models'
              ? 'border-arc-500/60 bg-arc-600/15 text-arc-700 dark:border-arc-500/60 dark:bg-[#04395e] dark:text-white'
              : 'border-ink-300 bg-white text-ink-700 hover:bg-ink-100 dark:border-ink-700 dark:bg-[#252526] dark:text-[#cccccc] dark:hover:bg-[#2a2d2e]'
          }`}
        >
          <Icon name="modelSearch" className="size-3.5 shrink-0 text-arc-500 dark:text-arc-400" />
          <span>Model Search</span>
        </button>

        <button
          type="button"
          onClick={() => openPalette('load model ')}
          title={modelId ? `Active model: ${modelId} — click to switch` : 'Select or load a model'}
          className="hidden h-[22px] max-w-[11rem] items-center gap-1.5 rounded-[3px] px-2 text-[11px] text-ink-600 hover:bg-ink-100 hover:text-ink-900 xl:inline-flex dark:text-[#cccccc] dark:hover:bg-[#2a2d2e] dark:hover:text-white"
        >
          <StatusDot tone={!connected ? 'red' : loadingModelId ? 'amber' : modelId ? 'green' : 'gray'} pulse={!!loadingModelId} />
          <span className="mono truncate">{modelId ?? 'No model'}</span>
        </button>

        <span className="mx-0.5 hidden h-3.5 w-px bg-ink-200 sm:inline-block dark:bg-ink-800" aria-hidden />

        <IconButton
          icon="panelLeft"
          label={sidebarOpen ? 'Hide Primary Side Bar' : 'Show Primary Side Bar'}
          active={sidebarOpen}
          shortcut={SHORTCUTS.toggleSidebar}
          onClick={toggleSidebar}
          className="!size-[24px]"
        />
        <IconButton
          icon="panelBottom"
          label="Toggle Terminal Panel"
          active={terminalActive}
          shortcut={SHORTCUTS.terminalPanel}
          onClick={() => {
            if (view !== 'chat') goTo('chat')
            if (appMode !== 'code') switchAppMode('code')
            togglePane('terminal', 'code')
          }}
          className="!size-[24px]"
        />
        <IconButton
          icon="panelRight"
          label={rightOpen ? 'Hide Secondary Side Bar' : 'Show Secondary Side Bar'}
          active={rightOpen}
          shortcut={SHORTCUTS.sessionPanel}
          onClick={() => {
            if (view !== 'chat') goTo('chat')
            useUi.getState().setRightPanel(rightOpen ? null : defaultRight)
          }}
          className="!size-[24px]"
        />
      </div>
    </header>
  )
}
