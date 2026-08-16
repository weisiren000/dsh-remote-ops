import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createKeyedLock } from '../async-key-lock.js'
import { createTransferCounter } from '../file-transfer.js'

const MAX_REMOTE_FILE_BYTES = 10 * 1024 * 1024
export const DEFAULT_SFTP_LOCK_STALE_MS = 30 * 60 * 1000
const connectionLocks = new WeakMap()

function codedError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function validateRemotePath(remotePath) {
  const value = String(remotePath ?? '').trim()
  if (!value || value.includes('\0')) {
    throw codedError('REMOTE_PATH_INVALID', '远程文件路径不能为空且不能包含 NUL 字符')
  }
  return value
}

function openSftp(connection) {
  return new Promise((resolve, reject) => {
    connection.sftp((error, sftp) => {
      if (error) reject(codedError('SSH_SFTP_FAILED', error.message || '无法打开 SSH SFTP 通道', { cause: error }))
      else resolve(sftp)
    })
  })
}

function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, ...result) => {
      if (error) reject(error)
      else resolve(result.length > 1 ? result : result[0])
    })
  })
}

function closeSftp(sftp) {
  sftp.end?.()
}

function sftpError(error, message) {
  if (error?.code === 'REMOTE_PATH_INVALID' || error?.code === 'REMOTE_FILE_TOO_LARGE' || error?.code === 'REMOTE_FILE_CONFLICT' || error?.code === 'REMOTE_FILE_BUSY' || error?.code === 'REMOTE_FILE_LOCK_STALE') return error
  return codedError('SSH_SFTP_FAILED', error?.message || message, { cause: error })
}

function contentVersion(content) {
  return createHash('sha256').update(content).digest('hex')
}

function withFileLock(connection, remotePath, task) {
  let lock = connectionLocks.get(connection)
  if (!lock) {
    lock = createKeyedLock()
    connectionLocks.set(connection, lock)
  }
  return lock(remotePath, task)
}

function isExistsError(error) {
  const code = error?.code
  return code === 'EEXIST' || code === 4 || /exist|already|failure/i.test(error?.message ?? '')
}

async function createRemoteLock(sftp, lockPath, token) {
  const handle = await call(sftp, 'open', lockPath, 'wx', 0o600)
  try {
    const content = Buffer.from(token, 'utf8')
    await new Promise((resolve, reject) => {
      sftp.write(handle, content, 0, content.length, 0, (error, count) => {
        if (error) reject(error)
        else if (count !== content.length) reject(codedError('SSH_SFTP_FAILED', '远程锁 owner 写入不完整'))
        else resolve()
      })
    })
  } finally {
    await call(sftp, 'close', handle).catch(() => {})
  }
}

async function readRemoteLockOwner(sftp, lockPath) {
  const attrs = await call(sftp, 'stat', lockPath)
  const size = Number(attrs?.size ?? 0)
  if (!Number.isSafeInteger(size) || size < 1 || size > 1024) return null
  const handle = await call(sftp, 'open', lockPath, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const count = await new Promise((resolve, reject) => {
      sftp.read(handle, buffer, 0, size, 0, (error, bytes) => error ? reject(error) : resolve(bytes))
    })
    return buffer.subarray(0, count).toString('utf8')
  } finally {
    await call(sftp, 'close', handle).catch(() => {})
  }
}

function lockAge(attrs, now) {
  const modifiedAt = Number(attrs?.mtime) * 1000
  return Number.isFinite(modifiedAt) ? now - modifiedAt : Number.NaN
}

async function assertRemoteLockOwner(sftp, lockPath, token) {
  const current = await readRemoteLockOwner(sftp, lockPath).catch(() => null)
  if (current === token) return
  throw codedError('REMOTE_FILE_BUSY', '远程条件写锁所有权已丢失')
}

async function releaseOwnedRemoteLock(sftp, lockPath, token) {
  const current = await readRemoteLockOwner(sftp, lockPath).catch(() => null)
  if (current === token) await call(sftp, 'unlink', lockPath).catch(() => {})
}

async function throwExistingLock(sftp, lockPath, staleMs, options, cause) {
  const attrs = await call(sftp, 'stat', lockPath).catch(() => null)
  const age = lockAge(attrs, options.now?.() ?? Date.now())
  if (Number.isFinite(age) && age > staleMs) {
    throw codedError(
      'REMOTE_FILE_LOCK_STALE',
      `远程条件写存在陈旧锁 ${lockPath}；确认没有活跃控制器后，使用已审批的 host_bash 手工删除`,
      { cause, lockPath },
    )
  }
  throw codedError('REMOTE_FILE_BUSY', '远程文件正在被其他条件写操作修改', { cause })
}

function ownedRemoteLock(sftp, lockPath, token) {
  return {
    assertOwner: () => assertRemoteLockOwner(sftp, lockPath, token),
    release: () => releaseOwnedRemoteLock(sftp, lockPath, token),
  }
}

async function acquireRemoteLock(sftp, lockPath, options = {}) {
  const staleMs = options.staleMs ?? DEFAULT_SFTP_LOCK_STALE_MS
  if (!Number.isSafeInteger(staleMs) || staleMs < 1000) {
    throw codedError('SFTP_LOCK_CONFIG_INVALID', 'SFTP 条件写锁租约必须至少为 1000ms')
  }
  const token = randomUUID()
  const reclaimPath = `${lockPath}.reclaim`
  const reclaimExists = await call(sftp, 'stat', reclaimPath).then(() => true, () => false)
  if (reclaimExists) await throwExistingLock(sftp, reclaimPath, staleMs, options)
  try {
    await createRemoteLock(sftp, lockPath, token)
  } catch (error) {
    if (!isExistsError(error)) throw error
    await throwExistingLock(sftp, lockPath, staleMs, options, error)
  }
  return ownedRemoteLock(sftp, lockPath, token)
}

async function currentSftpVersion(connection, pathValue) {
  try {
    const current = await readSftpFile(connection, pathValue)
    return contentVersion(Buffer.from(current.content, 'utf8'))
  } catch (error) {
    const code = error?.cause?.code ?? error?.code
    if (code === 2 || code === 'ENOENT' || /no such file|not found/i.test(error?.message ?? '')) return null
    throw error
  }
}

function assertExpectedVersion(expectedVersion, currentVersion) {
  if (expectedVersion === undefined || expectedVersion === currentVersion) return
  throw codedError('REMOTE_FILE_CONFLICT', '远程文件已发生变化', {
    expectedVersion,
    currentVersion,
  })
}

async function replaceRemoteFile(sftp, temporaryPath, targetPath) {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      await call(sftp, 'ext_openssh_rename', temporaryPath, targetPath)
      return
    } catch (error) {
      if (!/does not support this extended request/i.test(error?.message ?? '')) throw error
    }
  }
  await call(sftp, 'rename', temporaryPath, targetPath)
}

function mapSftpEntry(pathValue, entry) {
  return {
    name: entry.filename,
    path: path.posix.join(pathValue, entry.filename),
    type: entry.attrs?.isDirectory?.() ? 'directory' : 'file',
    size: entry.attrs?.size ?? 0,
    mtime: entry.attrs?.mtime ? entry.attrs.mtime * 1000 : null,
    mode: entry.attrs?.mode ?? null,
  }
}

function isSftpEof(error) {
  return error?.code === 1 || error?.code === 'EOF' || /end of file|eof/i.test(error?.message ?? '')
}

async function readSftpPage(sftp, pathValue, offset, limit) {
  if (typeof sftp.opendir !== 'function') {
    const all = await call(sftp, 'readdir', pathValue)
    return { rows: all.slice(offset, offset + limit), hasMore: offset + limit < all.length }
  }
  const handle = await call(sftp, 'opendir', pathValue)
  const selected = []
  let skipped = 0
  let hasMore = false
  try {
    while (!hasMore) {
      let rows
      try {
        rows = await call(sftp, 'readdir', handle)
      } catch (error) {
        if (isSftpEof(error)) break
        throw error
      }
      for (const row of rows ?? []) {
        if (skipped++ < offset) continue
        if (selected.length === limit) { hasMore = true; break }
        selected.push(row)
      }
    }
  } finally {
    await call(sftp, 'close', handle).catch(() => {})
  }
  return { rows: selected, hasMore }
}

export async function listSftpDirectory(connection, remotePath, options = {}) {
  const pathValue = validateRemotePath(remotePath)
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.max(1, options.limit ?? 100)
  const sftp = await openSftp(connection)
  try {
    const page = await readSftpPage(sftp, pathValue, offset, limit)
    const entries = page.rows.map((entry) => mapSftpEntry(pathValue, entry))
    if (page.hasMore) entries.nextOffset = offset + entries.length
    return entries
  } catch (error) {
    throw sftpError(error, '无法读取远程目录')
  } finally {
    closeSftp(sftp)
  }
}

export async function readSftpFile(connection, remotePath) {
  const pathValue = validateRemotePath(remotePath)
  const sftp = await openSftp(connection)
  let handle
  try {
    const attrs = await call(sftp, 'stat', pathValue)
    const size = Number(attrs?.size ?? 0)
    if (!Number.isSafeInteger(size) || size > MAX_REMOTE_FILE_BYTES) {
      throw codedError('REMOTE_FILE_TOO_LARGE', `远程文件超过 ${MAX_REMOTE_FILE_BYTES} 字节限制`, { size })
    }
    handle = await call(sftp, 'open', pathValue, 'r')
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const bytes = await new Promise((resolve, reject) => {
        sftp.read(handle, buffer, offset, size - offset, offset, (error, count) => error ? reject(error) : resolve(count))
      })
      if (!bytes) break
      offset += bytes
    }
    return {
      path: pathValue,
      content: buffer.subarray(0, offset).toString('utf8'),
      size,
      mtime: attrs?.mtime ? attrs.mtime * 1000 : null,
    }
  } catch (error) {
    throw sftpError(error, '无法读取远程文件')
  } finally {
    if (handle) await call(sftp, 'close', handle).catch(() => {})
    closeSftp(sftp)
  }
}

async function writeSftpFileLocked(connection, pathValue, data, expectedVersion, options) {
  const sftp = await openSftp(connection)
  const temporaryPath = `${pathValue}.dsh-tmp-${randomUUID()}`
  const lockPath = `${pathValue}.dsh-cas-lock`
  let handle
  let remoteLock
  try {
    if (expectedVersion !== undefined) {
      remoteLock = await acquireRemoteLock(sftp, lockPath, options)
      assertExpectedVersion(expectedVersion, await currentSftpVersion(connection, pathValue))
    }
    handle = await call(sftp, 'open', temporaryPath, 'w', 0o600)
    let offset = 0
    while (offset < data.length) {
      const written = await new Promise((resolve, reject) => {
        sftp.write(handle, data, offset, data.length - offset, offset, (error, count) => error ? reject(error) : resolve(count))
      })
      if (!written) throw codedError('SSH_SFTP_FAILED', '远程文件写入返回空进度')
      offset += written
    }
    await call(sftp, 'close', handle)
    handle = undefined
    await remoteLock?.assertOwner()
    await replaceRemoteFile(sftp, temporaryPath, pathValue)
    return { path: pathValue, size: data.length }
  } catch (error) {
    await call(sftp, 'unlink', temporaryPath).catch(() => {})
    throw sftpError(error, '无法写入远程文件')
  } finally {
    if (handle) await call(sftp, 'close', handle).catch(() => {})
    await remoteLock?.release().catch(() => {})
    closeSftp(sftp)
  }
}

export async function writeSftpFile(connection, remotePath, content, expectedVersion, options = {}) {
  const pathValue = validateRemotePath(remotePath)
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  if (data.length > MAX_REMOTE_FILE_BYTES) {
    throw codedError('REMOTE_FILE_TOO_LARGE', `远程文件超过 ${MAX_REMOTE_FILE_BYTES} 字节限制`, { size: data.length })
  }
  return withFileLock(connection, pathValue, () => writeSftpFileLocked(connection, pathValue, data, expectedVersion, options))
}

async function deleteSftpFileLocked(connection, pathValue, expectedVersion, options) {
  const sftp = await openSftp(connection)
  const lockPath = `${pathValue}.dsh-cas-lock`
  let remoteLock
  try {
    if (expectedVersion !== undefined) {
      remoteLock = await acquireRemoteLock(sftp, lockPath, options)
      assertExpectedVersion(expectedVersion, await currentSftpVersion(connection, pathValue))
    }
    await remoteLock?.assertOwner()
    await call(sftp, 'unlink', pathValue)
    return { path: pathValue, deleted: true }
  } catch (error) {
    throw sftpError(error, '无法删除远程文件')
  } finally {
    await remoteLock?.release().catch(() => {})
    closeSftp(sftp)
  }
}

export async function deleteSftpFile(connection, remotePath, expectedVersion, options = {}) {
  const pathValue = validateRemotePath(remotePath)
  return withFileLock(connection, pathValue, () => deleteSftpFileLocked(connection, pathValue, expectedVersion, options))
}

export async function uploadSftpFile(connection, remotePath, source) {
  const pathValue = validateRemotePath(remotePath)
  return withFileLock(connection, pathValue, async () => {
    const sftp = await openSftp(connection)
    const temporaryPath = `${pathValue}.dsh-tmp-${randomUUID()}`
    const counter = createTransferCounter()
    try {
      await pipeline(source, counter, sftp.createWriteStream(temporaryPath, { mode: 0o600 }))
      await replaceRemoteFile(sftp, temporaryPath, pathValue)
      return { path: pathValue, size: counter.transferredBytes }
    } catch (error) {
      await call(sftp, 'unlink', temporaryPath).catch(() => {})
      throw sftpError(error, '无法上传远程文件')
    } finally {
      closeSftp(sftp)
    }
  })
}

export async function downloadSftpFile(connection, remotePath) {
  const pathValue = validateRemotePath(remotePath)
  const sftp = await openSftp(connection)
  try {
    const attrs = await call(sftp, 'stat', pathValue)
    const size = Number(attrs?.size ?? 0)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw codedError('TRANSFER_LENGTH_INVALID', '远端文件传输长度无效', { size })
    }
    const stream = sftp.createReadStream(pathValue)
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      closeSftp(sftp)
    }
    stream.once('end', cleanup)
    stream.once('error', cleanup)
    stream.once('close', cleanup)
    return { path: pathValue, size, mtime: attrs?.mtime ? attrs.mtime * 1000 : null, stream }
  } catch (error) {
    closeSftp(sftp)
    throw sftpError(error, '无法下载远程文件')
  }
}
