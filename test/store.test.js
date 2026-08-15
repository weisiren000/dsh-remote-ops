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

test('兼容旧版 hosts.json 和 jobs.json，并为运维字段提供默认值', async () => {
  const dataDir = await tempDir()
  await fs.writeFile(path.join(dataDir, 'hosts.json'), JSON.stringify({
    current_host_id: 'legacy-host',
    hosts: [{
      host_id: 'legacy-host',
      display_name: 'legacy',
      address: 'http://127.0.0.1:7680',
      device_token: 'legacy-token',
      online: false,
      cwd: '/tmp',
      os: 'linux',
      dialect: 'bash',
    }],
  }), 'utf8')
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      job_id: 'legacy-job',
      host_id: 'legacy-host',
      command: 'printf legacy',
      description: 'old job',
      status: 'succeeded',
      started_at: 10,
    }],
  }), 'utf8')

  const store = await createControllerStore(dataDir)
  const host = store.getHost('legacy-host')
  const job = store.getJob('legacy-job')
  assert.equal(host.status, 'offline')
  assert.equal(host.lastError, undefined)
  assert.equal(host.latencyMs, undefined)
  assert.equal(job.status, 'succeeded')
  assert.equal(job.errorCode, undefined)
  assert.equal(job.canceledAt, undefined)
  assert.equal(store.getCurrentHost().hostId, 'legacy-host')
})

test('主机记录中的密码不会写入 hosts.json', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost({
    ...hostFixture({ hostId: 'ssh-host', transport: 'ssh' }),
    password: 'must-not-persist',
  })
  const persisted = await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8')
  assert.doesNotMatch(persisted, /must-not-persist/)
  assert.doesNotMatch(persisted, /password/i)
})

test('日志尾部读取只返回请求长度，不加载完整日志内容', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  const job = await store.createJob({
    hostId: 'host-a',
    command: 'generate-large-log',
    description: 'large log',
    status: 'running',
  })
  const content = 'x'.repeat(128 * 1024) + 'TAIL'
  await store.appendJobLog(job.jobId, content)
  const tail = await store.readJobLogTail(job.jobId, 64)
  assert.equal(tail.length, 64)
  assert.equal(tail, `${'x'.repeat(60)}TAIL`)
  assert.notEqual(tail.length, content.length)
})
