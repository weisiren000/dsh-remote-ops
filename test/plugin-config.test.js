import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Config, inject } from '../src/plugin/index.js'
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from '../src/protocol.js'
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/http-json.js'
import { DEFAULT_MAX_INLINE_OUTPUT_BYTES, DEFAULT_MAX_PROCESS_OUTPUT_BYTES } from '../src/output-limits.js'
import { DEFAULT_SFTP_LOCK_STALE_MS } from '../src/controller/sftp.js'
import { DEFAULT_MAX_JOB_LOG_BYTES } from '../src/controller/job-log-store.js'

test('exports a Cordis-compatible config schema', () => {
  const validate = Config['~standard']?.validate

  assert.equal(typeof validate, 'function')
  const result = validate({})
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, {
    dataDir: path.join(os.homedir(), '.dsh', 'remote-ssh-ops'),
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
    maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
    maxResponseBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
    maxInlineOutputBytes: DEFAULT_MAX_INLINE_OUTPUT_BYTES,
    maxProcessOutputBytes: DEFAULT_MAX_PROCESS_OUTPUT_BYTES,
    maxJobLogBytes: DEFAULT_MAX_JOB_LOG_BYTES,
    sftpLockStaleMs: DEFAULT_SFTP_LOCK_STALE_MS,
  })
})

test('配置拒绝无效的请求体上限', () => {
  const validate = Config['~standard'].validate
  assert.ok(validate({ maxRequestBodyBytes: 1023 }).issues?.length)
  assert.ok(validate({ maxRequestBodyBytes: 1024.5 }).issues?.length)
  assert.ok(validate({ maxResponseBodyBytes: 1023 }).issues?.length)
  assert.ok(validate({ maxResponseBodyBytes: 1024.5 }).issues?.length)
})

test('配置拒绝无效的输出上限', () => {
  const validate = Config['~standard'].validate
  assert.ok(validate({ maxInlineOutputBytes: 1023 }).issues?.length)
  assert.ok(validate({ maxProcessOutputBytes: 1023 }).issues?.length)
  assert.ok(validate({ maxInlineOutputBytes: 1024.5 }).issues?.length)
  assert.ok(validate({ maxProcessOutputBytes: 1024.5 }).issues?.length)
  assert.ok(validate({ maxJobLogBytes: 1023 }).issues?.length)
  assert.ok(validate({ maxJobLogBytes: 1024.5 }).issues?.length)
})

test('配置拒绝会错误抢占活跃 SFTP 条件写的短租约', () => {
  assert.ok(Config['~standard'].validate({ sftpLockStaleMs: 999 }).issues?.length)
  assert.ok(Config['~standard'].validate({ sftpLockStaleMs: 1000.5 }).issues?.length)
})

test('配置拒绝会退化成高频轮询的心跳间隔', () => {
  const validate = Config['~standard'].validate

  for (const heartbeatTimeoutMs of [-1, 0, 999]) {
    const result = validate({ heartbeatTimeoutMs })
    assert.ok(result.issues?.length, `${heartbeatTimeoutMs}ms 应被拒绝`)
  }
  assert.ok(validate({ heartbeatTimeoutMs: 1000.5 }).issues?.length)
})

test('插件把实际使用的 Web Server 声明为硬依赖', () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'webServer'])
})
