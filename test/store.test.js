import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createControllerStore } from '../src/controller/store.js'

function hostFixture(overrides = {}) {
  return {
    hostId: 'host-a',
    displayName: 'alpha',
    address: 'http://127.0.0.1:7680',
    deviceToken: 'token-secret',
    online: true,
    cwd: '/srv',
    os: 'linux',
    dialect: 'bash',
    lastHeartbeatAt: 1,
    approvalOverride: 'follow',
    ...overrides,
  }
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-ops-store-'))
}

test('upsertHost 后重启仍能读到同一台，listHosts 不含 token', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  const reloaded = await createControllerStore(dataDir)
  const listed = reloaded.listHosts()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].hostId, 'host-a')
  assert.equal(listed[0].deviceToken, undefined)
  assert.equal(reloaded.getHost('host-a').deviceToken, 'token-secret')
})

test('当前目标跨重启保持', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  await store.setCurrentHost('host-a')
  const reloaded = await createControllerStore(dataDir)
  assert.equal(reloaded.getCurrentHost().hostId, 'host-a')
})

test('任务日志按 job 隔离，审批拒绝任务不带远端 job 字段', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  const jobA = await store.createJob({
    hostId: 'host-a',
    command: 'printf a',
    description: 'run a',
    status: 'running',
  })
  const jobB = await store.createJob({
    hostId: 'host-a',
    command: 'printf b',
    description: 'run b',
    status: 'running',
  })
  await store.appendJobLog(jobA.jobId, 'alpha-log')
  await store.appendJobLog(jobB.jobId, 'beta-log')
  assert.equal(await store.readJobLog(jobA.jobId), 'alpha-log')
  assert.equal(await store.readJobLog(jobB.jobId), 'beta-log')

  const denied = await store.createJob({
    hostId: 'host-a',
    command: 'rm -rf /',
    description: 'denied',
    status: 'failed',
    approvalDenied: true,
  })
  assert.equal(store.getJob(denied.jobId).approvalDenied, true)
  assert.equal(store.getJob(denied.jobId).remoteJobId, undefined)
})

test('removeHost 删除记录并清空当前目标', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  await store.setCurrentHost('host-a')
  await store.removeHost('host-a')
  assert.equal(store.getHost('host-a'), undefined)
  assert.equal(store.getCurrentHost(), null)
})
