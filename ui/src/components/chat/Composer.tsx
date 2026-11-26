import { WebChip } from './WebChip'
// The composer: what is typed, what is attached, and everything that decides where it goes.
//
// Everything a person changes *while* writing lives inside the card — the files, the model, the
// agent's folder and leash, whether the prompt is mined — so none of it is a trip to another tab.
// What kind of thread it writes to is not one of them: that is the side of the window (Chat or
// Code), chosen with the switch at the top of the sidebar, and the composer follows it. The keys are
// the ones every chat app has taught people: Enter sends, Shift+Enter is a new line, ↑ in an empty
// box edits the last message, `/` opens commands, `@` mentions a file in a Code session.
//
// Escape is not handled here. An open menu closes on it through `useLayer`, before this sees the
// key; with nothing open it reaches the window's handler, which stops a running reply — and a
// second stop here would be a stop of whatever starts next.

import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { stopAgentRun, useAgent } from '../../lib/agent/run'
import { bytes } from '../../lib/format'
import { matches } from '../../lib/keys'
import { isWebTask, webEnabled } from '../../lib/web'
import {
  findCommand,
  fuzzyFilter,
  matchCommands,
  parseSlash,
  parseToggle,
  pickModel,
  slashInput,
  type SlashCommand,
} from '../../lib/slash'
import type { Conversation, ConversationMode } from '../../lib/types'
import { chatModelId, useStudio } from '../../store/studio'
import { useUi } from '../../store/ui'
import { AgentControls, ApprovalPicker } from '../agent/AgentControls'
import { Icon } from '../common'
import { newThreadHere, openFolder, projectForNewSession, switchAppMode } from '../shell/actions'
import { useNewSessionProject } from '../shell/useSessionProject'
import { IconButton, Kbd, Popover } from '../ui'
import { AttachmentChip } from './AttachmentChip'
import { ComposerContextBar } from './ComposerContextBar'
import { attachFiles, draftKey, useComposer, useDraft } from './composerStore'
import { downloadMarkdown } from './exportMarkdown'
import { busyConversation, queueFollowUp, removeFollowUp, retryFollowUp, sendFromComposer, useFollowUps, useSendingIn } from './followUps'
import { MiningChip } from './MiningChip'
import { ModelPicker, ModelSelectionNotice } from './ModelPicker'

/** The tallest the box grows before it scrolls: about fourteen lines. */
const MAX_HEIGHT_PX = 14 * 24 + 4
/** The last `composerDraft` loaded. Module-wide, so a composer that remounts does not reload it.
 *  A run that cannot start (no model, the folder gone) gives its words and files back through it. */
let loadedDraftTick = 0

type MenuEntry = {
  key: string
  label: ReactNode
  detail?: ReactNode
  icon?: 'slash' | 'file' | 'cube' | 'check' | 'edit'
  disabled?: boolean
  choose: () => void
}

/** `true` once `value` has held for `ms` — so a connection blip at startup draws no warning. */
function useSettled(value: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!value) {
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

export const Composer = memo(function Composer({
  conversation,
  variant,
  onSend,
  onEditLast,
}: {
  conversation: Conversation | null
  variant: 'hero' | 'dock'
  /** Just before a message goes out — the transcript follows it to the bottom. */
  onSend?: () => void
  /** ↑ in an empty composer: edit the last thing the person wrote. */
  onEditLast?: () => void
}) {
  // With no thread, the side decides what a send makes — a chat or a session — and which page's
  // draft this is.
  const side = useUi((s) => s.appMode)
  const key = draftKey(conversation?.id, side)
  const draft = useDraft(key)
  const setText = useComposer((s) => s.setText)
  const removeAttachment = useComposer((s) => s.removeAttachment)
  const pendingProject = useNewSessionProject()

  const models = useStudio((s) => s.models)
  const connected = useStudio((s) => s.connected)
  // Which thread is streaming, not what: the composer has no business redrawing for every token.
  const streamingIn = useStudio((s) => s.streaming?.conversationId ?? null)
  const agentRunIn = useAgent((s) => s.run?.conversationId ?? null)
  const sendingIn = useSendingIn()
  const followUps = useFollowUps(conversation?.id)
  const thinking = useUi((s) => s.thinking)
  const noProject = useUi((s) => s.noProject)
  const focusTick = useUi((s) => s.composerFocusTick)
  const composerDraft = useUi((s) => s.composerDraft)

  const textarea = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuList = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const [listening, setListening] = useState(false)
  const [dropTrayOpen, setDropTrayOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  /** The text a menu was dismissed at: it stays shut until the text changes. */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const lastFocus = useRef<{ tick: number; key: string } | null>(null)

  const mode: ConversationMode = conversation ? (conversation.mode ?? 'chat') : side === 'code' && !noProject ? 'agent' : 'chat'
  // Before the session exists, `@` searches the folder it will be made in.
  const workspace = conversation ? (conversation.workspace ?? null) : side === 'code' && !noProject ? pendingProject : null
  const runningIn = sendingIn ?? agentRunIn ?? streamingIn
  const busyHere = runningIn !== null && runningIn === conversation?.id
  const busyElsewhere = runningIn !== null && !busyHere
  const canStop = conversation !== null && (streamingIn === conversation.id || agentRunIn === conversation.id)
  const willQueue = busyHere || followUps.length > 0
  const offline = useSettled(!connected, 1200)
  const isCommand = parseSlash(draft.text) !== null
  const hasContent = draft.text.trim().length > 0 || draft.attachments.length > 0
  const canSend = isCommand || (hasContent && connected && !busyElsewhere)

  // --- focus and drafts from elsewhere ---------------------------------------------------------

  useEffect(() => {
    // Activity resumes effects when a view is revealed. Only an actual focus request or thread
    // change should move the caret; returning from Settings must preserve an in-progress edit.
    if (lastFocus.current?.tick === focusTick && lastFocus.current.key === key) return
    const element = textarea.current
    if (!element) return
    lastFocus.current = { tick: focusTick, key }
    element.focus({ preventScroll: true })
    const end = element.value.length
    element.setSelectionRange(end, end)
  }, [focusTick, key])

  useEffect(() => {
    if (!composerDraft || composerDraft.tick === loadedDraftTick) return
    loadedDraftTick = composerDraft.tick
    useComposer.getState().setText(key, composerDraft.text)
    if (composerDraft.attachments?.length) useComposer.getState().addAttachments(key, composerDraft.attachments)
    requestAnimationFrame(() => {
      const element = textarea.current
      if (!element) return
      element.focus({ preventScroll: true })
      element.setSelectionRange(composerDraft.text.length, composerDraft.text.length)
    })
  }, [composerDraft, key])

  // One line to about fourteen, then it scrolls.
  useLayoutEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`
    element.style.overflowY = element.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [draft.text, variant])

  // --- commands ----------------------------------------------------------------------------------

  /** A thread of this side's kind, made now — for a command that needs one before anything is sent. */
  const createHere = (): string => {
    const studio = useStudio.getState()
    if (mode !== 'agent') return studio.newConversation({ mode: 'chat' })
    const project = projectForNewSession()
    if (project) useUi.getState().addRecentWorkspace(project)
    return studio.newConversation({ mode: 'agent', workspace: project })
  }

  const runCommand = (command: SlashCommand, arg: string) => {
    const studio = useStudio.getState()
    const ui = useUi.getState()
    setText(key, '')
    setDismissedAt(null)
    const thread = () => conversation?.id ?? createHere()
    const noun = mode === 'agent' ? 'session' : 'thread'
    switch (command.name) {
      case 'new':
        newThreadHere()
        break
      // The kind of thread is the window's side now: these two switch sides, and the side brings
      // back the thread it had open.
      case 'code':
      case 'agent':
        switchAppMode('code')
        break
      case 'chat':
        switchAppMode('chat')
        break
      case 'model': {
        if (!arg) {
          studio.toast('info', 'Name the model: /model <part of its name>.')
          break
        }
        const id = pickModel(arg, studio.models.map((m) => m.id))
        if (!id) studio.toast('error', `No installed model matches “${arg}”.`)
        else void studio.loadModel(id)
        break
      }
      case 'clear':
        if (!conversation || conversation.messages.length === 0) studio.toast('info', `There is nothing in this ${noun} to clear.`)
        else {
          studio.clearConversation(conversation.id)
          studio.toast('success', 'Cleared. The pinned notes stay.')
        }
        break
      case 'rename':
        if (!arg) studio.toast('info', 'Give the title: /rename <title>.')
        else studio.renameConversation(thread(), arg)
        break
      case 'export':
        if (!conversation || conversation.messages.length === 0) studio.toast('info', `There is nothing in this ${noun} to export yet.`)
        else studio.toast('success', `Exported ${downloadMarkdown(conversation)}`)
        break
      case 'mine': {
        const on = arg ? parseToggle(arg) : !(conversation?.mine !== false)
        if (on === null) {
          studio.toast('info', 'Use /mine on or /mine off.')
          break
        }
        studio.setConversationMining(thread(), on)
        studio.toast('info', on ? `This ${noun}'s prompts are mined when background mining is on.` : `This ${noun}'s prompts are not mined.`)
        break
      }
      case 'think': {
        const on = arg ? parseToggle(arg) : !thinking
        if (on === null) {
          studio.toast('info', 'Use /think on or /think off.')
          break
        }
        ui.setThinking(on)
        studio.toast('info', on ? 'Thinking on: reasoning models think before they answer.' : 'Thinking off: requests ask reasoning models to answer without thinking.')
        break
      }
      case 'params':
        ui.setParametersOpen(!ui.parametersOpen)
        break
      case 'help':
        ui.setShortcutsOpen(true)
        break
    }
    ui.focusComposer()
  }

  // --- sending -------------------------------------------------------------------------------------

  const submit = async () => {
    const composer = useComposer.getState()
    const current = composer.drafts[key]
    if (!current) return
    const { text, attachments } = current
    const command = parseSlash(text)
    if (command) {
      runCommand(command.command, command.arg)
      return
    }
    const studio = useStudio.getState()
    const running = busyConversation()
    if ((!text.trim() && attachments.length === 0) || !studio.connected || (running !== null && running !== conversation?.id)) return
    // Sent with the mouse, the focus is on a button that is about to become Stop; the next message
    // is typed here.
    textarea.current?.focus({ preventScroll: true })

    const webTask = isWebTask(text)
    if (webTask && !webEnabled(conversation ?? undefined, studio.settings, studio.runtime?.backend)) {
      studio.toast('info', 'Enable Web in the composer and load a local model before researching a site.')
      return
    }

    let id = conversation?.id
    if (!id) {
      // The folder picker carries the draft into the session it creates. When sending now,
      // clear the captured draft before sideSync can carry it into the new thread.
      const project = mode === 'agent' ? projectForNewSession() : null
      if (mode === 'agent' && !project) {
        openFolder()
        return
      }
      composer.clear(key)
      id = studio.newConversation({ mode, workspace: project })
      if (mode === 'agent') studio.setConversationApproval(id, useUi.getState().defaultApproval)
      if (project) useUi.getState().addRecentWorkspace(project)
    }

    if (mode === 'agent' && !webTask && conversation && !conversation.workspace) {
      if (useUi.getState().noProject) {
        studio.setConversationMode(conversation.id, 'chat')
      } else {
        useUi.getState().openWorkspacePicker(id)
        return
      }
    }

    if (conversation) composer.clear(key)
    onSend?.()
    if (running || followUps.length > 0) queueFollowUp(id, current)
    else await sendFromComposer(id, current)
  }

  const stopHere = () => {
    if (agentRunIn !== null && agentRunIn === conversation?.id) stopAgentRun()
    else useStudio.getState().stop()
    textarea.current?.focus({ preventScroll: true })
  }

  // --- menus: `/` commands only (files & folders use direct drag-and-drop instead of global search) ---

  const slash = slashInput(draft.text)

  let entries: MenuEntry[] = []
  let menuTitle = ''
  if (slash) {
    if (slash.arg === null) {
      menuTitle = 'Commands'
      entries = matchCommands(slash.name).map((command) => ({
        key: command.name,
        icon: 'slash',
        label: (
          <>
            <span className="mono text-ink-800 dark:text-ink-100">/{command.name}</span>
            {command.args && <span className="mono ml-1 text-ink-400 dark:text-ink-500">{command.args}</span>}
          </>
        ),
        detail: command.description,
        choose: () => {
          if (command.needsArg || command.choices) {
            setText(key, `/${command.name} `)
            setMenuIndex(0)
          } else runCommand(command, '')
        },
      }))
    } else {
      const command = findCommand(slash.name)
      const arg = slash.arg.trim()
      if (command?.name === 'model') {
        menuTitle = 'Load a model'
        const loadedId = chatModelId()
        entries = fuzzyFilter(arg, models, (m) => m.id)
          .slice(0, 8)
          .map((model) => ({
            key: model.id,
            icon: model.id === loadedId ? 'check' : 'cube',
            label: <span className="truncate">{model.id}</span>,
            detail: `${bytes(model.size_bytes)}${model.id === loadedId ? ' · selected' : ''}`,
            disabled: model.fit.verdict === 'does_not_fit',
            choose: () => runCommand(command, model.id),
          }))
      } else if (command?.choices) {
        menuTitle = `/${command.name}`
        entries = command.choices
          .filter((choice) => choice.startsWith(arg.toLowerCase()))
          .map((choice) => ({
            key: choice,
            icon: 'slash',
            label: <span className="mono">/{command.name} {choice}</span>,
            detail: command.description,
            choose: () => runCommand(command, choice),
          }))
      } else if (command?.name === 'rename') {
        menuTitle = 'Rename this thread'
        entries = [
          arg
            ? { key: 'rename', icon: 'edit', label: <span className="truncate">Rename to “{arg}”</span>, choose: () => runCommand(command, arg) }
            : { key: 'hint', icon: 'edit', label: <span className="text-ink-500 dark:text-ink-400">Type the new title, then Enter</span>, disabled: true, choose: () => {} },
        ]
      } else if (command) {
        menuTitle = 'Commands'
        entries = [{ key: command.name, icon: 'slash', label: <span className="mono">/{command.name}</span>, detail: command.description, choose: () => runCommand(command, '') }]
      }
    }
  }

  const menuOpen = focused && entries.length > 0 && dismissedAt !== draft.text
  const menuIdentity = slash ? `${slash.name}|${slash.arg ?? ''}` : ''
  useEffect(() => setMenuIndex(0), [menuIdentity])
  useEffect(() => {
    menuList.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [menuIndex])

  // --- keys --------------------------------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // A key inside an input method's composition belongs to the composition — Enter there
    // commits the candidate, it must not send half a sentence.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return

    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setMenuIndex((i) => (i + step + entries.length) % entries.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        const entry = entries[Math.min(menuIndex, entries.length - 1)]
        // Tab never leaves the box while a menu is open: it completes, or it does nothing.
        if (event.key === 'Tab') event.preventDefault()
        if (entry && !entry.disabled) {
          event.preventDefault()
          entry.choose()
          return
        }
        if (event.key === 'Tab') return
      }
    }

    if (event.key === 'Enter' && (matches(event.nativeEvent, 'mod+enter') || !event.shiftKey)) {
      event.preventDefault()
      if (canSend) void submit()
      return
    }
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && draft.text === '' && draft.attachments.length === 0) {
      if (onEditLast) {
        event.preventDefault()
        onEditLast()
      }
    }
  }

  // --- the card ------------------------------------------------------------------------------------

  const placeholder = busyHere
    ? 'Send a follow-up to queue it'
    : 'Ask anything — drop files or folders here, / for actions'

  const toggleVoiceInput = () => {
    if (listening) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setListening(false)
      return
    }
    const SpeechCtor = (
      window as unknown as {
        SpeechRecognition?: new () => {
          continuous: boolean
          interimResults: boolean
          lang: string
          onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
          onerror: (() => void) | null
          onend: (() => void) | null
          start: () => void
          stop: () => void
        }
        webkitSpeechRecognition?: new () => {
          continuous: boolean
          interimResults: boolean
          lang: string
          onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
          onerror: (() => void) | null
          onend: (() => void) | null
          start: () => void
          stop: () => void
        }
      }
    ).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: never }).webkitSpeechRecognition
    if (!SpeechCtor) {
      useStudio.getState().toast('info', 'Voice dictation is not available in this system webview.')
      return
    }
    try {
      const rec = new (SpeechCtor as new () => {
        continuous: boolean
        interimResults: boolean
        lang: string
        onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null
        onerror: (() => void) | null
        onend: (() => void) | null
        start: () => void
        stop: () => void
      })()
      rec.continuous = false
      rec.interimResults = false
      rec.lang = navigator.language || 'ja-JP'
      rec.onresult = (event) => {
        const last = event.results[event.results.length - 1]
        const transcript = last?.[0]?.transcript?.trim()
        if (!transcript) return
        const prev = useComposer.getState().drafts[key]?.text ?? ''
        const next = prev ? `${prev}${/\s$/.test(prev) ? '' : ' '}${transcript}` : transcript
        setText(key, next)
      }
      rec.onerror = () => setListening(false)
      rec.onend = () => {
        recognitionRef.current = null
        setListening(false)
      }
      recognitionRef.current = rec
      setListening(true)
      rec.start()
    } catch {
      setListening(false)
      useStudio.getState().toast('info', 'Could not start microphone dictation.')
    }
  }

  return (
    <div className="w-full">
      {conversation && followUps.length > 0 && (
        <ul aria-label="Queued follow-ups" aria-live="polite" className="mb-2 max-h-28 space-y-1 overflow-y-auto">
          {followUps.map((item) => (
            <li key={item.id} className="flex items-center gap-2 rounded-[4px] border border-ink-200 bg-ink-50 px-2.5 py-1 text-xs text-ink-600 dark:border-ink-700 dark:bg-ink-850 dark:text-[#cccccc]">
              <Icon name="clock" className="size-3.5 shrink-0 text-ink-400" />
              <span className="shrink-0 font-medium">{item.paused ? 'Send paused' : 'Queued'}</span>
              <span className="min-w-0 flex-1 truncate" title={item.text}>{item.text.trim() || item.attachments.map((file) => file.name).join(', ')}</span>
              {item.paused && <button type="button" className="chip shrink-0" onClick={() => retryFollowUp(conversation.id, item.id)}>Retry</button>}
              <IconButton icon="x" label="Remove queued follow-up" onClick={() => removeFollowUp(conversation.id, item.id)} />
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-[14px] border border-ink-200/90 bg-ink-100/75 p-1 dark:border-[#2a2a2e] dark:bg-[#141417]">
        <ComposerContextBar conversation={conversation} workspace={workspace} />
        <div
          ref={card}
          className={`@container rounded-[11px] border bg-white transition-colors dark:bg-[#1b1b1f] ${
            focused
              ? 'border-arc-500/80 dark:border-[#3e3e46]'
              : 'border-ink-200 dark:border-[#2a2a30]'
          }`}
        >
          {dropTrayOpen && (
            <div className="mx-3 mt-2.5 flex items-center justify-between gap-3 rounded-[9px] border border-dashed border-ink-300 bg-ink-50/70 px-3 py-2 text-xs text-ink-600 dark:border-[#34343c] dark:bg-[#141418] dark:text-[#a1a1aa]">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-ink-900 dark:hover:text-white"
              >
                <Icon name="upload" className="size-4 shrink-0 text-arc-500" />
                <span className="truncate">
                  ファイルをここにドラッグ＆ドロップして追加（またはクリックして選択）
                </span>
              </button>
              <button
                type="button"
                aria-label="Close file drop bar"
                onClick={() => setDropTrayOpen(false)}
                className="icon-btn size-6"
              >
                <Icon name="x" className="size-3.5" />
              </button>
            </div>
          )}

          {draft.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-ink-200/70 px-3 py-2 dark:border-[#2a2a30]">
              {draft.attachments.map((attachment) => (
                <AttachmentChip key={attachment.id} attachment={attachment} onRemove={() => removeAttachment(key, attachment.id)} />
              ))}
            </div>
          )}

          <textarea
            ref={textarea}
            rows={1}
            value={draft.text}
            placeholder={placeholder}
            aria-label={mode === 'agent' ? 'Task for the agent' : 'Message'}
            spellCheck
            className={`block w-full resize-none bg-transparent px-3.5 pb-2 pt-3 text-[13.5px] leading-relaxed text-ink-900 outline-none placeholder:text-ink-400 dark:text-[#e4e4e7] dark:placeholder:text-[#71717a] ${
              variant === 'hero' ? 'min-h-[3.75rem]' : ''
            }`}
            onChange={(event) => {
              setText(key, event.target.value)
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (files.length === 0) return
              event.preventDefault()
              void attachFiles(key, files)
            }}
          />

          <div className="flex items-center gap-1 whitespace-nowrap px-2.5 pb-2.5 pt-1">
            <div className="flex min-w-0 items-center gap-1">
              <IconButton
                icon="plus"
                label="Drop or attach files"
                active={dropTrayOpen}
                onClick={() => setDropTrayOpen((v) => !v)}
              />
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  event.target.value = ''
                  if (files.length) {
                    void attachFiles(key, files)
                    setDropTrayOpen(false)
                  }
                  textarea.current?.focus()
                }}
              />
              <ModelPicker />
              <WebChip conversation={conversation} createThread={createHere} disabled={busyHere || busyElsewhere} />
              <MiningChip conversation={conversation} compact />
              {conversation && mode === 'agent' && <AgentControls conversation={conversation} />}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {!thinking && (
                <button
                  type="button"
                  className="chip shrink-0 text-ink-500 dark:text-ink-400"
                  onClick={() => useUi.getState().setThinking(true)}
                  aria-label="Thinking is off. Turn it on"
                  title="Thinking is off: click to let reasoning models think again."
                >
                  <Icon name="brain" className="size-3.5" />
                </button>
              )}

              <ApprovalPicker conversation={conversation} />

              <button
                type="button"
                onClick={toggleVoiceInput}
                aria-label={listening ? 'Stop voice dictation' : 'Voice dictation'}
                title={listening ? 'Listening… click to stop' : 'Voice dictation'}
                className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors ${
                  listening
                    ? 'bg-red-500/15 text-red-500'
                    : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:text-[#a1a1aa] dark:hover:bg-white/6 dark:hover:text-white'
                }`}
              >
                <Icon name="mic" className="size-4" />
              </button>

              {canStop && (
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-red-600 text-white transition-colors hover:bg-red-500"
                  onClick={stopHere}
                  aria-label={mode === 'agent' ? 'Stop the agent' : 'Stop generating'}
                  title="Stop (Esc)"
                >
                  <span className="size-2.5 rounded-[2px] bg-current" />
                </button>
              )}

              {(!canStop || canSend) && (
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#3b82f6] text-white shadow-xs transition-colors hover:bg-[#2563eb] disabled:bg-ink-200 disabled:text-ink-400 dark:disabled:bg-[#27272a] dark:disabled:text-[#52525b]"
                  onClick={() => void submit()}
                  disabled={!canSend}
                  aria-label={isCommand ? 'Run command' : willQueue ? 'Queue follow-up' : 'Send'}
                  title={isCommand ? 'Run the command (Enter)' : willQueue ? 'Queue follow-up (Enter)' : 'Send (Enter)'}
                >
                  <Icon name="arrowRight" className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ModelSelectionNotice />
      {(offline || busyElsewhere) && (
        <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[0.7rem] text-ink-500 dark:text-ink-400" role="status">
          <Icon name="warning" className="size-3.5 text-amber-500" />
          {offline
            ? 'The runtime is unreachable — sending is paused until it is back.'
            : 'Another thread is still answering. Stop it there, or wait, to send here.'}
        </p>
      )}

      <Popover anchor={card} open={menuOpen} onClose={() => setDismissedAt(draft.text)} placement="top-start" className="w-[min(30rem,calc(100vw-2rem))] p-0">
        {/* Clicks inside the menu must not take the focus from the box: the box is where the keys go. */}
        <div onMouseDown={(event) => event.preventDefault()}>
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <span className="menu-label p-0">{menuTitle}</span>
            <span className="flex items-center gap-1 text-[0.65rem] text-ink-400 dark:text-ink-500">
              <Kbd shortcut="arrowup" />
              <Kbd shortcut="arrowdown" />
              <span className="mx-0.5">to move</span>
              <Kbd shortcut="enter" />
              <span>to choose</span>
            </span>
          </div>
          <div ref={menuList} className="max-h-72 overflow-y-auto p-1 pt-0" role="listbox" aria-label={menuTitle}>
            {entries.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                role="option"
                aria-selected={index === menuIndex}
                className="menu-item"
                data-active={index === menuIndex && !entry.disabled}
                disabled={entry.disabled}
                onMouseEnter={() => setMenuIndex(index)}
                onClick={() => entry.choose()}
              >
                {entry.icon && <Icon name={entry.icon} className="size-3.5 shrink-0 text-ink-400" />}
                <span className="flex min-w-0 flex-1 items-center">{entry.label}</span>
                {entry.detail && <span className="ml-3 shrink-0 truncate text-[0.7rem] text-ink-400 dark:text-ink-500">{entry.detail}</span>}
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </div>
  )
})
