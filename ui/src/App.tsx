// The window.
//
// Everything long-lived is wired here: the initial fetch, the two SSE subscriptions, the theme,
// the keyboard shortcuts, the one mining poll and the sync that keeps the thread in view on the
// side in view (Chat or Code). Each is set up once for the life of the window rather than per
// view, so switching tabs does not tear down the metrics stream and lose the sparkline history.
//
// The workbench keeps its Activity Bar, sidebar and open-tab strip independent from retained
// views. Its status bar and window-level dialogs are mounted once.

import { lazy, Suspense, useEffect, type DragEvent, type ReactNode } from 'react'
import { subscribe } from './lib/api'
import { carriesFiles } from './lib/fileDrop'
import type { DownloadProgress, RuntimeSample } from './lib/types'
import { useStudio, type View } from './store/studio'
import { Sidebar } from './components/Sidebar'
import { WorkspacePicker } from './components/agent/WorkspacePicker'
import { CommandPalette } from './components/shell/CommandPalette'
import { ShortcutsHelp } from './components/shell/ShortcutsHelp'
import { StatusBar } from './components/shell/StatusBar'
import { useMiningPoll } from './components/shell/mining'
import { VIEW_ICONS, VIEW_LABELS } from './components/shell/shortcuts'
import { useSideSync } from './components/shell/sideSync'
import { useGlobalShortcuts } from './components/shell/useGlobalShortcuts'
import { RetainedView } from './components/shell/RetainedView'
import { QuickOpen } from './components/shell/QuickOpen'
import { WorkbenchTabs } from './components/shell/WorkbenchTabs'
import { useWorkbenchSync } from './components/shell/workbenchState'
import { useCodeWatchers } from './components/code/watchers'
import { Icon } from './components/common'

// The shell becomes interactive without evaluating every settings page, chart and renderer.
// Each chunk is requested on its first visit; revisits reuse both its module and its UI state.
const ChatView = lazy(() => import('./components/ChatView').then((m) => ({ default: m.ChatView })))
const ImageView = lazy(() => import('./components/ImageView').then((m) => ({ default: m.ImageView })))
const ModelsView = lazy(() => import('./components/ModelsView').then((m) => ({ default: m.ModelsView })))
const MonitorView = lazy(() => import('./components/MonitorView').then((m) => ({ default: m.MonitorView })))
const NetworkView = lazy(() => import('./components/NetworkView').then((m) => ({ default: m.NetworkView })))
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })))

// A file dropped outside an attachment area must not navigate away from the app.
function preventFileNavigation(event: DragEvent) {
  if (carriesFiles(event)) event.preventDefault()
}

export default function App() {
  const view = useStudio((s) => s.view)
  const bootstrap = useStudio((s) => s.bootstrap)
  const setSample = useStudio((s) => s.setSample)
  const setDownload = useStudio((s) => s.setDownload)
  const setConnected = useStudio((s) => s.setConnected)
  const theme = useStudio((s) => s.settings?.ui.theme)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const stopMetrics = subscribe<RuntimeSample>('/api/v1/metrics/stream', setSample, () => setConnected(false))
    const stopDownloads = subscribe<DownloadProgress>('/api/v1/downloads/stream', setDownload)
    return () => {
      stopMetrics()
      stopDownloads()
    }
  }, [setSample, setDownload, setConnected])

  // The theme is mirrored into localStorage so index.html's pre-paint script can apply it before
  // React exists — otherwise every start flashes white before the dark theme loads.
  useEffect(() => {
    const resolve = () => {
      const dark = theme === 'dark' || ((theme === 'system' || theme === undefined) && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    resolve()
    try {
      localStorage.setItem('misaka-studio.theme', theme ?? 'system')
    } catch {
      /* private windows and locked-down profiles both throw here; the theme still applies */
    }
    if (theme && theme !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', resolve)
    return () => media.removeEventListener('change', resolve)
  }, [theme])

  useGlobalShortcuts()
  // The queue behind the per-message mining badges and the prompt stack behind the status bar's
  // light, read by one poll for the whole window.
  useMiningPoll()
  // Whatever opens a thread, the window follows it to its side; a deleted thread falls back on
  // its own side.
  useSideSync()
  useWorkbenchSync()

  return (
    <div className="flex h-full flex-col overflow-hidden" onDragOver={preventFileNavigation} onDrop={preventFileNavigation}>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        {/* `min-h-0` is the whole fix for a page that scrolled forever. A flex item defaults to
            `min-height: auto`, which means it refuses to be shorter than its content — so a tall
            view (the Network tab is ~2200px) grew this element past the window instead of being
            clipped by it, and every view's own `h-full overflow-y-auto` then resolved against a
            container taller than itself and never scrolled internally. The document scrolled
            instead, past the end of the app. `overflow-hidden` is the belt to that braces: the
            shell already clips, and saying so here keeps a future overflowing child from escaping
            the same way. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkbenchTabs />
        <main id="workbench-content" className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <ViewSlot view="chat" active={view === 'chat'}><ChatView /></ViewSlot>
          <ViewSlot view="models" active={view === 'models'}><ModelsView /></ViewSlot>
          <ViewSlot view="image" active={view === 'image'}><ImageView /></ViewSlot>
          <ViewSlot view="network" active={view === 'network'}>
            <Page view="network" note="Prompt mining, the classes and the chain">
              <NetworkView />
            </Page>
          </ViewSlot>
          <ViewSlot view="monitor" active={view === 'monitor'}>
            <Page view="monitor" note="This machine and the engine, live">
              <MonitorView />
            </Page>
          </ViewSlot>
          <ViewSlot view="settings" active={view === 'settings'}>
            <Page view="settings" note="Saved to the runtime's settings file">
              <SettingsView />
            </Page>
          </ViewSlot>
        </main>
        </div>
      </div>
      <StatusBar />
      <CodeWatchers />

      <CommandPalette />
      <QuickOpen />
      <ShortcutsHelp />
      <WorkspacePicker />
      <Toasts />
    </div>
  )
}

/** Agent/file change services outlive a hidden chat. They are subscribed once per window. */
function CodeWatchers() {
  const conversation = useStudio((s) => s.conversations.find((c) => c.id === s.activeConversationId) ?? null)
  useCodeWatchers(conversation)
  return null
}

function ViewSlot({ view, active, children }: { view: View; active: boolean; children: ReactNode }) {
  return (
    <RetainedView active={active}>
      <div className="h-full min-h-0 overflow-hidden" data-workbench-view={view}>
        <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-ink-500" role="status">Opening {VIEW_LABELS[view]}…</div>}>
          {children}
        </Suspense>
      </div>
    </RetainedView>
  )
}

/**
 * A title bar for the views that have no header of their own, so every view opens under one
 * (Models and Image draw their own toolbars; the chat draws its own header).
 *
 * A grid row rather than a flex child: the view below sizes itself `h-full`, and a fixed grid
 * track is a definite height for it to resolve against in every engine the shell runs on.
 */
function Page({ view, note, children }: { view: View; note: string; children: ReactNode }) {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-11 min-w-0 items-center gap-2 border-b border-ink-200 px-4 dark:border-ink-800">
        <Icon name={VIEW_ICONS[view]} className="size-4 shrink-0 text-ink-400 dark:text-ink-500" />
        <h1 className="shrink-0 text-[0.85rem] font-semibold">{VIEW_LABELS[view]}</h1>
        <span className="hidden min-w-0 truncate text-[0.75rem] text-ink-400 md:inline dark:text-ink-500">{note}</span>
      </header>
      <div className="min-h-0">{children}</div>
    </div>
  )
}

function Toasts() {
  const toasts = useStudio((s) => s.toasts)
  const dismiss = useStudio((s) => s.dismissToast)
  if (toasts.length === 0) return null

  return (
    // Above the status bar, not over it: the bar is where someone looks to see what just happened.
    <div
      className="pointer-events-none fixed bottom-9 right-3 z-50 flex max-h-[calc(100vh-4.5rem)] w-80 flex-col justify-end gap-2 overflow-y-auto"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={`pop-in pointer-events-auto flex items-start gap-2 rounded-xl border bg-white px-3 py-2.5 text-[0.8rem] shadow-lg shadow-ink-950/10 dark:bg-ink-850 dark:shadow-black/40 ${
            toast.kind === 'error'
              ? 'border-red-300 text-red-700 dark:border-red-900 dark:text-red-300'
              : toast.kind === 'success'
                ? 'border-emerald-300 text-emerald-800 dark:border-emerald-900 dark:text-emerald-300'
                : 'border-ink-200 text-ink-700 dark:border-ink-700 dark:text-ink-200'
          }`}
        >
          {toast.kind === 'error' && <Icon name="warning" className="mt-0.5 size-4 shrink-0" />}
          {toast.kind === 'success' && <Icon name="circleCheck" className="mt-0.5 size-4 shrink-0" />}
          {toast.kind === 'info' && <Icon name="info" className="mt-0.5 size-4 shrink-0 text-ink-400 dark:text-ink-500" />}
          {/* The message scrolls inside the toast, and keeps its line breaks. An error stays until
              it is dismissed, so the dismiss button is the only way off the screen — and a fifteen
              line engine log grew the toast taller than the window, carried that button off the top
              edge, and left the user with a notification that could not be closed at all. */}
          <span className="max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words leading-snug">{toast.text}</span>
          <button
            type="button"
            className="-mr-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 transition-opacity hover:bg-ink-100 hover:opacity-100 dark:hover:bg-ink-800"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismiss(toast.id)}
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
