import { Transform } from 'node:stream'

export function declaredTransferSize(req) {
  const value = req.headers?.['content-length']
  if (value === undefined) return undefined
  const size = Number(Array.isArray(value) ? value[0] : value)
  if (!Number.isSafeInteger(size) || size < 0) {
    const error = new Error('文件传输 Content-Length 无效')
    error.code = 'TRANSFER_LENGTH_INVALID'
    error.status = 400
    throw error
  }
  return size
}

export function createTransferCounter() {
  let transferred = 0
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      transferred += chunk.length
      callback(null, chunk)
    },
  })
  Object.defineProperty(stream, 'transferredBytes', { get: () => transferred })
  return stream
}

export function remoteFileName(remotePath) {
  return String(remotePath ?? '').split(/[\\/]/).pop() || 'download'
}

export function downloadHeaders(remotePath, size) {
  const name = remoteFileName(remotePath)
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download'
  return {
    'content-type': 'application/octet-stream',
    'content-length': size,
    'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  }
}
