import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startHostd } from '../src/hostd/server.js'

async function boot() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-http-'))
  return startHostd({
    dataDir,
    listen: '127.0.0.1:0',
    allowInsecure: true,
  })
}

test('配对成功后心跳可用，旧暗号失效', async () => {
  const server = await boot()
  try {
    const pairRes = await fetch(`${server.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })
    assert.equal(pairRes.status, 200)
    const paired = await pairRes.json()
    const replay = await fetch(`${server.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })
    assert.equal(replay.status, 401)
    const hb = await fetch(`${server.url}/v1/heartbeat`, {
      headers: { authorization: `Bearer ${paired.device_token}` },
    })
    assert.equal(hb.status, 200)
    const body = await hb.json()
    assert.equal(body.host_id, paired.host_id)
  } finally {
    await server.close()
  }
})

test('无令牌不能执行；有令牌能跑命令并拿到退出码', async () => {
  const server = await boot()
  try {
    const denied = await fetch(`${server.url}/v1/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo no' }),
    })
    assert.equal(denied.status, 401)

    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()

    const command = paired.dialect === 'pwsh' ? 'Write-Output ok; exit 3' : 'printf ok; exit 3'
    const execRes = await fetch(`${server.url}/v1/exec`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${paired.device_token}`,
      },
      body: JSON.stringify({ command }),
    })
    assert.equal(execRes.status, 200)
    const result = await execRes.json()
    assert.match(result.stdout, /ok/)
    assert.equal(result.exit_code, 3)
    assert.equal(result.timed_out, false)
  } finally {
    await server.close()
  }
})

test('非回环无 TLS 默认拒绝监听', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-bind-'))
  await assert.rejects(
    () => startHostd({ dataDir, listen: '0.0.0.0:0' }),
    /insecure/,
  )
})
