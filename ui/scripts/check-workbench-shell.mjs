import assert from 'node:assert/strict'

// Real shell behavior, not snapshots of the implementation. No runtime process or commands run.
export async function checkWorkbenchShell(ctx) {
  const { act, check, change, flush, visible, findVisible, window, document, useStudio, useUi, useComposer, useWorkbench, closeTab, cycleTab, activateTab, fixtures, go } = ctx
  const studio = useStudio.getState()
  const savedStudio = { conversations: studio.conversations, activeConversationId: studio.activeConversationId, view: studio.view }
  const ui = useUi.getState()
  const savedUi = { appMode: ui.appMode, sidebarOpen: ui.sidebarOpen, sidebarWidth: ui.sidebarWidth, rightPanel: ui.rightPanel, lastThread: ui.lastThread }
  const savedTabs = { tabs: useWorkbench.getState().tabs, activeKey: useWorkbench.getState().activeKey }
  const fixture = (index) => ({ id: `shell-${index}`, title: `Shell thread ${String(index).padStart(4, '0')}`, mode: 'chat', createdAt: 1, updatedAt: 10000 - index, modelId: null, messages: [] })
  const a = fixture(0), b = fixture(1)
  const key = async (options, target = window) => act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options })))
  try {
    await act(async () => {
      useStudio.setState({ conversations: [...savedStudio.conversations, a, b], view: 'chat', activeConversationId: a.id })
      useUi.setState({ sidebarOpen: true, rightPanel: null })
    })
    await flush()

    await check('open tabs switch conversations and close without deleting history or drafts', async () => {
      await change(findVisible('textarea[aria-label="Message"]'), 'Keep a tab draft')
      await act(async () => useStudio.getState().selectConversation(b.id))
      await go('models')
      assert.ok(useWorkbench.getState().tabs.some((t) => t.key === `thread:${a.id}`))
      assert.ok(useWorkbench.getState().tabs.some((t) => t.key === `thread:${b.id}`))
      const tab = [...document.querySelectorAll('[role="tablist"][aria-label="Open tabs"] [role="tab"]')].find((e) => e.textContent === a.title)
      if (tab) await act(async () => tab.click())
      else await act(async () => activateTab({ key: `thread:${a.id}`, kind: 'thread', id: a.id }))
      assert.equal(useStudio.getState().activeConversationId, a.id)
      assert.equal(findVisible('textarea[aria-label="Message"]').value, 'Keep a tab draft')
      const history = useStudio.getState().conversations
      await act(async () => closeTab(`thread:${a.id}`))
      assert.strictEqual(useStudio.getState().conversations, history)
      assert.equal(useComposer.getState().drafts[a.id].text, 'Keep a tab draft')
      assert.ok(!useWorkbench.getState().tabs.some((t) => t.key === `thread:${a.id}`))
      const active = useWorkbench.getState().activeKey
      await act(async () => cycleTab(1))
      assert.notEqual(useWorkbench.getState().activeKey, active)
      await act(async () => cycleTab(-1))
      assert.equal(useWorkbench.getState().activeKey, active)
    })

    await check('Activity bar stays mounted while sidebar scroll and keyboard resizing are retained', async () => {
      await go('chat')
      const rail = document.querySelector('aside[aria-label="Activity bar"]')
      const list = findVisible('[data-virtual-sidebar="Conversations"]')
      list.scrollTop = 64
      const resize = findVisible('[role="separator"][aria-label="Resize sidebar"]')
      await key({ key: 'End' }, resize)
      assert.equal(useUi.getState().sidebarWidth, 420)
      await key({ key: 'Home' }, resize)
      assert.equal(useUi.getState().sidebarWidth, 200)
      await act(async () => useUi.getState().setSidebarOpen(false))
      assert.ok(visible(rail))
      assert.ok(!visible(list))
      await act(async () => useUi.getState().setSidebarOpen(true))
      assert.strictEqual(findVisible('[data-virtual-sidebar="Conversations"]'), list)
      assert.strictEqual(document.querySelector('aside[aria-label="Activity bar"]'), rail)
      assert.equal(list.scrollTop, 64)
    })

    await check('TitleBar layout toggles never switch out of Chat or hide the active chat conversation', async () => {
      await act(async () => {
        useStudio.setState({ view: 'chat', activeConversationId: a.id })
        useUi.setState({ appMode: 'chat', sidebarOpen: true, bottomPanelOpen: false, rightPanel: null })
      })
      await flush()
      const header = document.querySelector('header[aria-label="Workbench title bar"]')
      assert.ok(header)
      const leftBtn = header.querySelector('button[aria-label*="Primary Side Bar"]')
      const bottomBtn = header.querySelector('button[aria-label*="Bottom Panel"]')
      const rightBtn = header.querySelector('button[aria-label*="Secondary Side Bar"]')
      assert.ok(leftBtn && bottomBtn && rightBtn)

      // Toggle Left Sidebar off and back on — chat stays visible
      await act(async () => leftBtn.click())
      assert.equal(useUi.getState().sidebarOpen, false)
      assert.equal(useUi.getState().appMode, 'chat')
      assert.equal(useStudio.getState().activeConversationId, a.id)
      assert.ok(findVisible('textarea[aria-label="Message"]'))
      await act(async () => leftBtn.click())
      assert.equal(useUi.getState().sidebarOpen, true)

      // Toggle Bottom Panel on and off — chat stays visible, appMode stays 'chat', activeConversationId stays a.id
      await act(async () => bottomBtn.click())
      assert.equal(useUi.getState().bottomPanelOpen, true)
      assert.equal(useUi.getState().appMode, 'chat')
      assert.equal(useStudio.getState().activeConversationId, a.id)
      assert.ok(findVisible('textarea[aria-label="Message"]'))
      assert.ok(findVisible('section[aria-label="Workbench bottom panel"]'))
      await act(async () => bottomBtn.click())
      assert.equal(useUi.getState().bottomPanelOpen, false)
      assert.equal(useUi.getState().appMode, 'chat')
      assert.equal(useStudio.getState().activeConversationId, a.id)
      assert.ok(findVisible('textarea[aria-label="Message"]'))

      // Toggle Right Secondary Side Bar on and off — chat stays visible
      await act(async () => rightBtn.click())
      assert.equal(useUi.getState().rightPanel, 'context')
      assert.equal(useUi.getState().appMode, 'chat')
      assert.equal(useStudio.getState().activeConversationId, a.id)
      assert.ok(findVisible('textarea[aria-label="Message"]'))
      await act(async () => rightBtn.click())
      assert.equal(useUi.getState().rightPanel, null)
      assert.ok(findVisible('textarea[aria-label="Message"]'))
    })

    await check('Image Studio renders full controls without installed weights and Agent composer renders top workspace/branch bar', async () => {
      await go('image')
      assert.ok(findVisible('textarea[placeholder*="Describe the image"]'), 'Image prompt form is visible even with zero installed image models')
      assert.ok(findVisible('input[placeholder*="author/model"]'), 'Diffusers checkpoint installer is visible')

      const agentSession = { ...fixture(7777), mode: 'agent', workspace: '/fixture/gemini-bar-project' }
      const prevOpen = fixtures['/api/v1/workspace/open']
      const prevStatus = fixtures['/api/v1/workspace/git/status']
      const prevBrowse = fixtures['/api/v1/workspace/browse']
      fixtures['/api/v1/workspace/open'] = { root: agentSession.workspace, name: 'gemini-bar-project', is_git: true, branch: 'main' }
      fixtures['/api/v1/workspace/git/status'] = { root: agentSession.workspace, is_git: true, branch: 'main', head: 'abc1234', upstream: null, ahead: 0, behind: 0, files: [], staged: 0, unstaged: 0, untracked: 0 }
      fixtures['/api/v1/workspace/browse'] = { path: '/fixture', parent: '/', home: '/fixture', entries: [] }
      try {
        await act(async () => {
          useStudio.setState({ conversations: [...useStudio.getState().conversations, agentSession], activeConversationId: agentSession.id, view: 'chat' })
          useUi.setState({ appMode: 'code' })
        })
        await flush()
        const contextBar = findVisible('[role="toolbar"][aria-label="Workspace and branch context"]')
        assert.ok(contextBar, 'Gemini-style top context bar is rendered above the Agent composer')
        assert.match(contextBar.textContent, /This Computer/)
        assert.match(contextBar.textContent, /gemini-bar-project/)
        assert.match(contextBar.textContent, /main/)
        assert.ok(findVisible('button[title^="Execution mode: Turbo"]'), 'Turbo execution mode picker is rendered on composer bottom-right')
        assert.ok(findVisible('button[aria-label="Voice dictation"]'), 'Voice dictation mic button is rendered')
        assert.ok(findVisible('button[aria-label="Send"]'), 'Circular Send button is rendered')

        // Open Project dropdown and verify New Project + No Project items, then open Create Project modal
        const folderTrigger = findVisible('button[aria-label^="Workspace folder:"]')
        await act(async () => folderTrigger.click())
        const newProjectBtn = [...document.querySelectorAll('button')].find((b) => visible(b) && b.textContent.trim() === 'New Project')
        const noProjectBtn = [...document.querySelectorAll('button')].find((b) => visible(b) && b.textContent.trim() === 'No Project')
        assert.ok(newProjectBtn && noProjectBtn, 'Project menu shows New Project and No Project')
        await act(async () => newProjectBtn.click())
        const dialog = findVisible('[role="dialog"][aria-label="Create Project"]')
        assert.ok(dialog, 'Create Project dialog opens')
        assert.match(dialog.textContent, /This Computer/)
        assert.match(dialog.textContent, /Remote/)
        assert.match(dialog.textContent, /Select Folder\(s\)/)
        assert.match(dialog.textContent, /Add Folder/)
        const skipBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')
        assert.ok(skipBtn, 'Skip button is present in Create Project dialog')
        await act(async () => skipBtn.click())
        assert.equal(useUi.getState().workspacePicker, null)
        await act(async () => useUi.getState().setNoProject(false))
      } finally {
        if (prevOpen === undefined) delete fixtures['/api/v1/workspace/open']; else fixtures['/api/v1/workspace/open'] = prevOpen
        if (prevStatus === undefined) delete fixtures['/api/v1/workspace/git/status']; else fixtures['/api/v1/workspace/git/status'] = prevStatus
        if (prevBrowse === undefined) delete fixtures['/api/v1/workspace/browse']; else fixtures['/api/v1/workspace/browse'] = prevBrowse
        await act(async () => {
          useStudio.setState({ conversations: useStudio.getState().conversations.filter((c) => c.id !== agentSession.id), activeConversationId: a.id, view: 'chat' })
          useUi.setState({ appMode: 'chat' })
        })
        await flush()
      }
    })

    await check('5000 conversation sidebar mounts one window and keyboard End/Home reaches the entire archive', async () => {
      const archive = Array.from({ length: 5000 }, (_, index) => fixture(index))
      await act(async () => useStudio.setState({ conversations: archive, activeConversationId: archive[0].id, view: 'chat' }))
      await flush()
      const list = findVisible('[data-virtual-sidebar="Conversations"]')
      const rows = () => [...list.querySelectorAll('[data-thread-row]')].filter(visible)
      assert.ok(rows().length > 0 && rows().length <= 32, `Mounted ${rows().length} of 5000 threads`)
      const first = rows().find((r) => r.title === archive[0].title)
      assert.ok(first)
      await act(async () => first.focus())
      await key({ key: 'End' }, first)
      assert.equal(document.activeElement.title, archive.at(-1).title)
      assert.ok(rows().length <= 33, `Mounted ${rows().length} rows after End`)
      await key({ key: 'Home' }, document.activeElement)
      assert.equal(document.activeElement.title, archive[0].title)
    })

    await check('Quick Open searches titles, honors IME and opens by Enter without scanning message bodies', async () => {
      await key({ key: 'p', code: 'KeyP', ctrlKey: true, isComposing: true })
      assert.equal(useUi.getState().quickOpen, false)
      await key({ key: 'p', code: 'KeyP', ctrlKey: true })
      assert.equal(useUi.getState().quickOpen, true)
      const input = findVisible('[role="combobox"][aria-label="Search files and conversations"]')
      assert.ok(input)
      await change(input, 'Shell thread 4999')
      const results = [...document.querySelectorAll('#quick-open-results [role="option"]')]
      assert.equal(results.length, 1)
      await key({ key: 'Enter', isComposing: true }, input)
      assert.equal(useUi.getState().quickOpen, true)
      await key({ key: 'Enter' }, input)
      assert.equal(useStudio.getState().activeConversationId, 'shell-4999')
      assert.equal(useUi.getState().quickOpen, false)
    })

    await check('tab bookkeeping stays bounded and deleting history removes its tab', async () => {
      for (let index = 0; index < 25; index++) await act(async () => useStudio.getState().selectConversation(`shell-${index}`))
      assert.ok(useWorkbench.getState().tabs.length <= 16)
      await act(async () => useStudio.getState().deleteConversation('shell-20'))
      assert.ok(!useWorkbench.getState().tabs.some((t) => t.key === 'thread:shell-20'))
      assert.equal(useStudio.getState().conversations.length, 4999)
    })

    await check('Quick Open file requests discard a stale response after the query changes', async () => {
      const code = { ...fixture(6000), mode: 'agent', workspace: '/fixture/quick-open-project' }
      const previous = new Map()
      let resolveOld
      const additions = {
        '/api/v1/workspace/open': { root: code.workspace, name: 'quick-open-project', is_git: false, branch: null },
        '/api/v1/workspace/git/status': { root: code.workspace, is_git: false, branch: null, files: [], staged: 0, unstaged: 0, untracked: 0 },
        '/api/v1/workspace/files': (_url, options) => {
          const { query } = JSON.parse(options.body)
          if (query === 'old') return new Promise((resolve) => { resolveOld = resolve })
          return { paths: query === 'new' ? ['src/new.ts'] : [] }
        },
      }
      for (const name of Object.keys(additions)) previous.set(name, fixtures[name])
      Object.assign(fixtures, additions)
      try {
        await act(async () => useStudio.setState({ conversations: [...useStudio.getState().conversations, code], activeConversationId: code.id, view: 'chat' }))
        await act(async () => useUi.getState().setQuickOpen(true))
        const input = findVisible('[role="combobox"][aria-label="Search files and conversations"]')
        await change(input, 'old')
        await act(async () => new Promise((resolve) => setTimeout(resolve, 140)))
        assert.ok(resolveOld, 'The first request started')
        await change(input, 'new')
        await act(async () => new Promise((resolve) => setTimeout(resolve, 140)))
        assert.match(document.getElementById('quick-open-results').textContent, /new\.ts/)
        await act(async () => resolveOld({ paths: ['src/old.ts'] }))
        assert.doesNotMatch(document.getElementById('quick-open-results').textContent, /old\.ts/)
        await key({ key: 'Escape' }, input)
        assert.equal(useUi.getState().quickOpen, false)
      } finally {
        await act(async () => { useUi.getState().setQuickOpen(false); useStudio.setState(savedStudio) })
        for (const [name, value] of previous) { if (value === undefined) delete fixtures[name]; else fixtures[name] = value }
      }
    })
  } finally {
    await act(async () => {
      useUi.setState({ ...savedUi, quickOpen: false })
      useStudio.setState(savedStudio)
      useWorkbench.setState(savedTabs)
    })
    await flush()
  }
}
