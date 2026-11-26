// Agent execution controls & Antigravity-style "Turbo" approval selector.

import { useRef, useState } from 'react'
import { AGENT_GOOD_CONTEXT, contextTooSmall, useAgent } from '../../lib/agent/run'
import type { ApprovalPolicy, Conversation } from '../../lib/types'
import { chatModelId, useStudio } from '../../store/studio'
import { useUi } from '../../store/ui'
import { Icon, Spinner, type IconName } from '../common'
import { Popover, PopoverButton, StatusDot } from '../ui'

export const POLICIES: { value: ApprovalPolicy; label: string; icon: IconName; description: string }[] = [
  { value: 'full_auto', label: 'Turbo', icon: 'shieldAlert', description: 'Edits and terminal commands run automatically.' },
  { value: 'auto_edit', label: 'Auto', icon: 'bolt', description: 'Edits apply automatically; commands ask before running.' },
  { value: 'ask', label: 'Ask', icon: 'eye', description: 'Every file edit and every command asks for approval.' },
  { value: 'read_only', label: 'Plan', icon: 'lock', description: 'Read and search only — never edits files or runs commands.' },
]

/** Antigravity-style `[shieldAlert] Turbo ⌄` dropdown positioned on the bottom-right of the composer. */
export function ApprovalPicker({ conversation }: { conversation: Conversation | null }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const defaultApproval = useUi((s) => s.defaultApproval)
  const setDefaultApproval = useUi((s) => s.setDefaultApproval)
  const policy = conversation?.approval ?? defaultApproval
  const current = POLICIES.find((p) => p.value === policy) ?? POLICIES[0]!
  const allowed = useAgent((s) => (conversation ? (s.allowed[conversation.id] ?? null) : null))
  const close = () => setOpen(false)

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Execution mode: ${current.label} — ${current.description}`}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 dark:text-[#a1a1aa] dark:hover:bg-white/6 dark:hover:text-white"
      >
        <Icon name="shieldAlert" className="size-4 shrink-0 opacity-85" />
        <span>{current.label}</span>
        <Icon name="chevronDown" className="size-3 shrink-0 opacity-65" />
      </button>

      <Popover
        anchor={anchor}
        open={open}
        onClose={close}
        placement="top-end"
        className="w-76 !rounded-[14px] !border-ink-200 !bg-white !p-1.5 shadow-2xl dark:!border-[#2e2e32] dark:!bg-[#18181b]"
      >
        <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400 dark:text-[#71717a]">
          Execution Policy
        </div>
        {POLICIES.map((option) => {
          const active = option.value === policy
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setDefaultApproval(option.value)
                if (conversation) useStudio.getState().setConversationApproval(conversation.id, option.value)
                close()
              }}
              className="flex w-full items-start gap-2.5 rounded-[9px] px-3 py-2 text-left transition-colors hover:bg-ink-100 dark:hover:bg-[#27272a]"
            >
              <Icon name={option.icon} className="mt-0.5 size-4 shrink-0 text-ink-500 dark:text-[#a1a1aa]" />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink-900 dark:text-white">{option.label}</span>
                <span className="block text-[11.5px] leading-snug text-ink-500 dark:text-[#71717a]">{option.description}</span>
              </span>
              {active && <Icon name="check" className="mt-0.5 size-4 shrink-0 text-ink-900 dark:text-white" />}
            </button>
          )
        })}
        {conversation && allowed && allowed.length > 0 && (
          <>
            <div className="my-1 h-px bg-ink-200 dark:bg-[#27272a]" />
            <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-ink-500 dark:text-[#a1a1aa]">
              <Icon name="shield" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                Always allowed here: {allowed.map((kind) => (kind === 'edit' ? 'edits' : 'commands')).join(' & ')}.
              </span>
              <button
                type="button"
                className="shrink-0 font-medium text-arc-600 hover:underline dark:text-arc-400"
                onClick={() => useAgent.setState((s) => ({ allowed: { ...s.allowed, [conversation.id]: [] } }))}
              >
                Reset
              </button>
            </div>
          </>
        )}
      </Popover>
    </>
  )
}

function ContextChip() {
  const contextSize = useStudio((s) => (s.runtime?.model_id === chatModelId(s) ? (s.runtime?.context_size ?? null) : null))
  const backend = useStudio((s) => (s.runtime?.model_id === chatModelId(s) ? (s.runtime?.backend ?? null) : null))
  const loading = useStudio((s) => s.loadingModelId)
  const modelId = useStudio((s) => chatModelId(s))
  if (!contextTooSmall(contextSize) || backend === 'gateway' || !modelId) return null
  return (
    <PopoverButton
      className="chip text-amber-700 dark:text-amber-300"
      title="The model's window is small for the agent"
      placement="top-start"
      panelClassName="w-72 p-3"
      button={
        <>
          {loading ? <Spinner className="size-3" /> : <Icon name="warning" className="size-3.5" />}
          {Math.round((contextSize ?? 0) / 1024)}K window
        </>
      }
    >
      {(close) => (
        <div className="text-xs text-ink-600 dark:text-ink-300">
          <p>
            <span className="mono">{modelId}</span> is loaded with a {(contextSize ?? 0).toLocaleString('en-US')}-token window. A few file reads fill it,
            and then the agent loses the start of its task.
          </p>
          <button
            type="button"
            className="btn-primary mt-2.5 w-full py-1 text-xs"
            disabled={loading !== null}
            onClick={() => {
              close()
              void useStudio.getState().loadModel(modelId, AGENT_GOOD_CONTEXT)
            }}
          >
            {loading ? <Spinner className="size-3.5" /> : <Icon name="refresh" className="size-3.5" />}
            Reload at 32K
          </button>
          <p className="mt-1.5 text-[0.7rem] text-ink-400">A larger window takes more memory; the Models tab shows what fits.</p>
        </div>
      )}
    </PopoverButton>
  )
}

function RunStatus({ conversationId }: { conversationId: string }) {
  const run = useAgent((s) => (s.run?.conversationId === conversationId ? s.run : null))
  if (!run) return null
  const waiting = run.status === 'awaiting_approval'
  return (
    <span
      className={`flex min-w-0 items-center gap-1.5 px-1.5 text-[0.7rem] font-medium ${waiting ? 'text-amber-700 dark:text-amber-300' : 'text-ink-500 dark:text-ink-400'}`}
      role="status"
      title={waiting ? `Step ${run.step} · waiting for your approval` : `The agent is on step ${run.step}`}
    >
      {waiting ? <StatusDot tone="amber" pulse /> : <Spinner className="size-3 shrink-0" />}
      <span className="truncate">Step {run.step}</span>
    </span>
  )
}

export function AgentControls({ conversation }: { conversation: Conversation }) {
  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
      <ContextChip />
      <RunStatus conversationId={conversation.id} />
    </div>
  )
}
