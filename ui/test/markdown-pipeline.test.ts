import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { defaultUrlTransform } from 'react-markdown'
import { createLatestQueue } from '../src/components/markdown/queue.ts'

const compiled = await build({
  stdin: {
    contents: "export { parseMarkdown, safeMarkdownUrl } from './src/components/markdown/processor'; export { createBlockEncoder } from './src/components/markdown/blocks';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
})
const { parseMarkdown, safeMarkdownUrl, createBlockEncoder } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0]!.text).toString('base64')}`)
const descendants = (node: any): any[] => [node, ...(node.children ?? []).flatMap(descendants)]
const text = (node: any): string => typeof node.value === 'string' ? node.value : (node.children ?? []).map(text).join('')

test('worker URL policy matches react-markdown for safe, relative and malicious URLs', () => {
  for (const url of [
    'https://example.com', 'HTTP://example.com', 'mailto:person@example.com', 'irc:room', 'ircs:room', 'xmpp:person',
    '/path', './file.ts', '#section', '//example.com/path', '?next=javascript:alert(1)', '/path:part',
    'javascript:alert(1)', 'jAvAsCrIpT:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x',
    ' javascript:alert(1)', '\tjavascript:alert(1)', 'java\nscript:alert(1)', 'file:///secret', 'ftp://host/path',
  ]) assert.equal(safeMarkdownUrl(url), defaultUrlTransform(url), url)
})

test('raw HTML remains text and unsafe links cannot reach an href', async () => {
  const { tree } = await parseMarkdown('<script>alert("unsafe")</script>\n\n[bad](javascript:alert%281%29)\n\n[safe](https://example.com)', false)
  const nodes = descendants(tree)
  assert.ok(text(tree).includes('<script>alert("unsafe")</script>'))
  assert.equal(nodes.some((node) => node.type === 'raw' || node.tagName === 'img' || node.tagName === 'script'), false)
  const anchors = nodes.filter((node) => node.tagName === 'a')
  assert.equal(anchors[0].properties.href, '')
  assert.equal(anchors[1].properties.href, 'https://example.com')
})

test('GFM tables, task lists, references and fenced source keep their semantics', async () => {
  const source = '| Name | Value |\n| --- | --- |\n| one | two |\n\n- [x] complete\n\n[docs][target]\n\n```js\nconst value = "<script>"\n```\n\n[target]: https://example.com/docs'
  const { tree, math } = await parseMarkdown(source, false)
  const nodes = descendants(tree)
  assert.equal(math, false)
  assert.ok(nodes.some((node) => node.tagName === 'table'))
  assert.ok(nodes.some((node) => node.tagName === 'input' && node.properties.checked && node.properties.disabled))
  assert.ok(nodes.some((node) => node.tagName === 'a' && node.properties.href === 'https://example.com/docs'))
  const code = nodes.find((node) => node.tagName === 'code')
  assert.equal(text(code), 'const value = "<script>"\n')
  assert.equal(nodes.some((node) => node.properties?.className?.some((value: string) => value.startsWith('hljs-'))), false)
})

test('streaming leaves math and code as source; completed formulas render with safe KaTeX nodes', async () => {
  const source = 'Formula \\(x^2\\) and $a_1$.\n\n$$\ny = \\frac{1}{2}\n$$\n\n```js\nconst price = "$5"\n```'
  const live = await parseMarkdown(source, true)
  assert.equal(live.math, false)
  assert.equal(descendants(live.tree).some((node) => node.properties?.className?.includes('katex')), false)
  const finished = await parseMarkdown(source, false)
  assert.equal(finished.math, true)
  assert.ok(descendants(finished.tree).some((node) => node.properties?.className?.includes('katex')))
  const code = descendants(finished.tree).find((node) => node.tagName === 'code')
  assert.equal(text(code), 'const price = "$5"\n')
  const unsafeMath = await parseMarkdown('$\\href{javascript:alert(1)}{click}$ and $\\includegraphics{https://tracker.example/pixel}$', false)
  assert.equal(descendants(unsafeMath.tree).some((node) => node.tagName === 'img' || String(node.properties?.href ?? '').startsWith('javascript:')), false)
})

test('code, prices and URL dollar signs do not activate the optional math renderer', async () => {
  for (const source of ['```sh\necho "$HOME"\n```', '`$x^2$` is source', 'It costs $5 today.', '[link](https://example.com/$path)']) {
    assert.equal((await parseMarkdown(source, false)).math, false, source)
  }
  assert.equal((await parseMarkdown('```math\nx^2\n```', false)).math, true)
})

test('unchanged blocks retain identities, while a later reference definition correctly changes its block', async () => {
  const encoder = createBlockEncoder()
  const first = await parseMarkdown('A completed paragraph.\n\n```js\nconst n = 1\n```\n\nGrowing', true)
  const second = await parseMarkdown('A completed paragraph.\n\n```js\nconst n = 1\n```\n\nGrowing answer', true)
  const before = encoder.encode('reply', first.tree, first.math)
  const after = encoder.encode('reply', second.tree, second.math)
  assert.equal(after.blocks[0].id, before.blocks[0].id)
  assert.equal(after.blocks[2].id, before.blocks[2].id)
  assert.notEqual(after.blocks.at(-1).id, before.blocks.at(-1).id)
  const unresolved = await parseMarkdown('[link][later]', true)
  const resolved = await parseMarkdown('[link][later]\n\n[later]: https://example.com', true)
  const initial = encoder.encode('reference', unresolved.tree, false)
  const final = encoder.encode('reference', resolved.tree, false)
  assert.notEqual(initial.blocks[0].id, final.blocks[0].id)
  assert.ok(descendants(final.blocks[0].tree).some((node) => node.tagName === 'a'))
})

test('hundreds of streaming updates run the first and latest parse, without an obsolete backlog', async () => {
  const started: number[] = []
  const finish: Array<(value: number) => void> = []
  const queue = createLatestQueue<number, number>(async (_owner, value) => {
    started.push(value)
    return new Promise((resolve) => finish.push(resolve))
  })
  const first = queue.request('reply', 0)
  const updates = Array.from({ length: 300 }, (_, index) => queue.request('reply', index + 1))
  assert.deepEqual(queue.size(), { running: 1, waiting: 1 })
  await Promise.resolve()
  finish[0]!(0)
  assert.equal(await first, 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [0, 300])
  finish[1]!(300)
  const outcomes = await Promise.all(updates)
  assert.equal(outcomes.filter((value) => value !== null).length, 1)
  assert.equal(outcomes.at(-1), 300)
})

test('hidden/unmounted messages cancel deliveries and a live reply precedes queued history', async () => {
  const started: string[] = []
  const finish: Array<(value: string) => void> = []
  const queue = createLatestQueue<string, string>(async (_owner, value) => {
    started.push(value)
    return new Promise((resolve) => finish.push(resolve))
  })
  const abandoned = queue.request('hidden', 'old')
  const history = queue.request('history', 'saved')
  const live = queue.request('live', 'newest', 1)
  queue.release('hidden')
  assert.equal(await abandoned, null)
  await Promise.resolve()
  finish[0]!('obsolete')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['old', 'newest'])
  finish[1]!('newest')
  assert.equal(await live, 'newest')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['old', 'newest', 'saved'])
  finish[2]!('saved')
  assert.equal(await history, 'saved')
})
