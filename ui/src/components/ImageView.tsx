// Text-to-image and image-to-image studio.
//
// Always renders the generation workspace, checkpoint downloader, and engine configuration so
// first-run users never hit an empty dead-end page when no local diffusers weights exist yet.

import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useFileDrop } from '../lib/fileDrop'
import { bytes } from '../lib/format'
import type { Settings } from '../lib/types'
import { useStudio } from '../store/studio'
import { FitBadge, Icon, Spinner } from './common'
import { StatusDot } from './ui'

type Resolution = { label: string; width: number; height: number }

const DEFAULT_RESOLUTION: Resolution = { label: '1024 × 1024 (1:1)', width: 1024, height: 1024 }

const RESOLUTIONS: Resolution[] = [
  DEFAULT_RESOLUTION,
  { label: '1024 × 1536 (2:3 Portrait)', width: 1024, height: 1536 },
  { label: '1536 × 1024 (3:2 Landscape)', width: 1536, height: 1024 },
  { label: '512 × 512 (Fast Preview)', width: 512, height: 512 },
]

const CURATED_DIFFUSERS: { repo: string; title: string; note: string }[] = [
  { repo: 'segmind/tiny-sd', title: 'Tiny-SD', note: 'Lightweight ~1.3 GB diffusers pipeline — fast CPU/MPS test' },
  { repo: 'stabilityai/sdxl-turbo', title: 'SDXL Turbo', note: '1–4 step fast photorealistic generation' },
  { repo: 'black-forest-labs/FLUX.1-schnell', title: 'FLUX.1 [schnell]', note: 'High-quality 4-step transformer checkpoint' },
]

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).slice((reader.result as string).indexOf(',') + 1))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function enableMockPreview() {
  const studio = useStudio.getState()
  try {
    const current = studio.settings ?? (await api.settings())
    if (current.image_backend.kind !== 'mock') {
      await studio.saveSettings({
        ...current,
        image_backend: { ...current.image_backend, kind: 'mock' },
      })
    }
    await Promise.all([studio.refreshImageModels(), studio.refreshImageRuntime()])
    await studio.loadImageModel('mock-preview')
    studio.toast('success', 'Mock preview enabled — ready to generate test images immediately.')
  } catch (error) {
    studio.toast('error', (error as Error).message)
  }
}

function ImageModelBar({ onEnableMock, enablingMock }: { onEnableMock: () => void; enablingMock: boolean }) {
  const models = useStudio((s) => s.imageModels)
  const runtime = useStudio((s) => s.imageRuntime)
  const loadingId = useStudio((s) => s.loadingImageModelId)
  const loadImageModel = useStudio((s) => s.loadImageModel)
  const unloadImageModel = useStudio((s) => s.unloadImageModel)
  const refreshImageModels = useStudio((s) => s.refreshImageModels)
  const refreshImageRuntime = useStudio((s) => s.refreshImageRuntime)

  const loaded = models.find((m) => m.id === runtime?.model_id) ?? null
  const busy = loadingId !== null || enablingMock
  const backendName = runtime?.backend ?? 'none'

  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-ink-200 bg-ink-50/60 px-3.5 py-2 dark:border-ink-800 dark:bg-ink-950/60">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-ink-200">
        <Icon name="image" className="size-3.5 text-arc-600 dark:text-arc-400" />
        <span>Image Studio</span>
      </div>
      <span className="h-3.5 w-px bg-ink-200 dark:bg-ink-800" aria-hidden />

      <select
        aria-label="Image model"
        className="input max-w-72 py-1 text-xs"
        value={runtime?.model_id ?? ''}
        disabled={busy || models.length === 0}
        onChange={(event) => {
          const id = event.target.value
          if (id) void loadImageModel(id)
          else void unloadImageModel()
        }}
      >
        {models.length === 0 && <option value="">No image models installed</option>}
        {models.length > 0 && <option value="">— Select an image model —</option>}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name || model.id}
          </option>
        ))}
      </select>

      {busy && <Spinner className="size-3.5 text-arc-600" />}

      <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-ink-200 bg-white px-2 py-0.5 text-[11px] text-ink-600 dark:border-ink-700 dark:bg-[#252526] dark:text-[#cccccc]">
        <StatusDot tone={runtime?.model_id ? 'green' : runtime?.backend_available ? 'amber' : 'gray'} />
        <span className="mono">engine: {backendName}</span>
      </span>

      {loaded && loaded.size_bytes > 0 && (
        <div className="hidden min-w-0 items-center gap-2 text-xs text-ink-500 md:flex dark:text-ink-400">
          <span>{bytes(loaded.size_bytes)}</span>
          {loaded.architecture && <span className="mono">{loaded.architecture}</span>}
          <FitBadge fit={loaded.fit} summary={loaded.fit_summary} />
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {!runtime?.model_id && (
          <button
            type="button"
            className="btn-outline py-1 text-xs"
            disabled={busy}
            onClick={onEnableMock}
            title="Switch to the built-in mock preview engine and load it immediately without downloading weights"
          >
            <Icon name="sparkles" className="size-3.5 text-arc-500" />
            <span>Try Mock Preview</span>
          </button>
        )}
        {runtime?.model_id && (
          <button type="button" className="btn-ghost py-1 text-xs" onClick={() => void unloadImageModel()} title="Unload image model">
            <Icon name="power" className="size-3.5" />
            <span className="hidden sm:inline">Unload</span>
          </button>
        )}
        <button
          type="button"
          className="btn-ghost py-1 text-xs"
          onClick={() => {
            void refreshImageModels()
            void refreshImageRuntime()
          }}
          title="Rescan models directory"
        >
          <Icon name="refresh" className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

type Reference = { name: string; previewUrl: string; base64: string }

function GenerateForm({ onEnableMock, enablingMock }: { onEnableMock: () => void; enablingMock: boolean }) {
  const runtime = useStudio((s) => s.imageRuntime)
  const models = useStudio((s) => s.imageModels)
  const loadImageModel = useStudio((s) => s.loadImageModel)
  const generating = useStudio((s) => s.generatingImage)
  const generateImage = useStudio((s) => s.generateImage)
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [resolution, setResolution] = useState(DEFAULT_RESOLUTION)
  const [steps, setSteps] = useState(20)
  const [guidanceScale, setGuidanceScale] = useState(4.5)
  const [seed, setSeed] = useState('')
  const [batchCount, setBatchCount] = useState(1)
  const [references, setReferences] = useState<Reference[]>([])
  const fileInput = useRef<HTMLInputElement>(null)

  const hasLoadedModel = runtime?.model_id != null
  const canGenerate = hasLoadedModel && prompt.trim().length > 0 && !generating

  const addFiles = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    const toast = useStudio.getState().toast
    if (images.length !== files.length) toast('info', 'Only image files can be added as references.')
    const results = await Promise.allSettled(
      images.map(async (file) => {
        const base64 = await fileToBase64(file)
        return { name: file.name, previewUrl: URL.createObjectURL(file), base64 }
      }),
    )
    const added = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    if (added.length !== images.length) toast('error', 'Some reference images could not be read.')
    if (added.length) setReferences((prev) => [...prev, ...added])
  }
  const { dragging, dropHandlers, dropRef } = useFileDrop({ kind: 'image', onFiles: (files) => void addFiles(files) })

  const submit = async () => {
    if (!canGenerate) return
    await generateImage({
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      width: resolution.width,
      height: resolution.height,
      steps,
      guidanceScale,
      seed: seed.trim() ? Number(seed) : null,
      referenceImages: references.map((r) => r.base64),
      n: batchCount,
    })
  }

  return (
    <div className="card space-y-3.5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-700 dark:text-ink-200">Prompt & Parameters</h2>
        {runtime?.model_id === 'mock-preview' && (
          <span className="badge bg-arc-600/15 text-arc-700 dark:bg-[#04395e] dark:text-white">Mock Preview Active</span>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600 dark:text-ink-300">Prompt</label>
        <textarea
          className="input min-h-24 w-full resize-y"
          placeholder="Describe the image you want to generate (e.g., cyberpunk neon alleyway in rain, cinematic lighting)…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canGenerate) {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600 dark:text-ink-300">Negative prompt (optional)</label>
        <textarea
          className="input min-h-12 w-full resize-y"
          placeholder="Blur, low quality, artifacts, watermark…"
          value={negativePrompt}
          onChange={(event) => setNegativePrompt(event.target.value)}
        />
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-xs text-ink-500 dark:text-ink-400">
          <span className="mb-1 block">Resolution</span>
          <select
            className="input py-1 text-xs"
            value={resolution.label}
            onChange={(event) => setResolution(RESOLUTIONS.find((r) => r.label === event.target.value) ?? DEFAULT_RESOLUTION)}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r.label} value={r.label}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-ink-500 dark:text-ink-400">
          <span className="mb-1 block">Steps</span>
          <input
            type="number"
            className="input py-1 text-xs"
            min={1}
            max={100}
            value={steps}
            onChange={(event) => setSteps(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
          />
        </label>

        <label className="block text-xs text-ink-500 dark:text-ink-400">
          <span className="mb-1 block">Guidance (CFG)</span>
          <input
            type="number"
            className="input py-1 text-xs"
            step={0.5}
            min={0}
            value={guidanceScale}
            onChange={(event) => setGuidanceScale(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-ink-500 dark:text-ink-400">
            <span className="mb-1 block">Seed</span>
            <input
              type="number"
              className="input py-1 text-xs"
              placeholder="random"
              value={seed}
              onChange={(event) => setSeed(event.target.value)}
            />
          </label>
          <label className="block text-xs text-ink-500 dark:text-ink-400">
            <span className="mb-1 block">Count</span>
            <select
              className="input py-1 text-xs"
              value={batchCount}
              onChange={(event) => setBatchCount(Number(event.target.value) || 1)}
            >
              {[1, 2, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div
        ref={dropRef}
        className={`rounded-[4px] border border-dashed p-3 transition-colors ${
          dragging ? 'border-arc-500 bg-arc-500/10' : 'border-ink-300 bg-ink-50/40 dark:border-ink-700 dark:bg-[#1e1e1e]'
        }`}
        {...dropHandlers}
      >
        <div className="flex items-center justify-between text-xs text-ink-600 dark:text-ink-300">
          <span className="font-medium">Reference images (Img2Img / Edit)</span>
          <button type="button" className="btn-outline px-2 py-0.5 text-[11px]" onClick={() => fileInput.current?.click()}>
            <Icon name="plus" className="size-3" />
            Add image
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void addFiles(files)
            }}
          />
        </div>
        <p className="mt-1 text-[11px] text-ink-500 dark:text-ink-400">Drop PNG/JPG reference images here for image-conditioned pipelines.</p>
        {references.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {references.map((ref, i) => (
              <div key={ref.previewUrl} className="group relative">
                <img src={ref.previewUrl} alt={ref.name} className="size-16 rounded-[4px] border border-ink-200 object-cover dark:border-ink-700" />
                <button
                  type="button"
                  aria-label={`Remove ${ref.name}`}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-ink-900 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setReferences((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Icon name="x" className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <button type="button" className="btn-primary px-4 py-1.5" disabled={!canGenerate} onClick={() => void submit()}>
          {generating ? <Spinner className="size-3.5" /> : <Icon name="image" className="size-3.5" />}
          {generating ? 'Generating…' : 'Generate Image'}
        </button>

        {!hasLoadedModel && models.length > 0 && models[0] && (
          <button type="button" className="btn-outline py-1.5 text-xs" onClick={() => void loadImageModel(models[0]!.id)}>
            Load {models[0].name || models[0].id}
          </button>
        )}

        {!hasLoadedModel && models.length === 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500 dark:text-ink-400">
            <span>No model loaded yet — download a diffusers model on the right, or</span>
            <button type="button" className="font-medium text-arc-600 hover:underline dark:text-arc-400" disabled={enablingMock} onClick={onEnableMock}>
              enable Mock Preview
            </button>
            <span>to test right away.</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Gallery() {
  const generations = useStudio((s) => s.imageGenerations)
  if (generations.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="rounded-[6px] border border-ink-200 bg-ink-50 p-2.5 text-ink-400 dark:border-ink-700 dark:bg-[#1e1e1e]">
          <Icon name="image" className="size-5" />
        </div>
        <div className="text-xs font-medium text-ink-700 dark:text-ink-200">Generated Gallery</div>
        <p className="max-w-md text-[11.5px] text-ink-500 dark:text-ink-400">
          Images generated during this session appear here with one-click PNG download.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {generations.map((gen) => (
        <div key={gen.id} className="card p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs font-medium text-ink-800 dark:text-ink-100">{gen.prompt}</span>
            {gen.modelId && <span className="mono shrink-0 text-[11px] text-ink-400">{gen.modelId}</span>}
          </div>
          <div className="flex flex-wrap gap-3">
            {gen.images.map((src, i) => (
              <a key={i} href={src} download={`${gen.id}-${i}.png`} className="group relative block">
                <img src={src} alt={gen.prompt} className="max-h-72 rounded-[4px] border border-ink-200 dark:border-ink-700" />
                <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-[3px] bg-black/75 px-2 py-0.5 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <Icon name="download" className="size-3" />
                  Save PNG
                </span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ImageEngineAndModelsPanel({ onEnableMock, enablingMock }: { onEnableMock: () => void; enablingMock: boolean }) {
  const settings = useStudio((s) => s.settings)
  const saveSettings = useStudio((s) => s.saveSettings)
  const downloads = useStudio((s) => s.downloads)
  const setDownload = useStudio((s) => s.setDownload)
  const refreshImageModels = useStudio((s) => s.refreshImageModels)
  const refreshImageRuntime = useStudio((s) => s.refreshImageRuntime)
  const toast = useStudio((s) => s.toast)

  const [repoInput, setRepoInput] = useState('')
  const [downloadingRepo, setDownloadingRepo] = useState<string | null>(null)
  const [draft, setDraft] = useState<Settings['image_backend'] | null>(settings?.image_backend ?? null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings?.image_backend) setDraft(settings.image_backend)
  }, [settings?.image_backend])

  const startDownload = async (repo: string) => {
    const trimmed = repo.trim()
    if (!trimmed) return
    setDownloadingRepo(trimmed)
    try {
      const progress = await api.downloadImageModel(trimmed)
      setDownload(progress)
      toast('info', `Downloading diffusers checkpoint ${trimmed}`)
      setRepoInput('')
    } catch (error) {
      toast('error', (error as Error).message)
    } finally {
      setDownloadingRepo(null)
    }
  }

  const saveBackend = async () => {
    if (!settings || !draft) return
    setSaving(true)
    try {
      await saveSettings({ ...settings, image_backend: draft })
      await Promise.all([refreshImageModels(), refreshImageRuntime()])
      toast('success', `Image backend set to ${draft.kind}`)
    } catch (error) {
      toast('error', (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const activeImageDownloads = downloads.filter(
    (d) => d.file === 'diffusers' && (d.status === 'downloading' || d.status === 'verifying'),
  )
  const dirty = settings && draft ? JSON.stringify(settings.image_backend) !== JSON.stringify(draft) : false

  return (
    <div className="space-y-3.5">
      {/* Diffusers Checkpoint Downloader */}
      <section className="card space-y-3 p-3.5">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-800 dark:text-ink-100">Install Image Model</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500 dark:text-ink-400">
            Download any Hugging Face <code className="mono">diffusers</code> repository (<code className="mono">model_index.json</code> +{' '}
            <code className="mono">.safetensors</code>) straight into your models folder.
          </p>
        </div>

        <div className="flex gap-1.5">
          <input
            className="input flex-1 py-1 text-xs"
            placeholder="author/model (e.g. segmind/tiny-sd)"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && repoInput.trim()) {
                e.preventDefault()
                void startDownload(repoInput)
              }
            }}
          />
          <button
            type="button"
            className="btn-primary shrink-0 px-2.5 py-1 text-xs"
            disabled={!repoInput.trim() || downloadingRepo !== null}
            onClick={() => void startDownload(repoInput)}
          >
            {downloadingRepo === repoInput.trim() ? <Spinner className="size-3.5" /> : <Icon name="download" className="size-3.5" />}
            Get
          </button>
        </div>

        {activeImageDownloads.length > 0 && (
          <div className="space-y-1.5 rounded-[4px] border border-arc-500/40 bg-arc-500/5 p-2.5 text-[11px]">
            {activeImageDownloads.map((d) => {
              const pct = d.total && d.total > 0 ? Math.min(100, Math.round((d.downloaded / d.total) * 100)) : null
              return (
                <div key={d.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 font-medium text-ink-800 dark:text-ink-100">
                    <span className="mono truncate">{d.repo}</span>
                    <span>{pct !== null ? `${pct}%` : bytes(d.downloaded)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
                    <div className="h-full bg-arc-600 transition-all" style={{ width: `${pct ?? 25}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="space-y-1.5 pt-0.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-400 dark:text-ink-500">Recommended Checkpoints</div>
          {CURATED_DIFFUSERS.map((item) => (
            <div
              key={item.repo}
              className="flex items-center justify-between gap-2 rounded-[4px] border border-ink-200 bg-ink-50/50 px-2.5 py-2 dark:border-ink-800 dark:bg-[#1e1e1e]"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-ink-800 dark:text-ink-100">{item.title}</div>
                <div className="mono truncate text-[10.5px] text-ink-400">{item.repo}</div>
                <div className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">{item.note}</div>
              </div>
              <button
                type="button"
                className="btn-outline shrink-0 px-2 py-1 text-[11px]"
                disabled={downloadingRepo !== null}
                onClick={() => void startDownload(item.repo)}
              >
                {downloadingRepo === item.repo ? <Spinner className="size-3" /> : <Icon name="download" className="size-3" />}
                Install
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Image Backend Configuration */}
      {draft && (
        <section className="card space-y-2.5 p-3.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-800 dark:text-ink-100">Image Engine</h3>
            <button
              type="button"
              className="text-[11px] font-medium text-arc-600 hover:underline dark:text-arc-400"
              disabled={enablingMock}
              onClick={onEnableMock}
            >
              Quick Mock Setup
            </button>
          </div>

          <label className="block text-xs text-ink-600 dark:text-ink-300">
            <span className="mb-1 block">Backend</span>
            <select
              className="input py-1 text-xs"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as Settings['image_backend']['kind'] })}
            >
              <option value="diffusion">Diffusion sidecar (diffusers / PyTorch)</option>
              <option value="mock">Mock preview (built-in, no weights required)</option>
              <option value="none">Disabled (none)</option>
            </select>
          </label>

          {draft.kind === 'diffusion' && (
            <>
              <label className="block text-xs text-ink-600 dark:text-ink-300">
                <span className="mb-1 block">Accelerator device</span>
                <select
                  className="input py-1 text-xs"
                  value={draft.device ?? ''}
                  onChange={(e) => setDraft({ ...draft, device: e.target.value || null })}
                >
                  <option value="">Auto (Sidecar default)</option>
                  <option value="mps">Apple Silicon Metal (mps)</option>
                  <option value="cuda">NVIDIA GPU (cuda)</option>
                  <option value="cpu">CPU</option>
                </select>
              </label>

              <label className="block text-xs text-ink-600 dark:text-ink-300">
                <span className="mb-1 block">Python executable</span>
                <input
                  className="input py-1 text-xs"
                  placeholder="python3 (or /path/to/venv/bin/python)"
                  value={draft.python_path ?? ''}
                  onChange={(e) => setDraft({ ...draft, python_path: e.target.value.trim() || null })}
                />
              </label>

              <label className="block text-xs text-ink-600 dark:text-ink-300">
                <span className="mb-1 block">Sidecar script path</span>
                <input
                  className="input py-1 text-xs"
                  placeholder="sidecars/diffusion/server.py (auto-detected)"
                  value={draft.diffusion_server_path ?? ''}
                  onChange={(e) => setDraft({ ...draft, diffusion_server_path: e.target.value.trim() || null })}
                />
              </label>
            </>
          )}

          <button type="button" className="btn-primary w-full py-1.5 text-xs" disabled={!dirty || saving} onClick={() => void saveBackend()}>
            {saving ? <Spinner className="size-3.5" /> : 'Save Image Engine'}
          </button>
        </section>
      )}
    </div>
  )
}

export function ImageView() {
  const imageRuntime = useStudio((s) => s.imageRuntime)
  const [enablingMock, setEnablingMock] = useState(false)

  const handleEnableMock = async () => {
    setEnablingMock(true)
    try {
      await enableMockPreview()
    } finally {
      setEnablingMock(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white dark:bg-ink-900">
      <ImageModelBar onEnableMock={() => void handleEnableMock()} enablingMock={enablingMock} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            {imageRuntime && imageRuntime.backend === 'diffusion' && !imageRuntime.backend_available && (
              <div className="flex items-center justify-between gap-3 rounded-[4px] border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                <span>Python diffusion sidecar is not reachable yet — configure Python path on the right or try Mock Preview.</span>
                <button type="button" className="btn-outline shrink-0 px-2 py-0.5 text-[11px]" onClick={() => void handleEnableMock()}>
                  Use Mock
                </button>
              </div>
            )}
            <GenerateForm onEnableMock={() => void handleEnableMock()} enablingMock={enablingMock} />
            <Gallery />
          </div>

          <aside className="min-w-0">
            <ImageEngineAndModelsPanel onEnableMock={() => void handleEnableMock()} enablingMock={enablingMock} />
          </aside>
        </div>
      </div>
    </div>
  )
}
