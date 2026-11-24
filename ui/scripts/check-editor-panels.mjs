import assert from 'node:assert/strict'

// Used by test-workbench.mjs. These are real React panels under Activity with a mocked runtime;
// the synthetic dimensions test state/focus invariants, not browser paint or latency.
export async function checkEditorPanels(ctx) {
  const { act, check, change, flush, visible, findVisible, window, document, useStudio, useUi, useFiles, selectFile, useCodeUi, fixtures, requests, go } = ctx
  const studio = useStudio.getState()
  const savedStudio = { conversations: studio.conversations, activeConversationId: studio.activeConversationId, view: studio.view }
  const ui = useUi.getState()
  const savedUi = { appMode: ui.appMode, rightPanel: ui.rightPanel, lastThread: ui.lastThread }
  const introduced = useCodeUi.getState().introduced
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  if (!globalThis.CSS) Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') } })
  const code = (id, workspace) => ({ id, title: id, mode: 'agent', workspace, createdAt: 1, updatedAt: 1, modelId: null, messages: [] })
  const a = code('editor-project-a', '/fixture/project-a')
  const b = code('editor-project-b', '/fixture/project-b')
  const path = 'file0000.ts'
  const entries = Array.from({ length: 5000 }, (_, index) => ({ path: `file${String(index).padStart(4, '0')}.ts`, is_dir: false, size: 100 }))
  const body = (options) => JSON.parse(options.body || '{}')
  const addedFixtures = {
    '/api/v1/workspace/open': (_url, options) => { const { root } = body(options); return { root, name: root.split('/').pop(), is_git: false, branch: null } },
    '/api/v1/workspace/browse': { path: '/fixture', parent: '/', home: '/fixture', entries: [] },
    '/api/v1/workspace/tree': (_url, options) => ({ ...body(options), entries, truncated: false }),
    '/api/v1/workspace/files': { paths: entries.map((entry) => entry.path) },
    '/api/v1/workspace/read': (_url, options) => {
      const { root, path } = body(options)
      const content = `// ${root}/${path}\n${'const value = 42\n'.repeat(100)}`
      return { path, content, size: content.length, binary: false, truncated: false, total_lines: 101, start_line: 1, end_line: 101 }
    },
    '/api/v1/workspace/git/status': (_url, options) => ({ root: body(options).root, is_git: false, branch: null, files: [], staged: 0, unstaged: 0, untracked: 0, truncated: false }),
  }
  const previousFixtures = new Map(Object.keys(addedFixtures).map((key) => [key, fixtures[key]]))
  Object.assign(fixtures, addedFixtures)
  const select = async (thread) => {
    await act(async () => useStudio.getState().selectConversation(thread.id))
    await flush()
  }
  const panel = async (name) => {
    await act(async () => useUi.getState().setRightPanel(name))
    await flush()
  }
  const contents = () => findVisible(`[aria-label="Contents of ${path}"]`)
  const terminalInput = () => findVisible('input[aria-label^="Command to run in"]')

  try {
    await act(async () => {
      useCodeUi.setState({ introduced: true })
      useStudio.setState({ conversations: [...savedStudio.conversations, a, b] })
    })
    await go('chat')
    await select(a)
    await panel('files')

    await check('Files renders only the visible rows of a 5000-entry folder and supports End/Home', async () => {
      const tree = findVisible('[role="tree"]')
      assert.ok(tree)
      Object.defineProperty(tree, 'clientHeight', { configurable: true, value: 560 })
      await act(async () => tree.dispatchEvent(new window.Event('scroll', { bubbles: true })))
      const rows = () => [...tree.querySelectorAll('[role="treeitem"]')].filter(visible)
      assert.ok(rows().length > 0 && rows().length < 40, `Rendered ${rows().length} entries`)
      const first = rows()[0]
      assert.equal(first.getAttribute('aria-setsize'), '5000')
      await act(async () => {
        first.focus()
        first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      })
      assert.equal(document.activeElement.dataset.treeRow, 'file4999.ts')
      assert.equal(document.activeElement.getAttribute('aria-posinset'), '5000')
      assert.ok(rows().length < 40)
      await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
      assert.equal(document.activeElement.dataset.treeRow, 'file0000.ts')
      assert.equal(tree.scrollTop, 0)
    })

    await check('file previews retain their DOM and reading position across panel switches without rereading', async () => {
      await act(async () => selectFile(a.workspace, path))
      await flush()
      const viewer = contents()
      assert.ok(viewer)
      assert.match(viewer.textContent, /\/fixture\/project-a\/file0000.ts/)
      viewer.scrollTop = 340
      viewer.scrollLeft = 25
      const readCount = requests.filter((request) => request.pathname === '/api/v1/workspace/read').length
      await panel('terminal')
      assert.equal(visible(viewer), false)
      await panel('files')
      assert.ok(contents() === viewer, 'The file preview keeps the same DOM node')
      assert.equal(viewer.scrollTop, 340)
      assert.equal(viewer.scrollLeft, 25)
      assert.equal(requests.filter((request) => request.pathname === '/api/v1/workspace/read').length, readCount)
      assert.match(viewer.querySelector('pre:last-child').textContent, /const value = 42/, 'Plain text remains visible when Worker is unavailable')
    })

    await check('the same file path in two projects never displays bytes from the other project', async () => {
      await select(b)
      await panel('files')
      await act(async () => selectFile(b.workspace, path))
      await flush()
      assert.match(contents().textContent, /\/fixture\/project-b\/file0000.ts/)
      assert.doesNotMatch(contents().textContent, /\/fixture\/project-a\/file0000.ts/)
      await select(a)
      await panel('files')
      assert.match(contents().textContent, /\/fixture\/project-a\/file0000.ts/)
      assert.doesNotMatch(contents().textContent, /\/fixture\/project-b\/file0000.ts/)
      assert.equal(contents().scrollTop, 340)
    })

    await check('Terminal keeps an unsent command and reading position through tab, close and Chat/Code switches', async () => {
      await panel('terminal')
      const input = terminalInput()
      await change(input, 'npm run build -- --watch')
      const log = findVisible('[role="log"][aria-label="Terminal output"]')
      assert.ok(log)
      Object.defineProperties(log, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 500 } })
      await act(async () => {
        log.scrollTop = 320
        log.dispatchEvent(new window.Event('scroll', { bubbles: true }))
      })
      await panel('files')
      await panel('terminal')
      assert.ok(terminalInput() === input, 'The terminal keeps the same input across tabs')
      assert.equal(input.value, 'npm run build -- --watch')
      assert.equal(log.scrollTop, 320)
      await panel(null)
      assert.equal(visible(input), false)
      await panel('terminal')
      assert.ok(terminalInput() === input, 'Closing the panel retains its terminal input')
      assert.equal(input.value, 'npm run build -- --watch')
      assert.equal(log.scrollTop, 320)
      const chat = savedStudio.conversations.find((conversation) => conversation.mode !== 'agent')
      assert.ok(chat)
      await select(chat)
      assert.equal(visible(input), false)
      await select(a)
      await panel('terminal')
      assert.ok(terminalInput() === input, 'Chat/Code switching retains the terminal input')
      assert.equal(input.value, 'npm run build -- --watch')
      assert.equal(log.scrollTop, 320)
    })

    await check('Terminal drafts stay with their project and no command runs when a panel is restored', async () => {
      await select(b)
      await panel('terminal')
      assert.equal(terminalInput().value, '')
      await change(terminalInput(), 'cargo test')
      await select(a)
      await panel('terminal')
      assert.equal(terminalInput().value, 'npm run build -- --watch')
      await select(b)
      await panel('terminal')
      assert.equal(terminalInput().value, 'cargo test')
      assert.equal(requests.filter((request) => /workspace\/exec/.test(request.pathname)).length, 0)
      assert.equal(useFiles.getState().byRoot[a.workspace].selected, path)
    })
  } finally {
    await act(async () => {
      useStudio.setState(savedStudio)
      useUi.setState(savedUi)
      useCodeUi.setState({ introduced })
    })
    await flush()
    for (const [key, value] of previousFixtures) {
      if (value === undefined) delete fixtures[key]
      else fixtures[key] = value
    }
    if (originalCss) Object.defineProperty(globalThis, 'CSS', originalCss)
    else Reflect.deleteProperty(globalThis, 'CSS')
  }
}
