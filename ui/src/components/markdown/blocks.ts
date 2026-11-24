import type { Root } from 'hast'
import type { MarkdownDocument } from './types'

// Compare in the worker, where serialising a long code block cannot hold a UI event. Stable block
// ids let the UI reuse unchanged top-level React subtrees even while the last block is growing.
export function createBlockEncoder() {
  let nextId = 0
  let retainedWeight = 0
  const previous = new Map<string, { encoded: string[]; ids: number[]; weight: number }>()
  const MAX_OWNERS = 32
  const MAX_CHARS = 4_000_000

  const release = (owner: string) => {
    const old = previous.get(owner)
    if (old) retainedWeight -= old.weight
    previous.delete(owner)
  }

  return {
    encode(owner: string, tree: Root, math: boolean): MarkdownDocument {
      const before = previous.get(owner)
      const encoded = tree.children.map((node) => JSON.stringify(node))
      const ids = encoded.map((value, index) => before?.encoded[index] === value ? before.ids[index]! : nextId++)
      const weight = encoded.reduce((sum, value) => sum + value.length, 0)
      release(owner)
      previous.set(owner, { encoded, ids, weight })
      retainedWeight += weight
      while (previous.size > MAX_OWNERS || retainedWeight > MAX_CHARS) release(previous.keys().next().value!)
      return { blocks: tree.children.map((node, index) => ({ id: ids[index]!, tree: { type: 'root', children: [node] } })), math, weight }
    },
    release,
  }
}
