import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanDisplayName, entryCapabilities, extractLeadSummary, prepareReadmeMarkdown } from '../src/lib/catalogPresentation.ts'

test('prepareReadmeMarkdown converts HTML img tags and centered hero wrappers into Markdown images while preserving code fences', () => {
  const raw = [
    '# Inkling 2 Mini',
    '<p align="center">',
    '  <img src="https://cdn-uploads.huggingface.co/production/uploads/example/logo.png" alt="Thinking Machines" style="width: 30%;">',
    '</p>',
    '',
    '```html',
    '<img src="https://do-not-touch.example/inside-code.png" />',
    '```',
  ].join('\n')

  const prepared = prepareReadmeMarkdown(raw)
  assert.match(prepared, /!\[Thinking Machines]\(https:\/\/cdn-uploads\.huggingface\.co\/production\/uploads\/example\/logo\.png\)/)
  assert.doesNotMatch(prepared, /<p align="center">/)
  assert.match(prepared, /<img src="https:\/\/do-not-touch\.example\/inside-code\.png" \/>/)
})

test('extractLeadSummary skips HTML banners and headings to return the lead model description', () => {
  const readme = [
    '# Inkling 2 Mini',
    '',
    '<img src="https://cdn-uploads.huggingface.co/logo.png" style="width: 30%;">',
    '',
    '## 1. General Information',
    '',
    'Inkling 2 Mini is an open-weight multimodal mixture-of-experts model with 26.4B total parameters, 3.4B active parameters, and up to 1M context.',
  ].join('\n')

  assert.equal(
    extractLeadSummary(readme),
    'Inkling 2 Mini is an open-weight multimodal mixture-of-experts model with 26.4B total parameters, 3.4B active parameters, and up to 1M context.',
  )
})

test('cleanDisplayName and entryCapabilities normalize quantized repo names and capability badges', () => {
  assert.equal(cleanDisplayName('lmstudio-community/Inkling-2-Mini-GGUF', 'thinkingmachines/Inkling-2-Mini'), 'Inkling 2 Mini')
  assert.equal(cleanDisplayName('google/gemma-4-12b-qat-GGUF'), 'gemma 4 12b qat')

  const caps = entryCapabilities({
    id: 'lmstudio-community/Inkling-2-Mini-GGUF',
    downloads: 31613,
    likes: 8,
    tags: ['gguf'],
    last_modified: null,
    gated: false,
    pipeline_tag: 'image-text-to-text',
    capabilities: ['vision', 'tools', 'reasoning'],
  })
  assert.deepEqual(caps, ['vision', 'tools', 'reasoning'])
})
