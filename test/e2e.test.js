import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startHostd } from '../src/hostd/server.js'
import { createControllerStore } from '../src/controller/store.js'
import { createHostClient } from '../src/controller/client.js'
import { createRunner } from '../src/controller/runner.js'

async function bootHostd() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-e2e-'))
  return startHostd({ dataDir, listen: '127.0.0.1:0', allowInsecure: true })
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待远程任务状态超时')
}

function appendProbeCommand(filePath, dialect) {
  if (dialect === 'pwsh') {
    return `while ($true) { Add-Content -LiteralPath '${filePath.replaceAll("'", "''")}' -Value x; Start-Sleep -Milliseconds 30 }`
  }
  return `while true; do printf x >> '${filePath.replaceAll("'", "'\\''")}'; sleep 0.03; done`
}

test('双机配对、当前目标、并行、掉线和令牌轮换', async () => {
  const a = await bootHostd()
  const b = await bootHostd()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctrl-e2e-'))
  const store = await createControllerStore(dataDir)
  const runner = createRunner({
    store,
    client: createHostClient({ allowInsecureLoopback: true }),
  })
  try {
    const hostA = await runner.pair({ address: a.url, pairingCode: a.pairingCode, displayName: 'alpha' })
    const hostB = await runner.pair({ address: b.url, pairingCode: b.pairingCode, displayName: 'beta' })
    await runner.use(hostA.hostId)
    const echo = (host, text) => (
      host.dialect === 'pwsh' ? `Write-Output ${text}` : `printf ${text}`
    )
    const current = await runner.exec({ command: echo(hostA, 'A1'), description: 'current a' })
    assert.equal(current.hostId, hostA.hostId)
    const explicit = await runner.exec({ host: hostB.hostId, command: echo(hostB, 'B1'), description: 'explicit b' })
    assert.equal(explicit.hostId, hostB.hostId)
    const [pA, pB] = await Promise.all([
      runner.exec({ host: hostA.hostId, command: echo(hostA, 'A2'), description: 'par a' }),
      runner.exec({ host: hostB.hostId, command: echo(hostB, 'B2'), description: 'par b' }),
    ])
    const jobsA = runner.listJobs({ hostId: hostA.hostId })
    const jobsB = runner.listJobs({ hostId: hostB.hostId })
    assert.ok(jobsA.every((job) => job.hostId === hostA.hostId))
    assert.ok(jobsB.every((job) => job.hostId === hostB.hostId))
    assert.match((await runner.readJob(pA.jobId)).log, /A2/)
    assert.match((await runner.readJob(pB.jobId)).log, /B2/)

    await a.close()
    await assert.rejects(
      () => runner.exec({ host: hostA.hostId, command: echo(hostA, 'A3'), description: 'offline' }),
      (err) => err.code === 'HOST_OFFLINE',
    )
    const stillB = await runner.exec({ host: hostB.hostId, command: echo(hostB, 'B3'), description: 'still b' })
    assert.equal(stillB.status === 'succeeded' || stillB.exitCode === 0, true)

    await assert.rejects(
      () => runner.pair({ address: b.url, pairingCode: b.pairingCode }),
      /pairing|401|expired|used/i,
    )
    const nextCode = b.issuePairingCode().code
    const client = createHostClient({ allowInsecureLoopback: true })
    await client.pair(b.url, nextCode)
    const oldToken = store.getHost(hostB.hostId).deviceToken
    const oldHb = await fetch(`${b.url}/v1/heartbeat`, {
      headers: { authorization: `Bearer ${oldToken}` },
    })
    assert.equal(oldHb.status, 401)
  } finally {
    await b.close()
  }
})

test('Runner 取消 hostd 任务后真实进程停止且主机保持在线', async () => {
  const hostd = await bootHostd()
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctrl-cancel-e2e-'))
  const probe = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'runner-cancel-')), 'probe.log')
  const store = await createControllerStore(dataDir)
  const runner = createRunner({ store, client: createHostClient({ allowInsecureLoopback: true }) })
  try {
    const host = await runner.pair({ address: hostd.url, pairingCode: hostd.pairingCode, displayName: 'cancel-target' })
    const pending = runner.exec({
      host: host.hostId,
      command: appendProbeCommand(probe, host.dialect),
      description: 'cancel probe',
      timeoutMs: 5_000,
    })
    const job = await waitFor(() => runner.listJobs({ hostId: host.hostId, status: 'running' })[0])
    await waitFor(() => fs.stat(probe).then((attrs) => attrs.size > 0, () => false))
    const canceled = await runner.cancelJob(job.jobId)
    const result = await pending
    assert.equal(canceled.status, 'canceled')
    assert.equal(result.status, 'canceled')
    assert.equal(store.getHost(host.hostId).status, 'online')
    const stoppedAt = await fs.stat(probe).then((attrs) => attrs.size)
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.equal(await fs.stat(probe).then((attrs) => attrs.size), stoppedAt)
  } finally {
    await runner.dispose()
    await hostd.close()
  }
})
