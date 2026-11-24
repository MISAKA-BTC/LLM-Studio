// This module is loaded by the parsing worker. The UI imports it only as a delayed compatibility
// fallback when workers cannot run. Neither KaTeX nor syntax grammars belong in the Chat chunk.
import type { Root, RootContent } from 'hast'
import { urlAttributes } from 'html-url-attributes'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { normalizeMathDelimiters } from '../../lib/math'

const plain = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).freeze()
let mathProcessor: Promise<typeof plain> | null = null

function loadMathProcessor(): Promise<typeof plain> {
  mathProcessor ??= Promise.all([import('remark-math'), import('rehype-katex')]).then(([math, katex]) =>
    unified().use(remarkParse).use(remarkGfm).use(math.default).use(remarkRehype, { allowDangerousHtml: true })
      .use(katex.default, { trust: false, maxExpand: 1000 }).freeze(),
  ).catch((error: unknown) => {
    mathProcessor = null
    throw error
  })
  return mathProcessor
}

/** The same protocol policy as react-markdown: relative URLs and its safe protocol allowlist.
 * A colon before '/', '?' or '#' denotes a protocol, including malformed/control-filled ones. */
export function safeMarkdownUrl(value: string): string {
  const protocol = /^([^/?#]*):/.exec(value)?.[1]
  return protocol === undefined || /^(https?|ircs?|mailto|xmpp)$/i.test(protocol) ? value : ''
}

/** Raw source is escaped text, never interpreted HTML. KaTeX only contributes its own generated
 * nodes (trust:false); all URL properties are still checked, including those on generated nodes. */
function sanitize(root: Root): void {
  const walk = (children: RootContent[]) => {
    for (let index = 0; index < children.length; index++) {
      const node = children[index]!
      if ((node as { type: string }).type === 'raw') {
        children[index] = { type: 'text', value: (node as unknown as { value: string }).value }
        continue
      }
      delete node.position
      if (node.type !== 'element') continue
      for (const [key, tags] of Object.entries(urlAttributes)) {
        if (Object.hasOwn(node.properties, key) && (tags === null || tags.includes(node.tagName))) {
          node.properties[key] = safeMarkdownUrl(String(node.properties[key] ?? ''))
        }
      }
      walk(node.children)
    }
  }
  delete root.position
  walk(root.children)
}

export async function parseMarkdown(source: string, streaming: boolean): Promise<{ tree: Root; math: boolean }> {
  const normalized = streaming ? source : normalizeMathDelimiters(source)
  const parsed = plain.parse(normalized)
  // Inspect text ranges in the cheap Markdown AST, excluding inline/fenced source and HTML. A
  // shell sample's $HOME, a price escaped by the normaliser, or a dollar in a link URL must not
  // download KaTeX and its fonts. Explicit fenced `math` remains supported.
  type Candidate = { type: string; lang?: string | null; children?: Candidate[]; position?: { start: { offset?: number }; end: { offset?: number } } }
  const hasMath = (node: Candidate): boolean => {
    if (node.type === 'code') return node.lang === 'math'
    if (node.type === 'inlineCode' || node.type === 'html') return false
    if (node.type === 'text') {
      const { start, end } = node.position ?? { start: {}, end: {} }
      return start.offset !== undefined && end.offset !== undefined && /(?<!\\)\$/.test(normalized.slice(start.offset, end.offset))
    }
    return node.children?.some(hasMath) ?? false
  }
  const math = !streaming && hasMath(parsed)
  let processor = plain
  if (math) {
    try { processor = await loadMathProcessor() }
    catch { /* The source still renders as normal Markdown if the optional math chunk fails. */ }
  }
  const tree = processor.runSync(processor === plain ? parsed : processor.parse(normalized)) as Root
  sanitize(tree)
  return { tree, math: math && processor !== plain }
}
