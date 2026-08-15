import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createControllerStore } from '../src/controller/store.js'
import { resolveTarget } from '../src/controller/resolve.js'

async function storeWith(hosts, currentHostId = null) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-ops-resolve-'))
  const store = await createControllerStore(dataDir)
  for (const host of hosts) await store.upsertHost(host)
  if (currentHostId) await store.setCurrentHost(currentHostId)
  return store
}

function host(id, name, online = true) {
  return {
    hostId: id,
    displayName: name,
    address: `http://127.0.0.1:70${id.slice(-2)}`,
    deviceToken: `token-${id}`,
    online,
    cwd: '/',
    os: 'linux',
    dialect: 'bash',
    lastHeartbeatAt: 1,
  }
}

test('按 hostId 精确匹配', async () => {
  const store = await storeWith([host('h1', 'one'), host('h2', 'two')])
  assert.equal(resolveTarget(store, 'h2').hostId, 'h2')
})

test('显示名重名抛 HOST_AMBIGUOUS', async () => {
  const store = await storeWith([host('h1', 'dup'), host('h2', 'dup')])
  assert.throws(() => resolveTarget(store, 'dup'), (err) => err.code === 'HOST_AMBIGUOUS')
})

test('找不到抛 HOST_NOT_FOUND', async () => {
  const store = await storeWith([host('h1', 'one')])
  assert.throws(() => resolveTarget(store, 'missing'), (err) => err.code === 'HOST_NOT_FOUND')
})

test('未指定时使用当前目标', async () => {
  const store = await storeWith([host('h1', 'one'), host('h2', 'two')], 'h2')
  assert.equal(resolveTarget(store).hostId, 'h2')
})

test('未指定且无当前目标时仅一台则用那一台', async () => {
  const store = await storeWith([host('h1', 'only')])
  assert.equal(resolveTarget(store).hostId, 'h1')
})

test('未指定且多台无当前目标时抛 HOST_REQUIRED 并列出候选', async () => {
  const store = await storeWith([host('h1', 'one'), host('h2', 'two')])
  assert.throws(() => resolveTarget(store), (err) => {
    return err.code === 'HOST_REQUIRED'
      && err.message.includes('one (h1)')
      && err.message.includes('two (h2)')
  })
})

test('目标离线抛 HOST_OFFLINE，不改打其他在线机器', async () => {
  const store = await storeWith([host('h1', 'down', false), host('h2', 'up', true)], 'h1')
  assert.throws(() => resolveTarget(store), (err) => err.code === 'HOST_OFFLINE')
  assert.throws(() => resolveTarget(store, 'h1'), (err) => err.code === 'HOST_OFFLINE')
})
