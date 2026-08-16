import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createKeyedLock } from '../async-key-lock.js'
import { sliceUtf8Buffer } from '../output-limits.js'

export const DEFAULT_MAX_JOB_LOG_BYTES = 16 * 1024 * 1024

export function assertSafeJobId(jobId) {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(jobId ?? ''))) return
  const error = new Error(`invalid controller job id: ${jobId}`)
  error.code = 'JOB_ID_INVALID'
  throw error
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function atomicWrite(filePath, value, options) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const data = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value)}\n`)
  try {
    await writeFile(temporaryPath, data, { mode: 0o600 })
    await (options.renameFile ?? rename)(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
}

function logHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function savedState(saved, retainedBytes) {
  if (!saved || !Number.isSafeInteger(saved.start_byte) || !Number.isSafeInteger(saved.total_bytes)) {
    return { startByte: 0, totalBytes: retainedBytes, retainedBytes }
  }
  const savedRetained = saved.total_bytes - saved.start_byte
  if (saved.start_byte < 0 || savedRetained < 0 || savedRetained > retainedBytes) {
    return { startByte: 0, totalBytes: retainedBytes, retainedBytes }
  }
  return {
    startByte: saved.start_byte,
    totalBytes: saved.total_bytes + retainedBytes - savedRetained,
    retainedBytes,
  }
}

async function readBytes(filePath, start, length) {
  if (length <= 0) return Buffer.alloc(0)
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function expiredRangeError(startByte) {
  const error = new Error(`任务日志字节范围已轮转，当前最早可读位置为 ${startByte}`)
  error.code = 'JOB_LOG_RANGE_EXPIRED'
  error.availableStartByte = startByte
  return error
}

export async function createJobLogStore(logsDir, options = {}) {
  const maxBytes = options.maxJobLogBytes ?? DEFAULT_MAX_JOB_LOG_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    const error = new Error('任务日志磁盘上限必须是正安全整数')
    error.code = 'JOB_LOG_LIMIT_INVALID'
    throw error
  }
  await mkdir(logsDir, { recursive: true })
  const states = new Map()
  const withLock = createKeyedLock()
  const paths = (jobId) => {
    assertSafeJobId(jobId)
    return {
      log: path.join(logsDir, `${jobId}.log`),
      meta: path.join(logsDir, `${jobId}.meta.json`),
      pending: path.join(logsDir, `${jobId}.pending.json`),
    }
  }
  const loadState = async (jobId) => {
    if (states.has(jobId)) return states.get(jobId)
    const files = paths(jobId)
    const retainedBytes = await fileSize(files.log)
    const saved = await readJson(files.meta, null)
    const pending = await readJson(files.pending, null)
    let state = savedState(saved, retainedBytes)
    if (pending && retainedBytes === pending.total_bytes - pending.start_byte) {
      const content = await readFile(files.log).catch(() => Buffer.alloc(0))
      if (logHash(content) === pending.log_hash) {
        state = { startByte: pending.start_byte, totalBytes: pending.total_bytes, retainedBytes }
        await atomicWrite(files.meta, { start_byte: state.startByte, total_bytes: state.totalBytes }, options)
      }
    }
    if (pending) await unlink(files.pending).catch(() => {})
    states.set(jobId, state)
    return state
  }
  const append = (jobId, chunk) => withLock(jobId, async () => {
    const files = paths(jobId)
    const state = await loadState(jobId)
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    const nextTotal = state.totalBytes + data.length
    const retainedBytes = Math.min(maxBytes, state.retainedBytes + data.length)
    const next = { startByte: nextTotal - retainedBytes, totalBytes: nextTotal, retainedBytes }
    let pendingWritten = false
    if (state.retainedBytes + data.length <= maxBytes) {
      await appendFile(files.log, data, { mode: 0o600 })
    } else {
      const dataTail = data.subarray(Math.max(0, data.length - maxBytes))
      const existingBytes = Math.max(0, maxBytes - dataTail.length)
      const existingStart = Math.max(0, state.retainedBytes - existingBytes)
      const existingTail = await readBytes(files.log, existingStart, state.retainedBytes - existingStart)
      const nextLog = Buffer.concat([existingTail, dataTail])
      await atomicWrite(files.pending, {
        start_byte: next.startByte, total_bytes: next.totalBytes, log_hash: logHash(nextLog),
      }, options)
      pendingWritten = true
      try {
        await atomicWrite(files.log, nextLog, options)
      } catch (error) {
        await unlink(files.pending).catch(() => {})
        throw error
      }
    }
    states.set(jobId, next)
    await atomicWrite(files.meta, { start_byte: next.startByte, total_bytes: next.totalBytes }, options)
    if (pendingWritten) await unlink(files.pending).catch(() => {})
  })
  const readRange = async (jobId, startByte, lengthBytes) => {
    const state = await loadState(jobId)
    if (startByte < state.startByte) throw expiredRangeError(state.startByte)
    const requestedStart = Math.min(Math.max(state.startByte, startByte), state.totalBytes)
    const localStart = requestedStart - state.startByte
    const bytes = Math.min(state.retainedBytes - localStart, lengthBytes + 4)
    const buffer = await readBytes(paths(jobId).log, localStart, bytes)
    const page = sliceUtf8Buffer(buffer, 0, lengthBytes)
    const absoluteStart = requestedStart + page.startByte
    const absoluteEnd = requestedStart + page.endByte
    return {
      text: page.text, startByte: absoluteStart, endByte: absoluteEnd,
      totalBytes: state.totalBytes,
      truncated: absoluteStart > 0 || absoluteEnd < state.totalBytes,
    }
  }
  const readWindow = async (jobId, tail) => {
    const state = await loadState(jobId)
    if (tail <= 0 || state.retainedBytes === 0) {
      return { text: '', totalBytes: state.totalBytes, truncated: state.totalBytes > 0 }
    }
    const requestedStart = Math.max(state.startByte, state.totalBytes - tail)
    const page = await readRange(jobId, requestedStart, tail)
    return {
      text: page.text,
      totalBytes: page.totalBytes,
      truncated: page.truncated,
      ...(page.truncated ? {
        locator: {
          kind: 'controller_job_log', job_id: jobId,
          start_byte: page.startByte, total_bytes: page.totalBytes,
        },
      } : {}),
    }
  }
  return {
    append,
    async read(jobId) {
      try {
        return await readFile(paths(jobId).log, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return ''
        throw error
      }
    },
    readRange,
    readWindow,
  }
}
