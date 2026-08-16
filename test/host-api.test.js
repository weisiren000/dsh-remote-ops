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
      url: '/remote-ops/v1/hosts/pair',
      body: { address: hostd.url, pairing_code: hostd.pairingCode, display_name: 'alpha' },
    }), pairRes)
    assert.equal(pairRes.statusCode, 200)
    assert.equal(pairRes.body.display_name, 'alpha')
    assert.equal(pairRes.body.device_token, undefined)

    const listRes = mockRes()
    await handle(mockReq({ method: 'GET', url: '/remote-ops/v1/hosts' }), listRes)
    assert.equal(listRes.statusCode, 200)
    assert.equal(listRes.body.hosts[0].host_id, pairRes.body.host_id)
    assert.equal(listRes.body.hosts[0].device_token, undefined)

    const denied = mockRes()
    await handle(mockReq({
      method: 'GET',
      url: '/remote-ops/v1/hosts',
      address: '10.0.0.8',
    }), denied)
    assert.equal(denied.statusCode, 403)
  } finally {
    await hostd.close()
  }
})

test('可改显示名、切目标、删除本机记录', async () => {
  const { hostd, handle } = await boot()
  try {
    const paired = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: '/remote-ops/v1/hosts/pair',
      body: { address: hostd.url, pairing_code: hostd.pairingCode },
    }), paired)
    const hostId = paired.body.host_id

    const updated = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: `/remote-ops/v1/hosts/${hostId}`,
      body: { display_name: 'prod' },
    }), updated)
    assert.equal(updated.body.display_name, 'prod')

    const used = mockRes()
    await handle(mockReq({
      method: 'POST',
      url: `/remote-ops/v1/hosts/${hostId}/use`,
    }), used)
    assert.equal(used.body.current, true)

    const removed = mockRes()
    await handle(mockReq({
      method: 'DELETE',
      url: `/remote-ops/v1/hosts/${hostId}`,
    }), removed)
    assert.equal(removed.body.ok, true)

    const listed = mockRes()
    await handle(mockReq({ method: 'GET', url: '/remote-ops/v1/hosts' }), listed)
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
    await handle(mockReq({ method: 'GET', url: `/remote-ops/v1/hosts/h1/files?${query}` }), response)
    assert.equal(response.statusCode, 400, query)
    assert.equal(response.body.code, 'PAGE_PARAMETER_INVALID', query)
  }
  assert.equal(listCalls, 0)
})
