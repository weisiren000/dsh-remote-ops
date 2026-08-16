import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Config, inject } from '../src/plugin/index.js'
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from '../src/protocol.js'

test('exports a Cordis-compatible config schema', () => {
  const validate = Config['~standard']?.validate

  assert.equal(typeof validate, 'function')
  const result = validate({})
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, {
    dataDir: path.join(os.homedir(), '.dsh', 'remote-ops'),
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  })
})

test('配置拒绝会退化成高频轮询的心跳间隔', () => {
  const validate = Config['~standard'].validate

  for (const heartbeatTimeoutMs of [-1, 0, 999]) {
    const result = validate({ heartbeatTimeoutMs })
    assert.ok(result.issues?.length, `${heartbeatTimeoutMs}ms 应被拒绝`)
  }
})

test('插件把实际使用的 Web Server 声明为硬依赖', () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer'])
})
