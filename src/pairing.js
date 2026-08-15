import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { DEFAULT_PAIRING_TTL_MS, PAIRING_CODE_ALPHABET } from './protocol.js'

const PAIRING_CODE_LENGTH = 8
const DEVICE_TOKEN_BYTES = 32

export function createPairingCode() {
  let code = ''
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]
  }
  return code
}

export function hashPairingCode(code) {
  return createHash('sha256').update(code).digest('hex')
}

export function createDeviceToken() {
  return randomBytes(DEVICE_TOKEN_BYTES).toString('base64url')
}

export function createHostId() {
  return randomUUID()
}

export function isPairingCodeExpired(createdAt, now, ttlMs = DEFAULT_PAIRING_TTL_MS) {
  return now - createdAt >= ttlMs
}
