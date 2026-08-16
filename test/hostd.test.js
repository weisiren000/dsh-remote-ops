import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startHostd } from '../src/hostd/server.js'

async function boot(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-http-'))
  return startHostd({
    dataDir,
    listen: '127.0.0.1:0',
    allowInsecure: true,
    ...options,
  })
}

async function pair(server) {
  return (await fetch(`${server.url}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairing_code: server.pairingCode }),
  })).json()
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待探针状态超时')
}

function appendProbeCommand(filePath, dialect) {
  if (dialect === 'pwsh') {
    const quoted = filePath.replaceAll("'", "''")
    return `while ($true) { Add-Content -LiteralPath '${quoted}' -Value x; Start-Sleep -Milliseconds 30 }`
  }
  const quoted = filePath.replaceAll("'", "'\\''")
  return `while true; do printf x >> '${quoted}'; sleep 0.03; done`
}

async function fileSize(filePath) {
  return fs.stat(filePath).then((attrs) => attrs.size, () => 0)
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

test('hostd Wire 对超大 stdout 和 stderr 返回有界内容及原始字节数', async () => {
  const server = await boot({ maxOutputBytes: 1024 })
  try {
    const paired = await pair(server)
    const response = await fetch(`${server.url}/v1/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${paired.device_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        job_id: 'large-wire-output',
        command: `node -e "process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000))"`,
      }),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.ok(Buffer.byteLength(result.stdout) <= 1024)
    assert.ok(Buffer.byteLength(result.stderr) <= 1024)
    assert.equal(result.stdout_bytes, 200000)
    assert.equal(result.stderr_bytes, 200000)
    assert.equal(result.stdout_truncated, true)
    assert.equal(result.stderr_truncated, true)
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

test('hostd 取消响应只在真实命令停止后返回', async () => {
  const server = await boot()
  const probe = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-cancel-')), 'probe.log')
  const controller = new AbortController()
  let settledExecution = Promise.resolve()
  try {
    const paired = await pair(server)
    const headers = {
      authorization: `Bearer ${paired.device_token}`,
      'content-type': 'application/json',
    }
    const jobId = 'controller-job-cancel'
    const execution = fetch(`${server.url}/v1/exec`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({
        job_id: jobId,
        command: appendProbeCommand(probe, paired.dialect),
        timeout_ms: 1_000,
      }),
    })
    settledExecution = execution.catch(() => null)
    await waitFor(async () => await fileSize(probe) > 0)
    const canceled = await fetch(`${server.url}/v1/exec/${jobId}/cancel`, {
      method: 'POST', headers: { authorization: headers.authorization },
    })
    assert.equal(canceled.status, 200)
    assert.equal((await canceled.json()).status, 'canceled')
    const stoppedAt = await fileSize(probe)
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.equal(await fileSize(probe), stoppedAt)
    const result = await (await execution).json()
    assert.equal(result.job_id, jobId)
    assert.equal(result.aborted, true)
  } finally {
    controller.abort()
    await settledExecution
    await server.close()
  }
})

test('hostd 记住先于 exec 注册到达的取消请求', async () => {
  const server = await boot({ cancelTombstoneMs: 5_000 })
  const probe = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-early-cancel-')), 'probe.log')
  try {
    const paired = await pair(server)
    const headers = {
      authorization: `Bearer ${paired.device_token}`,
      'content-type': 'application/json',
    }
    const jobId = 'cancel-before-register'
    const canceled = await fetch(`${server.url}/v1/exec/${jobId}/cancel`, {
      method: 'POST', headers,
    })
    assert.equal(canceled.status, 202)

    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(probe)}, 'started')"`
    const execution = await fetch(`${server.url}/v1/exec`, {
      method: 'POST', headers,
      body: JSON.stringify({ job_id: jobId, command }),
    })
    assert.equal(execution.status, 200)
    const result = await execution.json()
    assert.equal(result.aborted, true)
    assert.equal(await fs.stat(probe).then(() => true, () => false), false)
  } finally {
    await server.close()
  }
})

test('hostd close 等待所有真实命令完全停稳', async () => {
  const server = await boot()
  const probe = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-close-')), 'probe.log')
  const controller = new AbortController()
  try {
    const paired = await pair(server)
    void fetch(`${server.url}/v1/exec`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${paired.device_token}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        job_id: 'controller-job-close',
        command: appendProbeCommand(probe, paired.dialect),
        timeout_ms: 1_000,
      }),
    }).catch(() => {})
    await waitFor(async () => await fileSize(probe) > 0)
    await server.close()
    const stoppedAt = await fileSize(probe)
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.equal(await fileSize(probe), stoppedAt)
  } finally {
    controller.abort()
    await server.close().catch(() => {})
  }
})
