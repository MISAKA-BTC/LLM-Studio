import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TranscriptHeights, transcriptWindow, captureTranscriptAnchor, anchoredTranscriptTop } from '../src/lib/transcriptWindow.ts'

test('a 10,000-message conversation mounts only its viewport and overscan, including the very first and last messages', () => {
  const heights = new TranscriptHeights(Array(10_000).fill(100))
  const first = transcriptWindow(heights, 0, 600)
  const middle = transcriptWindow(heights, 500_025, 600)
  const last = transcriptWindow(heights, heights.total - 600, 600)
  assert.equal(first.start, 0)
  assert.ok(middle.start <= 5000 && middle.end > 5006)
  assert.equal(last.end, 10_000)
  for (const range of [first, middle, last]) assert.ok(range.end - range.start <= 18)
  assert.equal(heights.total, 1_000_000)
})

test('variable-height boundaries and end offsets resolve to the correct message', () => {
  const heights = new TranscriptHeights([40, 200, 80, 1000])
  assert.deepEqual([-5, 0, 39, 40, 239, 240, 319, 320, 99999].map((top) => heights.indexAt(top)), [0, 0, 0, 1, 1, 2, 2, 3, 3])
  assert.deepEqual([0, 1, 2, 3, 4].map((index) => heights.top(index)), [0, 40, 240, 320, 1320])
})

test('measuring earlier rows preserves the visible message and its offset instead of jumping the reader', () => {
  const heights = new TranscriptHeights([100, 100, 100, 100])
  const anchor = captureTranscriptAnchor(heights, 225)
  assert.deepEqual(anchor, { index: 2, offset: 25 })
  heights.measure(0, 340)
  heights.measure(1, 60)
  assert.equal(anchoredTranscriptTop(heights, anchor), 425)
  assert.equal(heights.indexAt(425), 2)
  heights.measure(3, 2000)
  assert.equal(anchoredTranscriptTop(heights, anchor), 425, 'stream growth below the reader does not move their anchor')
})

test('repeated live-row measurements update total height without changing preceding offsets', () => {
  const heights = new TranscriptHeights(Array(5000).fill(80))
  for (let size = 100; size <= 2000; size += 20) heights.measure(4999, size)
  assert.equal(heights.top(4999), 4999 * 80)
  assert.equal(heights.total, 4999 * 80 + 2000)
  assert.equal(heights.measure(4999, 2000), 0)
})

test('empty, invalid and temporarily hidden measurements keep a usable index', () => {
  const empty = new TranscriptHeights([])
  assert.deepEqual(transcriptWindow(empty, 0, 0), { start: 0, end: 0 })
  const heights = new TranscriptHeights([100, 200])
  for (const bad of [0, -1, Infinity, NaN]) assert.equal(heights.measure(0, bad), 0)
  assert.equal(heights.total, 300)
  assert.equal(heights.measure(10, 300), 0)
})
