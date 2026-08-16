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

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function waitForRunningJob(runner) {
  for (let index = 0; index < 50; index += 1) {
    const job = runner.listJobs({ status: 'running' })[0]
    if (job) return job
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('running job did not appear')
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
  assert.equal(cancel.status, 'canceled')
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

test('内部任务按 owner session 隔离读取、日志和取消', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  const runner = createRunner({
    store,
    client: {
      async heartbeat(host) { return { ...host, ts: Date.now() } },
      async exec() { return { stdout: 'owned', stderr: '', exitCode: 0, aborted: false } },
    },
  })
  const result = await runner.exec({
    host: 'host-a', command: 'printf owned', description: 'owned', ownerSessionId: 'session-a',
  })
  assert.equal((await runner.readJob(result.jobId, 'session-a')).ownerSessionId, 'session-a')
  await assert.rejects(runner.readJob(result.jobId, 'session-b'), (error) => error.code === 'JOB_FORBIDDEN')
  await assert.rejects(runner.readJobLogTail(result.jobId, 100, 'session-b'), (error) => error.code === 'JOB_FORBIDDEN')
  await assert.rejects(runner.cancelJob(result.jobId, 'session-b'), (error) => error.code === 'JOB_FORBIDDEN')
  assert.deepEqual(runner.listJobs({ ownerSessionId: 'session-b' }), [])
})

test('Runner 读取大日志只返回有界 tail 和结构化 locator', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  const job = await store.createJob({ hostId: 'host-a', command: 'large', description: 'large', status: 'succeeded' })
  await store.appendJobLog(job.jobId, 'x'.repeat(200000))
  const runner = createRunner({ store, client: {}, maxInlineOutputBytes: 1024 })
  const result = await runner.readJob(job.jobId)
  assert.ok(Buffer.byteLength(result.log) <= 1024)
  assert.equal(result.logTruncated, true)
  assert.equal(result.logBytes, 200000)
  assert.deepEqual(result.logLocator, {
    kind: 'controller_job_log',
    job_id: job.jobId,
    start_byte: 198976,
    total_bytes: 200000,
  })
})

test('Runner 在心跳等待期间收到取消后不会启动远程命令', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  const heartbeatEntered = deferred()
  const releaseHeartbeat = deferred()
  let execCalls = 0
  const runner = createRunner({
    store,
    client: {
      async heartbeat(host) {
        heartbeatEntered.resolve()
        await releaseHeartbeat.promise
        return { ...host, ts: Date.now() }
      },
      async exec() {
        execCalls += 1
        return { stdout: 'must not run', stderr: '', exitCode: 0, aborted: false }
      },
    },
  })
  const controller = new AbortController()
  const pending = runner.exec({
    host: 'host-a', command: 'dangerous', description: 'abort during refresh', signal: controller.signal,
  })
  await heartbeatEntered.promise
  controller.abort('user canceled')
  releaseHeartbeat.resolve()

  await assert.rejects(pending, (error) => error.code === 'ABORTED')
  assert.equal(execCalls, 0)
  assert.deepEqual(runner.listJobs(), [])
})

test('Runner 在日志写盘失败后仍持久化 interrupted 终态', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  store.appendJobLog = async () => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  }
  const runner = createRunner({
    store,
    client: {
      async heartbeat(host) { return { ...host, ts: Date.now() } },
      async exec(_host, spec) {
        await spec.onStdout(Buffer.from('output'))
        return { stdout: 'output', stderr: '', exitCode: 0, aborted: false, streamed: true }
      },
    },
  })

  const result = await runner.exec({ host: 'host-a', command: 'write', description: 'log failure' })
  assert.equal(result.status, 'interrupted')
  assert.equal(result.errorCode, 'ENOSPC')
  assert.equal(store.getJob(result.jobId).status, 'interrupted')
})

test('Runner 区分用户取消、超时、移除主机和服务卸载终态', async (t) => {
  async function startAbortableRunner(resultFactory = () => ({
    stdout: '', stderr: '', exitCode: null, aborted: true, streamed: true,
  })) {
    const store = await createControllerStore(await tempDir())
    await store.upsertHost(hostFixture())
    const client = {
      async heartbeat(host) { return { ...host, ts: Date.now() } },
      exec(_host, spec) {
        return new Promise((resolve) => {
          const finish = () => resolve(resultFactory())
          if (spec.signal.aborted) finish()
          else spec.signal.addEventListener('abort', finish, { once: true })
        })
      },
      async cancel() { return { supported: true } },
      async remove() {},
      async dispose() {},
    }
    return { store, runner: createRunner({ store, client }) }
  }

  await t.test('用户信号取消映射为 canceled', async () => {
    const { runner } = await startAbortableRunner()
    const controller = new AbortController()
    const pending = runner.exec({
      host: 'host-a', command: 'sleep', description: 'user cancel', signal: controller.signal,
    })
    await waitForRunningJob(runner)
    controller.abort('user canceled')
    assert.equal((await pending).status, 'canceled')
  })

  await t.test('超时映射为 timed_out', async () => {
    const store = await createControllerStore(await tempDir())
    await store.upsertHost(hostFixture())
    const timeoutRunner = createRunner({
      store,
      client: {
        async heartbeat(host) { return { ...host, ts: Date.now() } },
        async exec() {
          return { stdout: '', stderr: '', exitCode: null, timedOut: true, aborted: false, streamed: true }
        },
      },
    })
    const result = await timeoutRunner.exec({ host: 'host-a', command: 'sleep', description: 'timeout' })
    assert.equal(result.status, 'timed_out')
  })

  await t.test('移除主机映射为 interrupted', async () => {
    const { runner } = await startAbortableRunner()
    const pending = runner.exec({ host: 'host-a', command: 'sleep', description: 'host removal' })
    const job = await waitForRunningJob(runner)
    await runner.removeHost('host-a')
    const result = await pending
    assert.equal(result.status, 'interrupted')
    assert.equal(result.errorCode, 'HOST_REMOVED')
    assert.equal(result.jobId, job.jobId)
  })

  await t.test('服务卸载映射为 interrupted', async () => {
    const { runner } = await startAbortableRunner()
    const pending = runner.exec({ host: 'host-a', command: 'sleep', description: 'service unload' })
    await waitForRunningJob(runner)
    await runner.dispose()
    const result = await pending
    assert.equal(result.status, 'interrupted')
    assert.equal(result.errorCode, 'RUNNER_DISPOSED')
  })
})

test('Runner dispose 等待 list 触发的心跳刷新停稳', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  const entered = deferred()
  const release = deferred()
  let clientDisposed = false
  const runner = createRunner({
    store,
    client: {
      async heartbeat(host) {
        entered.resolve()
        await release.promise
        return { ...host, ts: Date.now() }
      },
      async dispose() { clientDisposed = true },
    },
  })
  await runner.list()
  await entered.promise
  let disposed = false
  const disposing = runner.dispose().then(() => { disposed = true })
  await Promise.resolve()
  const disposedBeforeRelease = disposed
  const clientDisposedBeforeRelease = clientDisposed
  release.resolve()
  await disposing
  assert.equal(disposedBeforeRelease, false)
  assert.equal(clientDisposedBeforeRelease, false)
  assert.equal(clientDisposed, true)
})

test('reviewChange 删除文件时把已校验版本传给底层 CAS', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(hostFixture())
  const change = await store.recordChange({
    hostId: 'host-a', path: '/srv/new.txt', beforeContent: null, afterContent: 'created',
    beforeVersion: null, afterVersion: 'current-version', status: 'pending',
  })
  let deletedExpectedVersion
  const runner = createRunner({
    store,
    client: {
      async readRemoteFile() { return { content: 'created', version: 'current-version' } },
      async deleteRemoteFile(_host, _path, expectedVersion) {
        deletedExpectedVersion = expectedVersion
        return { deleted: true }
      },
    },
  })

  await runner.reviewChange(change.changeId, 'revert')
  assert.equal(deletedExpectedVersion, 'current-version')
})
