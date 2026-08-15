import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPairingCode,
  hashPairingCode,
  createDeviceToken,
  isPairingCodeExpired,
} from '../src/pairing.js'

test('createPairingCode 是 8 位且不含易混字符', () => {
  const code = createPairingCode()
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/)
})

test('hashPairingCode 对同一暗号稳定且不等于明文', () => {
  const code = 'ABCD2345'
  const hashed = hashPairingCode(code)
  assert.equal(hashed, hashPairingCode(code))
  assert.notEqual(hashed, code)
  assert.equal(hashed.length, 64)
})

test('createDeviceToken 足够长且两次不同', () => {
  const a = createDeviceToken()
  const b = createDeviceToken()
  assert.ok(a.length >= 40)
  assert.notEqual(a, b)
})

test('暗号超过 10 分钟过期', () => {
  const createdAt = 1_000_000
  assert.equal(isPairingCodeExpired(createdAt, createdAt + 9 * 60 * 1000), false)
  assert.equal(isPairingCodeExpired(createdAt, createdAt + 10 * 60 * 1000 + 1), true)
})
