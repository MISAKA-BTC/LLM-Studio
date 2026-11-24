import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFrameBatch } from '../src/lib/frameBatch.ts'

test('tokens arriving in one frame publish one complete snapshot, including reasoning and the first-token time', () => {
  let frame: (() => void) | null = null
  const snapshots: unknown[] = []
  const batch = createFrameBatch<{ content: string; reasoning: string; answerStartedAt: number }>(
    (patch) => snapshots.push(patch),
    (callback) => {
      assert.equal(frame, null, 'only one frame is scheduled at a time')
      frame = callback
      return () => { frame = null }
    },
  )
  batch.push({ reasoning: 'Plan' })
  batch.push({ answerStartedAt: 42 })
  for (let i = 1; i <= 500; i++) batch.push({ content: 'x'.repeat(i) })
  assert.deepEqual(snapshots, [])
  assert.ok(frame)
  ;(frame as () => void)()
  assert.deepEqual(snapshots, [{ reasoning: 'Plan', answerStartedAt: 42, content: 'x'.repeat(500) }])
})

test('finishing or stopping before the next frame flushes the latest partial text and cancels the frame', () => {
  const snapshots: unknown[] = []
  let cancelled = 0
  const batch = createFrameBatch<{ content: string }>((patch) => snapshots.push(patch), () => () => { cancelled++ })
  batch.push({ content: 'partial' })
  batch.flush()
  batch.flush()
  assert.equal(cancelled, 1)
  assert.deepEqual(snapshots, [{ content: 'partial' }])
})
