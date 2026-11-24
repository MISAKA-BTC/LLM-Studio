// Open tabs are navigation, never copies of conversations or their message histories.
import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useStudio, type View } from '../../store/studio'
import { useUi, type AppMode } from '../../store/ui'
import { goTo, openThread } from './actions'

export type WorkbenchTab =
  | { key: string; kind: 'thread'; id: string }
  | { key: string; kind: 'view'; view: Exclude<View, 'chat'> }
  | { key: string; kind: 'empty'; mode: AppMode }

export const MAX_OPEN_TABS = 16
type State = { tabs: WorkbenchTab[]; activeKey: string; visit: (tab: WorkbenchTab) => void }
export const useWorkbench = create<State>()(persist((set) => ({
  tabs: [], activeKey: '',
  visit: (tab) => set((s) => {
    if (s.activeKey === tab.key && s.tabs.some((t) => t.key === tab.key)) return s
    const tabs = s.tabs.some((t) => t.key === tab.key) ? s.tabs : [...s.tabs, tab].slice(-MAX_OPEN_TABS)
    return { tabs, activeKey: tab.key }
  }),
}), {
  name: 'misaka-studio.workbench', version: 1,
  partialize: (s) => ({ tabs: s.tabs, activeKey: s.activeKey }),
  merge: (saved, current) => {
    const value = saved as Partial<State> | null
    const tabs = Array.isArray(value?.tabs) ? value.tabs.filter(validTab).slice(-MAX_OPEN_TABS) : []
    return { ...current, tabs, activeKey: typeof value?.activeKey === 'string' ? value.activeKey : '' }
  },
}))

function validTab(tab: unknown): tab is WorkbenchTab {
  if (!tab || typeof tab !== 'object') return false
  const t = tab as WorkbenchTab
  if (typeof t.key !== 'string') return false
  if (t.kind === 'thread') return typeof t.id === 'string' && t.key === `thread:${t.id}`
  if (t.kind === 'empty') return (t.mode === 'chat' || t.mode === 'code') && t.key === `empty:${t.mode}`
  return t.kind === 'view' && ['models', 'image', 'network', 'monitor', 'settings'].includes(t.view) && t.key === `view:${t.view}`
}

function currentTab(): WorkbenchTab {
  const s = useStudio.getState()
  if (s.view !== 'chat') return { key: `view:${s.view}`, kind: 'view', view: s.view }
  if (s.activeConversationId) return { key: `thread:${s.activeConversationId}`, kind: 'thread', id: s.activeConversationId }
  const mode = useUi.getState().appMode
  return { key: `empty:${mode}`, kind: 'empty', mode }
}

export function activateTab(tab: WorkbenchTab): void {
  if (tab.kind === 'thread') {
    if (!useStudio.getState().conversations.some((c) => c.id === tab.id)) return
    openThread(tab.id)
  } else if (tab.kind === 'view') goTo(tab.view)
  else {
    useUi.getState().setAppMode(tab.mode)
    useStudio.setState({ activeConversationId: null, view: 'chat' })
  }
  useWorkbench.getState().visit(tab)
}

/** Closing a tab stops displaying it; generation, history and drafts remain untouched. */
export function closeTab(key: string): void {
  const s = useWorkbench.getState()
  const index = s.tabs.findIndex((t) => t.key === key)
  if (index < 0) return
  const tabs = s.tabs.filter((t) => t.key !== key)
  useWorkbench.setState({ tabs })
  if (s.activeKey !== key) return
  const next = tabs[Math.min(index, tabs.length - 1)]
  if (next) activateTab(next)
  else {
    const mode = useUi.getState().appMode
    activateTab({ key: `empty:${mode}`, kind: 'empty', mode })
  }
}

export function cycleTab(direction: 1 | -1): void {
  const s = useWorkbench.getState()
  if (s.tabs.length < 2) return
  const index = Math.max(0, s.tabs.findIndex((t) => t.key === s.activeKey))
  const tab = s.tabs[(index + direction + s.tabs.length) % s.tabs.length]
  if (tab) activateTab(tab)
}

/** Only navigation and a changed history membership do work; streamed tokens do neither. */
export function useWorkbenchSync(): void {
  useEffect(() => {
    const sync = () => useWorkbench.getState().visit(currentTab())
    const prune = () => {
      const ids = new Set(useStudio.getState().conversations.map((c) => c.id))
      const s = useWorkbench.getState()
      const tabs = s.tabs.filter((t) => t.kind !== 'thread' || ids.has(t.id))
      if (tabs.length !== s.tabs.length) useWorkbench.setState({ tabs })
    }
    prune()
    sync()
    const stopStudio = useStudio.subscribe((s, before) => {
      if (s.conversations !== before.conversations) prune()
      if (s.view !== before.view || s.activeConversationId !== before.activeConversationId) sync()
    })
    const stopUi = useUi.subscribe((s, before) => {
      if (s.appMode !== before.appMode && !useStudio.getState().activeConversationId) sync()
    })
    return () => { stopStudio(); stopUi() }
  }, [])
}
