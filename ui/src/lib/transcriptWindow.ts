/** A prefix-sum index with O(log n) height changes and offset lookups. */
export class TranscriptHeights {
  private readonly values: Float64Array
  private readonly tree: Float64Array

  constructor(heights: readonly number[]) {
    this.values = Float64Array.from(heights, (height) => Math.max(1, Number.isFinite(height) ? height : 120))
    this.tree = new Float64Array(heights.length + 1)
    for (let index = 1; index < this.tree.length; index++) {
      this.tree[index]! += this.values[index - 1]!
      const parent = index + (index & -index)
      if (parent < this.tree.length) this.tree[parent]! += this.tree[index]!
    }
  }

  get length(): number { return this.values.length }
  get total(): number { return this.top(this.length) }
  height(index: number): number { return this.values[index] ?? 0 }

  top(index: number): number {
    let result = 0
    for (let at = Math.max(0, Math.min(index, this.length)); at > 0; at -= at & -at) result += this.tree[at]!
    return result
  }

  measure(index: number, height: number): number {
    if (index < 0 || index >= this.length || !Number.isFinite(height) || height <= 0) return 0
    const delta = height - this.values[index]!
    if (Math.abs(delta) < 0.5) return 0
    this.values[index] = height
    for (let at = index + 1; at < this.tree.length; at += at & -at) this.tree[at]! += delta
    return delta
  }

  /** The row containing this offset; exact boundaries belong to the next row. */
  indexAt(offset: number): number {
    if (this.length === 0) return 0
    let index = 0
    let sum = 0
    let step = 1
    while (step * 2 <= this.length) step *= 2
    const target = Math.max(0, offset)
    for (; step > 0; step = Math.floor(step / 2)) {
      const next = index + step
      if (next <= this.length && sum + this.tree[next]! <= target) {
        index = next
        sum += this.tree[next]!
      }
    }
    return Math.min(index, this.length - 1)
  }
}

/** End is exclusive. Every row stays reachable through the full-height scroll spacer. */
export function transcriptWindow(heights: TranscriptHeights, top: number, viewport: number, overscan = 500): { start: number; end: number } {
  if (heights.length === 0) return { start: 0, end: 0 }
  const start = heights.indexAt(Math.max(0, top - overscan))
  const end = heights.indexAt(Math.max(0, top) + Math.max(1, viewport) + overscan) + 1
  return { start, end: Math.min(heights.length, Math.max(start + 1, end)) }
}

export type TranscriptAnchor = { index: number; offset: number }

export function captureTranscriptAnchor(heights: TranscriptHeights, top: number): TranscriptAnchor {
  const index = heights.indexAt(top)
  return { index, offset: Math.max(0, top - heights.top(index)) }
}

/** Used after measured heights change above the viewport, keeping the same text in view. */
export function anchoredTranscriptTop(heights: TranscriptHeights, anchor: TranscriptAnchor): number {
  return heights.top(anchor.index) + anchor.offset
}
