import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startHostd } from '../src/hostd/server.js'
import { createControllerStore } from '../src/controller/store.js'
import { createHostClient } from '../src/controller/client.js'
import { createRunner } from '../src/controller/runner.js'

async function bootRunner() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-ssh-ops-runner-'))
  const store = await createControllerStore(dataDir)
  const client = createHostClient({ allowInsecureLoopback: true })
  const runner = createRunner({ store, client })
  return { dataDir, store, runner }
}

async function bootHostd() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-runner-'))
  return startHostd({ dataDir, listen: '127.0.0.1:0', allowInsecure: true })
}

test('pair 后 list 在线且 host_id 稳定，不带 host 打到当前目标', async () => {
  const hostd = await bootHostd()
  const { runner } = await bootRunner()
  try {
    const first = await runner.pair({ address: hostd.url, pairingCode: hostd.pairingCode })
    const listed = await runner.list()
    assert.equal(listed[0].hostId, first.hostId)
    assert.equal(listed[0].online, true)
    const echo = first.dialect === 'pwsh' ? 'Write-Output target-a' : 'printf target-a'
    const result = await runner.exec({ command: echo, description: 'echo current' })
    assert.equal(result.hostId, first.hostId)
    assert.match(await runner.readJob(result.jobId).then((job) => job.log), /target-a/)
  } finally {
    await hostd.close()
  }
})

test('两台机器并行执行日志不串，离线不改打另一台', async () => {
  const a = await bootHostd()
  const b = await bootHostd()
  const { runner } = await bootRunner()
  try {
    const hostA = await runner.pair({ address: a.url, pairingCode: a.pairingCode, displayName: 'alpha' })
    const hostB = await runner.pair({ address: b.url, pairingCode: b.pairingCode, displayName: 'beta' })
    const cmdA = hostA.dialect === 'pwsh' ? 'Write-Output AAA' : 'printf AAA'
    const cmdB = hostB.dialect === 'pwsh' ? 'Write-Output BBB' : 'printf BBB'
    const [jobA, jobB] = await Promise.all([
      runner.exec({ host: hostA.hostId, command: cmdA, description: 'a' }),
      runner.exec({ host: hostB.hostId, command: cmdB, description: 'b' }),
    ])
    assert.match((await runner.readJob(jobA.jobId)).log, /AAA/)
    assert.doesNotMatch((await runner.readJob(jobA.jobId)).log, /BBB/)
    assert.match((await runner.readJob(jobB.jobId)).log, /BBB/)
    await a.close()
    await assert.rejects(
      () => runner.exec({ host: hostA.hostId, command: cmdA, description: 'offline' }),
      (err) => err.code === 'HOST_OFFLINE',
    )
    const stillB = await runner.exec({ host: hostB.hostId, command: cmdB, description: 'still b' })
    assert.equal(stillB.hostId, hostB.hostId)
  } finally {
    await b.close()
  }
})

test('远程命令不再被插件自定义审批分类拦截', async () => {
  const hostd = await bootHostd()
  const { store } = await bootRunner()
  const marker = path.join(hostd.dataDir ?? os.tmpdir(), `denied-${Date.now()}.txt`)
  const asking = createRunner({
    store,
    client: createHostClient({ allowInsecureLoopback: true }),
  })
  try {
    const host = await asking.pair({ address: hostd.url, pairingCode: hostd.pairingCode })
    const command = host.dialect === 'pwsh'
      ? `Set-Content -Path '${marker}' -Value denied`
      : `printf denied > '${marker}'`
    const result = await asking.exec({ command, description: 'should run' })
    assert.equal(result.status, 'succeeded')
    await fs.access(marker)
  } finally {
    await hostd.close()
  }
})

test('执行中关闭 hostd 记为 interrupted', async () => {
  const hostd = await bootHostd()
  const { runner } = await bootRunner()
  try {
    const host = await runner.pair({ address: hostd.url, pairingCode: hostd.pairingCode })
    const command = host.dialect === 'pwsh' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
    const pending = runner.exec({ command, description: 'sleep', timeoutMs: 20_000 })
    for (let i = 0; i < 50; i++) {
      if (runner.listJobs().some((job) => job.status === 'running')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await hostd.close()
    const result = await pending
    assert.equal(result.status, 'interrupted')
  } catch {
    await hostd.close()
    throw new Error('expected interrupted result, not throw')
  }
})
