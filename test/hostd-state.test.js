import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHostState } from '../src/hostd/state.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hostd-state-'))
}

test('首次启动生成稳定 host_id，重启保持不变', async () => {
  const dataDir = await tempDir()
  const first = await createHostState({ dataDir })
  const second = await createHostState({ dataDir })
  assert.equal(second.hostId, first.hostId)
})

test('暗号配对一次成功，第二次失败，旧令牌在重新配对后失效', async () => {
  const dataDir = await tempDir()
  let now = 1_000_000
  const state = await createHostState({ dataDir, now: () => now })
  const { code } = state.issuePairingCode()
  const first = state.pair(code)
  assert.equal(state.authenticate(first.deviceToken), true)
  assert.throws(() => state.pair(code), /pairing code/)

  const next = state.issuePairingCode()
  const second = state.pair(next.code)
  assert.equal(state.authenticate(first.deviceToken), false)
  assert.equal(state.authenticate(second.deviceToken), true)
})

test('过期暗号不能配对', async () => {
  const dataDir = await tempDir()
  let now = 1_000_000
  const state = await createHostState({ dataDir, now: () => now })
  const { code } = state.issuePairingCode()
  now += 10 * 60 * 1000 + 1
  assert.throws(() => state.pair(code), /expired/)
})
