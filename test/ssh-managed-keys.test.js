import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import {
  DEFAULT_MAX_RECOVERY_KEYS,
  recoverManagedKeyConnection,
} from '../src/controller/ssh-managed-keys.js'

const { utils } = ssh2
const TARGET = { sshHost: 'remote.example', port: 22, username: 'tenant#user' }

function authFailed() {
  const error = new Error('SSH 身份认证失败')
  error.code = 'SSH_AUTH_FAILED'
  return error
}

async function keysDirWith(names) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-managed-keys-'))
  const candidates = []
  for (const hostId of names) {
    const key = utils.generateKeyPairSync('ed25519', { comment: `test-${hostId}` })
    const privateKeyPath = path.join(dir, `${hostId}.key`)
    await fs.writeFile(privateKeyPath, key.private, { encoding: 'utf8', mode: 0o600 })
    candidates.push({ hostId, privateKeyPath })
  }
  return { dir, candidates }
}

test('无托管密钥时恢复返回 null 且不尝试连接', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-managed-keys-empty-'))
  try {
    let opened = 0
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      openConnection: async () => { opened += 1; throw authFailed() },
      inspectRemote: async () => { throw new Error('unreachable') },
    })
    assert.equal(result, null)
    assert.equal(opened, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('恢复连接最多尝试 maxKeys 个密钥', async () => {
  const { dir } = await keysDirWith(['host-a', 'host-b', 'host-c', 'host-d', 'host-e'])
  try {
    const attempts = []
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      maxKeys: 2,
      openConnection: async (config) => {
        attempts.push(config.privateKey)
        throw authFailed()
      },
      inspectRemote: async () => { throw new Error('unreachable') },
    })
    assert.equal(result, null)
    assert.equal(attempts.length, 2)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('未指定 maxKeys 时使用默认尝试上限', async () => {
  const { dir } = await keysDirWith(['host-a', 'host-b', 'host-c', 'host-d'])
  try {
    const attempts = []
    await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      openConnection: async () => {
        attempts.push(true)
        throw authFailed()
      },
      inspectRemote: async () => { throw new Error('unreachable') },
    })
    assert.equal(attempts.length, DEFAULT_MAX_RECOVERY_KEYS)
    assert.ok(DEFAULT_MAX_RECOVERY_KEYS > 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('跳过无法解析的密钥文件且不消耗尝试次数', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-managed-keys-invalid-'))
  try {
    await fs.writeFile(path.join(dir, 'broken.key'), 'not-a-private-key', 'utf8')
    const key = utils.generateKeyPairSync('ed25519', { comment: 'test-good' })
    await fs.writeFile(path.join(dir, 'good.key'), key.private, 'utf8')
    const attempts = []
    const opened = { connection: { id: 'conn' } }
    const remote = { hostname: 'remote' }
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      maxKeys: 1,
      openConnection: async (config) => {
        attempts.push(config.privateKey)
        return opened
      },
      inspectRemote: async (connection) => {
        assert.equal(connection, opened.connection)
        return remote
      },
    })
    assert.equal(result.hostId, 'good')
    assert.equal(result.opened, opened)
    assert.equal(result.remote, remote)
    assert.equal(attempts.length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('密钥认证失败后继续尝试下一个托管密钥', async () => {
  const { dir, candidates } = await keysDirWith(['host-a', 'host-b', 'host-c'])
  try {
    const attempts = []
    const opened = { connection: { id: 'conn' } }
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      maxKeys: 3,
      openConnection: async () => {
        attempts.push(true)
        if (attempts.length < 2) throw authFailed()
        return opened
      },
      inspectRemote: async () => ({ hostname: 'remote' }),
    })
    assert.equal(attempts.length, 2)
    assert.equal(result.hostId, candidates[1].hostId)
    assert.equal(result.privateKeyPath, candidates[1].privateKeyPath)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('恢复遇到 HOST_KEY_CHANGED 时原样抛出且不再尝试后续密钥', async () => {
  const { dir } = await keysDirWith(['host-a', 'host-b'])
  try {
    const changed = Object.assign(new Error('SSH 指纹与已保存记录不一致'), {
      code: 'HOST_KEY_CHANGED',
      fingerprint: 'SHA256:new',
    })
    let attempts = 0
    await assert.rejects(recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      openConnection: async () => {
        attempts += 1
        throw changed
      },
      inspectRemote: async () => { throw new Error('unreachable') },
    }), (error) => error === changed && error.code === 'HOST_KEY_CHANGED')
    assert.equal(attempts, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('恢复时远程检查失败会原样抛出 SSH_INSPECT_FAILED', async () => {
  const { dir } = await keysDirWith(['host-a'])
  try {
    const inspectError = Object.assign(new Error('无法读取远程主机信息'), {
      code: 'SSH_INSPECT_FAILED',
    })
    await assert.rejects(recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      openConnection: async () => ({
        connection: { id: 'conn', end() {} },
        fingerprint: 'SHA256:fp',
      }),
      inspectRemote: async () => { throw inspectError },
    }), (error) => error === inspectError)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('远程检查失败时立即关闭已建立的连接，避免泄漏临时 SSH 连接', async () => {
  const { dir } = await keysDirWith(['host-a'])
  try {
    const inspectError = Object.assign(new Error('无法读取远程主机信息'), {
      code: 'SSH_INSPECT_FAILED',
    })
    let closed = 0
    await assert.rejects(recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      openConnection: async () => ({
        connection: { id: 'conn', end() { closed += 1 } },
        fingerprint: 'SHA256:fp',
      }),
      inspectRemote: async () => { throw inspectError },
    }), (error) => error === inspectError)
    assert.equal(closed, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('远程检查报认证失败时同样关闭连接后再尝试下一个密钥', async () => {
  const { dir, candidates } = await keysDirWith(['host-a', 'host-b'])
  try {
    const closed = []
    const attempts = []
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      maxKeys: 3,
      openConnection: async () => {
        attempts.push(true)
        return { connection: { id: `conn-${attempts.length}`, end() { closed.push(attempts.length) } } }
      },
      inspectRemote: async () => {
        if (attempts.length === 1) throw authFailed()
        return { hostname: 'remote' }
      },
    })
    assert.equal(attempts.length, 2)
    assert.equal(result.hostId, candidates[1].hostId)
    assert.deepEqual(closed, [1])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('maxKeys 为 0 时不尝试任何密钥', async () => {
  const { dir } = await keysDirWith(['host-a', 'host-b'])
  try {
    let opened = 0
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      maxKeys: 0,
      openConnection: async () => { opened += 1; throw authFailed() },
      inspectRemote: async () => { throw new Error('unreachable') },
    })
    assert.equal(result, null)
    assert.equal(opened, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('全部密钥认证失败时返回 null', async () => {
  const { dir } = await keysDirWith(['host-a', 'host-b'])
  try {
    const result = await recoverManagedKeyConnection({
      keysDir: dir,
      target: TARGET,
      hostFingerprint: 'SHA256:fp',
      openConnection: async () => { throw authFailed() },
      inspectRemote: async () => { throw new Error('unreachable') },
    })
    assert.equal(result, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
