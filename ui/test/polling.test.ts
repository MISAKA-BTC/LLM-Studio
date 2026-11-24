import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPollingResource, type PollClock } from '../src/lib/polling.ts'

function clock() {
  let now = 100_000
  let id = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const time: PollClock = {
    now: () => now,
    set: (run, ms) => { timers.set(++id, { at: now + ms, run }); return id },
    clear: (id) => { timers.delete(id as number) },
  }
  return { time, timers, advance(ms: number) {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run() }
  } }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture() {
  const time = clock()
  const requests: { signal: AbortSignal; resolve: (value: string) => void; reject: (error: Error) => void }[] = []
  const resource = createPollingResource((signal) => new Promise<string>((resolve, reject) => requests.push({ signal, resolve, reject })), time.time)
  return { ...time, requests, resource }
}

test('100 consumers share one status request and one timer at the fastest visible cadence', async () => {
  const f = fixture()
  const release = Array.from({ length: 100 }, (_, i) => f.resource.watch(i === 99 ? 1000 : 5000))
  await flush()
  assert.equal(f.requests.length, 1)
  f.requests[0]!.resolve('ready')
  await flush()
  assert.equal(f.timers.size, 1)
  f.advance(999); await flush()
  assert.equal(f.requests.length, 1)
  f.advance(1); await flush()
  assert.equal(f.requests.length, 2)
  release.forEach((done) => done())
  assert.equal(f.requests[1]!.signal.aborted, true)
  assert.equal(f.timers.size, 0)
})

test('a slow read never accumulates interval work, and the next cadence starts after completion', async () => {
  const f = fixture()
  const release = f.resource.watch(1000)
  await flush()
  for (let i = 0; i < 20; i++) { f.advance(1000); await flush() }
  assert.equal(f.requests.length, 1)
  assert.equal(f.timers.size, 0)
  f.requests[0]!.resolve('done'); await flush()
  f.advance(999); await flush()
  assert.equal(f.requests.length, 1)
  f.advance(1); await flush()
  assert.equal(f.requests.length, 2)
  release()
})

test('refreshes after mutations collapse to one trailing read and discard the older response', async () => {
  const f = fixture()
  const release = f.resource.watch(1000)
  await flush()
  const refreshes = Array.from({ length: 100 }, () => f.resource.refresh())
  assert.ok(refreshes.every((promise) => promise === refreshes[0]))
  f.requests[0]!.resolve('before mutation'); await flush()
  assert.equal(f.requests.length, 2)
  assert.equal(f.resource.getSnapshot().value, null)
  f.requests[1]!.resolve('after mutation')
  assert.deepEqual(await Promise.all(refreshes), Array(100).fill('after mutation'))
  assert.equal(f.resource.getSnapshot().value, 'after mutation')
  release()
})

test('hiding cancels work and resolves waiting refreshes even when a transport ignores abort', async () => {
  const f = fixture()
  const release = f.resource.watch(1000)
  await flush()
  const refresh = f.resource.refresh()
  f.resource.setVisible(false)
  assert.equal(await refresh, null)
  assert.equal(f.requests[0]!.signal.aborted, true)
  f.advance(50_000); await flush()
  assert.equal(f.requests.length, 1)
  f.resource.setVisible(true); f.resource.setVisible(true); await flush()
  assert.equal(f.requests.length, 2)
  f.requests[1]!.resolve('new'); await flush()
  f.requests[0]!.resolve('late old'); await flush()
  assert.equal(f.resource.getSnapshot().value, 'new')
  release()
})

test('the last lease aborts an active manual refresh and releasing an earlier lease does not', async () => {
  const f = fixture()
  const one = f.resource.watch(1000)
  const two = f.resource.watch(2000)
  await flush()
  one()
  assert.equal(f.requests[0]!.signal.aborted, false)
  two()
  assert.equal(f.requests[0]!.signal.aborted, true)
  const manual = f.resource.refresh()
  await flush()
  f.resource.setVisible(false)
  assert.equal(await manual, null)
})

test('a failed read preserves the last successful value and retries at the normal interval', async () => {
  const f = fixture()
  const release = f.resource.watch(1000)
  await flush()
  f.requests[0]!.resolve('retained'); await flush()
  f.advance(1000); await flush()
  f.requests[1]!.reject(new Error('offline')); await flush()
  assert.equal(f.resource.getSnapshot().value, 'retained')
  assert.match(String(f.resource.getSnapshot().error), /offline/)
  assert.equal(f.requests.length, 2)
  f.advance(1000); await flush()
  assert.equal(f.requests.length, 3)
  f.requests[2]!.resolve('online'); await flush()
  assert.equal(f.resource.getSnapshot().error, null)
  release()
})

test('dynamic cadence changes reuse the timer and completion events bring a later poll forward', async () => {
  const f = fixture()
  let interval = 15_000
  const release = f.resource.watch(() => interval)
  await flush()
  f.requests[0]!.resolve('idle'); await flush()
  interval = 5000
  f.resource.reschedule()
  assert.equal(f.timers.size, 1)
  f.advance(4000); await flush()
  f.resource.soon(100)
  f.advance(100); await flush()
  assert.equal(f.requests.length, 2)
  release()
})

test('a subscriber can request a fresh read during publication without receiving a placeholder promise', async () => {
  const f = fixture()
  let requested = false
  let waiting: Promise<string | null> | null = null
  const unsubscribe = f.resource.subscribe(() => {
    if (f.resource.getSnapshot().reading && !requested) { requested = true; waiting = f.resource.refresh() }
  })
  const release = f.resource.watch(1000)
  await flush()
  f.requests[0]!.resolve('old'); await flush()
  f.requests[1]!.resolve('latest')
  assert.equal(await waiting, 'latest')
  unsubscribe(); release()
})
