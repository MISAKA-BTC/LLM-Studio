// Runs the actual Vite production worker, with no document/DOMParser globals. This catches browser
// conditional exports that would accidentally work on the window but fail inside a real worker.
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

const assets = fileURLToPath(new URL('../dist/assets/', import.meta.url))
const entry = (await readdir(assets)).find((file) => /^markdown\.worker-.*\.js$/.test(file))
assert.ok(entry, 'Build the UI before running the production-worker test: npm run build')
const worker = new Worker(`
  const { parentPort, workerData } = require('node:worker_threads');
  globalThis.self = globalThis;
  globalThis.postMessage = (data) => parentPort.postMessage(data);
  const waiting = [];
  let ready = false;
  parentPort.on('message', (data) => ready ? self.onmessage({ data }) : waiting.push(data));
  import(workerData.entry).then(() => {
    ready = true;
    parentPort.postMessage({ ready: true, hasDOM: typeof document !== 'undefined' || typeof DOMParser !== 'undefined' });
    for (const data of waiting) self.onmessage({ data });
  });
`, { eval: true, workerData: { entry: pathToFileURL(join(assets, entry)).href } })

let nextId = 0
const pending = new Map()
const ready = new Promise((resolve, reject) => {
  worker.on('error', reject)
  worker.on('message', (message) => {
    if (message.ready) resolve(message)
    else { pending.get(message.id)?.(message.document); pending.delete(message.id) }
  })
})
const ask = async (source, streaming, owner = 'fixture') => {
  const id = nextId++
  const response = new Promise((resolve) => pending.set(id, resolve))
  worker.postMessage({ id, owner, source, streaming })
  return response
}
const all = (node) => [node, ...(node.children ?? []).flatMap(all)]
const nodes = (document) => document.blocks.flatMap((block) => all(block.tree))
const timer = setTimeout(() => { console.error('Production Markdown worker timed out'); void worker.terminate(); process.exitCode = 1 }, 15000)
try {
  assert.equal((await ready).hasDOM, false)
  const first = await ask('Stable **paragraph**.\n\nGrowing &amp; text', true)
  assert.ok(first)
  assert.equal(first.math, false)
  const second = await ask('Stable **paragraph**.\n\nGrowing &amp; text continues', true)
  assert.equal(first.blocks[0].id, second.blocks[0].id)
  const rich = await ask('| A | B |\n| --- | --- |\n| one | two |\n\n$\\frac{1}{2}$\n\n[bad](javascript:alert%281%29)\n\n<script>alert(1)</script>', false)
  assert.ok(rich)
  assert.equal(rich.math, true)
  assert.ok(nodes(rich).some((node) => node.tagName === 'table'))
  assert.ok(nodes(rich).some((node) => node.properties?.className?.includes('katex')))
  assert.equal(nodes(rich).some((node) => node.tagName === 'script' || String(node.properties?.href ?? '').startsWith('javascript:')), false)
  console.log('PASS production Markdown worker: DOM-free startup, entities, GFM, lazy math, URL/HTML safety, stable blocks')
} finally {
  clearTimeout(timer)
  await worker.terminate()
}
