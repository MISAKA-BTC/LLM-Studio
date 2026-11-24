import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionStorage, SessionStorageError } from '../src/lib/sessionStorage.ts'

const KEY = 'session'
const INDEX = `${KEY}.v3.index`
const PREVIOUS = `${KEY}.v3.previous`
const PREFIX = `${KEY}.v3.record.`
const conversation = (id = 'chat', content = 'kept history') => ({ id, messages: [{ content }] })
const state = (conversations = [conversation()]) => ({ conversations, activeConversationId: conversations[0]?.id ?? null, view: 'chat', preferredModelId: 'model' })
type State = ReturnType<typeof state>
type Failure = (operation: 'get' | 'set' | 'remove', key: string, value?: string) => boolean

function fixture() {
  const values = new Map<string, string>()
  const writes: { key: string; value: string }[] = []
  const errors: unknown[] = []
  let failure: Failure = () => false
  const backing = {
    getItem(key: string) {
      if (failure('get', key)) throw new Error('read denied')
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (failure('set', key, value)) throw new Error('quota')
      writes.push({ key, value })
      values.set(key, value)
    },
    removeItem(key: string) {
      if (failure('remove', key)) throw new Error('remove denied')
      values.delete(key)
    },
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
  }
  const open = () => createSessionStorage<State>(backing, (error) => errors.push(error))
  const storage = open()
  const save = (next: State, version = 2) => { storage.setItem(KEY, { state: next, version }); storage.flush() }
  const fresh = async () => await open().getItem(KEY)
  const index = () => JSON.parse(values.get(INDEX)!) as { revision: string; version?: number; entries: [string, string][] }
  const record = (id: string) => `${PREFIX}${index().entries.find(([key]) => key === id)![1]}`
  return { storage, open, save, fresh, index, record, backing, values, writes, errors, setFailure: (next: Failure) => { failure = next } }
}

test('one changed conversation serializes only that conversation, preserving other records and list order', async () => {
  const f = fixture()
  const counts = new Map<string, number>()
  const tracked = (id: string, content: string) => ({
    ...conversation(id, content),
    toJSON() { counts.set(id, (counts.get(id) ?? 0) + 1); return conversation(id, content) },
  })
  const initial = state(Array.from({ length: 1000 }, (_, index) => tracked(`chat-${index}`, 'first')))
  f.save(initial)
  const originalKeys = new Map(f.index().entries)
  counts.clear()
  const updated = { ...initial, conversations: initial.conversations.map((thread) => thread.id === 'chat-500' ? tracked(thread.id, 'changed') : thread) }
  f.writes.length = 0
  f.save(updated)
  assert.deepEqual([...counts], [['chat-500', 1]])
  assert.equal(f.writes.filter((write) => write.key.startsWith(PREFIX)).length, 1)
  const currentKeys = new Map(f.index().entries)
  for (const [id, token] of originalKeys) assert.equal(currentKeys.get(id) === token, id !== 'chat-500')
  assert.deepEqual((await f.fresh())?.state.conversations.map((thread) => thread.id), initial.conversations.map((thread) => thread.id))
  assert.equal((await f.fresh())?.state.conversations[500]?.messages[0]?.content, 'changed')
  counts.clear()
  f.save({ ...updated, conversations: [...updated.conversations].reverse() })
  assert.equal(counts.size, 0, 'Reordering metadata does not stringify message bodies')
  assert.equal((await f.fresh())?.state.conversations[0]?.id, 'chat-999')
})

test('1000 navigation changes write one small navigation record and never rewrite history or index', async () => {
  const f = fixture()
  let serializations = 0
  const thread = { ...conversation(), toJSON() { serializations++; return conversation() } }
  const initial = state([thread])
  f.save(initial)
  const original = f.values.get(INDEX)
  f.writes.length = 0
  for (let i = 0; i < 1000; i++) {
    f.storage.setItem(KEY, { state: { ...initial, view: i % 2 ? 'settings' : 'chat', activeConversationId: `chat-${i}` }, version: 2 })
  }
  f.storage.flush()
  assert.equal(serializations, 1)
  assert.equal(f.values.get(INDEX), original)
  assert.deepEqual(f.writes.map((write) => write.key), [`${KEY}.navigation`])
  assert.ok(f.writes[0]!.value.length < 300)
  assert.equal((await f.fresh())?.state.view, 'settings')
  assert.equal((await f.fresh())?.state.activeConversationId, 'chat-999')
})

test('v1 and v2 sessions migrate on data change without removing their original recovery copy', async () => {
  for (const version of [1, 2]) {
    const f = fixture()
    const original = JSON.stringify({ state: state(), version })
    f.values.set(KEY, original)
    const restored = await f.storage.getItem(KEY)
    assert.equal(restored?.version, version)
    assert.deepEqual(restored?.state, state())
    f.save({ ...restored!.state, conversations: [conversation('chat', 'latest')] })
    assert.equal(f.values.get(KEY), original)
    assert.equal(f.index().version, 2)
    assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, 'latest')
  }
})

test('legacy navigation stays small without forcing a migration, including a missing old model preference', async () => {
  const f = fixture()
  const legacy = { conversations: [conversation()], activeConversationId: 'chat', view: 'chat' }
  const original = JSON.stringify({ state: legacy, version: 2 })
  f.values.set(KEY, original)
  const restored = await f.storage.getItem(KEY)
  assert.equal(restored?.state.preferredModelId, null)
  f.save({ ...restored!.state, view: 'settings' })
  assert.equal(f.values.get(KEY), original)
  assert.equal(f.values.has(INDEX), false)
  assert.deepEqual(f.writes.map((write) => write.key), [`${KEY}.navigation`])
  assert.equal((await f.fresh())?.state.view, 'settings')
})

test('quota during migration removes staging records and continues saving in the old format', async () => {
  const f = fixture()
  f.values.set(KEY, JSON.stringify({ state: state([conversation('a'), conversation('b')]), version: 2 }))
  const restored = await f.storage.getItem(KEY)
  let recordAttempts = 0
  f.setFailure((operation, key) => operation === 'set' && key.startsWith(PREFIX) && ++recordAttempts === 2)
  const newest = { ...restored!.state, conversations: [conversation('a', 'new a'), conversation('b', 'new b')] }
  f.save(newest)
  assert.equal(f.values.has(INDEX), false)
  assert.equal([...f.values.keys()].some((key) => key.startsWith(PREFIX)), false)
  assert.deepEqual((await f.fresh())?.state, newest)
  assert.equal(f.errors.length, 0, 'A successful compatibility save is not reported as lost data')
  f.setFailure(() => false)
  f.save({ ...newest, conversations: [...newest.conversations, conversation('c')] })
  assert.equal(f.index().entries.length, 3)
  assert.equal((await f.fresh())?.state.conversations.length, 3)
})

test('record, backup and final-index failures leave the previous complete snapshot and retry the newest data', async () => {
  for (const failAt of ['record', 'backup', 'index']) {
    const f = fixture()
    const initial = state([conversation('a'), conversation('b')])
    f.save(initial)
    const original = f.values.get(INDEX)
    const originalRecords = [...f.values.keys()].filter((key) => key.startsWith(PREFIX)).sort()
    const newest = { ...initial, conversations: [conversation('a', 'latest a'), conversation('b', 'latest b')] }
    let recordAttempts = 0
    f.setFailure((operation, key) => operation === 'set' && (
      (failAt === 'record' && key.startsWith(PREFIX) && ++recordAttempts === 2) ||
      (failAt === 'backup' && key === PREVIOUS) ||
      (failAt === 'index' && key === INDEX)
    ))
    f.save(newest)
    assert.equal(f.values.get(INDEX), original, failAt)
    assert.deepEqual([...f.values.keys()].filter((key) => key.startsWith(PREFIX)).sort(), originalRecords, failAt)
    assert.deepEqual((await f.fresh())?.state, initial, failAt)
    assert.equal(f.errors.length, 1)
    f.setFailure(() => false)
    f.storage.flush()
    assert.deepEqual((await f.fresh())?.state, newest, failAt)
  }
})

test('repeated storage failures are reported once until a successful save', async () => {
  const f = fixture()
  const initial = state()
  f.save(initial)
  f.setFailure((operation) => operation === 'set')
  f.save({ ...initial, conversations: [conversation('chat', 'pending')] })
  f.storage.flush()
  f.storage.flush()
  assert.equal(f.errors.length, 1)
  f.setFailure(() => false)
  f.storage.flush()
  assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, 'pending')
  f.setFailure((operation) => operation === 'set')
  f.save({ ...initial, conversations: [conversation('chat', 'next failure')] })
  assert.equal(f.errors.length, 2)
})

test('a failed final commit also collects records orphaned by replacing the previous index', async () => {
  const f = fixture()
  f.save(state([conversation('chat', 'first')]))
  const oldestRecord = f.record('chat')
  f.save(state([conversation('chat', 'second')]))
  const currentRecord = f.record('chat')
  assert.equal(f.values.has(oldestRecord), true)
  f.setFailure((operation, key) => operation === 'set' && key === INDEX)
  f.save(state([conversation('chat', 'third')]))
  assert.equal(f.values.has(oldestRecord), false, 'The overwritten backup no longer references this record')
  assert.equal(f.values.has(currentRecord), true)
  assert.equal([...f.values.keys()].filter((key) => key.startsWith(PREFIX)).length, 1)
  assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, 'second')
  f.setFailure(() => false)
  f.storage.flush()
  assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, 'third')
})

test('a valid current index recovers only its listed IDs and never resurrects a deleted legacy conversation', async () => {
  const f = fixture()
  f.values.set(KEY, JSON.stringify({ state: state([conversation('a', 'legacy a'), conversation('b', 'legacy b')]), version: 1 }))
  const restored = await f.storage.getItem(KEY)
  f.save({ ...restored!.state, conversations: [conversation('a', 'prior a'), conversation('b', 'prior b')] })
  f.save(state([conversation('a', 'latest a')]))
  const brokenRecord = f.record('a')
  f.values.set(brokenRecord, '{broken')
  const recovery = f.open()
  const recovered = await recovery.getItem(KEY)
  assert.deepEqual(recovered?.state.conversations.map((thread) => thread.id), ['a'])
  assert.equal(recovered?.state.conversations[0]?.messages[0]?.content, 'prior a')
  assert.equal(f.values.get(brokenRecord), '{broken', 'Reading does not mutate damaged source data')
  assert.ok(f.errors.some((error) => error instanceof SessionStorageError && error.code === 'recovery'))
  recovery.setItem(KEY, recovered!)
  recovery.flush()
  assert.deepEqual((await f.fresh())?.state.conversations.map((thread) => thread.id), ['a'])
})

test('an empty committed index stays empty even when its legacy and previous backups contain conversations', async () => {
  const f = fixture()
  f.values.set(KEY, JSON.stringify({ state: state(), version: 1 }))
  await f.storage.getItem(KEY)
  f.save(state([conversation('chat', 'v3')]))
  f.save(state([]))
  assert.equal(f.index().entries.length, 0)
  assert.deepEqual((await f.fresh())?.state.conversations, [])
  assert.ok(f.values.has(KEY))
  assert.ok(f.values.has(PREVIOUS))
})

test('a damaged primary index falls back to the previous snapshot without overwriting the damaged source on read', async () => {
  const f = fixture()
  const initial = state()
  f.save(initial)
  f.save(state([conversation('chat', 'newest')]))
  f.values.set(INDEX, '{broken-index')
  assert.deepEqual((await f.fresh())?.state, initial)
  assert.equal(f.values.get(INDEX), '{broken-index')
})

test('a primary index with duplicate conversation IDs is rejected in favor of a complete previous snapshot', async () => {
  const f = fixture()
  const initial = state([conversation('a'), conversation('b')])
  f.save(initial)
  f.save(state([conversation('a', 'new a'), conversation('b', 'new b')]))
  const invalid = { ...f.index(), entries: [f.index().entries[0], f.index().entries[0]] }
  const damaged = JSON.stringify(invalid)
  f.values.set(INDEX, damaged)
  assert.deepEqual((await f.fresh())?.state, initial)
  assert.equal(f.values.get(INDEX), damaged)
})

test('unrecoverable legacy or per-conversation corruption blocks automatic overwrite and retains the original bytes', async () => {
  for (const mode of ['legacy', 'record']) {
    const f = fixture()
    if (mode === 'legacy') f.values.set(KEY, '{unreadable-history')
    else { f.save(state()); f.values.set(f.record('chat'), JSON.stringify({ format: 1, conversation: conversation('wrong-id') })) }
    const before = new Map(f.values)
    const reopened = f.open()
    assert.equal(await reopened.getItem(KEY), null)
    reopened.setItem(KEY, { state: state([]), version: 2 })
    reopened.flush()
    assert.deepEqual(f.values, before)
    assert.ok(f.errors.some((error) => error instanceof SessionStorageError && error.code === 'read'))
  }
})

test('a damaged navigation record cannot hide history or inject a replacement conversations array', async () => {
  const f = fixture()
  f.save(state())
  f.values.set(`${KEY}.navigation`, '{broken')
  assert.deepEqual((await f.fresh())?.state.conversations, [conversation()])
  f.values.set(`${KEY}.navigation`, JSON.stringify({ state: { ...state(), view: 'models', conversations: [] }, version: 2, historyRevision: f.index().revision }))
  assert.deepEqual((await f.fresh())?.state.conversations, [conversation()])
  assert.equal((await f.fresh())?.state.view, 'models')
  const oldNavigation = f.values.get(`${KEY}.navigation`)!
  f.save({ ...state(), conversations: [conversation('chat', 'changed')], view: 'settings' })
  f.values.set(`${KEY}.navigation`, oldNavigation)
  assert.equal((await f.fresh())?.state.view, 'settings', 'An older revision cannot override the new history snapshot')
})

test('obsolete record versions are collected while the current and previous versions remain readable', async () => {
  const f = fixture()
  for (let i = 0; i < 8; i++) f.save(state([conversation('a', String(i)), conversation('b', String(i))]))
  assert.equal([...f.values.keys()].filter((key) => key.startsWith(PREFIX)).length, 4)
  assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, '7')
  f.values.set(INDEX, '{corrupt')
  assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, '6')
})

test('a stale window cannot overwrite a newer committed history snapshot', async () => {
  const f = fixture()
  f.save(state())
  const other = f.open()
  const old = await other.getItem(KEY)
  f.save(state([conversation('chat', 'saved by another window')]))
  const before = new Map(f.values)
  other.setItem(KEY, { state: { ...old!.state, conversations: [conversation('chat', 'stale overwrite')] }, version: 2 })
  other.flush()
  assert.deepEqual(f.values, before)
  assert.equal((await f.fresh())?.state.conversations[0]?.messages[0]?.content, 'saved by another window')
  assert.ok(f.errors.some((error) => error instanceof SessionStorageError && error.code === 'conflict'))
})

test('invalid duplicate IDs are refused without corrupting a legacy or segmented snapshot', async () => {
  for (const legacy of [false, true]) {
    const f = fixture()
    if (legacy) { f.values.set(KEY, JSON.stringify({ state: state(), version: 2 })); await f.storage.getItem(KEY) }
    else f.save(state())
    const before = new Map(f.values)
    f.save(state([conversation('same'), conversation('same')]))
    assert.deepEqual(f.values, before)
    assert.equal(f.errors.length, 1)
  }
})

test('rehydration cancels an older queued write, and clear removes all owned records without touching other keys', async () => {
  const f = fixture()
  f.values.set('unrelated', 'keep me')
  const initial = state()
  f.save(initial)
  f.storage.setItem(KEY, { state: state([]), version: 2 })
  assert.deepEqual((await f.storage.getItem(KEY))?.state, initial)
  f.storage.flush()
  assert.deepEqual((await f.fresh())?.state, initial)
  f.values.set(`${PREFIX}orphan-from-crash`, 'uncommitted')
  f.storage.setItem(KEY, { state: { ...initial, view: 'settings' }, version: 2 })
  f.storage.removeItem(KEY)
  f.storage.flush()
  assert.deepEqual([...f.values], [['unrelated', 'keep me']])
})

test('an interrupted clear leaves a tombstone so legacy or backup data cannot reappear', async () => {
  const f = fixture()
  f.values.set(KEY, JSON.stringify({ state: state(), version: 2 }))
  await f.storage.getItem(KEY)
  f.save(state([conversation('chat', 'migrated')]))
  f.setFailure((operation, key) => operation === 'remove' && key === KEY)
  f.storage.removeItem(KEY)
  assert.equal((await f.fresh()), null)
  assert.ok(f.values.has(KEY), 'Failed deletions remain available for a later explicit retry')
  assert.equal(JSON.parse(f.values.get(INDEX)!).cleared, true)
  f.setFailure(() => false)
  f.storage.removeItem(KEY)
  assert.equal(f.values.size, 0)
})

function fakeScheduler() {
  const timers = new Map<number, () => void>()
  const idles = new Map<number, (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void>()
  let id = 0
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, requestIdleCallback: globalThis.requestIdleCallback, cancelIdleCallback: globalThis.cancelIdleCallback }
  globalThis.setTimeout = ((callback: () => void) => { timers.set(++id, callback); return id }) as typeof setTimeout
  globalThis.clearTimeout = ((key: number) => { timers.delete(key) }) as typeof clearTimeout
  globalThis.requestIdleCallback = (callback) => { idles.set(++id, callback); return id }
  globalThis.cancelIdleCallback = (key) => { idles.delete(key) }
  const runTimer = () => { const [key, callback] = [...timers][0]!; timers.delete(key); callback() }
  const runIdle = () => { const [key, callback] = [...idles][0]!; idles.delete(key); callback({ didTimeout: false, timeRemaining: () => 50 }) }
  return { timers, idles, runTimer, runIdle, restore() { Object.assign(globalThis, original) } }
}

test('automatic migration yields after 16 records and commits only after every record is present', async () => {
  const scheduler = fakeScheduler()
  try {
    const f = fixture()
    const initial = state(Array.from({ length: 80 }, (_, index) => conversation(`chat-${index}`)))
    f.storage.setItem(KEY, { state: initial, version: 2 })
    scheduler.runTimer()
    scheduler.runIdle()
    assert.equal(f.writes.filter((write) => write.key.startsWith(PREFIX)).length, 16)
    assert.equal(f.values.has(INDEX), false)
    assert.equal(await f.fresh(), null, 'A reader cannot see an uncommitted partial session')
    while (scheduler.idles.size) scheduler.runIdle()
    assert.equal(f.writes.filter((write) => write.key.startsWith(PREFIX)).length, 80)
    assert.equal(f.index().entries.length, 80)
    assert.deepEqual((await f.fresh())?.state, initial)
  } finally { scheduler.restore() }
})

test('pagehide flush finishes a staged migration and the newer edit queued while it was yielding', async () => {
  const scheduler = fakeScheduler()
  try {
    const f = fixture()
    const initial = state(Array.from({ length: 80 }, (_, index) => conversation(`chat-${index}`)))
    f.storage.setItem(KEY, { state: initial, version: 2 })
    scheduler.runTimer()
    scheduler.runIdle()
    const newest = { ...initial, conversations: initial.conversations.map((thread, index) => index ? thread : conversation(thread.id, 'edited during migration')) }
    f.storage.setItem(KEY, { state: newest, version: 2 })
    f.storage.flush()
    assert.equal(scheduler.idles.size, 0)
    assert.equal(scheduler.timers.size, 0)
    assert.deepEqual((await f.fresh())?.state, newest)
    assert.equal(f.writes.filter((write) => write.key.startsWith(PREFIX)).length, 81)
  } finally { scheduler.restore() }
})

test('rehydration during staging drops only uncommitted records and leaves the last committed session', async () => {
  const scheduler = fakeScheduler()
  try {
    const f = fixture()
    const initial = state([conversation('original')])
    f.save(initial)
    const original = new Map(f.values)
    f.storage.setItem(KEY, { state: state(Array.from({ length: 80 }, (_, index) => conversation(`chat-${index}`))), version: 2 })
    scheduler.runTimer()
    scheduler.runIdle()
    assert.ok(f.values.size > original.size)
    assert.deepEqual((await f.storage.getItem(KEY))?.state, initial)
    assert.deepEqual(f.values, original)
    assert.equal(scheduler.idles.size, 0)
    f.storage.flush()
    assert.deepEqual((await f.fresh())?.state, initial)
  } finally { scheduler.restore() }
})
