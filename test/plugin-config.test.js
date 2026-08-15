import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../src/plugin/index.js'
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from '../src/protocol.js'

test('exports a Cordis-compatible config schema', () => {
  const validate = Config['~standard']?.validate

  assert.equal(typeof validate, 'function')
  const result = validate({})
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, {
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
  })
})
