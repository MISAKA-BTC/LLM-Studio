import { useEffect, useMemo, useRef } from 'react'
import { useStudio } from '../../store/studio'
import { useUi } from '../../store/ui'
import { Icon } from '../common'
import { IconButton, Kbd } from '../ui'
import { SHORTCUTS, VIEW_ICONS, VIEW_LABELS } from './shortcuts'
import { activateTab, closeTab, useWorkbench, type WorkbenchTab } from './workbenchState'

/** VS Code Editor Group Tab Strip. Tab contents retain their own bounded caches separately. */
export function WorkbenchTabs() {
  const tabs = useWorkbench((s) => s.tabs)
  const activeKey = useWorkbench((s) => s.activeKey)
  const conversations = useStudio((s) => s.conversations)
  const threads = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations])
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeKey])
  function label(tab: WorkbenchTab): string {
    if (tab.kind === 'view') return VIEW_LABELS[tab.view]
    if (tab.kind === 'empty') return tab.mode === 'code' ? 'New session' : 'New chat'
    return threads.get(tab.id)?.title || 'Untitled'
  }
  return (
    <header className="flex h-[35px] shrink-0 items-stretch border-b border-ink-200 bg-ink-50 select-none dark:border-ink-800 dark:bg-ink-950" aria-label="Workbench">
      <div
        ref={strip}
        className="workbench-tabs flex min-w-0 flex-1 overflow-x-auto"
        role="tablist"
        aria-label="Open tabs"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key) || event.nativeEvent.isComposing) return
          const index = tabs.findIndex((t) => t.key === activeKey)
          if (event.key === 'Delete') {
            event.preventDefault()
            closeTab(activeKey)
            return
          }
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          const tab = tabs[next]
          if (!tab) return
          event.preventDefault()
          activateTab(tab)
          requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true }))
        }}
      >
        {tabs.map((tab) => {
          const active = tab.key === activeKey
          const title = label(tab)
          const isCode = tab.kind === 'empty' ? tab.mode === 'code' : tab.kind === 'thread' && threads.get(tab.id)?.mode === 'agent'
          const icon = tab.kind === 'view' ? VIEW_ICONS[tab.view] : isCode ? 'code' : 'chat'
          return (
            <div
              key={tab.key}
              className={`group relative flex max-w-56 shrink-0 items-center border-r border-ink-200 transition-colors dark:border-ink-800 ${
                active
                  ? 'bg-white text-ink-900 dark:bg-ink-900 dark:text-white'
                  : 'bg-ink-50 text-ink-500 hover:bg-ink-100/80 dark:bg-ink-950 dark:text-[#969696] dark:hover:bg-[#1f1f1f]/70'
              }`}
              data-workbench-tab={tab.key}
            >
              {active && <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-arc-500" aria-hidden />}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="workbench-content"
                tabIndex={active ? 0 : -1}
                title={title}
                className="flex h-full min-w-0 items-center gap-1.5 pl-3 pr-2 text-[12px] outline-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-arc-500"
                onClick={() => activateTab(tab)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault()
                    closeTab(tab.key)
                  }
                }}
              >
                <Icon name={icon} className={`size-3.5 shrink-0 ${isCode ? 'text-arc-500 dark:text-arc-400' : 'opacity-80'}`} />
                <span className="truncate">{title}</span>
              </button>
              {(tab.kind !== 'empty' || tabs.length > 1) && (
                <button
                  type="button"
                  aria-label={`Close tab: ${title}`}
                  title="Close tab (keeps history and drafts)"
                  className={`mr-1.5 flex size-[18px] shrink-0 items-center justify-center rounded-[3px] transition-opacity hover:bg-ink-200 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-[#333333] ${
                    active ? 'opacity-70' : 'opacity-0'
                  }`}
                  onClick={() => closeTab(tab.key)}
                >
                  <Icon name="x" className="size-3" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-ink-200 px-1.5 dark:border-ink-800">
        <button
          type="button"
          className="hidden h-6 items-center gap-1.5 rounded-[3px] px-2 text-[11px] text-ink-500 hover:bg-ink-100 hover:text-ink-900 sm:inline-flex dark:text-[#9d9d9d] dark:hover:bg-[#2a2d2e] dark:hover:text-white"
          aria-label="Quick Open"
          title="Open a file or conversation"
          onClick={() => useUi.getState().setQuickOpen(true)}
        >
          <Icon name="search" className="size-3" />
          <Kbd shortcut={SHORTCUTS.quickOpen} />
        </button>
        <IconButton icon="more" label="Commands" shortcut={SHORTCUTS.paletteEditor} onClick={() => useUi.getState().openPalette()} className="!size-[24px]" />
      </div>
    </header>
  )
}
