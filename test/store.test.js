import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createControllerStore } from '../src/controller/store.js'
import { createJobLogStore } from '../src/controller/job-log-store.js'
import { createRunner } from '../src/controller/runner.js'

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

function recoverableWriter(shouldFail) {
  return async (filePath, value) => {
    if (shouldFail(filePath)) throw Object.assign(new Error('injected write failure'), { code: 'EIO' })
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }
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

test('SSH 认证模式可持久化且密码不会进入主机内存或任何主机数据文件', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost({
    ...hostFixture({ hostId: 'ssh-host', transport: 'ssh' }),
    authMode: 'password_session',
    password: 'must-not-persist',
  })
  const publicHost = store.getHost('ssh-host')
  assert.equal(publicHost.authMode, 'password_session')
  assert.equal(publicHost.password, undefined)
  assert.equal(store.listHosts()[0].password, undefined)
  const hostsText = await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8')
  const secretsText = await fs.readFile(path.join(dataDir, 'host-secrets.json'), 'utf8')
  assert.doesNotMatch(hostsText, /must-not-persist/)
  assert.doesNotMatch(secretsText, /must-not-persist/)
  assert.equal(JSON.parse(secretsText).host_records[0].auth_mode, 'password_session')
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

test('任务日志超过磁盘上限后轮转尾部并诚实标记过期范围', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir, { maxJobLogBytes: 32 })
  await store.createJob({
    jobId: 'bounded-log', hostId: 'host-a', command: 'true',
    description: 'bounded', status: 'running',
  })
  await store.appendJobLog('bounded-log', 'a'.repeat(24))
  await store.appendJobLog('bounded-log', 'b'.repeat(24))

  const logPath = path.join(dataDir, 'logs', 'bounded-log.log')
  assert.ok((await fs.stat(logPath)).size <= 32)
  const window = await store.readJobLogWindow('bounded-log', 16)
  assert.equal(window.totalBytes, 48)
  assert.equal(window.truncated, true)
  assert.equal(window.text, 'b'.repeat(16))
  await assert.rejects(
    store.readJobLogRange('bounded-log', 0, 8),
    (error) => error.code === 'JOB_LOG_RANGE_EXPIRED' && error.availableStartByte === 16,
  )
})

test('任务日志原子元数据写失败后不遗留临时文件', async () => {
  const logsDir = await tempDir()
  let failures = 1
  const store = await createJobLogStore(logsDir, {
    renameFile: async (from, to) => {
      if (to.endsWith('.meta.json') && failures-- > 0) {
        throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
      }
      await fs.rename(from, to)
    },
  })

  await assert.rejects(store.append('failed-meta', 'FIRST'), /injected rename failure/)
  const leftovers = (await fs.readdir(logsDir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  await store.append('failed-meta', 'SECOND')
  const page = await store.readRange('failed-meta', 0, 32)
  assert.equal(page.text, 'FIRSTSECOND')
  assert.equal(page.totalBytes, 11)
  const reloaded = await createJobLogStore(logsDir)
  const reloadedPage = await reloaded.readRange('failed-meta', 0, 32)
  assert.equal(reloadedPage.text, 'FIRSTSECOND')
  assert.equal(reloadedPage.totalBytes, 11)
})

test('任务日志轮转后元数据发布失败可通过 journal 恢复', async () => {
  const logsDir = await tempDir()
  let failures = 1
  const store = await createJobLogStore(logsDir, {
    maxJobLogBytes: 8,
    renameFile: async (from, to) => {
      if (to.endsWith('.meta.json') && failures-- === 0) {
        throw Object.assign(new Error('injected rotation metadata failure'), { code: 'EIO' })
      }
      await fs.rename(from, to)
    },
  })
  await store.append('rotated', 'ABCDEFGH')
  await assert.rejects(store.append('rotated', 'IJK'), /injected rotation metadata failure/)

  const reloaded = await createJobLogStore(logsDir, { maxJobLogBytes: 8 })
  const page = await reloaded.readRange('rotated', 3, 8)
  assert.equal(page.text, 'DEFGHIJK')
  assert.equal(page.totalBytes, 11)
  assert.equal(await fs.stat(path.join(logsDir, 'rotated.pending.json')).then(() => true, () => false), false)
})

test('controller job id 不能通过日志文件名逃出 logs 目录', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await assert.rejects(
    store.createJob({
      jobId: '../escape', hostId: 'host-a', command: 'true',
      description: 'escape', status: 'running',
    }),
    (error) => error.code === 'JOB_ID_INVALID',
  )
})

test('主机写盘失败不会污染内存，且下一次写入可以恢复', async () => {
  const dataDir = await tempDir()
  let failures = 1
  const store = await createControllerStore(dataDir, {
    writeJson: recoverableWriter((filePath) => filePath.endsWith('host-secrets.json') && failures-- > 0),
  })
  await assert.rejects(store.upsertHost(hostFixture()), /injected write failure/)
  assert.equal(store.getHost('host-a'), undefined)

  await store.upsertHost(hostFixture())
  assert.equal(store.getHost('host-a').displayName, 'alpha')
  assert.equal((await createControllerStore(dataDir)).getHost('host-a').displayName, 'alpha')
})

test('公开主机提交失败后重启仍保留上一个权威主机快照', async () => {
  const dataDir = await tempDir()
  const initial = await createControllerStore(dataDir)
  await initial.upsertHost(hostFixture({ deviceToken: 'old-token', displayName: 'old-name' }))

  let failHostWrite = true
  const store = await createControllerStore(dataDir, {
    writeJson: recoverableWriter((filePath) => {
      if (!filePath.endsWith('host-secrets.json') || !failHostWrite) return false
      failHostWrite = false
      return true
    }),
  })
  await assert.rejects(
    store.upsertHost(hostFixture({ deviceToken: 'new-token', displayName: 'new-name' })),
    /injected write failure/,
  )
  assert.equal(store.getHost('host-a').deviceToken, 'old-token')

  const reloaded = await createControllerStore(dataDir)
  assert.equal(reloaded.getHost('host-a').deviceToken, 'old-token')
  assert.equal(reloaded.getHost('host-a').displayName, 'old-name')
})

test('通用 JSON 原子写发布失败后清理可能含秘密的临时文件', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir, {
    renameFile: async () => {
      throw Object.assign(new Error('injected atomic rename failure'), { code: 'EIO' })
    },
  })
  await assert.rejects(store.upsertHost(hostFixture()), /injected atomic rename failure/)
  const leftovers = (await fs.readdir(dataDir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('任务和变更写队列在一次失败后恢复且不提交失败状态', async () => {
  const dataDir = await tempDir()
  const failures = new Set(['jobs.json', 'changes.json'])
  const store = await createControllerStore(dataDir, {
    writeJson: recoverableWriter((filePath) => {
      const name = path.basename(filePath)
      if (!failures.has(name)) return false
      failures.delete(name)
      return true
    }),
  })
  await assert.rejects(store.createJob({
    jobId: 'failed-job', hostId: 'host-a', command: 'true', description: 'failed', status: 'running',
  }), /injected write failure/)
  assert.equal(store.getJob('failed-job'), undefined)
  await store.createJob({
    jobId: 'saved-job', hostId: 'host-a', command: 'true', description: 'saved', status: 'running',
  })
  assert.equal(store.getJob('saved-job').status, 'running')

  await assert.rejects(store.recordChange({
    changeId: 'failed-change', hostId: 'host-a', path: '/tmp/a', afterContent: 'a',
  }), /injected write failure/)
  assert.equal(store.getChange('failed-change'), undefined)
  await store.recordChange({
    changeId: 'saved-change', hostId: 'host-a', path: '/tmp/b', afterContent: 'b',
  })
  assert.equal(store.getChange('saved-change').path, '/tmp/b')
})

test('启动时把没有执行所有者的 running 任务恢复为 interrupted', async () => {
  const dataDir = await tempDir()
  await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify({
    jobs: [{
      job_id: 'orphan', host_id: 'host-a', command: 'sleep 30', description: 'orphan',
      status: 'running', started_at: 10,
    }],
  }), 'utf8')
  const store = await createControllerStore(dataDir, { now: () => 999 })
  const recovered = store.getJob('orphan')
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.finishedAt, 999)
  assert.equal(recovered.errorCode, 'CONTROLLER_RESTARTED')
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8'))
  assert.equal(persisted.jobs[0].status, 'interrupted')
})

test('重启后仍能通过 DSH Job ID 找回 controller job', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.createJob({
    jobId: 'controller-job', dshJobId: 'dsh-job', hostId: 'host-a',
    command: 'sleep 1', description: 'background', status: 'running',
    ownerSessionId: 'session-a',
  })

  const reloaded = await createControllerStore(dataDir)
  const recovered = reloaded.getJobByDshJobId('dsh-job')
  assert.equal(recovered.jobId, 'controller-job')
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.ownerSessionId, 'session-a')
  const runner = createRunner({ store: reloaded, client: {} })
  assert.equal((await runner.readJob('dsh-job', 'session-a')).jobId, 'controller-job')
})

test('旧 hosts.json 的 device_token 无损迁移到受限秘密文件', async () => {
  const dataDir = await tempDir()
  await fs.writeFile(path.join(dataDir, 'hosts.json'), JSON.stringify({
    current_host_id: 'legacy-host',
    hosts: [{
      host_id: 'legacy-host', display_name: 'legacy', address: 'http://127.0.0.1:7680',
      device_token: 'legacy-secret-token', online: true, cwd: '/srv', os: 'linux', dialect: 'bash',
    }],
  }), 'utf8')

  const store = await createControllerStore(dataDir)
  assert.equal(store.getHost('legacy-host').deviceToken, 'legacy-secret-token')
  const hostsText = await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8')
  const secretsText = await fs.readFile(path.join(dataDir, 'host-secrets.json'), 'utf8')
  assert.doesNotMatch(hostsText, /legacy-secret-token|device_token/)
  assert.match(secretsText, /legacy-secret-token/)
  assert.equal((await createControllerStore(dataDir)).getHost('legacy-host').deviceToken, 'legacy-secret-token')
})

test('旧令牌迁移的秘密快照失败时不会先破坏 legacy 数据', async () => {
  const dataDir = await tempDir()
  const legacy = {
    current_host_id: 'legacy-host',
    hosts: [{
      host_id: 'legacy-host', display_name: 'legacy', address: 'http://127.0.0.1:7680',
      device_token: 'legacy-secret-token', online: true, cwd: '/srv', os: 'linux', dialect: 'bash',
    }],
  }
  await fs.writeFile(path.join(dataDir, 'hosts.json'), JSON.stringify(legacy), 'utf8')
  let failures = 1
  await assert.rejects(
    createControllerStore(dataDir, {
      writeJson: recoverableWriter((filePath) => (
        filePath.endsWith('host-secrets.json') && failures-- > 0
      )),
    }),
    /injected write failure/,
  )
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8'))
  assert.equal(persisted.hosts[0].device_token, 'legacy-secret-token')
  assert.equal((await createControllerStore(dataDir)).getHost('legacy-host').deviceToken, 'legacy-secret-token')
})

test('旧令牌迁移清理公开明文失败时返回失败并可在重启后重试', async () => {
  const dataDir = await tempDir()
  await fs.writeFile(path.join(dataDir, 'hosts.json'), JSON.stringify({
    current_host_id: 'legacy-host',
    hosts: [{
      host_id: 'legacy-host', display_name: 'legacy', address: 'http://127.0.0.1:7680',
      device_token: 'PLAINTEXT', online: true, cwd: '/srv', os: 'linux', dialect: 'bash',
    }],
  }), 'utf8')
  await assert.rejects(
    createControllerStore(dataDir, {
      writeJson: recoverableWriter((filePath) => filePath.endsWith('hosts.json')),
    }),
    /injected write failure/,
  )
  assert.match(await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8'), /PLAINTEXT/)
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'host-secrets.json'), 'utf8')).version, 2)

  const recovered = await createControllerStore(dataDir)
  assert.equal(recovered.getHost('legacy-host').deviceToken, 'PLAINTEXT')
  assert.doesNotMatch(await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8'), /PLAINTEXT|device_token/)
})

test('v2 权威主机快照会修复崩溃遗留的公开投影', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(hostFixture({ displayName: 'authoritative' }))
  await fs.writeFile(path.join(dataDir, 'hosts.json'), JSON.stringify({
    current_host_id: null,
    hosts: [{ host_id: 'stale-host', display_name: 'stale' }],
  }), 'utf8')

  const reloaded = await createControllerStore(dataDir)
  const projection = JSON.parse(await fs.readFile(path.join(dataDir, 'hosts.json'), 'utf8'))
  assert.equal(reloaded.getHost('host-a').displayName, 'authoritative')
  assert.deepEqual(projection.hosts.map((host) => host.host_id), ['host-a'])
})
