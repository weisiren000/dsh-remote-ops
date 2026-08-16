import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../src/plugin/index.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('心跳 disposer 先停止调度并等待正在执行的刷新停稳', async () => {
  assert.equal(typeof plugin.createHeartbeatLoop, 'function')
  const entered = deferred()
  const release = deferred()
  let tick
  let cleared = false
  const heartbeat = plugin.createHeartbeatLoop({
    async refreshHosts() {
      entered.resolve()
      await release.promise
    },
  }, 1000, {
    setInterval(callback) { tick = callback; return 'timer' },
    clearInterval(timer) { assert.equal(timer, 'timer'); cleared = true },
  })
  const running = tick()
  await entered.promise
  let disposed = false
  const disposing = heartbeat.dispose().then(() => { disposed = true })
  await Promise.resolve()
  assert.equal(cleared, true)
  assert.equal(disposed, false)
  release.resolve()
  await Promise.all([running, disposing])
  assert.equal(disposed, true)
})

test('apply 在 Web 路由注册失败时清理已创建的心跳定时器', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-ops-apply-'))
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const timer = { id: 'test-timer' }
  let cleared
  globalThis.setInterval = () => timer
  globalThis.clearInterval = (value) => { cleared = value }
  try {
    const ctx = {
      tools: { register() {}, guard() {} },
      systemPrompt: { section() {} },
      on() {},
      get() {},
      effect() {},
      webServer: { register() { throw new Error('route registration failed') } },
    }
    await assert.rejects(plugin.apply(ctx, { dataDir }), /route registration failed/)
    assert.equal(cleared, timer)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
})
