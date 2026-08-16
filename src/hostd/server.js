import { createReadStream, createWriteStream } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { lstat, mkdir, opendir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createHostState } from './state.js'
import { resolveDialect, runCommand } from '../executor.js'
import { createKeyedLock } from '../async-key-lock.js'
import { DEFAULT_MAX_REQUEST_BODY_BYTES, readJsonBody } from '../http-json.js'
import { createWorkspacePathResolver } from './workspace-path.js'
import { DEFAULT_MAX_PROCESS_OUTPUT_BYTES } from '../output-limits.js'
import {
  createTransferCounter,
  declaredTransferSize,
  downloadHeaders,
} from '../file-transfer.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const MAX_REMOTE_FILE_BYTES = 10 * 1024 * 1024
export const DEFAULT_CANCEL_TOMBSTONE_MS = 30 * 1000
const DEFAULT_DIRECTORY_PAGE_SIZE = 100
const MAX_DIRECTORY_PAGE_SIZE = 1000

function codedError(code, message, status = 400, details = {}) {
  const error = new Error(message)
  error.code = code
  error.status = status
  Object.assign(error, details)
  return error
}

function contentVersion(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function readWorkspaceFile(resolveWorkspacePath, requestedPath) {
  const filePath = await resolveWorkspacePath(requestedPath)
  const attrs = await stat(filePath)
  if (attrs.size > MAX_REMOTE_FILE_BYTES) {
    throw codedError('REMOTE_FILE_TOO_LARGE', `远程文件超过 ${MAX_REMOTE_FILE_BYTES} 字节限制`, 413)
  }
  const content = await readFile(filePath)
  return {
    path: requestedPath,
    content: content.toString('utf8'),
    size: attrs.size,
    mtime: attrs.mtimeMs,
    version: contentVersion(content),
  }
}

async function currentWorkspaceVersion(resolveWorkspacePath, requestedPath) {
  try {
    return (await readWorkspaceFile(resolveWorkspacePath, requestedPath)).version
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function parseListen(listen) {
  const value = listen ?? '127.0.0.1:7680'
  const lastColon = value.lastIndexOf(':')
  if (lastColon <= 0) throw new Error(`invalid listen address: ${value}`)
  const host = value.slice(0, lastColon)
  const port = Number(value.slice(lastColon + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid listen port: ${value}`)
  }
  return { host, port }
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host)
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function bearerToken(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1] : ''
}

function routeKey(method, pathname) {
  return `${method} ${pathname}`
}

function fileRoute(method, pathname) {
  if (method === 'GET' && pathname === '/v1/files') return true
  if (method === 'GET' && pathname === '/v1/file') return true
  if ((method === 'GET' || method === 'PUT') && pathname === '/v1/transfer') return true
  return (method === 'PUT' || method === 'DELETE') && pathname === '/v1/file'
}

function execCancelMatch(pathname) {
  const match = /^\/v1\/exec\/([^/]+)\/cancel$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
}

function parseJobId(value) {
  const jobId = String(value ?? randomUUID())
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) {
    throw codedError('HOSTD_JOB_ID_INVALID', '远程任务 ID 无效')
  }
  return jobId
}

function pageInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  const parsed = value === null ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw codedError('DIRECTORY_PAGE_INVALID', '目录分页参数无效')
  }
  return Math.min(parsed, maximum)
}

async function createServerInstance(options, listener) {
  if (options.tlsCert && options.tlsKey) {
    const [cert, key] = await Promise.all([
      readFile(options.tlsCert),
      readFile(options.tlsKey),
    ])
    return { server: createHttpsServer({ cert, key }, listener), protocol: 'https' }
  }
  return { server: createHttpServer(listener), protocol: 'http' }
}

export async function startHostd(options = {}) {
  const { host, port } = parseListen(options.listen)
  const allowInsecure = options.allowInsecure === true
  const hasTls = Boolean(options.tlsCert && options.tlsKey)
  if (!isLoopbackHost(host) && !hasTls && !allowInsecure) {
    throw new Error('insecure bind refused: non-loopback HTTP requires TLS or --allow-insecure')
  }

  const dataDir = options.dataDir
  const state = await createHostState({ dataDir, now: options.now })
  const issued = state.issuePairingCode()
  const jobs = new Map()
  const pendingCancels = new Map()
  const dialect = resolveDialect()
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd())
  const resolveWorkspacePath = await createWorkspacePathResolver(workspaceRoot)
  const withWorkspaceMutation = createKeyedLock()
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES
  const cancelTombstoneMs = options.cancelTombstoneMs ?? DEFAULT_CANCEL_TOMBSTONE_MS
  if (!Number.isSafeInteger(cancelTombstoneMs) || cancelTombstoneMs < 1000) {
    throw codedError('HOSTD_CANCEL_TOMBSTONE_INVALID', '取消墓碑时长必须是至少 1000ms 的整数', 500)
  }

  const consumePendingCancel = (jobId) => {
    const expiresAt = pendingCancels.get(jobId)
    pendingCancels.delete(jobId)
    return expiresAt !== undefined && expiresAt > Date.now()
  }

  const handlePair = async (req, res) => {
    const body = await readJsonBody(req, maxRequestBodyBytes)
    try {
      const paired = state.pair(body.pairing_code)
      json(res, 200, {
        host_id: paired.hostId,
        device_token: paired.deviceToken,
        hostname: paired.hostname,
        dialect: paired.dialect,
        cwd: workspaceRoot,
      })
    } catch {
      json(res, 401, { error: 'pairing failed' })
    }
  }

  const requireAuth = (req, res) => {
    if (state.authenticate(bearerToken(req))) return true
    json(res, 401, { error: 'unauthorized' })
    return false
  }

  const handleHeartbeat = (_req, res) => {
    json(res, 200, {
      host_id: state.hostId,
      hostname: os.hostname(),
      dialect,
      cwd: workspaceRoot,
      ts: Date.now(),
    })
  }

  const handleExec = async (req, res) => {
    const body = await readJsonBody(req, maxRequestBodyBytes)
    const jobId = parseJobId(body.job_id)
    if (jobs.has(jobId)) throw codedError('HOSTD_JOB_ID_CONFLICT', '远程任务 ID 已存在', 409)
    if (consumePendingCancel(jobId)) {
      json(res, 200, {
        job_id: jobId,
        stdout: '',
        stderr: '',
        exit_code: null,
        timed_out: false,
        aborted: true,
        abort_reason: 'cancel requested before execution started',
        stdout_bytes: 0,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
      })
      return
    }
    const controller = new AbortController()
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort('client disconnected')
    }
    req.once('aborted', abortOnDisconnect)
    res.once('close', abortOnDisconnect)
    const done = runCommand({
      command: body.command,
      workdir: body.workdir,
      timeoutMs: body.timeout_ms,
      signal: controller.signal,
      dialect,
      maxOutputBytes,
    })
    jobs.set(jobId, { controller, done })
    try {
      const result = await done
      if (!res.destroyed && !res.writableEnded) {
        json(res, 200, {
          job_id: jobId,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          aborted: result.aborted,
          abort_reason: result.aborted ? controller.signal.reason : undefined,
          stdout_bytes: result.stdoutBytes,
          stderr_bytes: result.stderrBytes,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
        })
      }
    } finally {
      req.removeListener('aborted', abortOnDisconnect)
      res.removeListener('close', abortOnDisconnect)
      jobs.delete(jobId)
    }
  }

  const handleCancel = async (jobId, res) => {
    const job = jobs.get(jobId)
    if (!job) {
      pendingCancels.set(jobId, Date.now() + cancelTombstoneMs)
      json(res, 202, { ok: true, status: 'cancel_requested', job_id: jobId })
      return
    }
    job.controller.abort('cancel requested')
    await job.done
    json(res, 200, { ok: true, status: 'canceled', job_id: jobId })
  }

  const handleFiles = async (url, res) => {
    const requestedPath = url.searchParams.get('path') || workspaceRoot
    const directory = await resolveWorkspacePath(requestedPath)
    const limit = pageInteger(url.searchParams.get('limit'), DEFAULT_DIRECTORY_PAGE_SIZE, MAX_DIRECTORY_PAGE_SIZE, 1)
    const offset = pageInteger(url.searchParams.get('offset'), 0)
    const rows = []
    let index = 0
    let hasMore = false
    const directoryHandle = await opendir(directory)
    for await (const entry of directoryHandle) {
      if (entry.name.startsWith('.dsh-tmp-')) continue
      if (index++ < offset) continue
      if (rows.length === limit) { hasMore = true; break }
      rows.push(entry)
    }
    const entries = await Promise.all(rows.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      const attrs = await lstat(entryPath)
      return {
        name: entry.name,
        path: entryPath,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        size: attrs.size,
        mtime: attrs.mtimeMs,
        mode: attrs.mode,
      }
    }))
    json(res, 200, {
      host_id: state.hostId,
      path: directory,
      entries,
      ...(hasMore ? { next_offset: offset + entries.length } : {}),
    })
  }

  const handleReadFile = async (url, res) => {
    const requestedPath = url.searchParams.get('path')
    json(res, 200, { host_id: state.hostId, ...(await readWorkspaceFile(resolveWorkspacePath, requestedPath)) })
  }

  const handleWriteFile = async (req, res) => {
    const body = await readJsonBody(req, maxRequestBodyBytes)
    const content = Buffer.from(String(body.content ?? ''), 'utf8')
    if (content.length > MAX_REMOTE_FILE_BYTES) {
      throw codedError('REMOTE_FILE_TOO_LARGE', `远程文件超过 ${MAX_REMOTE_FILE_BYTES} 字节限制`, 413)
    }
    const filePath = await resolveWorkspacePath(body.path)
    await withWorkspaceMutation(workspaceRoot, async () => {
      let lockedPath = await resolveWorkspacePath(body.path)
      const currentVersion = await currentWorkspaceVersion(resolveWorkspacePath, body.path)
      if (body.expected_version !== undefined && body.expected_version !== currentVersion) {
        throw codedError('REMOTE_FILE_CONFLICT', '远程文件已发生变化', 409, {
          expectedVersion: body.expected_version,
          currentVersion,
        })
      }
      await mkdir(path.dirname(lockedPath), { recursive: true })
      lockedPath = await resolveWorkspacePath(body.path)
      const temporaryPath = await resolveWorkspacePath(`.dsh-tmp-${randomUUID()}`)
      try {
        await writeFile(temporaryPath, content, { mode: 0o600 })
        const publishPath = await resolveWorkspacePath(body.path)
        if (publishPath !== lockedPath) {
          throw codedError('REMOTE_PATH_CHANGED', '文件父目录在发布前发生变化', 409)
        }
        await rename(temporaryPath, publishPath)
      } finally {
        await unlink(temporaryPath).catch(() => {})
      }
    })
    json(res, 200, { path: filePath, size: content.length, version: contentVersion(content) })
  }

  const handleDeleteFile = async (req, res) => {
    const body = await readJsonBody(req, maxRequestBodyBytes)
    const filePath = await resolveWorkspacePath(body.path)
    await withWorkspaceMutation(workspaceRoot, async () => {
      const lockedPath = await resolveWorkspacePath(body.path)
      const currentVersion = await currentWorkspaceVersion(resolveWorkspacePath, body.path)
      if (body.expected_version !== undefined && body.expected_version !== currentVersion) {
        throw codedError('REMOTE_FILE_CONFLICT', '远程文件已发生变化', 409, {
          expectedVersion: body.expected_version,
          currentVersion,
        })
      }
      const deletePath = await resolveWorkspacePath(body.path)
      if (deletePath !== lockedPath) {
        throw codedError('REMOTE_PATH_CHANGED', '文件父目录在删除前发生变化', 409)
      }
      await unlink(deletePath)
    })
    json(res, 200, { path: filePath, deleted: true })
  }

  const handleDownloadTransfer = async (url, res) => {
    const filePath = await resolveWorkspacePath(url.searchParams.get('path'))
    const attrs = await stat(filePath)
    res.writeHead(200, downloadHeaders(filePath, attrs.size))
    await pipeline(createReadStream(filePath), res)
  }

  const handleUploadTransfer = async (req, url, res) => {
    declaredTransferSize(req)
    const requestedPath = url.searchParams.get('path')
    const targetPath = await resolveWorkspacePath(requestedPath)
    let transferredBytes = 0
    await withWorkspaceMutation(workspaceRoot, async () => {
      await mkdir(path.dirname(targetPath), { recursive: true })
      const lockedPath = await resolveWorkspacePath(requestedPath)
      const temporaryPath = await resolveWorkspacePath(path.join(
        path.dirname(lockedPath),
        `.dsh-tmp-${randomUUID()}`,
      ))
      const counter = createTransferCounter()
      try {
        await pipeline(req, counter, createWriteStream(temporaryPath, { mode: 0o600 }))
        transferredBytes = counter.transferredBytes
        const publishPath = await resolveWorkspacePath(requestedPath)
        if (publishPath !== lockedPath) {
          throw codedError('REMOTE_PATH_CHANGED', '文件父目录在发布前发生变化', 409)
        }
        await rename(temporaryPath, publishPath)
      } finally {
        await unlink(temporaryPath).catch(() => {})
      }
    })
    json(res, 200, { path: targetPath, size: transferredBytes })
  }

  const listener = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://hostd.local')
      const key = routeKey(req.method ?? 'GET', url.pathname)
      if (key === 'POST /v1/pair') {
        await handlePair(req, res)
        return
      }
      if (key === 'GET /v1/heartbeat') {
        if (requireAuth(req, res)) handleHeartbeat(req, res)
        return
      }
      if (key === 'POST /v1/exec') {
        if (requireAuth(req, res)) await handleExec(req, res)
        return
      }
      const cancelId = req.method === 'POST' ? execCancelMatch(url.pathname) : null
      if (cancelId !== null) {
        if (requireAuth(req, res)) await handleCancel(cancelId, res)
        return
      }
      if (fileRoute(req.method ?? 'GET', url.pathname)) {
        if (!requireAuth(req, res)) return
        if (key === 'GET /v1/files') await handleFiles(url, res)
        if (key === 'GET /v1/file') await handleReadFile(url, res)
        if (key === 'PUT /v1/file') await handleWriteFile(req, res)
        if (key === 'DELETE /v1/file') await handleDeleteFile(req, res)
        if (key === 'GET /v1/transfer') await handleDownloadTransfer(url, res)
        if (key === 'PUT /v1/transfer') await handleUploadTransfer(req, url, res)
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      json(res, error?.status ?? 400, {
        error: error instanceof Error ? error.message : 'bad request',
        code: error?.code ?? 'HOSTD_ERROR',
        ...(error?.currentVersion !== undefined ? { current_version: error.currentVersion } : {}),
        ...(error?.expectedVersion !== undefined ? { expected_version: error.expectedVersion } : {}),
      })
    }
  }

  const { server, protocol } = await createServerInstance(options, listener)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `${protocol}://${host}:${actualPort}`

  return {
    url,
    pairingCode: issued.code,
    hostId: state.hostId,
    dataDir,
    issuePairingCode() {
      return state.issuePairingCode()
    },
    async close() {
      const active = [...jobs.values()]
      for (const job of active) job.controller.abort('hostd closing')
      await Promise.allSettled(active.map((job) => job.done))
      pendingCancels.clear()
      return new Promise((resolve, reject) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections()
        }
        server.close((error) => {
          if (error && error.code === 'ERR_SERVER_NOT_RUNNING') {
            resolve()
            return
          }
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}
