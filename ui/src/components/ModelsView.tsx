// Models: what is installed, what can be downloaded, and what is downloading now.
//
// Styled in VS Code workbench density, with creator avatars and hardware fit verdicts on every row.

import { useState } from 'react'
import { api } from '../lib/api'
import { bytes, eta, params, rate, relativeTime, tokens } from '../lib/format'
import type { DownloadProgress } from '../lib/types'
import { useStudio } from '../store/studio'
import { useUi } from '../store/ui'
import { EmptyState, FitBadge, Icon, QuantBadge, Spinner } from './common'
import { ContextBadge } from './ContextBadge'
import { InstalledMiningArtifacts } from './MiningCatalog'
import { ModelAvatar, ModelSearch } from './ModelSearch'
import { RetainedView } from './shell/RetainedView'

export function ModelsView() {
  const tab = useUi((s) => s.modelsTab)
  const setTab = useUi((s) => s.setModelsTab)
  const models = useStudio((s) => s.models)
  const downloads = useStudio((s) => s.downloads)
  const refreshModels = useStudio((s) => s.refreshModels)

  const active = downloads.filter((d) => d.status === 'downloading' || d.status === 'verifying')

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white dark:bg-ink-900">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-200 bg-ink-50/70 px-3 dark:border-ink-800 dark:bg-ink-950/70">
        <div className="inline-flex items-center gap-0.5 rounded-[4px] border border-ink-300 bg-ink-100 p-0.5 dark:border-ink-700 dark:bg-[#252526]">
          {(['installed', 'discover'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
              className={`inline-flex h-6 items-center rounded-[3px] px-2.5 text-xs font-medium transition-colors ${
                tab === value
                  ? 'bg-arc-600 text-white shadow-xs'
                  : 'text-ink-600 hover:text-ink-900 dark:text-[#cccccc] dark:hover:text-white'
              }`}
            >
              {value === 'discover' ? 'Model Search' : 'Installed'}
              {value === 'installed' && models.length > 0 && (
                <span className={`ml-1.5 text-[11px] tabular-nums ${tab === value ? 'text-white/80' : 'text-ink-500 dark:text-ink-400'}`}>
                  {models.length}
                </span>
              )}
            </button>
          ))}
        </div>
        {tab === 'installed' && (
          <button type="button" className="btn-ghost ml-auto h-6 px-2 text-xs" onClick={() => void refreshModels()}>
            <Icon name="refresh" className="size-3.5" />
            Rescan
          </button>
        )}
      </div>

      {active.length > 0 && <DownloadsPanel downloads={downloads} />}
      <div className="min-h-0 flex-1 overflow-hidden">
        <RetainedView active={tab === 'installed'}>
          <div className="h-full overflow-y-auto" data-model-tab="installed">
            <InstalledMiningArtifacts />
            <InstalledList />
          </div>
        </RetainedView>
        <RetainedView active={tab === 'discover'}>
          <div className="flex h-full min-h-0 flex-col" data-model-tab="discover">
            <ModelSearch />
          </div>
        </RetainedView>
      </div>
    </div>
  )
}

function DownloadsPanel({ downloads }: { downloads: DownloadProgress[] }) {
  const cancel = async (id: string) => {
    try {
      await api.cancelDownload(id)
    } catch {
      /* the store's SSE stream reports the outcome */
    }
  }

  return (
    <div className="max-h-[28vh] shrink-0 overflow-y-auto border-b border-ink-200 bg-ink-50 px-3.5 py-2.5 dark:border-ink-800 dark:bg-ink-950">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">Active Downloads</h3>
      <div className="space-y-2">
        {downloads
          .filter((d) => d.status === 'downloading' || d.status === 'verifying')
          .map((download) => {
            const percent = download.total ? (download.downloaded / download.total) * 100 : null
            const remaining =
              download.total && download.bytes_per_second > 1 ? (download.total - download.downloaded) / download.bytes_per_second : null
            const repoOwner = download.repo.split('/')[0] ?? null
            return (
              <div key={download.id} className="card p-2.5">
                <div className="flex items-center gap-2.5">
                  <ModelAvatar owner={repoOwner} name={download.repo} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{download.id.startsWith('catalog/') ? download.file : download.model_id}</div>
                    <div className="mono truncate text-[11px] text-ink-500 dark:text-ink-400">{download.repo}</div>
                  </div>
                  <button type="button" className="icon-btn !size-6" title="Cancel" onClick={() => void cancel(download.id)}>
                    <Icon name="x" className="size-3.5" />
                  </button>
                </div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-[2px] bg-ink-200 dark:bg-ink-800">
                  <div
                    className={`h-full transition-[width] duration-300 ${download.status === 'verifying' ? 'bg-emerald-500' : 'bg-arc-500'}`}
                    style={{ width: `${percent ?? 100}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-ink-500 dark:text-ink-400">
                  <span>
                    {download.status === 'verifying'
                      ? 'Verifying published SHA-256 digest…'
                      : `${bytes(download.downloaded)} of ${bytes(download.total)} · ${rate(download.bytes_per_second)}`}
                  </span>
                  <span className="tabular-nums">{download.status === 'verifying' ? '' : remaining !== null ? eta(remaining) : ''}</span>
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}

function InstalledList() {
  const models = useStudio((s) => s.models)
  const runtime = useStudio((s) => s.runtime)
  const loadingModelId = useStudio((s) => s.loadingModelId)
  const loadModel = useStudio((s) => s.loadModel)
  const unloadModel = useStudio((s) => s.unloadModel)
  const deleteModel = useStudio((s) => s.deleteModel)
  const hashModel = useStudio((s) => s.hashModel)
  const system = useStudio((s) => s.system)
  const setView = useStudio((s) => s.setView)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [hashing, setHashing] = useState<string | null>(null)

  if (models.length === 0) {
    return (
      <EmptyState icon="cube" title="No models installed">
        Models live in <code className="mono">{system?.models_dir ?? 'the model directory'}</code>. Put a <code className="mono">.gguf</code>{' '}
        file there and rescan, or open <strong>Model Search</strong> to download one.
      </EmptyState>
    )
  }

  return (
    <div className="space-y-2 p-3.5">
      {models.map((model) => {
        const isLoaded = runtime?.model_id === model.id
        const isMiningArtifact = model.architecture === 'palw' && runtime?.backend !== 'misaka'
        const owner = (model.source.base_repo ?? model.source.repo ?? model.id).split('/')[0] ?? null
        const fallbackOwner = model.source.repo?.split('/')[0] ?? null
        return (
          <div key={model.id} className={`card p-3.5 transition-colors ${isLoaded ? 'border-arc-500 dark:border-arc-500' : ''}`}>
            <div className="flex flex-wrap items-start gap-3">
              <ModelAvatar owner={owner} fallbackOwner={fallbackOwner} name={model.name} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="truncate text-[13px] font-semibold text-ink-900 dark:text-white">{model.name}</h3>
                  <QuantBadge quantization={model.quantization} architecture={model.architecture} />
                  {isLoaded && <span className="badge bg-arc-600 text-white">loaded</span>}
                  {isMiningArtifact && (
                    <span
                      className="badge bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      title="PALW artifact. Mining eligibility is listed under Mining classes."
                    >
                      PALW artifact
                    </span>
                  )}
                  {model.expert_count && <span className="badge bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">MoE · {model.expert_count} experts</span>}
                  {model.context_length ? (
                    <ContextBadge
                      value={model.context_length}
                      title={
                        model.architecture === 'palw'
                          ? `The artifact's rotary table covers ${model.context_length.toLocaleString()} positions — the widest window this file can run at. The class it mines was registered at its own context; see Mining class artifacts.`
                          : `Trained context: ${model.context_length.toLocaleString()} tokens, from the GGUF header. It loads at the context shown below, which is sized to this machine's memory.`
                      }
                    />
                  ) : (
                    model.architecture === 'palw' && (
                      <span className="badge bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300" title="This artifact format's header is not one the Studio reads, so its context is not shown rather than guessed.">
                        ctx not read
                      </span>
                    )
                  )}
                </div>

                <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-ink-500 dark:text-ink-400">
                  <span>{bytes(model.size_bytes)}</span>
                  {model.parameter_count && <span>{params(model.parameter_count)} params</span>}
                  {model.architecture && <span className="mono">{model.architecture}</span>}
                  {model.context_length && (
                    <span>{model.architecture === 'palw' ? `${tokens(model.context_length)}-position window` : `${tokens(model.context_length)} trained ctx`}</span>
                  )}
                  {model.block_count && <span>{model.block_count} layers</span>}
                  {model.modified_at && <span>added {relativeTime(model.modified_at)}</span>}
                </div>

                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <FitBadge fit={model.fit} summary={model.fit_summary} />
                  <span className="text-[11px] text-ink-500 dark:text-ink-400">
                    at {tokens(model.recommended_context)} context · {bytes(model.requirements.kv_cache_bytes)} KV cache
                  </span>
                </div>

                {model.source.repo && (
                  <div className="mt-1.5 truncate text-[11px] text-ink-500 dark:text-ink-400">
                    from <span className="mono">{model.source.repo}</span>
                    {model.source.revision && <span className="mono"> @ {model.source.revision.slice(0, 7)}</span>}
                  </div>
                )}
                {model.identity && (
                  <div className="mt-0.5 truncate text-[11px] text-ink-500 dark:text-ink-400">
                    h_M <span className="mono">{model.identity.h_m.slice(0, 24)}…</span>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {isLoaded ? (
                  <button type="button" className="btn-outline" onClick={() => void unloadModel()}>
                    <Icon name="power" className="size-3.5" />
                    Unload
                  </button>
                ) : isMiningArtifact ? (
                  <button
                    type="button"
                    className="btn-outline"
                    title="This file is mined with, not chatted with. The Network tab is where a class artifact is named to the node."
                    onClick={() => setView('network')}
                  >
                    <Icon name="globe" className="size-3.5" />
                    Mining
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={loadingModelId !== null}
                    onClick={async () => {
                      await loadModel(model.id)
                      setView('chat')
                    }}
                  >
                    {loadingModelId === model.id ? <Spinner className="size-3.5" /> : <Icon name="power" className="size-3.5" />}
                    Load
                  </button>
                )}

                <div className="flex gap-1">
                  {!model.sha256 && (
                    <button
                      type="button"
                      className="btn-ghost"
                      title="Read the file once and record its identity"
                      disabled={hashing === model.id}
                      onClick={async () => {
                        setHashing(model.id)
                        await hashModel(model.id)
                        setHashing(null)
                      }}
                    >
                      {hashing === model.id ? <Spinner className="size-3.5" /> : <Icon name="shield" className="size-3.5" />}
                      Identify
                    </button>
                  )}
                  {confirming === model.id ? (
                    <>
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={async () => {
                          setConfirming(null)
                          await deleteModel(model.id)
                        }}
                      >
                        Delete {bytes(model.size_bytes)}
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="icon-btn" title="Delete this model" onClick={() => setConfirming(model.id)}>
                      <Icon name="trash" className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
