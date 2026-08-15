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

test('API 错误保留服务端错误码和附加字段', async () => {
  const client = createSettingsClient(async () => response({ error: 'fingerprint changed', code: 'HOST_KEY_CHANGED', fingerprint: 'abc' }, false))
  await assert.rejects(client.health('h1'), (error) => {
    assert.equal(error.code, 'HOST_KEY_CHANGED')
    assert.equal(error.fingerprint, 'abc')
    return true
  })
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
