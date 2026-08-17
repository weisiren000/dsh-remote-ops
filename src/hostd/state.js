import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createDeviceToken,
  createHostId,
  createPairingCode,
  hashPairingCode,
  isPairingCodeExpired,
} from '../pairing.js'
import { DEFAULT_PAIRING_TTL_MS } from '../protocol.js'
import { getDefaultHostdDataDir } from '../data-paths.js'

function resolveDialect(platform = process.platform) {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

function emptyRecord(hostId) {
  return {
    host_id: hostId,
    device_token_hash: null,
    pairing_code_hash: null,
    pairing_created_at: null,
  }
}

function hashesEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuf = Buffer.from(left, 'utf8')
  const rightBuf = Buffer.from(right, 'utf8')
  if (leftBuf.length !== rightBuf.length) return false
  return timingSafeEqual(leftBuf, rightBuf)
}

function writeHostJson(filePath, record) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tempPath, filePath)
}

function loadRecord(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (typeof parsed.host_id !== 'string' || parsed.host_id.length === 0) {
      throw new Error('invalid host.json: host_id')
    }
    return {
      host_id: parsed.host_id,
      device_token_hash: parsed.device_token_hash ?? null,
      pairing_code_hash: parsed.pairing_code_hash ?? null,
      pairing_created_at: parsed.pairing_created_at ?? null,
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

export async function createHostState(options = {}) {
  const dataDir = options.dataDir ?? getDefaultHostdDataDir()
  const now = options.now ?? Date.now
  const filePath = path.join(dataDir, 'host.json')
  await mkdir(dataDir, { recursive: true })
  let record = loadRecord(filePath)
  if (record === null) {
    record = emptyRecord(createHostId())
    writeHostJson(filePath, record)
  }

  const persist = () => {
    writeHostJson(filePath, record)
  }

  return {
    get hostId() {
      return record.host_id
    },
    issuePairingCode() {
      const code = createPairingCode()
      const createdAt = now()
      record.pairing_code_hash = hashPairingCode(code)
      record.pairing_created_at = createdAt
      persist()
      return {
        code,
        expiresAt: createdAt + DEFAULT_PAIRING_TTL_MS,
      }
    },
    pair(code) {
      if (
        typeof record.pairing_code_hash !== 'string'
        || record.pairing_created_at === null
      ) {
        throw new Error('pairing code is not available')
      }
      if (isPairingCodeExpired(record.pairing_created_at, now())) {
        throw new Error('pairing code expired')
      }
      if (!hashesEqual(record.pairing_code_hash, hashPairingCode(code))) {
        throw new Error('pairing code is invalid')
      }
      const deviceToken = createDeviceToken()
      record.device_token_hash = hashPairingCode(deviceToken)
      record.pairing_code_hash = null
      record.pairing_created_at = null
      persist()
      return {
        hostId: record.host_id,
        deviceToken,
        hostname: os.hostname(),
        dialect: resolveDialect(),
        cwd: process.cwd(),
      }
    },
    authenticate(token) {
      if (typeof record.device_token_hash !== 'string') return false
      return hashesEqual(record.device_token_hash, hashPairingCode(token))
    },
    revokeToken() {
      record.device_token_hash = null
      persist()
    },
  }
}
