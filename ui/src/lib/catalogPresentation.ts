import type { CatalogEntry } from './types.ts'

export type CapabilityKind = 'vision' | 'tools' | 'reasoning'

export function cleanDisplayName(id: string, baseModel?: string | null): string {
  const source = baseModel && baseModel.includes('/') ? baseModel.split('/')[1]! : id.split('/')[1] ?? id
  const stripped = source
    .replace(/[-_.]?(GGUF|gguf|MLX|mlx)(?:[-_.].*)?$/g, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
  return stripped || (id.split('/')[1] ?? id)
}

export function entryCapabilities(entry: CatalogEntry): CapabilityKind[] {
  const explicit = new Set((entry.capabilities ?? []).map((c) => c.toLowerCase()))
  const tags = entry.tags.map((t) => t.toLowerCase())
  const nameLower = entry.id.toLowerCase()
  const out: CapabilityKind[] = []
  if (
    explicit.has('vision') ||
    entry.pipeline_tag === 'image-text-to-text' ||
    tags.some((t) => t === 'vision' || t === 'image-text-to-text' || t === 'multimodal' || t === 'vlm') ||
    /(?:^|[-_.])(vl|vision|pixtral|llava|moondream|qwen2\.5-vl|gemma-3|gemma-4|inkling)(?:[-_.]|$)/.test(nameLower)
  ) {
    out.push('vision')
  }
  if (
    explicit.has('tools') ||
    tags.some((t) => ['tool-calling', 'function-calling', 'tool-use', 'tools', 'agentic'].includes(t))
  ) {
    out.push('tools')
  }
  if (
    explicit.has('reasoning') ||
    tags.some((t) => ['reasoning', 'thinking', 'cot'].includes(t)) ||
    /(?:^|[-_.])(r1|qwq|thinking|reasoning|o1|deepseek-r1)(?:[-_.]|$)/.test(nameLower)
  ) {
    out.push('reasoning')
  }
  return out
}

/** Extract the first meaningful prose paragraph from a Markdown model card for the summary header. */
export function extractLeadSummary(markdown: string | null | undefined): string | null {
  if (!markdown) return null
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '')
  const blocks = withoutComments.split(/\n\s*\n/)
  for (const raw of blocks) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (/^(#{1,6}\s|!\[|<img|<p\s+align|<div|<table|<ul|<ol|\||>|[-*]\s|\*\*Model creator\*\*|\*👾)/i.test(trimmed)) continue
    const plain = trimmed
      .replace(/<[^>]+>/g, ' ')
      .replace(/!\[[^\]]*]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (plain.length < 40) continue
    if (/^(special thanks|disclaimers?|quantized by|provided by lm studio)/i.test(plain)) continue
    return plain.length > 280 ? `${plain.slice(0, 277).trimEnd()}…` : plain
  }
  return null
}

export function isBoilerplateQuantCard(markdown: string | null | undefined): boolean {
  if (!markdown) return true
  if (markdown.length < 900) return true
  if (/Community Model>|LM Studio is not the creator|Using llama\.cpp release/i.test(markdown) && markdown.length < 3200) {
    return true
  }
  return false
}

/**
 * Safely normalize common HTML constructs in Hugging Face model cards (`<img src="...">`, `<br>`,
 * centered `<p align="center">` wrappers) into standard Markdown so images and banners render
 * cleanly without enabling arbitrary raw HTML execution.
 */
export function prepareReadmeMarkdown(markdown: string): string {
  const parts = markdown.split(/(```[\s\S]*?```)/g)
  return parts
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment
      return segment
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<img\b([^>]*?)\/?>/gi, (_full, attrs: string) => {
          const srcMatch = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs)
          const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
          const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim()
          const alt = (altMatch?.[1] ?? altMatch?.[2] ?? '').trim().replace(/[\[\]]/g, '')
          return src ? `\n\n![${alt}](${src})\n\n` : ''
        })
        .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi, (_full, h1?: string, h2?: string, inner?: string) => {
          const href = (h1 ?? h2 ?? '').trim()
          const content = (inner ?? '').trim()
          return href && content ? `[${content}](${href})` : content
        })
        .replace(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_full, level: string, inner: string) => {
          const hashes = '#'.repeat(Number(level))
          const clean = inner.replace(/<[^>]+>/g, '').trim()
          return clean ? `\n\n${hashes} ${clean}\n\n` : ''
        })
        .replace(/<br\s*\/?>/gi, '  \n')
        .replace(/<\/?(?:p|div|center|picture|figure|figcaption|span|sup|sub|kbd|details|summary)\b[^>]*>/gi, '\n')
        .replace(/<source\b[^>]*>/gi, '')
    })
    .join('')
}
