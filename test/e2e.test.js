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
