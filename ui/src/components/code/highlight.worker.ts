// Parsing a source file can occupy the UI thread for tens of milliseconds. Keep both the
// grammars and parsing in a worker, so switching a panel never waits for syntax colours.
import hljs from 'highlight.js/lib/common'

self.onmessage = (event: MessageEvent<{ id: number; text: string; language: string }>) => {
  const { id, text, language } = event.data
  try {
    // An unlabelled completed chat fence may be detected here. Streaming never submits that
    // work, and neither detection nor the common grammar bundle runs on the UI thread.
    const html = language === '' ? hljs.highlightAuto(text).value : hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : null
    self.postMessage({ id, html })
  } catch {
    self.postMessage({ id, html: null })
  }
}
