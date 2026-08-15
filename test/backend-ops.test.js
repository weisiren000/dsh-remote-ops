import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createControllerStore } from '../src/controller/store.js'
import { createRunner } from '../src/controller/runner.js'
import { createHostApiHandler } from '../src/host-api.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'remote-ops-backend-'))
}

function hostFixture(overrides = {}) {
  return {
    hostId: 'host-a', displayName: 'alpha', address: 'http://127.0.0.1:7680',
    transport: 'ssh', sshHost: '127.0.0.1', sshPort: 22, sshUsername: 'root',
    online: true, status: 'online', cwd: '/srv', os: 'linux', dialect: 'bash', ...overrides,
  }
}

test('store 为旧任务补默认运维字段并支持状态时间筛选和日志尾部', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  const job = await store.createJob({ hostId: 'host-a', command: 'printf x', status: 'running', startedAt: 100 })
  await store.appendJobLog(job.jobId, '0123456789')
  await store.updateJob(job.jobId, { status: 'failed', finishedAt: 200, errorCode: 'SSH_CONNECT_FAILED' })
  const filtered = store.listJobs({ hostId: 'host-a', status: 'failed', since: 50, until: 250 })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].errorCode, 'SSH_CONNECT_FAILED')
  assert.equal(await store.readJobLogTail(job.jobId, 4), '6789')
})

test('SSH 运行中任务取消会调用真实客户端并返回 canceled 日志', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture())
  let cancelCalls = 0
  let resolveExec
  const client = {
    async heartbeat(host) { return { ...host, ts: Date.now() } },
    exec(_host, spec) {
      return new Promise((resolve) => {
        resolveExec = resolve
        const finish = () => { spec.onStdout?.(Buffer.from('stopped\n')); resolve({
          stdout: 'stopped\n', stderr: '', exitCode: null, aborted: true, remoteJobId: 'channel-1', streamed: true,
        }) }
        if (spec.signal.aborted) finish()
        else spec.signal.addEventListener('abort', finish, { once: true })
      })
    },
    async cancel() { cancelCalls += 1; return { supported: true } },
  }
  const runner = createRunner({ store, client })
  const pending = runner.exec({ host: 'host-a', command: 'sleep 30', description: 'cancel me' })
  for (let i = 0; i < 20 && !runner.listJobs({ status: 'running' }).length; i++) await new Promise((resolve) => setTimeout(resolve, 1))
  const running = runner.listJobs({ status: 'running' })[0]
  const cancel = await runner.cancelJob(running.jobId)
  assert.equal(cancel.status, 'cancel_requested')
  const result = await pending
  assert.equal(result.status, 'canceled')
  assert.equal(cancelCalls, 1)
  assert.match(result.log, /stopped/)
  void resolveExec
})

test('确认变更后的 SSH 指纹时先验证再保存新指纹', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture({ hostFingerprint: 'old' }))
  let checkedFingerprint
  const runner = createRunner({
    store,
    client: {
      async heartbeat(host) {
        checkedFingerprint = host.hostFingerprint
        return { cwd: host.cwd, os: host.os, dialect: host.dialect, ts: Date.now() }
      },
    },
  })
  const result = await runner.reconnectHost('host-a', { hostFingerprint: 'new' })
  assert.equal(result.status, 'online')
  assert.equal(checkedFingerprint, 'new')
  assert.equal(store.getHost('host-a').hostFingerprint, 'new')
})

test('主机列表包含六种任务状态统计', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  await store.createJob({ hostId: 'host-a', command: 'a', status: 'running' })
  await store.createJob({ hostId: 'host-a', command: 'b', status: 'failed' })
  const runner = createRunner({
    store,
    client: { async heartbeat(host) { return { cwd: host.cwd, os: host.os, dialect: host.dialect, ts: Date.now() } } },
  })
  const [host] = await runner.list()
  assert.deepEqual(host.taskStats, {
    running: 1, succeeded: 0, failed: 1, timed_out: 0, canceled: 0, interrupted: 0,
  })
})

test('主机列表不等待离线 SSH 心跳完成', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture({ online: false, status: 'offline' }))
  const runner = createRunner({
    store,
    client: { heartbeat: () => new Promise(() => {}) },
  })
  const result = await Promise.race([
    runner.list(),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ])
  assert.notEqual(result, 'timeout')
  assert.equal(result[0].status, 'offline')
})

test('host API 暴露重连、诊断、健康、任务取消和日志尾部接口', async () => {
  const calls = []
  const runner = {
    async reconnectHost(id) { calls.push(['reconnect', id]); return { hostId: id, displayName: 'alpha', online: true, status: 'online' } },
    async diagnoseHost(id) { calls.push(['diagnose', id]); return { hostId: id, ok: true } },
    async healthHost(id) { calls.push(['health', id]); return { hostId: id, status: 'online' } },
    listJobs(filter) { calls.push(['jobs', filter]); return [{ jobId: 'j1', hostId: filter.hostId, status: 'failed', command: 'x' }] },
    async cancelJob(id) { calls.push(['cancel', id]); return { jobId: id, status: 'cancel_requested' } },
    async readJobLogTail(id, tail) { calls.push(['log', id, tail]); return { jobId: id, log: 'tail' } },
  }
  const handler = createHostApiHandler({ runner })
  const request = (url, method = 'GET') => ({
    method, url, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {},
  })
  const response = () => ({ writeHead(status) { this.status = status }, end(body) { this.body = body ? JSON.parse(body) : null } })
  let res = response(); await handler(request('/remote-ops/v1/hosts/host-a/reconnect', 'POST'), res); assert.equal(res.body.status, 'online')
  res = response(); await handler(request('/remote-ops/v1/hosts/host-a/diagnose', 'POST'), res); assert.equal(res.body.ok, true)
  res = response(); await handler(request('/remote-ops/v1/hosts/host-a/health'), res); assert.equal(res.body.status, 'online')
  res = response(); await handler(request('/remote-ops/v1/hosts/host-a/jobs?status=failed'), res); assert.equal(res.body.jobs.length, 1)
  res = response(); await handler(request('/remote-ops/v1/jobs/j1/cancel', 'POST'), res); assert.equal(res.body.status, 'cancel_requested')
  res = response(); await handler(request('/remote-ops/v1/jobs/j1/log?tail=12'), res); assert.equal(res.body.log, 'tail')
  assert.deepEqual(calls.map((call) => call[0]), ['reconnect', 'diagnose', 'health', 'jobs', 'cancel', 'log'])
})

test('SSH 重连指纹变化先返回可确认错误，确认后才保存新指纹', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture({ hostFingerprint: 'SHA256:old' }))
  const seen = []
  const client = {
    async heartbeat(host) {
      seen.push(host.hostFingerprint)
      if (host.hostFingerprint !== 'SHA256:new') {
        throw Object.assign(new Error('fingerprint changed'), {
          code: 'HOST_KEY_CHANGED',
          fingerprint: 'SHA256:new',
        })
      }
      return { ts: Date.now(), cwd: host.cwd, os: host.os, dialect: host.dialect }
    },
  }
  const runner = createRunner({ store, client })
  await assert.rejects(
    runner.reconnectHost('host-a'),
    (error) => error.code === 'HOST_KEY_CHANGED' && error.fingerprint === 'SHA256:new',
  )
  assert.equal(store.getHost('host-a').hostFingerprint, 'SHA256:old')
  await runner.reconnectHost('host-a', { hostFingerprint: 'SHA256:new' })
  assert.equal(store.getHost('host-a').hostFingerprint, 'SHA256:new')
  assert.deepEqual(seen, ['SHA256:old', 'SHA256:new'])
})
