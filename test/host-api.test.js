import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startHostd } from '../src/hostd/server.js'
import { createControllerStore } from '../src/controller/store.js'
import { createHostClient } from '../src/controller/client.js'
import { createRunner } from '../src/controller/runner.js'
import { createHostApiHandler } from '../src/host-api.js'

function mockReq({ method, url, address = '127.0.0.1', body }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.socket = { remoteAddress: address }
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  }
  return req
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    writeHead(status) {
      this.statusCode = status
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null
    },
  }
  return res
}

async function boot() {
  const hostd = await startHostd({
    dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-api-')),
    listen: '127.0.0.1:0',
    allowInsecure: true,
  })
  const store = await createControllerStore(await fs.mkdtemp(path.join(os.tmpdir(), 'ctrl-api-')))
  const runner = createRunner({
    store,
    client: createHostClient({ allowInsecureLoopback: true }),
  })
  const handle = createHostApiHandler({ runner })
  return { hostd, store, runner, handle }
}

test('回环可配对，列表不含 token，非回环拒绝', async () => {
  const { hostd, handle } = await boot()
  try {
    const pairRes = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: '/remote-ssh-ops/v1/hosts/pair',
      body: { address: hostd.url, pairing_code: hostd.pairingCode, display_name: 'alpha' },
    }), pairRes)
    assert.equal(pairRes.statusCode, 200)
    assert.equal(pairRes.body.display_name, 'alpha')
    assert.equal(pairRes.body.device_token, undefined)

    const listRes = mockRes()
    await handle(mockReq({ method: 'GET', url: '/remote-ssh-ops/v1/hosts' }), listRes)
    assert.equal(listRes.statusCode, 200)
    assert.equal(listRes.body.hosts[0].host_id, pairRes.body.host_id)
    assert.equal(listRes.body.hosts[0].device_token, undefined)

    const denied = mockRes()
    await handle(mockReq({
      method: 'GET',
      url: '/remote-ssh-ops/v1/hosts',
      address: '10.0.0.8',
    }), denied)
    assert.equal(denied.statusCode, 403)
  } finally {
    await hostd.close()
  }
})

test('旧 API 路径不再命中插件接口', async () => {
  let listCalled = false
  const handle = createHostApiHandler({
    runner: {
      async list() {
        listCalled = true
        return []
      },
    },
  })
  const response = mockRes()
  const legacyPath = `/${['remote', 'ops'].join('-')}/v1/hosts`

  await handle(mockReq({ method: 'GET', url: legacyPath }), response)

  assert.equal(response.statusCode, 404)
  assert.equal(response.body.code, 'NOT_FOUND')
  assert.equal(listCalled, false)
})

test('Host API 默认错误码使用统一项目标识', async () => {
  const handle = createHostApiHandler({
    runner: {
      async list() {
        throw new Error('temporary failure')
      },
    },
  })
  const response = mockRes()

  await handle(mockReq({ method: 'GET', url: '/remote-ssh-ops/v1/hosts' }), response)

  assert.equal(response.statusCode, 400)
  assert.equal(response.body.code, 'REMOTE_SSH_OPS_ERROR')
})

test('可改显示名、切目标、删除本机记录', async () => {
  const { hostd, handle } = await boot()
  try {
    const paired = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: '/remote-ssh-ops/v1/hosts/pair',
      body: { address: hostd.url, pairing_code: hostd.pairingCode },
    }), paired)
    const hostId = paired.body.host_id

    const updated = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: `/remote-ssh-ops/v1/hosts/${hostId}`,
      body: { display_name: 'prod' },
    }), updated)
    assert.equal(updated.body.display_name, 'prod')

    const used = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: `/remote-ssh-ops/v1/hosts/${hostId}/use`,
    }), used)
    assert.equal(used.body.current, true)

    const removed = mockRes()
    await handle(mockReq({
      method: 'DELETE',
      url: `/remote-ssh-ops/v1/hosts/${hostId}`,
    }), removed)
    assert.equal(removed.body.ok, true)

    const listed = mockRes()
    await handle(mockReq({ method: 'GET', url: '/remote-ssh-ops/v1/hosts' }), listed)
    assert.equal(listed.body.hosts.length, 0)
  } finally {
    await hostd.close()
  }
})

test('文件分页拒绝 NaN、小数和负数参数', async () => {
  let listCalls = 0
  const handle = createHostApiHandler({
    runner: {
      async listFiles() { listCalls += 1; return { hostId: 'h1', path: '/', entries: [] } },
    },
  })
  for (const query of ['limit=NaN', 'limit=1.5', 'limit=-1', 'offset=NaN', 'offset=1.5', 'offset=-1']) {
    const response = mockRes()
    await handle(mockReq({ method: 'GET', url: `/remote-ssh-ops/v1/hosts/h1/files?${query}` }), response)
    assert.equal(response.statusCode, 400, query)
    assert.equal(response.body.code, 'PAGE_PARAMETER_INVALID', query)
  }
  assert.equal(listCalls, 0)
})

test('SSH 直连从 JSON 到控制器完整保留包含多个 # 的用户名', async () => {
  let received
  const handle = createHostApiHandler({
    runner: {
      async connectSsh(input) {
        received = input
        return {
          hostId: 'ssh-host',
          displayName: 'SSH host',
          address: 'ssh://127.0.0.1:2222',
          transport: 'ssh',
          sshUsername: input.username,
          online: true,
        }
      },
      getCurrentHost() { return null },
    },
  })
  const response = mockRes()

  await handle(mockReq({
    method: 'POST',
    url: '/remote-ssh-ops/v1/hosts/ssh',
    body: {
      host: '127.0.0.1',
      port: 2222,
      username: 'tenant#user#remote',
      password: 'memory-only-password',
    },
  }), response)

  assert.equal(response.statusCode, 200)
  assert.equal(received.username, 'tenant#user#remote')
  assert.equal(response.body.ssh_username, 'tenant#user#remote')
})

test('无法自动处理的 SSH 交互式认证返回 401 和专用错误码', async () => {
  const handle = createHostApiHandler({
    runner: {
      async connectSsh() {
        throw Object.assign(new Error('服务器要求无法自动处理的交互式认证'), {
          code: 'SSH_INTERACTIVE_AUTH_UNSUPPORTED',
        })
      },
    },
  })
  const response = mockRes()

  await handle(mockReq({
    method: 'POST',
    url: '/remote-ssh-ops/v1/hosts/ssh',
    body: { host: '127.0.0.1', port: 22, username: 'user', password: 'secret' },
  }), response)

  assert.equal(response.statusCode, 401)
  assert.equal(response.body.code, 'SSH_INTERACTIVE_AUTH_UNSUPPORTED')
})

test('服务器无可用 SSH 认证方式返回 401 和准确错误码', async () => {
  const handle = createHostApiHandler({
    runner: {
      async connectSsh() {
        throw Object.assign(new Error('服务器未开放可用的 SSH 认证方式'), {
          code: 'SSH_NO_AUTH_METHODS',
        })
      },
    },
  })
  const response = mockRes()

  await handle(mockReq({
    method: 'POST',
    url: '/remote-ssh-ops/v1/hosts/ssh',
    body: { host: '127.0.0.1', port: 22, username: 'user', password: 'secret' },
  }), response)

  assert.equal(response.statusCode, 401)
  assert.equal(response.body.code, 'SSH_NO_AUTH_METHODS')
})

test('SSH 重认证透传临时密码并返回认证模式，不把密码回显到主机数据', async () => {
  let received
  const handle = createHostApiHandler({
    runner: {
      async reconnectHost(hostId, options) {
        received = { hostId, options }
        return {
          hostId,
          displayName: 'gateway host',
          transport: 'ssh',
          authMode: 'password_session',
          sshUsername: 'tenant#user#asset',
          password: 'must-not-return',
          online: true,
        }
      },
      getCurrentHost() { return null },
    },
  })
  const response = mockRes()

  await handle(mockReq({
    method: 'POST',
    url: '/remote-ssh-ops/v1/hosts/ssh-host/reconnect',
    body: { host_fingerprint: 'SHA256:new', password: 'memory-only-password' },
  }), response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(received, {
    hostId: 'ssh-host',
    options: { hostFingerprint: 'SHA256:new', password: 'memory-only-password' },
  })
  assert.equal(response.body.auth_mode, 'password_session')
  assert.equal(response.body.password, undefined)
})

test('SSH 会话丢失返回 401 和重新认证错误码', async () => {
  const handle = createHostApiHandler({
    runner: {
      async reconnectHost() {
        throw Object.assign(new Error('SSH 会话已断开，请重新输入登录密码'), {
          code: 'SSH_REAUTH_REQUIRED',
        })
      },
    },
  })
  const response = mockRes()

  await handle(mockReq({
    method: 'POST',
    url: '/remote-ssh-ops/v1/hosts/ssh-host/reconnect',
    body: {},
  }), response)

  assert.equal(response.statusCode, 401)
  assert.equal(response.body.code, 'SSH_REAUTH_REQUIRED')
})
