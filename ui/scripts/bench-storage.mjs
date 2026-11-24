// Actual storage adapters, deterministic synthetic history, in-memory backing storage.
// This measures serialized work and Node execution only: no browser, disk, quota or IPC.
// node scripts/bench-storage.mjs --baseline /path/to/phase1/ui --output ../docs/phase2-storage-benchmark.json
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { cpus, platform, arch } from 'node:os'

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const baseline = option('--baseline') || process.env.STORAGE_BASELINE_ROOT
const output = option('--output')
const repeats = Number(option('--repeats') || 5)
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 50, 'repeats must be 1..50')
const KEY = 'benchmark.session'
const counts = [1000, 5000]
const operations = ['initialSave', 'changeOneConversation', 'coalescedNavigation', 'coldHydration']
const bytes = (value) => Buffer.byteLength(value, 'utf8')
const checksum = (value) => createHash('sha256').update(value).digest('hex')
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function fixture(size) {
  const values = new Map()
  let meter
  const reset = () => { meter = { getItemCalls: 0, readValueUtf8Bytes: 0, setItemCalls: 0, writtenValueUtf8Bytes: 0, removeItemCalls: 0, serializedConversationBodies: 0, jsonStringifyCalls: 0, jsonStringifyUtf8Bytes: 0, jsonParseCalls: 0 } }
  reset()
  const backing = {
    getItem(key) { const value = values.get(key) ?? null; meter.getItemCalls++; if (value !== null) meter.readValueUtf8Bytes += bytes(value); return value },
    setItem(key, value) { meter.setItemCalls++; meter.writtenValueUtf8Bytes += bytes(value); values.set(key, value) },
    removeItem(key) { meter.removeItemCalls++; values.delete(key) },
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
  }
  const conversation = (index, changed = false) => {
    const value = {
      id: `conversation-${String(index).padStart(5, '0')}`,
      title: `Synthetic conversation ${index}`,
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index + Number(changed),
      modelId: 'fixture-model',
      messages: Array.from({ length: 4 }, (_, message) => ({
        id: `message-${index}-${message}`, role: message % 2 ? 'assistant' : 'user',
        content: `${changed ? 'Changed' : 'Message'} ${index}:${message} `.padEnd(256, 'x'),
        createdAt: 1_700_000_000_000 + message,
      })),
    }
    return { ...value, toJSON() { meter.serializedConversationBodies++; return value } }
  }
  const initial = { conversations: Array.from({ length: size }, (_, index) => conversation(index)), activeConversationId: 'conversation-00000', view: 'chat', preferredModelId: 'fixture-model' }
  const changed = { ...initial, conversations: initial.conversations.map((value, index) => index === Math.floor(size / 2) ? conversation(index, true) : value) }
  function measure(action) {
    reset()
    const stringify = JSON.stringify
    const parse = JSON.parse
    JSON.stringify = function (...values) { const result = stringify.apply(JSON, values); meter.jsonStringifyCalls++; if (typeof result === 'string') meter.jsonStringifyUtf8Bytes += bytes(result); return result }
    JSON.parse = function (...values) { meter.jsonParseCalls++; return parse.apply(JSON, values) }
    const started = performance.now()
    try { action() } finally { JSON.stringify = stringify; JSON.parse = parse }
    return { ...meter, nodeInstrumentedWallMs: +(performance.now() - started).toFixed(3), retainedStorageKeys: values.size, retainedValueUtf8Bytes: [...values.values()].reduce((sum, value) => sum + bytes(value), 0) }
  }
  return { backing, initial, changed, measure }
}

const adapters = [
  ...(baseline ? [{ label: 'phase1', root: resolve(baseline) }] : []),
  { label: 'phase2', root: uiRoot },
]
const results = []
for (const adapter of adapters) {
  const source = join(adapter.root, 'src/lib/sessionStorage.ts')
  const sourceSha256 = checksum(await readFile(source))
  const { createSessionStorage } = await import(pathToFileURL(source).href)
  for (const size of counts) {
    const samples = Object.fromEntries(operations.map((operation) => [operation, []]))
    for (let repeat = 0; repeat < repeats; repeat++) {
      const f = fixture(size)
      const storage = createSessionStorage(f.backing, (error) => { throw error })
      assert.equal(await storage.getItem(KEY), null)
      samples.initialSave.push(f.measure(() => { storage.setItem(KEY, { state: f.initial, version: 2 }); storage.flush() }))
      samples.changeOneConversation.push(f.measure(() => { storage.setItem(KEY, { state: f.changed, version: 2 }); storage.flush() }))
      samples.coalescedNavigation.push(f.measure(() => {
        for (let index = 0; index < 1000; index++) storage.setItem(KEY, { state: { ...f.changed, activeConversationId: f.changed.conversations[index % size].id, view: index % 2 ? 'settings' : 'chat' }, version: 2 })
        storage.flush()
      }))
      samples.coldHydration.push(f.measure(() => {
        const reloaded = createSessionStorage(f.backing, (error) => { throw error }).getItem(KEY)
        assert.equal(reloaded.state.conversations.length, size)
        assert.equal(reloaded.state.view, 'settings')
        assert.ok(reloaded.state.conversations[Math.floor(size / 2)].messages[0].content.startsWith('Changed'))
      }))
    }
    const summary = Object.fromEntries(operations.map((operation) => [operation, Object.fromEntries(Object.keys(samples[operation][0]).map((metric) => [metric, median(samples[operation].map((sample) => sample[metric]))]))]))
    const result = { label: adapter.label, conversationCount: size, sourceSha256, summary, samples }
    results.push(result)
    console.log(JSON.stringify({ label: adapter.label, conversationCount: size, summary }))
  }
}
const report = {
  schema: 1,
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, scriptSha256: checksum(await readFile(fileURLToPath(import.meta.url))) },
  methodology: {
    repeats, statistic: 'median; all samples retained',
    fixture: '1000 or 5000 conversations; 4 messages each; 256 ASCII content characters per message; one immutable conversation object changed; 1000 navigation updates coalesced before flush',
    backing: 'Unlimited in-memory Map. No browser quota, disk access, WebView IPC, DOM or layout. The 5000-conversation fixture may exceed real localStorage quota.',
    work: 'Actual adapter source. Explicit synchronous flush excludes the 500 ms debounce and idle scheduling. Navigation is measured after a committed history save. Cold hydration creates a new adapter against the saved values.',
    instrumentation: 'Counts successful storage operations, JSON calls, and conversation toJSON calls. UTF-8 byte counts are serialized values only, not UTF-16 browser quota or key overhead. Instrumented Node wall time is not UI response latency.',
    tradeoff: 'Per-conversation records reduce repeated body serialization while increasing storage keys and synchronous cold reads. Metadata indexes and the previous recovery index remain proportional to conversation count.',
  },
  results,
}
if (output) {
  const destination = resolve(output)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Saved ${destination}`)
}
