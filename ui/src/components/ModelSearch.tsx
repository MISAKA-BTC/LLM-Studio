import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'
import { bytes, count, params, relativeTime, tokens } from '../lib/format'
import type { CatalogEntry, CatalogFormat, CatalogRepo, CatalogSort, CatalogVariant, HardwareSnapshot } from '../lib/types'
import { useStudio } from '../store/studio'
import { EmptyState, Icon, Spinner } from './common'
import { MiningCatalog, PublishedPalwModels } from './MiningCatalog'
import { RetainedView } from './shell/RetainedView'

type CatalogSection = 'local' | 'mining' | 'published'
type Format = 'all' | CatalogFormat
type Selection = { id: string; revision?: string; file?: string }

const SECTIONS: ReadonlyArray<[CatalogSection, string]> = [
  ['local', 'Local inference'], ['mining', 'Mining classes'], ['published', 'Unregistered PALW'],
]
const SORTS: ReadonlyArray<[CatalogSort, string]> = [
  ['best_match', 'Best match'], ['trending', 'Trending'], ['downloads', 'Most downloads'],
  ['likes', 'Most likes'], ['updated', 'Recently updated'],
]

export function ModelSearch() {
  const [section, setSection] = useState<CatalogSection>('local')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="Model collections" className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-ink-200 px-4 dark:border-ink-800">
        {SECTIONS.map(([value, label]) => (
          <button key={value} type="button" aria-pressed={section === value} onClick={() => setSection(value)}
            className={`border-b-2 px-1 py-2.5 text-sm font-medium ${section === value
              ? 'border-arc-500 text-arc-700 dark:text-arc-300'
              : 'border-transparent text-ink-500 hover:text-ink-800 dark:text-ink-400 dark:hover:text-ink-200'}`}>
            {label}
          </button>
        ))}
      </nav>
      <RetainedView active={section === 'local'}>
        <div className="min-h-0 flex-1">
          <HubSearch />
        </div>
      </RetainedView>
      {section === 'mining' && <div className="min-h-0 flex-1 overflow-y-auto p-4"><MiningCatalog searchable /></div>}
      {section === 'published' && <div className="min-h-0 flex-1 overflow-y-auto p-4"><PublishedPalwModels /></div>}
    </div>
  )
}

function locator(input: string, endpoint: string): Selection | null {
  if (/^[\w.-]+\/[\w.-]+$/.test(input)) return { id: input }
  try {
    const url = new URL(input)
    const hub = new URL(endpoint)
    const base = hub.pathname.replace(/\/$/, '')
    const path = url.origin === hub.origin && url.pathname.startsWith(`${base}/`)
      ? url.pathname.slice(base.length)
      : url.origin === 'https://huggingface.co' ? url.pathname : ''
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

function formats(entry: CatalogEntry) {
  return [entry.tags.includes('gguf') ? 'GGUF' : null, entry.tags.includes('mlx') ? 'MLX' : null].filter(Boolean)
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
  const completedSearch = useRef<string | null>(null)
  const completedDetail = useRef<{ selection: Selection; retry: number; endpoint: string } | null>(null)
  const text = query.trim()
  const direct = locator(text, endpoint)

  useEffect(() => {
    const key = JSON.stringify([text, endpoint, format, sort, refresh])
    if (completedSearch.current === key) return
    // Forget the previous result as soon as a different request starts replacing it.
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
      api.search(text, format, sort, controller.signal).then((entries) => {
        if (controller.signal.aborted) return
        completedSearch.current = key
        setResults(entries)
        setSelection((current) => current && !current.revision && !current.file && entries.some((e) => e.id === current.id)
          ? current : entries[0] ? { id: entries[0].id } : null)
      }).catch((error: Error) => {
        if (controller.signal.aborted) return
        setResults([])
        setSelection(null)
        setSearchError(error.message)
      }).finally(() => {
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
    api.repo(selection.id, selection.revision, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      completedDetail.current = { selection, retry: repoRetry, endpoint }
      setDetail({ selection, repo: result })
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setDetail({ selection, error: error.message })
    })
    return () => controller.abort()
  }, [selection, repoRetry, endpoint])

  const selectedDetail = detail?.selection === selection ? detail : null
  const repo = selectedDetail && 'repo' in selectedDetail ? selectedDetail.repo : null
  const repoError = selectedDetail && 'error' in selectedDetail ? selectedDetail.error : null
  const rows = direct ? (repo?.entry ? [repo.entry] : []) : results
  return (
    <div className="flex h-full min-h-0 flex-col">
      <form className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-200 p-4 dark:border-ink-800" onSubmit={(event) => {
        event.preventDefault()
        if (direct) setRepoRetry((value) => value + 1)
        else setRefresh((value) => value + 1)
      }}>
        <label className="relative min-w-[min(100%,17rem)] flex-1">
          <span className="sr-only">Search Hugging Face</span>
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <input type="search" className="input pl-9" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Model name, author/model, or Hugging Face URL" />
        </label>
        <select className="input w-auto" aria-label="Model format" value={format} onChange={(event) => setFormat(event.target.value as Format)}>
          <option value="all">GGUF + MLX</option>
          <option value="gguf">GGUF</option>
          <option value="mlx">MLX</option>
        </select>
        <select className="input w-auto" aria-label="Sort models" disabled={direct !== null} value={sort} onChange={(event) => setSort(event.target.value as CatalogSort)}>
          {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="submit" className="btn-ghost" aria-label="Refresh model search" title="Refresh model search">
          {searching ? <Spinner className="size-4" /> : <Icon name="refresh" className="size-4" />}
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(13rem,1fr)_minmax(0,1.7fr)] md:overflow-hidden">
        <section aria-label="Model results" className="max-h-64 overflow-y-auto border-b border-ink-200 md:max-h-none md:border-b-0 md:border-r dark:border-ink-800">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-ink-200 bg-ink-50 px-4 py-2 text-xs text-ink-500 dark:border-ink-800 dark:bg-ink-950 dark:text-ink-400">
            <span className="font-semibold">{direct ? 'Repository' : !text && (sort === 'best_match' || sort === 'trending') ? 'Trending on Hugging Face' : 'Repositories'}</span>
            <span aria-live="polite">{searching ? 'Searching…' : rows.length}</span>
          </div>
          {searchError && <p role="alert" className="break-words p-4 text-sm text-red-700 dark:text-red-300">{searchError}</p>}
          {!searching && !direct && !searchError && !rows.length && <p className="p-4 text-sm text-ink-500">No models found.</p>}
          {rows.map((entry) => {
            const [owner, name] = entry.id.split('/')
            const selected = direct !== null || selection?.id === entry.id
            return (
              <button key={entry.id} type="button" aria-pressed={selected} onClick={() => { if (!selected) setSelection({ id: entry.id }) }}
                className={`block w-full border-b border-l-2 px-4 py-3 text-left transition-colors dark:border-b-ink-800 ${selected
                  ? 'border-l-arc-500 border-b-ink-200 bg-arc-500/10'
                  : 'border-l-transparent border-b-ink-100 hover:bg-ink-100 dark:hover:bg-ink-900'}`}>
                <span title={entry.id} className="block truncate text-sm font-semibold">{name ?? owner}</span>
                <span className="mt-0.5 block truncate text-xs text-ink-500 dark:text-ink-400">{name ? owner : 'Hugging Face'}</span>
                <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500 dark:text-ink-400">
                  {formats(entry).map((value) => <span key={value} className="mono font-medium text-arc-700 dark:text-arc-300">{value}</span>)}
                  <span className="inline-flex items-center gap-1" title={`${entry.downloads.toLocaleString()} downloads`}><Icon name="download" className="size-3" />{count(entry.downloads)}</span>
                  {entry.last_modified && <span>{updated(entry.last_modified)}</span>}
                </span>
              </button>
            )
          })}
        </section>

        <section aria-label="Model details" className="min-w-0 md:overflow-y-auto">
          {selection && repo && !repoError ? (
            <Repository key={`${selection.id}:${selection.revision ?? ''}:${selection.file ?? ''}:${repo.revision ?? ''}`} repo={repo} endpoint={endpoint} format={format} preferredFile={selection.file} />
          ) : selection && repoError ? (
            <div className="space-y-3 p-5">
              <h3 className="break-all text-base font-semibold">{selection.id}</h3>
              <p role="alert" className="break-words text-sm text-red-700 dark:text-red-300">{repoError}</p>
              <button type="button" className="btn-outline" onClick={() => setRepoRetry((value) => value + 1)}>Retry</button>
            </div>
          ) : selection ? (
            <p className="flex items-center gap-2 p-5 text-sm text-ink-500"><Spinner className="size-4" /> Loading model details…</p>
          ) : (
            <EmptyState icon="cube" title={searching ? 'Searching Hugging Face' : 'Select a repository'} />
          )}
        </section>
      </div>
    </div>
  )
}

function estimateFit(size: number | null, hardware: HardwareSnapshot | undefined, format: CatalogFormat) {
  if (!size || !hardware) return null
  const gpu = Math.max(0, ...hardware.accelerators.filter((a) => a.kind !== 'cpu').map((a) => a.usable_memory ?? 0))
  const ram = Math.max(0, hardware.total_memory - 2 * 1024 ** 3)
  const needed = size * 1.15
  if (gpu > 0 && needed <= gpu) return { fits: true, label: 'Likely fits in GPU memory', tone: 'text-emerald-700 dark:text-emerald-300' }
  if (format === 'gguf' && needed <= ram) return { fits: true, label: 'Likely fits in system memory', tone: 'text-amber-700 dark:text-amber-300' }
  if (format === 'mlx' && gpu === 0) return null
  return { fits: false, label: 'Likely too large for this machine', tone: 'text-red-700 dark:text-red-300' }
}

function defaultVariant(variants: CatalogVariant[], preferredFile: string | undefined, hardware: HardwareSnapshot | undefined) {
  return variants.find((variant) => variant.files.some((file) => file.path === preferredFile))
    ?? variants.find((variant) => variant.label === 'Q4_K_M' && estimateFit(variant.size, hardware, variant.format)?.fits !== false)
    ?? variants.find((variant) => estimateFit(variant.size, hardware, variant.format)?.fits)
    ?? variants.reduce<CatalogVariant | undefined>((smallest, variant) =>
      !smallest || (variant.size ?? Infinity) < (smallest.size ?? Infinity) ? variant : smallest, undefined)
}

function Repository({ repo, endpoint, format, preferredFile }: { repo: CatalogRepo; endpoint: string; format: Format; preferredFile?: string }) {
  const hardware = useStudio((s) => s.system?.hardware)
  const models = useStudio((s) => s.models)
  const downloads = useStudio((s) => s.downloads)
  const [chosen, setChosen] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const variants = (repo.variants ?? []).filter((variant) => format === 'all' || variant.format === format)
  const option = variants.find((variant) => variant.id === chosen) ?? defaultVariant(variants, preferredFile, hardware)
  const installed = option && models.some((model) => model.source.repo?.toLowerCase() === repo.id.toLowerCase() && model.source.filename === option.id)
  const progress = option && downloads.find((job) => job.id === `catalog/${repo.id.toLowerCase()}/${option.id}` && (job.status === 'downloading' || job.status === 'verifying'))
  const fit = option && estimateFit(option.size, hardware, option.format)
  const hubLink = `${endpoint.replace(/\/$/, '')}/${repo.id.split('/').map(encodeURIComponent).join('/')}`
  const [owner, name] = repo.id.split('/')
  const metadata = [
    ['Architecture', repo.architecture], ['Parameters', repo.parameters == null ? null : params(repo.parameters)],
    ['Context', repo.context_length == null ? null : tokens(repo.context_length)], ['License', repo.license],
    ['Task', repo.entry?.pipeline_tag?.replaceAll('-', ' ')], ['Base model', repo.base_model],
  ].filter(([, value]) => value)
  const tags = repo.entry?.tags ?? []
  const capabilities = [
    repo.entry?.pipeline_tag === 'image-text-to-text' || tags.includes('vision') ? 'Vision' : null,
    tags.some((tag) => ['tool-calling', 'function-calling', 'tool-use'].includes(tag)) ? 'Tool use' : null,
    tags.some((tag) => ['reasoning', 'thinking'].includes(tag)) ? 'Reasoning' : null,
  ].filter((tag): tag is string => tag !== null)

  const download = async () => {
    if (!option || !repo.revision || starting || installed || progress) return
    setStarting(true)
    setDownloadError(null)
    const jobId = `catalog/${repo.id.toLowerCase()}/${option.id}`
    const previous = useStudio.getState().downloads.find((job) => job.id === jobId)
    try {
      const progress = await api.downloadVariant(repo.id, repo.revision, option.id)
      const studio = useStudio.getState()
      if (studio.downloads.find((job) => job.id === progress.id) === previous) studio.setDownload(progress)
    } catch (error) {
      setDownloadError((error as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <article className="mx-auto max-w-4xl space-y-5 p-4 sm:p-5 lg:p-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="mono break-all text-xs text-ink-500 dark:text-ink-400">{name ? owner : 'Hugging Face'}</span>
          <a href={hubLink} target="_blank" rel="noreferrer" className="text-xs font-medium text-arc-700 hover:underline dark:text-arc-300">View on Hugging Face ↗</a>
        </div>
        <h2 className="break-words text-2xl font-semibold tracking-tight">{name ?? owner}</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-500 dark:text-ink-400">
          {repo.entry && <><span>{repo.entry.downloads.toLocaleString()} downloads</span><span>{repo.entry.likes.toLocaleString()} likes</span></>}
          {repo.entry?.last_modified && <span>Updated {updated(repo.entry.last_modified)}</span>}
          <span className="badge bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200">No mining support</span>
        </div>
      </header>

      {metadata.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-ink-100/70 p-3 dark:bg-ink-900 lg:grid-cols-3">
          {metadata.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-ink-500 dark:text-ink-400">{label}</dt>
              <dd className="mono mt-0.5 break-words text-xs font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {capabilities.length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
        <span>Repository tags</span>
        {capabilities.map((tag) => <span key={tag} className="badge bg-arc-500/10 text-arc-700 dark:text-arc-300">{tag}</span>)}
      </div>}

      <section aria-label="Download options" className="card space-y-3 p-4">
        <h3 className="text-sm font-semibold">Download options</h3>
        {repo.gated && <p className="text-xs text-amber-700 dark:text-amber-300">Accept the repository’s terms on Hugging Face and add an access token in Settings.</p>}
        {option ? (
          <>
            <label className="block min-w-0 text-xs text-ink-500 dark:text-ink-400">
              <span className="sr-only">Quantization and format</span>
              <select value={option.id} className="input mono w-full" onChange={(event) => { setChosen(event.target.value); setDownloadError(null) }}>
                {variants.map((variant) => <option key={variant.id} value={variant.id}>
                  {variant.format.toUpperCase()} · {variant.label} · {bytes(variant.size)}{variant.files.length > 1 ? ` · ${variant.files.length} files` : ''}
                </option>)}
              </select>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-ink-500 dark:text-ink-400">
                {fit && <div className={fit.tone}>{fit.label} <span className="text-ink-500">(estimate)</span></div>}
                {option.format === 'mlx' && <div>Requires the MLX runtime on Apple silicon.</div>}
              </div>
              <button type="button" className="btn-primary ml-auto" disabled={!repo.revision || starting || installed || !!progress} onClick={() => void download()}>
                {starting || progress ? <Spinner className="size-4" /> : <Icon name="download" className="size-4" />}
                {installed ? 'Installed' : progress ? (progress.status === 'verifying' ? 'Verifying…' : 'Downloading…') : starting ? 'Starting…' : `Download · ${bytes(option.size)}`}
              </button>
            </div>
            <details className="border-t border-ink-100 pt-2 text-xs text-ink-500 dark:border-ink-800 dark:text-ink-400">
              <summary className="cursor-pointer">Files{repo.revision ? ` · revision ${repo.revision.slice(0, 10)}` : ''}</summary>
              <ul className="mono mt-2 max-h-44 space-y-1 overflow-auto">
                {option.files.map((file) => <li key={file.path} className="flex justify-between gap-3"><span className="break-all">{file.path}</span><span className="shrink-0">{bytes(file.size)}</span></li>)}
              </ul>
            </details>
            {!repo.revision && <p className="text-xs text-amber-700 dark:text-amber-300">This repository returned no commit to pin the download to.</p>}
          </>
        ) : <p className="text-xs text-ink-500 dark:text-ink-400">No complete {format === 'all' ? 'GGUF or MLX' : format.toUpperCase()} download options were found.</p>}
        {downloadError && <p role="alert" className="break-words text-xs text-red-700 dark:text-red-300">{downloadError}</p>}
      </section>
      <ModelReadme repo={repo} hubLink={hubLink} />
    </article>
  )
}

function ModelReadme({ repo, hubLink }: { repo: CatalogRepo; hubLink: string }) {
  const [readme, setReadme] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState(false)
  const loaded = useRef(false)
  useEffect(() => {
    if (loaded.current) return
    const controller = new AbortController()
    api.catalogReadme(repo.id, repo.revision ?? undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      loaded.current = true
      setError(false)
      setReadme(result)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    })
    return () => controller.abort()
  }, [repo.id, repo.revision])
  return (
    <section aria-label="README" className="space-y-3 border-t border-ink-200 pt-4 dark:border-ink-800">
      <h3 className="text-sm font-semibold">README</h3>
      {error ? <p className="text-xs text-ink-500">README could not be loaded. <a className="underline" href={hubLink} target="_blank" rel="noreferrer">Open the repository</a></p>
        : readme === undefined ? <Spinner className="size-4 text-ink-500" />
        : !readme ? <p className="text-xs text-ink-500">This repository has no README.</p>
        : <div className="prose-chat min-w-0 overflow-x-auto break-words text-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]} disallowedElements={['img']} components={{
            a: ({ href, children }) => {
              if (!href) return <>{children}</>
              if (href.startsWith('#')) return <span>{children}</span>
              try {
                const url = new URL(href, `${hubLink}/blob/${encodeURIComponent(repo.revision ?? 'main')}/README.md`)
                if (url.protocol === 'http:' || url.protocol === 'https:') return <a href={url.href} target="_blank" rel="noreferrer">{children}</a>
              } catch {
                // Keep the link text when the repository supplied an invalid URL.
              }
              return <>{children}</>
            },
          }}>{readme}</ReactMarkdown>
        </div>}
    </section>
  )
}
