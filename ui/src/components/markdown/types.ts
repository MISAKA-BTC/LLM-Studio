import type { Root } from 'hast'

export type MarkdownBlock = { id: number; tree: Root }
export type MarkdownDocument = { blocks: MarkdownBlock[]; math: boolean; weight: number }
export type MarkdownInput = { source: string; streaming: boolean }
export type ParseRequest = MarkdownInput & { id: number; owner: string }
export type ParseResponse = { id: number; document: MarkdownDocument | null }
