import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startHostd } from '../src/hostd/server.js'

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'hostd-pagination-'))

test('hostd 目录分页拒绝不会推进游标的零 limit', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const response = await fetch(`${server.url}/v1/files?limit=0`, {
      headers: { authorization: `Bearer ${paired.device_token}` },
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'DIRECTORY_PAGE_INVALID')
  } finally {
    await server.close()
  }
})
