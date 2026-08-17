import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireDataDirLock } from '../src/controller/data-dir-lock.js'

const LOCK_FILE = '.controller.lock'
const STALE_PID = 999_999_999

test('正常获取数据目录锁并在释放后删除锁文件', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-ok-'))
  const release = await acquireDataDirLock(dataDir)
  const lockPath = path.join(dataDir, LOCK_FILE)
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  assert.equal(lock.pid, process.pid)
  assert.ok(lock.token)
  await release()
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' })
})

test('已占用的数据目录返回 DATA_DIR_IN_USE', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-inuse-'))
  const release = await acquireDataDirLock(dataDir)
  try {
    await assert.rejects(acquireDataDirLock(dataDir), { code: 'DATA_DIR_IN_USE' })
  } finally {
    await release()
  }
})

test('stale 锁被回收并写入新锁', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-stale-'))
  const lockPath = path.join(dataDir, LOCK_FILE)
  await fs.writeFile(lockPath, JSON.stringify({ pid: STALE_PID, token: 'old' }), 'utf8')
  const release = await acquireDataDirLock(dataDir)
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  assert.notEqual(lock.token, 'old')
  await release()
})

test('stale 锁并发回收时失败的一方返回 DATA_DIR_IN_USE 而非 EEXIST', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-race-'))
  const lockPath = path.join(dataDir, LOCK_FILE)
  await fs.writeFile(lockPath, JSON.stringify({ pid: STALE_PID, token: 'old' }), 'utf8')
  const results = await Promise.allSettled([
    acquireDataDirLock(dataDir),
    acquireDataDirLock(dataDir),
  ])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'DATA_DIR_IN_USE')
  for (const result of fulfilled) await result.value()
})

test('stale 锁回收时第二次 createLock 的 EEXIST 转为 DATA_DIR_IN_USE', async () => {
  const dataDir = path.join(os.tmpdir(), 'dsh-lock-race-mock-')
  let opens = 0
  let renamed = 0
  const mockFs = {
    mkdir: async () => {},
    readFile: async () => JSON.stringify({ pid: STALE_PID, token: 'old' }),
    rename: async () => { renamed += 1 },
    unlink: async () => {},
    open: async () => {
      opens += 1
      throw Object.assign(new Error('lock exists'), { code: 'EEXIST' })
    },
  }
  await assert.rejects(acquireDataDirLock(dataDir, { fs: mockFs }), { code: 'DATA_DIR_IN_USE' })
  assert.equal(opens, 2)
  assert.equal(renamed, 1)
})

test('open 成功后 writeFile 失败会关闭句柄并删除残留锁文件', async () => {
  const dataDir = path.join(os.tmpdir(), 'dsh-lock-writefail-')
  const lockPath = path.join(dataDir, LOCK_FILE)
  const unlinked = []
  const closed = []
  const writeError = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  const mockFs = {
    mkdir: async () => {},
    readFile: async () => {
      throw Object.assign(new Error('no lock yet'), { code: 'ENOENT' })
    },
    unlink: async (target) => { unlinked.push(target) },
    open: async (target, flag) => {
      assert.equal(target, lockPath)
      assert.equal(flag, 'wx')
      return {
        writeFile: async () => { throw writeError },
        close: async () => { closed.push(true) },
      }
    },
  }
  await assert.rejects(acquireDataDirLock(dataDir, { fs: mockFs }), (error) => error === writeError)
  assert.equal(closed.length, 1)
  assert.deepEqual(unlinked, [lockPath])
})
