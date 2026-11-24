import assert from 'node:assert/strict'

// Actual App + Activity lifecycle, with read-only fixture endpoints. No mining/signing action runs.
export async function checkRuntimePolling({ act, check, flush, findVisible, window, document, fixtures, requests, go }) {
  const network = '/api/v1/network'
  const remote = `${network}/remote-miner`
  const seed = `${network}/model-market/seed-readiness`
  const log = `${remote}/log`
  const stack = `${network}/prompt-stack`
  const queue = `${network}/mining-queue`
  const paths = [network, remote, seed, stack, queue]
  const saved = Object.fromEntries([...paths, log].map((path) => [path, fixtures[path]]))
  const data = {
    [network]: { network: 'testnet12', public_nodes: [], classes: [] },
    [remote]: { running: false, exited: null, command_line: null, planned: { Err: 'Fixture: never runs commands' }, state_dir: '/fixture', facts: null, public_wrpc: [], label: 'Fixture' },
    [seed]: { line_id: null, from_address: null, seed_min_sompi: 0, spendable_sompi: null, short_by_sompi: null, already_seeded: null, blocked_because: 'Fixture: no transactions are enabled' },
  }
  const count = (path) => requests.filter((request) => request.pathname === path).length
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  let visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const show = async (next) => {
    visibility = next
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    await flush()
  }
  try {
    Object.assign(fixtures, data)
    await go('network')
    for (let i = 0; i < 4; i++) await flush()

    await check('Network panels and window chrome share each status request on visibility restore', async () => {
      assert.ok([...document.querySelectorAll('h3')].some((node) => node.textContent === 'Prompt mining — no node'))
      await show('hidden')
      const before = Object.fromEntries(paths.map((path) => [path, count(path)]))
      await show('visible')
      for (const path of paths) assert.equal(count(path) - before[path], 1, `one shared read for ${path}`)
    })

    await check('leaving Network aborts its pending reads and returning reconnects exactly once', async () => {
      await show('hidden')
      const pending = []
      for (const path of [network, remote, seed]) fixtures[path] = (_url, options) => new Promise((resolve) => pending.push({ path, signal: options.signal, resolve }))
      await show('visible')
      assert.equal(pending.length, 3)
      await go('chat')
      for (const read of pending) assert.equal(read.signal.aborted, true, read.path)
      await act(async () => { for (const read of pending) read.resolve(data[read.path]) })
      Object.assign(fixtures, data)
      const before = Object.fromEntries([network, remote, seed].map((path) => [path, count(path)]))
      await go('network')
      for (const path of [network, remote, seed]) assert.equal(count(path) - before[path], 1, `one resumed read for ${path}`)
      assert.ok(findVisible('h3'))
    })

    await check('remote status and Stop stay available while its log read stalls or fails', async () => {
      await show('hidden')
      fixtures[remote] = { ...data[remote], running: true, command_line: ['fixture: not executed'] }
      let rejectLog
      fixtures[log] = () => new Promise((_resolve, reject) => { rejectLog = reject })
      await show('visible')
      for (let i = 0; i < 3; i++) await flush()
      const stop = () => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Stop')
      assert.equal(typeof rejectLog, 'function', 'the log is pending')
      assert.ok(stop(), 'running status arrived without waiting for the log')
      assert.equal(stop().disabled, false)
      await act(async () => rejectLog(new Error('Fixture log unavailable')))
      await flush()
      assert.ok(stop(), 'log failure does not hide status controls')
      assert.equal(stop().disabled, false)
    })
    assert.equal(requests.filter((request) => /network\/(?:remote-miner|prompt-stack)\/(?:start|stop)|network\/model-market\/seed$/.test(request.pathname) && request.method !== 'GET').length, 0)
  } finally {
    await show('visible')
    await go('chat')
    for (const path of [...paths, log]) { if (saved[path] === undefined) delete fixtures[path]; else fixtures[path] = saved[path] }
    if (original) Object.defineProperty(document, 'visibilityState', original)
    else delete document.visibilityState
  }
}
