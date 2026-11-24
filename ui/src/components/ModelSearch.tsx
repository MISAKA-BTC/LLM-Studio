import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import {
  cleanDisplayName,
  entryCapabilities,
  extractLeadSummary,
  isBoilerplateQuantCard,
  prepareReadmeMarkdown,
  type CapabilityKind,
} from '../lib/catalogPresentation'
import { bytes, count, eta, params, rate, relativeTime, tokens } from '../lib/format'
import type { CatalogEntry, CatalogFormat, CatalogRepo, CatalogSort, CatalogVariant, HardwareSnapshot } from '../lib/types'
import { useStudio } from '../store/studio'
import { CopyButton, EmptyState, Icon, Spinner, type IconName } from './common'
import { MiningCatalog, PublishedPalwModels } from './MiningCatalog'
import { RetainedView } from './shell/RetainedView'

type CatalogSection = 'local' | 'mining' | 'published'
type Format = 'all' | CatalogFormat
type Selection = { id: string; revision?: string; file?: string }

const SECTIONS: ReadonlyArray<[CatalogSection, string]> = [
  ['local', 'Local inference'],
  ['mining', 'Mining classes'],
  ['published', 'Unregistered PALW'],
]

const SORTS: ReadonlyArray<[CatalogSort, string]> = [
  ['best_match', 'Best Match'],
  ['trending', 'Trending'],
  ['downloads', 'Most Downloads'],
  ['likes', 'Most Likes'],
  ['updated', 'Recently Updated'],
]

const RECOGNIZED_CREATORS = new Set([
  'google',
  'qwen',
  'meta-llama',
  'mistralai',
  'deepseek-ai',
  'microsoft',
  'thinkingmachines',
  'nvidia',
  'allenai',
  'cohereforai',
  '01-ai',
  'bigcode',
  'apple',
  'ibm-granite',
  'stabilityai',
  'black-forest-labs',
  'lmstudio-community',
  'mlx-community',
  'unsloth',
  'bartowski',
  'ggml-org',
  'nousresearch',
  'openbmb',
  'baichuan-inc',
  'internlm',
  'tiiuae',
  'zhipuai',
  'thudm',
  'moonshotai',
  'minimaxai',
  'stepfun-ai',
])

const AVATAR_PALETTE: ReadonlyArray<string> = [
  'bg-sky-600/15 text-sky-700 border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-400/25',
  'bg-indigo-600/15 text-indigo-700 border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-400/25',
  'bg-emerald-600/15 text-emerald-700 border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-400/25',
  'bg-amber-600/15 text-amber-800 border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-400/25',
  'bg-purple-600/15 text-purple-700 border-purple-500/30 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-400/25',
  'bg-rose-600/15 text-rose-700 border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-400/25',
]

// Bounded cache of extracted README lead summaries so visited repositories enrich left-list rows too.
const readmeSummaryCache = new Map<string, string>()

function rememberSummary(repoId: string, summary: string) {
  if (!summary) return
  readmeSummaryCache.delete(repoId)
  readmeSummaryCache.set(repoId, summary)
  if (readmeSummaryCache.size > 128) {
    const oldest = readmeSummaryCache.keys().next().value
    if (oldest) readmeSummaryCache.delete(oldest)
  }
}

export function ModelSearch() {
  const [section, setSection] = useState<CatalogSection>('local')
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-ink-900">
      <nav
        aria-label="Model collections"
        className="flex h-8 shrink-0 items-stretch gap-1 border-b border-ink-200 bg-ink-50/70 px-3 dark:border-ink-800 dark:bg-ink-950"
      >
        {SECTIONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={section === value}
            onClick={() => setSection(value)}
            className={`border-b-2 px-2.5 text-xs font-medium transition-colors ${
              section === value
                ? 'border-arc-500 text-ink-900 dark:text-white'
                : 'border-transparent text-ink-500 hover:text-ink-800 dark:text-[#969696] dark:hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      <RetainedView active={section === 'local'}>
        <div className="min-h-0 flex-1">
          <HubSearch />
        </div>
      </RetainedView>
      {section === 'mining' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <MiningCatalog searchable />
        </div>
      )}
      {section === 'published' && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <PublishedPalwModels />
        </div>
      )}
    </div>
  )
}

/** Organization / model creator avatar fetched via runtime proxy with graceful fallback. */
export function ModelAvatar({
  owner,
  fallbackOwner,
  name,
  size = 'md',
  selected = false,
}: {
  owner: string | null | undefined
  fallbackOwner?: string | null
  name: string
  size?: 'sm' | 'md' | 'lg'
  selected?: boolean
}) {
  const candidates = useMemo(() => {
    const list: string[] = []
    for (const candidate of [owner, fallbackOwner]) {
      const clean = candidate?.trim()
      if (clean && /^[\w.-]+$/.test(clean) && !list.some((existing) => existing.toLowerCase() === clean.toLowerCase())) {
        list.push(clean)
      }
    }
    return list
  }, [owner, fallbackOwner])

  const [attempt, setAttempt] = useState(0)
  useEffect(() => setAttempt(0), [candidates])

  const currentOwner = candidates[attempt] ?? null
  const dims = size === 'sm' ? 'size-7 rounded-[5px] text-[10px]' : size === 'lg' ? 'size-10 rounded-[7px] text-xs' : 'size-9 rounded-[6px] text-[11px]'
  const seed = (candidates[0] ?? name).toLowerCase()
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const tone = selected
    ? 'bg-white/95 text-ink-900 border-white/40'
    : AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]!
  const initials = (candidates[0] ?? name)
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'AI'

  if (!currentOwner) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center border font-bold tracking-tight select-none ${dims} ${tone}`} aria-hidden>
        {initials.slice(0, 2)}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden border bg-white p-0.5 select-none dark:bg-white ${dims} ${
        selected ? 'border-white/50 shadow-xs' : 'border-ink-200 dark:border-ink-700'
      }`}
      aria-hidden
    >
      <img
        src={api.catalogAvatarUrl(currentOwner)}
        alt=""
        loading="lazy"
        className="size-full rounded-[4px] object-contain"
        onError={() => setAttempt((index) => index + 1)}
      />
    </span>
  )
}

function locator(input: string, endpoint: string): Selection | null {
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) return { id: input }
  try {
    const url = new URL(input)
    const hub = new URL(endpoint)
    const base = hub.pathname.replace(/\/$/, '')
    const path =
      url.origin === hub.origin && url.pathname.startsWith(`${base}/`)
        ? url.pathname.slice(base.length)
        : url.origin === 'https://huggingface.co'
          ? url.pathname
          : ''
    const [author, name, action, revision, ...file] = path.split('/').filter(Boolean).map(decodeURIComponent)
    if (!author || !name || !/^[\w.-]+$/.test(author) || !/^[\w.-]+$/.test(name)) return null
    if (action && !['tree', 'blob', 'resolve'].includes(action)) return null
    return { id: `${author}/${name}`, revision, file: file.length ? file.join('/') : undefined }
  } catch {
    return null
  }
}

function updated(date: string | null) {
  return date ? relativeTime(Date.parse(date) / 1000) : '—'
}

function formatsOf(entry: CatalogEntry): CatalogFormat[] {
  const out: CatalogFormat[] = []
  if (entry.tags.some((t) => t.toLowerCase() === 'gguf')) out.push('gguf')
  if (entry.tags.some((t) => t.toLowerCase() === 'mlx')) out.push('mlx')
  return out
}

function isRecognized(entry: CatalogEntry): boolean {
  const [owner] = entry.id.split('/')
  const creator = entry.creator ?? owner
  return (
    (!!creator && RECOGNIZED_CREATORS.has(creator.toLowerCase())) ||
    (!!owner && RECOGNIZED_CREATORS.has(owner.toLowerCase())) ||
    entry.downloads >= 10_000
  )
}

const CAPABILITY_META: Record<
  CapabilityKind,
  { label: string; icon: IconName; dotTone: string; selectedDotTone: string; pillTone: string }
> = {
  vision: {
    label: 'Vision',
    icon: 'eye',
    dotTone: 'bg-amber-500/15 text-amber-600 border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-400/30',
    selectedDotTone: 'bg-white/20 text-amber-200 border-white/30',
    pillTone: 'bg-amber-500/12 text-amber-800 border-amber-500/25 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-400/25',
  },
  tools: {
    label: 'Tool Use',
    icon: 'wrench',
    dotTone: 'bg-sky-500/15 text-sky-600 border-sky-500/30 dark:bg-sky-500/20 dark:text-sky-300 dark:border-sky-400/30',
    selectedDotTone: 'bg-white/20 text-sky-200 border-white/30',
    pillTone: 'bg-sky-500/12 text-sky-800 border-sky-500/25 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-400/25',
  },
  reasoning: {
    label: 'Reasoning',
    icon: 'brain',
    dotTone: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-400/30',
    selectedDotTone: 'bg-white/20 text-emerald-200 border-white/30',
    pillTone: 'bg-emerald-500/12 text-emerald-800 border-emerald-500/25 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-400/25',
  },
}

function summarizeEntry(entry: CatalogEntry): string {
  const cached = readmeSummaryCache.get(entry.id) ?? (entry.base_model ? readmeSummaryCache.get(entry.base_model) : undefined)
  if (cached) return cached
  if (entry.summary) return entry.summary
  const parts: string[] = []
  const display = cleanDisplayName(entry.id, entry.base_model)
  const caps = entryCapabilities(entry)
  if (caps.includes('vision')) parts.push('Multimodal')
  else parts.push('Open-weight')
  if (entry.tags.some((t) => t.toLowerCase() === 'moe')) parts.push('MoE')
  parts.push('model')
  const specs: string[] = []
  if (entry.parameters) specs.push(`${params(entry.parameters)} params`)
  if (entry.context_length) specs.push(`${tokens(entry.context_length)} ctx`)
  if (entry.architecture) specs.push(entry.architecture)
  const fmts = formatsOf(entry).map((f) => f.toUpperCase())
  if (fmts.length) specs.push(fmts.join('/'))
  if (specs.length > 0) return `${display} — ${parts.join(' ')} (${specs.join(' · ')})`
  const [owner] = entry.id.split('/')
  return `${display} by ${entry.creator ?? owner ?? 'Hugging Face'} · ${count(entry.downloads)} downloads`
}

function HubSearch() {
  const system = useStudio((s) => s.system)
  const endpoint = system?.catalog_endpoint ?? 'https://huggingface.co'
  const [query, setQuery] = useState('')
  const [format, setFormat] = useState<Format>('all')
  const [sort, setSort] = useState<CatalogSort>('best_match')
  const [refresh, setRefresh] = useState(0)
  const [results, setResults] = useState<CatalogEntry[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [searching, setSearching] = useState(true)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ selection: Selection; repo: CatalogRepo } | { selection: Selection; error: string } | null>(null)
  const [repoRetry, setRepoRetry] = useState(0)
  const [, setSummaryTick] = useState(0)
  const completedSearch = useRef<string | null>(null)
  const completedDetail = useRef<{ selection: Selection; retry: number; endpoint: string } | null>(null)
  const text = query.trim()
  const direct = locator(text, endpoint)

  useEffect(() => {
    const key = JSON.stringify([text, endpoint, format, sort, refresh])
    if (completedSearch.current === key) return
    completedSearch.current = null
    const match = locator(text, endpoint)
    setSearchError(null)
    if (match) {
      setResults([])
      setSearching(false)
      const timer = window.setTimeout(() => {
        completedSearch.current = key
        setSelection(match)
      }, 240)
      return () => window.clearTimeout(timer)
    }
    const controller = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      api
        .search(text, format, sort, controller.signal)
        .then((entries) => {
          if (controller.signal.aborted) return
          completedSearch.current = key
          setResults(entries)
          setSelection((current) =>
            current && !current.revision && !current.file && entries.some((e) => e.id === current.id)
              ? current
              : entries[0]
                ? { id: entries[0].id }
                : null,
          )
        })
        .catch((error: Error) => {
          if (controller.signal.aborted) return
          setResults([])
          setSelection(null)
          setSearchError(error.message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, text ? 240 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [endpoint, format, sort, text, refresh])

  useEffect(() => {
    if (!selection) return
    const previous = completedDetail.current
    if (previous?.selection === selection && previous.retry === repoRetry && previous.endpoint === endpoint) return
    completedDetail.current = null
    const controller = new AbortController()
    setDetail(null)
    api
      .repo(selection.id, selection.revision, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        completedDetail.current = { selection, retry: repoRetry, endpoint }
        setDetail({ selection, repo: result })
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setDetail({ selection, error: error.message })
      })
    return () => controller.abort()
  }, [selection, repoRetry, endpoint])

  const selectedDetail = detail?.selection === selection ? detail : null
  const repo = selectedDetail && 'repo' in selectedDetail ? selectedDetail.repo : null
  const repoError = selectedDetail && 'error' in selectedDetail ? selectedDetail.error : null
  const rows = direct ? (repo?.entry ? [repo.entry] : []) : results
  const feedTitle = direct
    ? 'Direct repository'
    : !text && (sort === 'best_match' || sort === 'trending')
      ? 'Staff picks & trending'
      : searching
        ? 'Searching…'
        : `${rows.length} models`

  return (
    <div className="flex h-full min-h-0 flex-col md:grid md:grid-cols-[minmax(310px,40%)_minmax(0,60%)] md:overflow-hidden">
      {/* Left Master Pane: Search Bar + Filter Row + Rich Model List */}
      <div className="flex max-h-80 min-h-0 flex-col border-b border-ink-200 bg-ink-50/40 md:max-h-none md:border-b-0 md:border-r dark:border-ink-800 dark:bg-ink-950/60">
        <form
          className="shrink-0 space-y-2 border-b border-ink-200 p-3 dark:border-ink-800"
          onSubmit={(event) => {
            event.preventDefault()
            if (direct) setRepoRetry((value) => value + 1)
            else setRefresh((value) => value + 1)
          }}
        >
          <label className="relative block">
            <span className="sr-only">Search Hugging Face</span>
            <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-400" />
            <input
              type="search"
              className="input h-8 pl-8 pr-3 text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Model name, author/model, or Hugging Face URL…"
            />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1 text-xs text-ink-600 dark:text-[#cccccc]">
              <span className="truncate font-medium">{feedTitle}</span>
              <button
                type="submit"
                className="icon-btn !size-6"
                aria-label="Refresh model search"
                title="Refresh model search"
              >
                {searching ? <Spinner className="size-3.5" /> : <Icon name="refresh" className="size-3.5" />}
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <select
                className="input h-6 w-auto px-2 py-0 text-[11px] font-medium"
                aria-label="Model format"
                value={format}
                onChange={(event) => setFormat(event.target.value as Format)}
              >
                <option value="all">GGUF, MLX +</option>
                <option value="gguf">GGUF</option>
                <option value="mlx">MLX</option>
              </select>
              <select
                className="input h-6 w-auto px-2 py-0 text-[11px] font-medium"
                aria-label="Sort models"
                disabled={direct !== null}
                value={sort}
                onChange={(event) => setSort(event.target.value as CatalogSort)}
              >
                {SORTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </form>

        <section aria-label="Model results" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {searchError && (
            <p role="alert" className="rounded-[4px] border border-red-300 bg-red-50 p-3 break-words text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {searchError}
            </p>
          )}
          {!searching && !direct && !searchError && !rows.length && (
            <p className="p-4 text-center text-xs text-ink-500 dark:text-ink-400">No models found.</p>
          )}
          {rows.map((entry) => {
            const [owner] = entry.id.split('/')
            const selected = direct !== null || selection?.id === entry.id
            const displayName = cleanDisplayName(entry.id, entry.base_model)
            const caps = entryCapabilities(entry)
            const verified = isRecognized(entry)
            const description = summarizeEntry(entry)

            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  if (!selected) setSelection({ id: entry.id })
                }}
                className={`group flex w-full items-center gap-3 rounded-[6px] px-2.5 py-2.5 text-left transition-colors focus-visible:outline-1 focus-visible:outline-arc-500 ${
                  selected
                    ? 'bg-arc-600 text-white shadow-xs dark:bg-[#0066b8] dark:text-white'
                    : 'text-ink-900 hover:bg-ink-200/60 dark:text-[#e1e1e1] dark:hover:bg-[#2a2d2e]'
                }`}
              >
                <ModelAvatar owner={entry.creator ?? owner} fallbackOwner={owner} name={displayName} size="md" selected={selected} />

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span title={entry.id} className="min-w-0 truncate text-[13px] font-semibold">
                      {displayName}
                    </span>
                    {verified && (
                      <Icon
                        name="verified"
                        className={`size-3.5 shrink-0 ${selected ? 'text-white' : 'text-arc-600 dark:text-arc-400'}`}
                      />
                    )}
                    {caps.length > 0 && (
                      <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
                        {caps.map((cap) => {
                          const meta = CAPABILITY_META[cap]
                          return (
                            <span
                              key={cap}
                              title={meta.label}
                              className={`inline-flex size-5 items-center justify-center rounded-full border ${
                                selected ? meta.selectedDotTone : meta.dotTone
                              }`}
                            >
                              <Icon name={meta.icon} className="size-3" />
                            </span>
                          )
                        })}
                      </span>
                    )}
                  </span>

                  <span
                    className={`mt-0.5 flex items-baseline justify-between gap-2 text-[11.5px] ${
                      selected ? 'text-white/85' : 'text-ink-500 dark:text-[#9d9d9d]'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{description}</span>
                    {entry.last_modified && (
                      <span className={`shrink-0 text-[11px] tabular-nums ${selected ? 'text-white/80' : 'text-ink-400 dark:text-ink-500'}`}>
                        {updated(entry.last_modified)}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            )
          })}
        </section>
      </div>

      {/* Right Detail Pane: Repo Header + Metadata Summary Card + Download Options + README with Images */}
      <section aria-label="Model details" className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-white dark:bg-ink-900">
        {selection && repo && !repoError ? (
          <Repository
            key={`${selection.id}:${selection.revision ?? ''}:${selection.file ?? ''}:${repo.revision ?? ''}`}
            repo={repo}
            endpoint={endpoint}
            format={format}
            preferredFile={selection.file}
            onSummaryLoaded={() => setSummaryTick((n) => n + 1)}
          />
        ) : selection && repoError ? (
          <div className="space-y-3 p-5">
            <h3 className="mono break-all text-sm font-semibold">{selection.id}</h3>
            <p role="alert" className="break-words text-xs text-red-700 dark:text-red-300">
              {repoError}
            </p>
            <button type="button" className="btn-outline" onClick={() => setRepoRetry((value) => value + 1)}>
              Retry
            </button>
          </div>
        ) : selection ? (
          <p className="flex items-center gap-2 p-6 text-xs text-ink-500 dark:text-ink-400">
            <Spinner className="size-4" /> Loading model details…
          </p>
        ) : (
          <EmptyState icon="modelSearch" title={searching ? 'Searching Hugging Face…' : 'Select a model'}>
            Choose a repository on the left to inspect quantizations, hardware fit, and full model documentation.
          </EmptyState>
        )}
      </section>
    </div>
  )
}

function estimateFit(size: number | null, hardware: HardwareSnapshot | undefined, format: CatalogFormat) {
  if (!size || !hardware) return null
  const gpu = Math.max(0, ...hardware.accelerators.filter((a) => a.kind !== 'cpu').map((a) => a.usable_memory ?? 0))
  const ram = Math.max(0, hardware.total_memory - 2 * 1024 ** 3)
  const needed = size * 1.15
  if (gpu > 0 && needed <= gpu) {
    return {
      fits: true,
      label: 'Full GPU Offload Possible',
      pill: 'border-emerald-500/35 bg-emerald-500/12 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-300',
    }
  }
  if (format === 'gguf' && needed <= ram) {
    return {
      fits: true,
      label: gpu > 0 ? 'Partial GPU Offload Possible' : 'Fits in System Memory',
      pill: 'border-sky-500/35 bg-sky-500/12 text-sky-800 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-300',
    }
  }
  if (format === 'mlx' && gpu === 0) return null
  return {
    fits: false,
    label: 'Likely Too Large for This Machine',
    pill: 'border-red-500/35 bg-red-500/12 text-red-800 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-300',
  }
}

function defaultVariant(variants: CatalogVariant[], preferredFile: string | undefined, hardware: HardwareSnapshot | undefined) {
  return (
    variants.find((variant) => variant.files.some((file) => file.path === preferredFile)) ??
    variants.find((variant) => variant.label === 'Q4_K_M' && estimateFit(variant.size, hardware, variant.format)?.fits !== false) ??
    variants.find((variant) => estimateFit(variant.size, hardware, variant.format)?.fits) ??
    variants.reduce<CatalogVariant | undefined>(
      (smallest, variant) => (!smallest || (variant.size ?? Infinity) < (smallest.size ?? Infinity) ? variant : smallest),
      undefined,
    )
  )
}

function Repository({
  repo,
  endpoint,
  format,
  preferredFile,
  onSummaryLoaded,
}: {
  repo: CatalogRepo
  endpoint: string
  format: Format
  preferredFile?: string
  onSummaryLoaded: () => void
}) {
  const hardware = useStudio((s) => s.system?.hardware)
  const models = useStudio((s) => s.models)
  const downloads = useStudio((s) => s.downloads)
  const loadModel = useStudio((s) => s.loadModel)
  const setView = useStudio((s) => s.setView)
  const [chosen, setChosen] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [leadSummary, setLeadSummary] = useState<string | null>(() => readmeSummaryCache.get(repo.id) ?? repo.entry.summary ?? null)

  const variants = (repo.variants ?? []).filter((variant) => format === 'all' || variant.format === format)
  const option = variants.find((variant) => variant.id === chosen) ?? defaultVariant(variants, preferredFile, hardware)
  const installedModel =
    option && models.find((model) => model.source.repo?.toLowerCase() === repo.id.toLowerCase() && model.source.filename === option.id)
  const installed = !!installedModel
  const progress =
    option &&
    downloads.find(
      (job) => job.id === `catalog/${repo.id.toLowerCase()}/${option.id}` && (job.status === 'downloading' || job.status === 'verifying'),
    )
  const fit = option && estimateFit(option.size, hardware, option.format)
  const hubLink = `${endpoint.replace(/\/$/, '')}/${repo.id.split('/').map(encodeURIComponent).join('/')}`
  const baseLink =
    repo.base_model && repo.base_model.toLowerCase() !== repo.id.toLowerCase()
      ? `${endpoint.replace(/\/$/, '')}/${repo.base_model.split('/').map(encodeURIComponent).join('/')}`
      : null

  const [owner] = repo.id.split('/')
  const displayName = cleanDisplayName(repo.id, repo.base_model)
  const caps = entryCapabilities(repo.entry)
  const domain = caps.includes('vision') ? 'vlm' : repo.entry.pipeline_tag === 'feature-extraction' ? 'embedding' : 'llm'
  const activeFormat = (option?.format ?? formatsOf(repo.entry)[0] ?? 'gguf').toUpperCase()
  const summaryText =
    leadSummary ??
    repo.entry.summary ??
    `${displayName} is an open-weight ${caps.includes('vision') ? 'multimodal ' : ''}language model${
      repo.parameters ? ` with ${params(repo.parameters)} parameters` : ''
    }${repo.context_length ? ` and up to ${tokens(repo.context_length)} context` : ''}.`

  const download = async () => {
    if (!option || !repo.revision || starting || installed || progress) return
    setStarting(true)
    setDownloadError(null)
    const jobId = `catalog/${repo.id.toLowerCase()}/${option.id}`
    const previous = useStudio.getState().downloads.find((job) => job.id === jobId)
    try {
      const nextProgress = await api.downloadVariant(repo.id, repo.revision, option.id)
      const studio = useStudio.getState()
      if (studio.downloads.find((job) => job.id === nextProgress.id) === previous) studio.setDownload(nextProgress)
    } catch (error) {
      setDownloadError((error as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const cancelActiveDownload = async () => {
    if (!progress) return
    try {
      await api.cancelDownload(progress.id)
    } catch {
      /* SSE updates state */
    }
  }

  return (
    <article className="mx-auto max-w-4xl space-y-5 p-4 sm:p-5 lg:p-6">
      {/* Top Repository Header */}
      <header className="space-y-2.5">
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 pb-3 dark:border-ink-800">
          <div className="flex min-w-0 items-center gap-2.5">
            <ModelAvatar owner={repo.entry.creator ?? owner} fallbackOwner={owner} name={displayName} size="sm" />
            <h2 className="mono min-w-0 truncate text-[15px] font-semibold tracking-tight text-ink-900 dark:text-white" title={repo.id}>
              {repo.id}
            </h2>
            <CopyButton text={repo.id} label="Copy repository ID" className="icon-btn !size-6" />
          </div>
          <a
            href={hubLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-ink-200 bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700 transition-colors hover:bg-ink-100 dark:border-ink-700 dark:bg-ink-850 dark:text-[#cccccc] dark:hover:bg-[#313131]"
          >
            <span>Hugging Face</span>
            <Icon name="external" className="size-3" />
          </a>
        </div>

        {/* Downloads, Likes, Last Updated & Base Model strip */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-600 dark:text-[#9d9d9d]">
          {repo.entry && (
            <>
              <span className="inline-flex items-center gap-1 rounded-[4px] border border-ink-200 bg-ink-50 px-2 py-0.5 font-medium tabular-nums text-ink-700 dark:border-ink-800 dark:bg-ink-850 dark:text-[#cccccc]">
                <Icon name="download" className="size-3 text-ink-400" />
                {repo.entry.downloads.toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1 rounded-[4px] border border-ink-200 bg-ink-50 px-2 py-0.5 font-medium tabular-nums text-ink-700 dark:border-ink-800 dark:bg-ink-850 dark:text-[#cccccc]">
                <Icon name="star" className="size-3 text-ink-400" />
                {repo.entry.likes.toLocaleString()}
              </span>
            </>
          )}
          {repo.entry?.last_modified && <span>Last updated: {updated(repo.entry.last_modified)}</span>}
          {repo.license && (
            <span className="mono rounded-[3px] bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-600 dark:bg-ink-850 dark:text-ink-300">
              {repo.license}
            </span>
          )}
          {baseLink && repo.base_model && (
            <a
              href={baseLink}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 rounded-[4px] border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100 dark:border-ink-800 dark:bg-ink-850 dark:text-[#cccccc] dark:hover:bg-[#313131]"
            >
              <Icon name="sparkles" className="size-3 text-arc-500" />
              <span className="mono truncate max-w-52">{repo.base_model}</span>
              <Icon name="external" className="size-2.5 opacity-70" />
            </a>
          )}
        </div>
      </header>

      {/* Summary & Technical Metadata Card (matching screenshot layout) */}
      <section aria-label="Model overview" className="rounded-[6px] border border-ink-200 bg-ink-50/70 p-4 space-y-3 dark:border-ink-800 dark:bg-ink-850/80">
        <p className="text-[13px] font-medium leading-relaxed text-arc-700 dark:text-[#4fc1ff]">{summaryText}</p>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-200/80 pt-2.5 text-xs dark:border-ink-800">
          {repo.parameters != null && (
            <div className="inline-flex items-baseline gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Params</span>
              <span className="font-semibold text-ink-900 dark:text-white">{params(repo.parameters)}</span>
            </div>
          )}
          {repo.architecture && (
            <div className="inline-flex items-baseline gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Arch</span>
              <span className="mono font-semibold text-ink-900 dark:text-white">{repo.architecture}</span>
            </div>
          )}
          {repo.context_length != null && (
            <div className="inline-flex items-baseline gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Context</span>
              <span className="mono font-semibold text-ink-900 dark:text-white">{tokens(repo.context_length)}</span>
            </div>
          )}
          <div className="inline-flex items-baseline gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Domain</span>
            <span className="mono font-semibold text-arc-700 dark:text-arc-400">{domain}</span>
          </div>
          <div className="inline-flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Format</span>
            <span className="mono rounded-[3px] bg-arc-600 px-1.5 py-0.5 text-[10.5px] font-semibold text-white">{activeFormat}</span>
          </div>
        </div>

        {caps.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Capabilities</span>
            {caps.map((cap) => {
              const meta = CAPABILITY_META[cap]
              return (
                <span key={cap} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${meta.pillTone}`}>
                  <Icon name={meta.icon} className="size-3" />
                  {meta.label}
                </span>
              )
            })}
          </div>
        )}
      </section>

      {/* Download Options Section */}
      <section aria-label="Download options" className="space-y-2.5">
        <h3 className="text-[13px] font-semibold text-ink-900 dark:text-white">Download Options</h3>
        <div className="rounded-[6px] border border-ink-200 bg-white p-3.5 space-y-3 dark:border-ink-800 dark:bg-ink-850">
          {repo.gated && (
            <p className="flex items-center gap-1.5 rounded-[4px] border border-amber-400/40 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <Icon name="lock" className="size-3.5 shrink-0" />
              Accept the repository’s terms on Hugging Face and add an access token in Settings.
            </p>
          )}

          {option ? (
            <>
              <label className="relative flex items-center gap-2 rounded-[4px] border border-ink-300 bg-ink-50 px-2.5 py-1.5 focus-within:border-arc-500 dark:border-ink-700 dark:bg-[#1f1f1f]">
                <span className="sr-only">Quantization and format</span>
                <span className="mono shrink-0 rounded-[3px] bg-arc-600 px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
                  {option.format.toUpperCase()}
                </span>
                <span className="hidden truncate text-xs font-medium text-ink-700 sm:inline dark:text-[#cccccc]">{displayName}</span>
                <select
                  value={option.id}
                  aria-label="Quantization and format"
                  className="mono min-w-0 flex-1 cursor-pointer bg-transparent py-0.5 text-xs font-medium text-ink-900 outline-none dark:text-white"
                  onChange={(event) => {
                    setChosen(event.target.value)
                    setDownloadError(null)
                  }}
                >
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id} className="bg-white text-ink-900 dark:bg-ink-850 dark:text-white">
                      {variant.label} — {bytes(variant.size)}
                      {variant.files.length > 1 ? ` (${variant.files.length} shards)` : ''}
                    </option>
                  ))}
                </select>
              </label>

              {progress && (
                <div className="space-y-1 rounded-[4px] border border-arc-500/30 bg-arc-500/5 p-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-arc-700 dark:text-arc-300">
                      {progress.status === 'verifying'
                        ? 'Verifying SHA-256 digest…'
                        : `${bytes(progress.downloaded)} / ${bytes(progress.total)} · ${rate(progress.bytes_per_second)}`}
                    </span>
                    <span className="flex items-center gap-2">
                      {progress.total && progress.bytes_per_second > 1 && progress.status !== 'verifying' && (
                        <span className="tabular-nums text-[11px] text-ink-500">{eta((progress.total - progress.downloaded) / progress.bytes_per_second)}</span>
                      )}
                      <button type="button" className="text-[11px] font-medium text-red-600 hover:underline dark:text-red-400" onClick={() => void cancelActiveDownload()}>
                        Cancel
                      </button>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-[2px] bg-ink-200 dark:bg-ink-800">
                    <div
                      className={`h-full transition-[width] duration-300 ${progress.status === 'verifying' ? 'bg-emerald-500' : 'bg-arc-500'}`}
                      style={{ width: `${progress.total ? (progress.downloaded / progress.total) * 100 : 100}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {fit && (
                    <span className={`inline-flex items-center gap-1.5 rounded-[4px] border px-2.5 py-1 text-[11.5px] font-medium ${fit.pill}`}>
                      <Icon name="cpu" className="size-3.5 shrink-0" />
                      {fit.label}
                    </span>
                  )}
                  {option.format === 'mlx' && (
                    <span className="text-[11px] text-ink-500 dark:text-ink-400">Requires MLX runtime on Apple Silicon</span>
                  )}
                </div>

                {installed && installedModel ? (
                  <button
                    type="button"
                    className="btn-outline ml-auto px-3.5 py-1.5 text-xs font-semibold"
                    onClick={async () => {
                      await loadModel(installedModel.id)
                      setView('chat')
                    }}
                  >
                    <Icon name="check" className="size-3.5 text-emerald-500" />
                    Installed · Load in Chat
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary ml-auto px-4 py-1.5 text-xs font-semibold"
                    disabled={!repo.revision || starting || !!progress}
                    onClick={() => void download()}
                  >
                    {starting || progress ? <Spinner className="size-3.5" /> : <Icon name="download" className="size-3.5" />}
                    {progress
                      ? progress.status === 'verifying'
                        ? 'Verifying…'
                        : 'Downloading…'
                      : starting
                        ? 'Starting…'
                        : `Download  ${bytes(option.size)}`}
                  </button>
                )}
              </div>

              <details className="border-t border-ink-200/80 pt-2 text-xs text-ink-500 dark:border-ink-800 dark:text-ink-400">
                <summary className="cursor-pointer select-none font-medium hover:text-ink-800 dark:hover:text-white">
                  Files ({option.files.length}){repo.revision ? ` · revision ${repo.revision.slice(0, 10)}` : ''}
                </summary>
                <ul className="mono mt-2 max-h-44 space-y-1 overflow-auto text-[11px]">
                  {option.files.map((file) => (
                    <li key={file.path} className="flex justify-between gap-3">
                      <span className="break-all">{file.path}</span>
                      <span className="shrink-0 tabular-nums">{bytes(file.size)}</span>
                    </li>
                  ))}
                </ul>
              </details>
              {!repo.revision && (
                <p className="text-xs text-amber-700 dark:text-amber-300">This repository returned no commit to pin the download to.</p>
              )}
            </>
          ) : (
            <p className="text-xs text-ink-500 dark:text-ink-400">
              No complete {format === 'all' ? 'GGUF or MLX' : format.toUpperCase()} download options were found.
            </p>
          )}
          {downloadError && (
            <p role="alert" className="break-words text-xs text-red-700 dark:text-red-300">
              {downloadError}
            </p>
          )}
        </div>
      </section>

      <ModelReadme
        repo={repo}
        endpoint={endpoint}
        hubLink={hubLink}
        onLeadSummary={(summary) => {
          rememberSummary(repo.id, summary)
          if (repo.base_model) rememberSummary(repo.base_model, summary)
          setLeadSummary(summary)
          onSummaryLoaded()
        }}
      />
    </article>
  )
}

function ModelReadme({
  repo,
  endpoint,
  hubLink,
  onLeadSummary,
}: {
  repo: CatalogRepo
  endpoint: string
  hubLink: string
  onLeadSummary: (summary: string) => void
}) {
  const [readme, setReadme] = useState<string | null | undefined>(undefined)
  const [baseReadme, setBaseReadme] = useState<string | null | undefined>(undefined)
  const [sourceTab, setSourceTab] = useState<'primary' | 'base'>('primary')
  const [error, setError] = useState(false)
  const loaded = useRef(false)
  const summarySent = useRef(false)
  const distinctBase =
    repo.base_model && repo.base_model.includes('/') && repo.base_model.toLowerCase() !== repo.id.toLowerCase()
      ? repo.base_model
      : null

  useEffect(() => {
    if (loaded.current) return
    const controller = new AbortController()
    api
      .catalogReadme(repo.id, repo.revision ?? undefined, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return
        loaded.current = true
        setError(false)
        setReadme(result)

        let baseCard: string | null = null
        if (distinctBase && isBoilerplateQuantCard(result)) {
          try {
            baseCard = await api.catalogReadme(distinctBase, undefined, controller.signal)
            if (controller.signal.aborted) return
            setBaseReadme(baseCard)
            if (baseCard) setSourceTab('base')
          } catch {
            if (!controller.signal.aborted) setBaseReadme(null)
          }
        }

        if (!summarySent.current) {
          const extracted = extractLeadSummary(baseCard) ?? extractLeadSummary(result)
          if (extracted) {
            summarySent.current = true
            onLeadSummary(extracted)
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [repo.id, repo.revision, distinctBase, onLeadSummary])

  const loadBaseOnDemand = () => {
    if (!distinctBase || baseReadme !== undefined) {
      setSourceTab('base')
      return
    }
    setSourceTab('base')
    api
      .catalogReadme(distinctBase)
      .then((card) => {
        setBaseReadme(card)
        if (!summarySent.current) {
          const extracted = extractLeadSummary(card)
          if (extracted) {
            summarySent.current = true
            onLeadSummary(extracted)
          }
        }
      })
      .catch(() => setBaseReadme(null))
  }

  const showingBase = sourceTab === 'base' && distinctBase !== null
  const activeRepoId = showingBase ? distinctBase : repo.id
  const activeRevision = showingBase ? 'main' : (repo.revision ?? 'main')
  const activeHubLink = showingBase
    ? `${endpoint.replace(/\/$/, '')}/${distinctBase.split('/').map(encodeURIComponent).join('/')}`
    : hubLink
  const activeRaw = showingBase ? baseReadme : readme
  const prepared = useMemo(() => (activeRaw ? prepareReadmeMarkdown(activeRaw) : null), [activeRaw])

  return (
    <section aria-label="README" className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-ink-700 dark:text-[#cccccc]">README</h3>
        {distinctBase && (
          <div className="inline-flex items-center gap-0.5 rounded-[4px] border border-ink-200 bg-ink-50 p-0.5 text-[11px] dark:border-ink-800 dark:bg-ink-850">
            {baseReadme && (
              <button
                type="button"
                onClick={() => setSourceTab('base')}
                className={`rounded-[3px] px-2 py-0.5 font-medium ${
                  showingBase ? 'bg-arc-600 text-white' : 'text-ink-600 hover:text-ink-900 dark:text-[#cccccc]'
                }`}
              >
                Model Card ({distinctBase.split('/')[1]})
              </button>
            )}
            <button
              type="button"
              onClick={() => setSourceTab('primary')}
              className={`rounded-[3px] px-2 py-0.5 font-medium ${
                !showingBase ? 'bg-arc-600 text-white' : 'text-ink-600 hover:text-ink-900 dark:text-[#cccccc]'
              }`}
            >
              Repository ({repo.id.split('/')[1]})
            </button>
            {baseReadme === undefined && (
              <button
                type="button"
                onClick={loadBaseOnDemand}
                className="rounded-[3px] px-2 py-0.5 font-medium text-ink-600 hover:text-ink-900 dark:text-[#cccccc]"
              >
                Original Card ({distinctBase.split('/')[1]})
              </button>
            )}
          </div>
        )}
      </div>

      <div className="rounded-[6px] border border-ink-200 bg-white p-4 sm:p-5 dark:border-ink-800 dark:bg-ink-850">
        {error ? (
          <p className="text-xs text-ink-500">
            README could not be loaded.{' '}
            <a className="text-arc-600 underline dark:text-arc-400" href={hubLink} target="_blank" rel="noreferrer">
              Open the repository
            </a>
          </p>
        ) : activeRaw === undefined ? (
          <div className="flex items-center gap-2 py-3 text-xs text-ink-500">
            <Spinner className="size-4" />
            <span>Loading README…</span>
          </div>
        ) : !prepared ? (
          <p className="text-xs text-ink-500">This repository has no README.</p>
        ) : (
          <div className="prose-chat min-w-0 overflow-x-auto break-words text-sm">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  if (!href) return <>{children}</>
                  if (href.startsWith('#')) return <span>{children}</span>
                  try {
                    const url = new URL(href, `${activeHubLink}/blob/${encodeURIComponent(activeRevision)}/README.md`)
                    if (url.protocol === 'http:' || url.protocol === 'https:') {
                      return (
                        <a href={url.href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      )
                    }
                  } catch {
                    // Keep link text when the repository supplied an invalid URL.
                  }
                  return <>{children}</>
                },
                img: ({ src, alt }) => {
                  if (!src) return null
                  const trimmed = src.trim()
                  if (!trimmed || /^(?:javascript|vbscript|file):/i.test(trimmed)) return null
                  const resolved = trimmed.startsWith('data:image/')
                    ? trimmed
                    : api.catalogImageUrl(trimmed, activeRepoId, activeRevision)
                  return <ReadmeImage src={resolved} alt={alt ?? ''} />
                },
              }}
            >
              {prepared}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </section>
  )
}

function ReadmeImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return alt ? <span className="text-xs text-ink-400">[{alt}]</span> : null
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="my-2 inline-block max-h-[420px] max-w-full rounded-[4px] object-contain"
      onError={() => setFailed(true)}
    />
  )
}
