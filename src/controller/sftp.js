import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

const MAX_REMOTE_FILE_BYTES = 10 * 1024 * 1024

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
  if (error?.code === 'REMOTE_PATH_INVALID' || error?.code === 'REMOTE_FILE_TOO_LARGE' || error?.code === 'REMOTE_FILE_CONFLICT') return error
  return codedError('SSH_SFTP_FAILED', error?.message || message, { cause: error })
}

function contentVersion(content) {
  return createHash('sha256').update(content).digest('hex')
}

export async function listSftpDirectory(connection, remotePath) {
  const pathValue = validateRemotePath(remotePath)
  const sftp = await openSftp(connection)
  try {
    const entries = await call(sftp, 'readdir', pathValue)
    return entries.map((entry) => ({
      name: entry.filename,
      path: path.posix.join(pathValue, entry.filename),
      type: entry.attrs?.isDirectory?.() ? 'directory' : 'file',
      size: entry.attrs?.size ?? 0,
      mtime: entry.attrs?.mtime ? entry.attrs.mtime * 1000 : null,
      mode: entry.attrs?.mode ?? null,
    }))
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

export async function writeSftpFile(connection, remotePath, content, expectedVersion) {
  const pathValue = validateRemotePath(remotePath)
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  if (data.length > MAX_REMOTE_FILE_BYTES) {
    throw codedError('REMOTE_FILE_TOO_LARGE', `远程文件超过 ${MAX_REMOTE_FILE_BYTES} 字节限制`, { size: data.length })
  }
  const sftp = await openSftp(connection)
  const temporaryPath = `${pathValue}.dsh-tmp-${randomUUID()}`
  let handle
  try {
    if (expectedVersion !== undefined) {
      let currentVersion = null
      try {
        const current = await readSftpFile(connection, pathValue)
        currentVersion = contentVersion(Buffer.from(current.content, 'utf8'))
      } catch (error) {
        const code = error?.cause?.code ?? error?.code
        if (code !== 2 && code !== 'ENOENT' && !/no such file|not found/i.test(error?.message ?? '')) throw error
      }
      if (expectedVersion !== currentVersion) {
        throw codedError('REMOTE_FILE_CONFLICT', '远程文件已发生变化', {
          expectedVersion,
          currentVersion,
        })
      }
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
    await call(sftp, 'rename', temporaryPath, pathValue)
    return { path: pathValue, size: data.length }
  } catch (error) {
    await call(sftp, 'unlink', temporaryPath).catch(() => {})
    throw sftpError(error, '无法写入远程文件')
  } finally {
    if (handle) await call(sftp, 'close', handle).catch(() => {})
    closeSftp(sftp)
  }
}

export async function deleteSftpFile(connection, remotePath) {
  const pathValue = validateRemotePath(remotePath)
  const sftp = await openSftp(connection)
  try {
    await call(sftp, 'unlink', pathValue)
    return { path: pathValue, deleted: true }
  } catch (error) {
    throw sftpError(error, '无法删除远程文件')
  } finally {
    closeSftp(sftp)
  }
}
