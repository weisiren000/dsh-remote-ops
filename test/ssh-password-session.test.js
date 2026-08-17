import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { createSshClient } from '../src/controller/ssh-client.js'

const { Server, utils } = ssh2
const PASSWORD = 'memory-only-password'
const USERNAME = 'tenant#user#asset'
const HOST_KEY = utils.generateKeyPairSync('rsa', { bits: 2048 }).private

function commandOutput(command) {
  if (command.startsWith('hostname;')) {
    return 'gateway-target\n__DSH_CWD__/srv/workspace\nLinux\n'
  }
  if (command === 'hostname') return 'gateway-target\n'
  return ''
}

async function startGatewayFixture({ rollbackExitCode = 0 } = {}) {
  const commands = []
  const attempts = []
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (context) => {
      attempts.push({ method: context.method, username: context.username })
      if (context.method === 'password' && context.password === PASSWORD) {
        context.accept()
        return
      }
      context.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _rejectExec, info) => {
          commands.push(info.command)
          const stream = acceptExec()
          const isRollback = info.command.includes('authorized_keys.dsh-tmp')
          stream.write(commandOutput(info.command))
          stream.exit(isRollback ? rollbackExitCode : 0)
          stream.end()
        })
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    attempts,
    commands,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function connectAfterTrust(client, port) {
  const input = { host: '127.0.0.1', port, username: USERNAME, password: PASSWORD }
  let fingerprint
  await assert.rejects(client.connect(input), (error) => {
    fingerprint = error.fingerprint
    return error.code === 'HOST_KEY_UNTRUSTED' && Boolean(fingerprint)
  })
  return client.connect({ ...input, hostFingerprint: fingerprint })
}

async function createFixture(options) {
  const server = await startGatewayFixture(options)
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-password-session-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  return {
    server,
    keysDir,
    client,
    async close() {
      await client.dispose()
      await server.close()
      await fs.rm(keysDir, { recursive: true, force: true })
    },
  }
}

test('网关拒绝专用私钥时回滚公钥并保留首次密码会话', async () => {
  const fixture = await createFixture()
  try {
    const host = await connectAfterTrust(fixture.client, fixture.server.port)
    assert.equal(host.authMode, 'password_session')
    assert.equal(host.privateKeyPath, undefined)
    assert.equal(host.sshUsername, USERNAME)
    assert.ok(fixture.server.attempts.some(({ method }) => method === 'publickey'))
    assert.ok(fixture.server.commands.some((command) => command.includes('authorized_keys.dsh-tmp')))
    assert.deepEqual(await fs.readdir(fixture.keysDir), [])

    const result = await fixture.client.exec(host, { command: 'hostname' })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'gateway-target\n')
  } finally {
    await fixture.close()
  }
})

test('专用私钥失败后的远端公钥回滚失败会返回明确错误', async () => {
  const fixture = await createFixture({ rollbackExitCode: 23 })
  try {
    await assert.rejects(connectAfterTrust(fixture.client, fixture.server.port), (error) => {
      assert.equal(error.code, 'SSH_KEY_ROLLBACK_FAILED')
      assert.doesNotMatch(error.message, new RegExp(PASSWORD))
      return true
    })
    assert.ok(fixture.server.commands.some((command) => command.includes('authorized_keys.dsh-tmp')))
    assert.deepEqual(await fs.readdir(fixture.keysDir), [])
  } finally {
    await fixture.close()
  }
})

test('password_session 断开后要求重新认证且密码重认证可恢复内存会话', async () => {
  const fixture = await createFixture()
  try {
    const host = await connectAfterTrust(fixture.client, fixture.server.port)
    await assert.rejects(fixture.client.reconnect(host), (error) => (
      error.code === 'SSH_REAUTH_REQUIRED'
    ))

    const live = await fixture.client.reconnect(host, { password: PASSWORD })
    assert.equal(live.hostname, 'gateway-target')
    assert.equal(live.hostId, host.hostId)
    assert.ok(fixture.server.attempts.filter(({ method }) => method === 'password').length >= 2)
  } finally {
    await fixture.close()
  }
})
