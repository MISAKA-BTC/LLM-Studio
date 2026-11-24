import { api } from '../lib/api'
import { useStudio } from '../store/studio'
// Markdown rendering for assistant messages.
//
// What this does that a bare `react-markdown` does not:
//
// * **A header on every code block** — its language, a Copy that is always there, and a wrap
//   toggle. The single most common thing anyone does with a local model's answer is copy the code
//   out of it, and a copy button that only appears on hover is one nobody finds on a long block.
// * **Math in every spelling models use.** `$x$`, `$$x$$`, `\(x\)` and `\[x\]` all render; see
//   `lib/math.ts` for the normalisation and the bug it replaced.
// * **It renders partial markdown while streaming.** Text arrives token by token, which means the
//   renderer sees `` ```py `` with no closing fence for several seconds. `react-markdown` handles
//   that gracefully — the alternative, waiting for the whole message before rendering, is the
//   thing that makes a streaming app feel like a non-streaming one.
// * **Tables scroll** inside the answer instead of widening it past the window.
//
// The renderers below are defined once, at module level, on purpose. An inline `components={{…}}`
// is a new component type on every render — and a streamed reply renders on every token — so each
// code block was unmounted and rebuilt per token, and a wrap toggle or a "Copied" confirmation
// could not survive the next one.
//
// Parsing runs in a coalescing worker, including math normalisation and optional KaTeX. Stable
// top-level blocks are reused on the UI thread; only a changing block needs new React elements.
// Code colours are a separate shared worker job after streaming ends, never a token-time parse.

import { createContext, isValidElement, memo, startTransition, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { Components } from 'react-markdown'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { cachedHighlight, highlightFile } from './code/highlight'
import { cachedMarkdown, releaseMarkdown, requestMarkdown } from './markdown/client'
import type { MarkdownBlock, MarkdownDocument } from './markdown/types'
import { Icon } from './common'

const Streaming = createContext(false)
const CODE_HIGHLIGHT_LIMIT = 50_000

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in (node as any)) return textOf((node as any).props?.children)
  return ''
}

/** The fence's language — or the one highlight.js detected — from the `language-xxx` class. */
function languageOf(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement(child)) return null
  const className = (child.props as { className?: unknown }).className
  const match = typeof className === 'string' ? /(?:^|\s)language-([^\s]+)/.exec(className) : null
  return match?.[1] ?? null
}

function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[0.7rem] font-medium text-ink-300 transition-colors hover:bg-white/10 hover:text-white"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
        } catch {
          // Clipboard access can be denied; the label simply does not change.
          setCopied(false)
        }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

const CodeBlock = memo(function CodeBlock({ children }: { children?: ReactNode }) {
  const [wrap, setWrap] = useState(false)
  const language = languageOf(children)
  const text = textOf(children)
  const streaming = useContext(Streaming)
  const [colours, setColours] = useState<{ text: string; language: string | null; html: string | null } | null>(null)
  const canHighlight = !streaming && text.length <= CODE_HIGHLIGHT_LIMIT
  const html = canHighlight
    ? (colours?.text === text && colours.language === language ? colours.html : cachedHighlight(text, language ?? '') ?? null)
    : null

  useEffect(() => {
    if (!canHighlight) return
    let live = true
    void highlightFile(text, language ?? '').then((html) => {
      if (live) startTransition(() => setColours({ text, language, html }))
    })
    return () => { live = false }
  }, [text, language, canHighlight])
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800 bg-ink-900 dark:border-ink-800 dark:bg-black/40">
      <div className="flex h-8 items-center gap-0.5 border-b border-white/10 pl-3 pr-1 text-[0.7rem] text-ink-400">
        <span className="mono min-w-0 flex-1 truncate">{language ?? 'text'}</span>
        <button
          type="button"
          className={`inline-flex size-6 items-center justify-center rounded-md transition-colors hover:bg-white/10 hover:text-white ${wrap ? 'bg-white/10 text-white' : 'text-ink-400'}`}
          aria-label="Wrap long lines"
          aria-pressed={wrap}
          title={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
          onClick={() => setWrap((v) => !v)}
        >
          <Icon name="wrap" className="size-3.5" />
        </button>
        <CopyCode text={text} />
      </div>
      <pre className={`rounded-none bg-transparent dark:bg-transparent ${wrap ? 'whitespace-pre-wrap break-words' : ''}`}>
        {html === null ? children : <code className={`hljs${language ? ` language-${language}` : ''}`} dangerouslySetInnerHTML={{ __html: html }} />}
      </pre>
    </div>
  )
}, (before, after) => languageOf(before.children) === languageOf(after.children) && textOf(before.children) === textOf(after.children))

const COMPONENTS: Components = {
  img({ src, alt }) {
    // Never let a fetched page or a model load tracking images outside the Web route.
    if (!src || !/^https?:\/\//i.test(src)) return <span>{alt ?? 'Image'}</span>
    return <button type="button" className="underline" onClick={() => void api.web.open(src).catch((error) => useStudio.getState().toast('error', error.message))}>{alt || 'Open image in browser'}</button>
  },
  pre: CodeBlock,
  // Links open outside the app. A local-LLM window is not a browser, and a model's hallucinated URL
  // should not replace the app with a 404.
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" title="Open in browser"
        onClick={(event) => {
          if (!href || !/^https?:\/\//i.test(href)) return
          event.preventDefault()
          void api.web.open(href).catch((error) => useStudio.getState().toast('error', error.message))
        }}
        onAuxClick={(event) => {
          if (!href || !/^https?:\/\//i.test(href)) return
          event.preventDefault()
          void api.web.open(href).catch((error) => useStudio.getState().toast('error', error.message))
        }}>
        {children}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="max-w-full overflow-x-auto">
        <table>{children}</table>
      </div>
    )
  },
}

const RenderBlock = memo(function RenderBlock({ block }: { block: MarkdownBlock }) {
  return useMemo(() => toJsxRuntime(block.tree, { Fragment, jsx, jsxs, components: COMPONENTS, ignoreInvalidStyle: true, passKeys: true, passNode: true }), [block])
})

let mathStyles: Promise<unknown> | null = null
type Snapshot = { source: string; streaming: boolean; document: MarkdownDocument }

export const Markdown = memo(function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  const owner = useId()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => {
    const document = !streaming && cachedMarkdown(children)
    return document ? { source: children, streaming: false, document } : null
  })
  const [plainSource, setPlainSource] = useState<{ source: string; streaming: boolean } | null>(null)
  const current = useRef({ children, streaming })
  current.current = { children, streaming }
  const life = useRef(0)

  useEffect(() => {
    life.current++
    return () => {
      life.current++
      releaseMarkdown(owner)
    }
  }, [owner])

  useEffect(() => {
    const generation = life.current
    void requestMarkdown(owner, children, streaming).then((document) => {
      // A completed parse of a still-valid prefix is useful while another parse catches up. It
      // must never enter a different message, a replaced answer, or a hidden/unmounted view.
      if (generation !== life.current || !current.current.children.startsWith(children)) return
      if (!document) {
        if (current.current.children !== children || current.current.streaming !== streaming) return
        // A failed/unsupported worker can leave a valid old prefix on screen. Drop that prefix
        // when the current request cannot be formatted, otherwise the rest of the answer vanishes.
        startTransition(() => {
          setSnapshot(null)
          setPlainSource({ source: children, streaming })
        })
        return
      }
      startTransition(() => {
        setPlainSource(null)
        setSnapshot((previous) => {
          if (previous && current.current.children.startsWith(previous.source) &&
            (previous.source.length > children.length || (previous.source === children && !previous.streaming && streaming))) return previous
          return { source: children, streaming, document }
        })
      })
    })
  }, [owner, children, streaming])

  const shown = snapshot && children.startsWith(snapshot.source) ? snapshot : null
  useEffect(() => {
    if (!shown?.document.math) return
    mathStyles ??= import('katex/dist/katex.min.css').catch(() => { mathStyles = null })
  }, [shown?.document.math])

  return (
    <div className="prose-chat" data-markdown-pending={(plainSource?.source === children && plainSource.streaming === streaming) || (shown?.source === children && shown.streaming === streaming) ? undefined : true}>
      <Streaming value={streaming}>
        {shown
          ? shown.document.blocks.map((block, index) => <RenderBlock key={index} block={block} />)
          : <p className="whitespace-pre-wrap break-words">{children}</p>}
      </Streaming>
    </div>
  )
})
