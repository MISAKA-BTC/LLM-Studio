import type { PersistStorage, StorageValue } from 'zustand/middleware'

type Navigation = { activeConversationId: string | null; view: string; preferredModelId: string | null }
type Conversation = { id: string; messages: readonly unknown[] }
type Session = Navigation & { conversations: readonly Conversation[] }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<globalThis.Storage, 'length' | 'key'>>
type SavedNavigation = StorageValue<Navigation> & { historyRevision: string | null }
type Index = {
  format: 3
  revision: string
  version?: number
  state: Navigation & Record<string, unknown>
  /** Conversation ID and immutable record token, in conversation-list order. */
  entries: [string, string][]
}
type RecordRef = { value: Conversation; token: string | null }
type Snapshot<S> = { value: StorageValue<S>; index: Index | null; rawIndex: string | null; revision: string | null; refs: Map<string, RecordRef> }
type Transaction<S> = {
  value: StorageValue<S>
  index: Index
  writes: { token: string; conversation: Conversation }[]
  cursor: number
  staged: string[]
  refs: Map<string, RecordRef>
}
type Context<S> = {
  initialized: boolean
  blocked: boolean
  repair: boolean
  primaryRaw: string | null
  legacyRaw: string | null
  saved: Snapshot<S> | null
  last: StorageValue<S> | null
  pending: StorageValue<S> | null
  transaction: Transaction<S> | null
  garbage: Set<string>
}

const SAVE_DELAY_MS = 500
const RECORDS_PER_SLICE = 16
const indexKey = (name: string) => `${name}.v3.index`
const previousKey = (name: string) => `${name}.v3.previous`
const recordPrefix = (name: string) => `${name}.v3.record.`
const recordKey = (name: string, token: string) => `${recordPrefix(name)}${token}`
const revision = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** The message is suitable for the app's existing error notification surface. */
export class SessionStorageError extends Error {
  readonly code: 'read' | 'write' | 'conflict' | 'recovery' | 'cleanup'
  constructor(code: SessionStorageError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionStorageError'
    this.code = code
  }
}

/**
 * Save changed conversations separately from navigation and from unchanged transcripts.
 *
 * Records are immutable. The small index is the commit point and is written only after every
 * referenced record exists. A failed partial write leaves the previous index usable. One prior
 * index is retained for recovery; a valid current index always owns membership, so recovery of
 * one damaged record cannot resurrect a deleted conversation. v1/v2 blobs remain readable and
 * are kept as a migration backup. If migration cannot fit, saving in the old format continues.
 *
 * Ordinary saves yield between at most 16 records; explicit flush (pagehide) completes pending
 * work synchronously. This is not a multi-window database: optimistic revision checks refuse a
 * known stale writer, but localStorage provides no cross-window compare-and-swap transaction.
 */
export function createSessionStorage<S extends Session>(
  storage: Storage,
  onError: (error: unknown) => void = (error) => console.warn('LLM Studio could not save the conversations:', error),
): PersistStorage<S> & { flush: () => void } {
  const contexts = new Map<string, Context<S>>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let idle: number | null = null
  let lastIssue = ''

  const report = (error: SessionStorageError) => {
    const identity = `${error.code}:${error.message}`
    if (lastIssue === identity) return
    lastIssue = identity
    onError(error)
  }
  const contextFor = (name: string): Context<S> => {
    let context = contexts.get(name)
    if (!context) {
      context = { initialized: false, blocked: false, repair: false, primaryRaw: null, legacyRaw: null, saved: null, last: null, pending: null, transaction: null, garbage: new Set() }
      contexts.set(name, context)
    }
    return context
  }
  const cancelSchedule = () => {
    if (timer !== null) clearTimeout(timer)
    if (idle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
    timer = null
    idle = null
  }
  const readRecord = (name: string, id: string, token: string): Conversation | null => {
    try {
      const raw = storage.getItem(recordKey(name, token))
      const record: unknown = raw ? JSON.parse(raw) : null
      if (!isObject(record) || record.format !== 1 || !isConversation(record.conversation) || record.conversation.id !== id) return null
      return record.conversation
    } catch {
      return null
    }
  }
  const readLegacy = (name: string): Snapshot<S> | null => {
    const raw = storage.getItem(name)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed) || !isObject(parsed.state) || !validConversations(parsed.state.conversations)) return null
    const navigation = legacyNavigation(parsed.state)
    if (!navigation || !validVersion(parsed.version)) return null
    const state = { ...parsed.state, ...navigation } as S
    const version = typeof parsed.version === 'number' ? parsed.version : undefined
    return {
      value: { state, version }, index: null, rawIndex: null,
      revision: typeof parsed.revision === 'string' ? parsed.revision : null,
      refs: new Map(state.conversations.map((conversation) => [conversation.id, { value: conversation, token: null }])),
    }
  }
  const overlayNavigation = (name: string, snapshot: Snapshot<S>) => {
    try {
      const raw = storage.getItem(`${name}.navigation`)
      const nav: unknown = raw ? JSON.parse(raw) : null
      if (isObject(nav) && nav.version === snapshot.value.version && nav.historyRevision === snapshot.revision && isNavigation(nav.state)) {
        snapshot.value = { ...snapshot.value, state: { ...snapshot.value.state, ...navigationOf(nav.state) } }
      }
    } catch {
      // Navigation is optional. It must never hide or inject conversation history.
    }
  }
  const load = (name: string, context: Context<S>): Snapshot<S> | null => {
    context.initialized = true
    context.blocked = false
    context.repair = false
    context.saved = null
    try {
      context.primaryRaw = storage.getItem(indexKey(name))
      const parsedPrimary = parseJson(context.primaryRaw)
      if (isObject(parsedPrimary) && parsedPrimary.format === 3 && parsedPrimary.cleared === true) return null
      const primary = parseIndex(parsedPrimary)
      let previous: Index | null | undefined
      const getPrevious = () => {
        if (previous === undefined) previous = parseIndex(parseJson(storage.getItem(previousKey(name))))
        return previous
      }
      let legacy: Snapshot<S> | null | undefined
      const getLegacy = () => {
        if (legacy === undefined) {
          context.legacyRaw = storage.getItem(name)
          try { legacy = readLegacy(name) } catch { legacy = null }
        }
        return legacy
      }
      const index = primary ?? getPrevious()
      let snapshot: Snapshot<S> | null = null
      if (index) {
        // Once an index is valid, its IDs are authoritative even if some records need recovery.
        // In particular, an empty current index must not fall back to old, deleted conversations.
        const refs = new Map<string, RecordRef>()
        const conversations: Conversation[] = []
        const previousRefs = new Map(getPrevious()?.entries ?? [])
        for (const [id, token] of index.entries) {
          let value = readRecord(name, id, token)
          let recoveredToken: string | null = token
          if (!value) {
            const priorToken = previousRefs.get(id)
            value = priorToken ? readRecord(name, id, priorToken) : null
            recoveredToken = value ? priorToken! : null
            if (!value) value = getLegacy()?.refs.get(id)?.value ?? null
            if (!value) throw new Error(`Unrecoverable conversation: ${id}`)
            context.repair = true
          }
          conversations.push(value)
          refs.set(id, { value, token: recoveredToken })
        }
        context.repair ||= primary === null
        snapshot = {
          value: { state: { ...index.state, conversations } as unknown as S, version: index.version },
          index, rawIndex: primary ? context.primaryRaw : storage.getItem(previousKey(name)), revision: index.revision, refs,
        }
      } else {
        snapshot = getLegacy()
        if (!snapshot && (context.primaryRaw !== null || storage.getItem(previousKey(name)) !== null || context.legacyRaw !== null)) {
          throw new Error('No complete readable session was found')
        }
        context.repair = snapshot !== null && context.primaryRaw !== null
      }
      if (snapshot) overlayNavigation(name, snapshot)
      context.saved = snapshot
      if (context.repair) report(new SessionStorageError('recovery', '履歴の一部を直前の保存データから復元しました。読み取れなかった元データは削除していません。'))
      return snapshot
    } catch (cause) {
      // Returning null starts an in-memory session, but must not authorize an empty overwrite.
      context.blocked = true
      report(new SessionStorageError('read', '保存済みの会話履歴を読み取れません。元データを保護するため自動保存を停止しています。', { cause }))
      return null
    }
  }
  const assertCurrent = (name: string, context: Context<S>) => {
    if (storage.getItem(indexKey(name)) !== context.primaryRaw ||
      (context.primaryRaw === null && storage.getItem(name) !== context.legacyRaw)) {
      throw new SessionStorageError('conflict', '別のウィンドウで履歴が更新されました。上書きを止めています。この画面の未保存内容を退避してから再読み込みしてください。')
    }
  }
  const rollback = (name: string, context: Context<S>) => {
    for (const token of context.transaction?.staged ?? []) {
      try { storage.removeItem(recordKey(name, token)) } catch { context.garbage.add(token) }
    }
    context.transaction = null
  }
  const plan = (name: string, context: Context<S>, value: StorageValue<S>): Transaction<S> => {
    if (!validConversations(value.state.conversations) || !isNavigation(value.state) || !validVersion(value.version)) {
      throw new SessionStorageError('write', '会話履歴の形式を確認できないため保存を止めています。既存の保存データは変更していません。')
    }
    assertCurrent(name, context)
    const stamp = revision()
    const entries: [string, string][] = []
    const refs = new Map<string, RecordRef>()
    const writes: Transaction<S>['writes'] = []
    for (const conversation of value.state.conversations) {
      const saved = context.saved?.refs.get(conversation.id)
      const token = saved?.value === conversation && saved.token ? saved.token : `${stamp}-${writes.length.toString(36)}`
      if (token !== saved?.token) writes.push({ token, conversation })
      entries.push([conversation.id, token])
      refs.set(conversation.id, { value: conversation, token })
    }
    return {
      value, index: { format: 3, revision: stamp, version: value.version, state: metadataOf(value.state), entries },
      writes, cursor: 0, staged: [], refs,
    }
  }
  const commit = (name: string, context: Context<S>, transaction: Transaction<S>) => {
    assertCurrent(name, context)
    const previous = parseIndex(parseJson(storage.getItem(previousKey(name))))
    const oldIndex = context.saved?.index
    const backup = oldIndex && !context.repair ? oldIndex : previous
    // Replacing the backup can orphan its old records even if the final index write fails.
    // collect() re-reads both committed indexes before removing any candidate.
    for (const [, token] of previous?.entries ?? []) context.garbage.add(token)
    // Do not replace a good backup with an index already known to contain damaged records.
    if (context.saved?.rawIndex && !context.repair) storage.setItem(previousKey(name), context.saved.rawIndex)
    const raw = JSON.stringify(transaction.index)
    storage.setItem(indexKey(name), raw)
    const protectedTokens = new Set([...transaction.index.entries.map(([, token]) => token), ...(backup?.entries.map(([, token]) => token) ?? [])])
    for (const [, token] of [...(previous?.entries ?? []), ...(oldIndex?.entries ?? [])]) {
      if (!protectedTokens.has(token)) context.garbage.add(token)
    }
    context.primaryRaw = raw
    context.saved = { value: transaction.value, index: transaction.index, rawIndex: raw, revision: transaction.index.revision, refs: transaction.refs }
    context.repair = false
    context.transaction = null
    if (context.pending === transaction.value) context.pending = null
    lastIssue = ''
  }
  const saveLegacy = (name: string, context: Context<S>, value: StorageValue<S>): boolean => {
    // Only an already readable old-format session may fall back. A failed v3 commit must not
    // write a newer legacy blob behind an existing authoritative v3 index.
    if (context.saved?.index || context.legacyRaw === null || context.primaryRaw !== null) return false
    assertCurrent(name, context)
    const stamp = revision()
    const raw = JSON.stringify({ ...value, revision: stamp })
    storage.setItem(name, raw)
    context.legacyRaw = raw
    context.saved = { value, index: null, rawIndex: null, revision: stamp, refs: new Map(value.state.conversations.map((conversation) => [conversation.id, { value: conversation, token: null }])) }
    context.repair = false
    if (context.pending === value) context.pending = null
    lastIssue = ''
    return true
  }
  const collect = (name: string, context: Context<S>, limit: number): boolean => {
    if (!context.garbage.size || !context.saved?.index) return false
    try {
      if (storage.getItem(indexKey(name)) !== context.primaryRaw) return false
      const protectedTokens = new Set([
        ...context.saved.index.entries.map(([, token]) => token),
        ...(parseIndex(parseJson(storage.getItem(previousKey(name))))?.entries.map(([, token]) => token) ?? []),
      ])
      let processed = 0
      for (const token of context.garbage) {
        if (processed++ >= limit) break
        if (!protectedTokens.has(token)) storage.removeItem(recordKey(name, token))
        context.garbage.delete(token)
      }
      return context.garbage.size > 0
    } catch {
      // A committed save remains successful even if old record cleanup is temporarily blocked.
      return false
    }
  }
  const work = (force: boolean, deadline?: IdleDeadline) => {
    timer = null
    idle = null
    let remainingWork = false
    for (const [name, context] of contexts) {
      if (!context.pending && !context.transaction) { remainingWork ||= collect(name, context, force ? Infinity : RECORDS_PER_SLICE); continue }
      if (!context.initialized) load(name, context)
      if (context.blocked) continue
      try {
        do {
          const value = context.transaction?.value ?? context.pending!
          if (!context.transaction && context.saved && !context.repair && sameHistory(context.saved.value, value)) {
            assertCurrent(name, context)
            const nav: SavedNavigation = { state: navigationOf(value.state), version: value.version, historyRevision: context.saved.revision }
            storage.setItem(`${name}.navigation`, JSON.stringify(nav))
            context.saved.value = value
            context.pending = null
            lastIssue = ''
          } else {
            const transaction = context.transaction ??= plan(name, context, value)
            let written = 0
            while (transaction.cursor < transaction.writes.length) {
              const entry = transaction.writes[transaction.cursor]!
              storage.setItem(recordKey(name, entry.token), JSON.stringify({ format: 1, conversation: entry.conversation }))
              transaction.staged.push(entry.token)
              transaction.cursor++
              written++
              if (!force && (written >= RECORDS_PER_SLICE || (deadline && deadline.timeRemaining() < 4))) break
            }
            if (transaction.cursor === transaction.writes.length) commit(name, context, transaction)
          }
        } while (force && context.pending)
        const moreGarbage = collect(name, context, force ? Infinity : RECORDS_PER_SLICE)
        remainingWork ||= context.transaction !== null || context.pending !== null || moreGarbage
      } catch (cause) {
        const failed = context.transaction?.value ?? context.pending
        rollback(name, context)
        collect(name, context, force ? Infinity : RECORDS_PER_SLICE)
        if (!(cause instanceof SessionStorageError) && failed) {
          try { if (saveLegacy(name, context, failed)) { remainingWork ||= context.pending !== null; continue } } catch { /* report the original save failure */ }
        }
        report(cause instanceof SessionStorageError ? cause : new SessionStorageError('write', '会話履歴を保存できませんでした。現在の内容は画面に残っています。空き容量や保存権限を確認してください。', { cause }))
        // Keep pending for the next update or explicit pagehide flush; do not spin on a full disk.
      }
    }
    if (!force && remainingWork) scheduleIdle()
  }
  const scheduleIdle = () => {
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback((deadline) => work(false, deadline), { timeout: 1000 })
    else timer = setTimeout(() => work(false), 0)
  }
  const flush = () => {
    cancelSchedule()
    work(true)
  }

  return {
    flush,
    getItem(name) {
      const context = contextFor(name)
      rollback(name, context)
      context.pending = null
      const snapshot = load(name, context)
      context.last = snapshot?.value ?? null
      if (![...contexts.values()].some((entry) => entry.pending || entry.transaction)) cancelSchedule()
      return snapshot?.value ?? null
    },
    setItem(name, value) {
      const context = contextFor(name)
      if (!context.last || context.last.version !== value.version || !sameState(context.last.state, value.state) || context.repair) {
        context.last = value
        context.pending = value
      }
      if (context.pending && timer === null && idle === null) {
        timer = setTimeout(() => { timer = null; scheduleIdle() }, SAVE_DELAY_MS)
      }
    },
    removeItem(name) {
      const context = contextFor(name)
      context.pending = null
      rollback(name, context)
      const keys = new Set([name, `${name}.navigation`, previousKey(name)])
      for (const source of [storage.getItem(indexKey(name)), storage.getItem(previousKey(name))]) {
        for (const [, token] of parseIndex(parseJson(source))?.entries ?? []) keys.add(recordKey(name, token))
      }
      for (const token of context.garbage) keys.add(recordKey(name, token))
      // Real localStorage can also enumerate staging records left by a process crash.
      if (storage.key && typeof storage.length === 'number') {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (key?.startsWith(`${name}.v3.`) && key !== indexKey(name)) keys.add(key)
        }
      }
      const tombstone = JSON.stringify({ format: 3, cleared: true, revision: revision() })
      storage.setItem(indexKey(name), tombstone)
      context.primaryRaw = tombstone
      context.saved = null
      context.last = null
      context.blocked = false
      context.repair = false
      let failed = false
      for (const key of keys) {
        try { storage.removeItem(key) } catch { failed = true }
      }
      if (!failed) {
        storage.removeItem(indexKey(name))
        context.primaryRaw = null
        context.legacyRaw = null
        context.garbage.clear()
      } else {
        report(new SessionStorageError('cleanup', '履歴の削除を完了できませんでした。削除済みの履歴が自動復元されないよう保護しています。'))
      }
      if (![...contexts.values()].some((entry) => entry.pending || entry.transaction)) cancelSchedule()
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isConversation(value: unknown): value is Conversation { return isObject(value) && typeof value.id === 'string' && value.id.length > 0 && Array.isArray(value.messages) }
function validConversations(value: unknown): value is Conversation[] {
  return Array.isArray(value) && value.every(isConversation) && new Set(value.map((conversation) => conversation.id)).size === value.length
}
function validVersion(value: unknown): value is number | undefined { return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) }
function parseJson(value: string | null): unknown { try { return value === null ? null : JSON.parse(value) } catch { return null } }
function parseIndex(value: unknown): Index | null {
  if (!isObject(value) || value.format !== 3 || typeof value.revision !== 'string' || !value.revision || !validVersion(value.version) || !isNavigation(value.state) || !Array.isArray(value.entries)) return null
  const ids = new Set<string>()
  for (const entry of value.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || typeof entry[1] !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(entry[1]) || ids.has(entry[0])) return null
    ids.add(entry[0])
  }
  return value as unknown as Index
}
function navigationOf(state: Navigation): Navigation { return { activeConversationId: state.activeConversationId, view: state.view, preferredModelId: state.preferredModelId } }
function metadataOf(state: Session): Navigation & Record<string, unknown> {
  const metadata = { ...state } as Navigation & Record<string, unknown>
  delete metadata.conversations
  return metadata
}
function isNavigation(value: unknown): value is Navigation & Record<string, unknown> {
  return isObject(value) && typeof value.view === 'string' &&
    (value.activeConversationId === null || typeof value.activeConversationId === 'string') &&
    (value.preferredModelId === null || typeof value.preferredModelId === 'string')
}
function legacyNavigation(value: Record<string, unknown>): Navigation | null {
  const nav = { activeConversationId: value.activeConversationId ?? null, view: value.view ?? 'chat', preferredModelId: value.preferredModelId ?? null }
  return isNavigation(nav) ? nav : null
}
function sameState(a: Session, b: Session): boolean {
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}
function sameHistory<S extends Session>(a: StorageValue<S>, b: StorageValue<S>): boolean {
  if (a.version !== b.version || a.state.conversations !== b.state.conversations) return false
  const left = a.state as unknown as Record<string, unknown>
  const right = b.state as unknown as Record<string, unknown>
  const nav = new Set(['activeConversationId', 'view', 'preferredModelId'])
  const keys = Object.keys(left).filter((key) => !nav.has(key))
  return keys.length === Object.keys(right).filter((key) => !nav.has(key)).length && keys.every((key) => left[key] === right[key])
}
