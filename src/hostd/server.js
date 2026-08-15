import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createHostState } from './state.js'
import { resolveDialect, runCommand } from '../executor.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

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

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function bearerToken(req) {
  const header = req.headers.authorization ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1] : ''
}

function routeKey(method, pathname) {
  return `${method} ${pathname}`
}

function execCancelMatch(pathname) {
  const match = /^\/v1\/exec\/([^/]+)\/cancel$/.exec(pathname)
  return match ? decodeURIComponent(match[1]) : null
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
  const dialect = resolveDialect()

  const handlePair = async (req, res) => {
    const body = await readJsonBody(req)
    try {
      const paired = state.pair(body.pairing_code)
      json(res, 200, {
        host_id: paired.hostId,
        device_token: paired.deviceToken,
        hostname: paired.hostname,
        dialect: paired.dialect,
        cwd: paired.cwd,
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
      cwd: process.cwd(),
      ts: Date.now(),
    })
  }

  const handleExec = async (req, res) => {
    const body = await readJsonBody(req)
    const jobId = randomUUID()
    const controller = new AbortController()
    jobs.set(jobId, controller)
    try {
      const result = await runCommand({
        command: body.command,
        workdir: body.workdir,
        timeoutMs: body.timeout_ms,
        signal: controller.signal,
        dialect,
      })
      json(res, 200, {
        job_id: jobId,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        aborted: result.aborted,
      })
    } finally {
      jobs.delete(jobId)
    }
  }

  const handleCancel = (jobId, res) => {
    const controller = jobs.get(jobId)
    controller?.abort()
    json(res, 200, { ok: true })
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
        if (requireAuth(req, res)) handleCancel(cancelId, res)
        return
      }
      json(res, 404, { error: 'not found' })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'bad request' })
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
    close() {
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
