import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostClient } from '../src/controller/client.js'

test('Host Client 将 SSH 重认证参数完整传给 SSH 客户端', async () => {
  let received
  const sshClient = {
    async reconnect(host, options) {
      received = { host, options }
      return { hostId: host.hostId, hostname: 'gateway-target' }
    },
    async dispose() {},
  }
  const client = createHostClient({ sshClient })
  const host = { hostId: 'ssh-host', transport: 'ssh', authMode: 'password_session' }
  const options = { password: 'memory-only-password', hostFingerprint: 'SHA256:new' }

  await client.reconnect(host, options)

  assert.deepEqual(received, { host, options })
})
