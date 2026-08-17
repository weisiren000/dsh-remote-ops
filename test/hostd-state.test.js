import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createHostState } from '../src/hostd/state.js'

const execFileAsync = promisify(execFile)

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hostd-state-'))
}

test('hostd 默认数据写入新项目目录', async () => {
  const fakeHome = await tempDir()
  const stateUrl = new URL('../src/hostd/state.js', import.meta.url).href
  const script = `import { createHostState } from ${JSON.stringify(stateUrl)}; await createHostState()`

  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  })

  await fs.access(path.join(fakeHome, '.dsh', 'remote-ssh-ops', 'hostd', 'host.json'))
  await assert.rejects(
    fs.access(path.join(fakeHome, '.dsh', 'remote-ops', 'hostd', 'host.json')),
    { code: 'ENOENT' },
  )
})

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
