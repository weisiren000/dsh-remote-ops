import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsClient, reduceHostsState } from '../src/plugin/client-api.js'

function response(body, ok = true) {
  return { ok, json: async () => body }
}

test('加载失败不冲掉已有列表', () => {
  const state = {
    error: null,
    hosts: [{ host_id: 'h1', display_name: 'one' }],
    currentHostId: 'h1',
  }
  const next = reduceHostsState(state, { type: 'load-error', message: 'loopback only' })
  assert.equal(next.error, 'loopback only')
  assert.equal(next.hosts[0].host_id, 'h1')
})

test('配对成功写入列表并在标记当前时切换目标', () => {
  const state = { error: 'old', hosts: [], currentHostId: null }
  const next = reduceHostsState(state, {
    type: 'paired',
    host: { host_id: 'h2', display_name: 'two', current: true },
  })
  assert.equal(next.error, null)
  assert.equal(next.currentHostId, 'h2')
  assert.equal(next.hosts[0].host_id, 'h2')
})

test('运维 API 使用统一路径并传递任务筛选与日志尾部参数', async () => {
  const calls = []
  const client = createSettingsClient(async (url, options) => {
    calls.push({ url, options })
    return response({ jobs: [], log: 'tail' })
  })
  await client.reconnect('host/1')
  await client.diagnose('host/1')
  await client.health('host/1')
  await client.jobs('host/1', { status: 'running', from: '' })
  await client.cancel('job/1')
  await client.log('job/1', 32)
  assert.equal(calls[0].url, '/remote-ops/v1/hosts/host%2F1/reconnect')
  assert.equal(calls[1].url, '/remote-ops/v1/hosts/host%2F1/diagnose')
  assert.equal(calls[2].url, '/remote-ops/v1/hosts/host%2F1/health')
  assert.equal(calls[3].url, '/remote-ops/v1/hosts/host%2F1/jobs?status=running')
  assert.equal(calls[4].options.method, 'POST')
  assert.equal(calls[5].url, '/remote-ops/v1/jobs/job%2F1/log?tail=32')
})

test('SSH password_session 重认证只临时提交密码和可选指纹', async () => {
  let request
  const client = createSettingsClient(async (url, options) => {
    request = { url, options }
    return response({ ok: true })
  })

  await client.reconnect('host/1', { hostFingerprint: 'SHA256:new', password: 'memory-only-password' })

  assert.equal(request.url, '/remote-ops/v1/hosts/host%2F1/reconnect')
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), {
    host_fingerprint: 'SHA256:new',
    password: 'memory-only-password',
  })
})

test('API 错误保留服务端错误码和附加字段', async () => {
  const client = createSettingsClient(async () => response({ error: 'fingerprint changed', code: 'HOST_KEY_CHANGED', fingerprint: 'abc' }, false))
  await assert.rejects(client.health('h1'), (error) => {
    assert.equal(error.code, 'HOST_KEY_CHANGED')
    assert.equal(error.fingerprint, 'abc')
    return true
  })
})

test('SSH 直连 JSON 完整保留包含多个 # 的用户名', async () => {
  let request
  const client = createSettingsClient(async (url, options) => {
    request = { url, options }
    return response({ host_id: 'ssh-host' })
  })

  await client.ssh({
    host: '1.180.205.130',
    port: 2222,
    username: 'tenant#user#remote',
    password: 'memory-only-password',
  })

  assert.equal(request.url, '/remote-ops/v1/hosts/ssh')
  assert.equal(JSON.parse(request.options.body).username, 'tenant#user#remote')
})

test('工作区 API 使用编码路径和 snake_case 请求字段', async () => {
  const calls = []
  const client = createSettingsClient(async (url, options) => {
    calls.push({ url, options })
    return response({ entries: [], content: '', changes: [] })
  })
  await client.listFiles('h/1', '/srv/app')
  await client.readFile('h/1', '/srv/app/main.js')
  await client.writeFile('h/1', { path: '/srv/app/main.js', content: 'next', beforeContent: 'old', expectedVersion: 'sha256:x', source: 'ai' })
  await client.terminal('h/1', { command: 'pwd', timeoutMs: 1000 })
  await client.changes('h/1', { status: 'pending' })
  await client.reviewChange('c/1', 'accept')
  assert.equal(calls[0].url, '/remote-ops/v1/hosts/h%2F1/files?path=%2Fsrv%2Fapp')
  assert.equal(calls[1].url, '/remote-ops/v1/hosts/h%2F1/file?path=%2Fsrv%2Fapp%2Fmain.js')
  const writeBody = JSON.parse(calls[2].options.body)
  assert.equal(writeBody.before_content, 'old')
  assert.equal(writeBody.expected_version, 'sha256:x')
  assert.equal(JSON.parse(calls[3].options.body).timeout_ms, 1000)
  assert.equal(calls[4].url, '/remote-ops/v1/hosts/h%2F1/changes?status=pending')
  assert.equal(calls[5].url, '/remote-ops/v1/changes/c%2F1/accept')
})

test('文件传输 API 使用二进制请求并上报上传进度', async () => {
  const requests = []
  const progress = []
  const client = createSettingsClient(fetch, () => {
    const request = {
      upload: {},
      open(method, url) { requests.push({ method, url, request: this }) },
      send(body) {
        requests.at(-1).body = body
        this.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 4 })
        this.status = 200
        this.response = { path: '/srv/archive.bin', size: 4 }
        this.onload?.()
      },
    }
    return request
  })
  const file = new Blob([Buffer.from([0, 1, 2, 255])])

  const result = await client.uploadFile('h/1', '/srv/archive.bin', file, (value) => progress.push(value))

  assert.equal(requests[0].method, 'PUT')
  assert.equal(requests[0].url, '/remote-ops/v1/hosts/h%2F1/transfer?path=%2Fsrv%2Farchive.bin')
  assert.equal(requests[0].body, file)
  assert.deepEqual(progress, [{ loaded: 3, total: 4, percent: 75 }])
  assert.equal(result.size, 4)
  assert.equal(client.downloadUrl('h/1', '/srv/archive.bin'), '/remote-ops/v1/hosts/h%2F1/transfer?path=%2Fsrv%2Farchive.bin')
})

test('上传开始前已取消时立即返回取消错误', async () => {
  let sent = false
  const client = createSettingsClient(fetch, () => ({
    upload: {},
    open() {},
    abort() {},
    send() { sent = true },
  }))
  const controller = new AbortController()
  controller.abort()

  const result = await Promise.race([
    client.uploadFile('h1', '/srv/archive.bin', new Blob(), null, controller.signal)
      .then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 25)),
  ])

  assert.equal(result, 'TRANSFER_ABORTED')
  assert.equal(sent, false)
})
