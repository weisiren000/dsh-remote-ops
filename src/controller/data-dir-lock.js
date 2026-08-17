import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const LOCK_FILE = '.controller.lock'
const defaultFs = { mkdir, open, readFile, rename, unlink }

function dataDirInUse(lockPath) {
  const error = new Error(`远程主机数据目录已被另一个 DSH 进程使用：${lockPath}`)
  error.code = 'DATA_DIR_IN_USE'
  return error
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function staleLock(lockPath, fsImpl) {
  const raw = await fsImpl.readFile(lockPath, 'utf8').catch(() => '')
  try {
    return !processAlive(JSON.parse(raw).pid)
  } catch {
    return false
  }
}

async function releaseOwnedLock(handle, lockPath, token, fsImpl) {
  await handle.close().catch(() => {})
  const raw = await fsImpl.readFile(lockPath, 'utf8').catch(() => '')
  let owned = false
  try {
    owned = JSON.parse(raw).token === token
  } catch {}
  if (owned) await fsImpl.unlink(lockPath).catch(() => {})
}

async function createLock(lockPath, fsImpl) {
  const token = randomUUID()
  const handle = await fsImpl.open(lockPath, 'wx')
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
  } catch (error) {
    // open('wx') 成功后写入失败：句柄必须关闭，并删除本次创建的残留锁文件，
    // 否则会留下空锁导致后续进程误判为已占用。
    await handle.close().catch(() => {})
    await fsImpl.unlink(lockPath).catch(() => {})
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await releaseOwnedLock(handle, lockPath, token, fsImpl)
  }
}

// 锁住完整控制器目录，避免多进程用各自内存快照覆盖主机记录。
// 第二个参数仅供测试注入 fs 实现，生产调用保持 acquireDataDirLock(dataDir)。
export async function acquireDataDirLock(dataDir, { fs = defaultFs } = {}) {
  await fs.mkdir(dataDir, { recursive: true })
  const lockPath = path.join(dataDir, LOCK_FILE)
  try {
    return await createLock(lockPath, fs)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  if (!(await staleLock(lockPath, fs))) throw dataDirInUse(lockPath)
  // stale 锁回收：用 rename 原子移走旧锁（并发进程只有一个能成功），再独占
  // 创建新锁。其余进程在 createLock 时要么 EEXIST（他人已建新锁）→
  // DATA_DIR_IN_USE，要么自己建锁后由他人的 EEXIST 分支判定为占用。
  // 直接 unlink 会在"删除后重建"窗口误删他人刚创建的新锁，导致双持有。
  const tombstone = path.join(dataDir, `${LOCK_FILE}.gc.${randomUUID()}`)
  await fs.rename(lockPath, tombstone).catch(() => {})
  try {
    return await createLock(lockPath, fs)
  } catch (error) {
    if (error?.code === 'EEXIST') throw dataDirInUse(lockPath)
    throw error
  } finally {
    // 尽力清理被移走的 stale 锁副本，失败可忽略（残留仅是无害垃圾文件）。
    await fs.unlink(tombstone).catch(() => {})
  }
}
