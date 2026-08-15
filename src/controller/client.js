import { createSshClient } from './ssh-client.js'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function codedError(code, message, cause, details = {}) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  Object.assign(error, details)
  return error
}

export function isConnectionRefused(error) {
  const codes = []
  for (let current = error; current; current = current.cause) {
    if (current.code) codes.push(current.code)
    if (current.cause?.code) codes.push(current.cause.code)
    if (current.errors) {
      for (const item of current.errors) {
        if (item.code) codes.push(item.code)
        if (item.cause?.code) codes.push(item.cause.code)
      }
    }
  }
  return codes.some((code) => code === 'ECONNREFUSED' || code === 'ERR_SERVER_NOT_RUNNING')
}

function assertAddress(address) {
  const url = new URL(address)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url
  throw codedError('INSECURE_ADDRESS', `insecure address: ${address}`)
}

async function readJson(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

async function request(url, init) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw codedError(isConnectionRefused(error) ? 'ECONNREFUSED' : 'REMOTE_NETWORK', String(error), error)
  }
  const body = await readJson(response)
  if (!response.ok) {
    throw codedError(
      body.code ?? 'REMOTE_HTTP',
      body.error ?? `http ${response.status}`,
      undefined,
      body.fingerprint ? { fingerprint: body.fingerprint } : {},
    )
  }
  return body
}

function authHeaders(host, extra = {}) {
  return {
    authorization: `Bearer ${host.deviceToken}`,
    ...extra,
  }
}

export function createHostClient(options = {}) {
  const ssh = createSshClient({ keysDir: options.keysDir })
  return {
    connectSsh: (input) => ssh.connect(input),
    async pair(address, pairingCode) {
      const url = assertAddress(address)
      const body = await request(new URL('/v1/pair', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairing_code: pairingCode }),
      })
      return {
        hostId: body.host_id,
        deviceToken: body.device_token,
        hostname: body.hostname,
        dialect: body.dialect,
        cwd: body.cwd,
        address: url.origin,
      }
    },
    async heartbeat(host) {
      if (host.transport === 'ssh') return ssh.heartbeat(host)
      const url = assertAddress(host.address)
      const body = await request(new URL('/v1/heartbeat', url), {
        headers: authHeaders(host),
      })
      return {
        hostId: body.host_id,
        hostname: body.hostname,
        dialect: body.dialect,
        cwd: body.cwd,
        ts: body.ts,
      }
    },
    async diagnose(host) {
      const started = Date.now()
      const live = await this.heartbeat(host)
      return { ...live, latencyMs: Date.now() - started }
    },
    async reconnect(host) {
      if (host.transport === 'ssh') return ssh.reconnect(host)
      return this.heartbeat(host)
    },
    async exec(host, spec) {
      if (host.transport === 'ssh') return ssh.exec(host, spec)
      const url = assertAddress(host.address)
      const body = await request(new URL('/v1/exec', url), {
        method: 'POST',
        headers: authHeaders(host, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          command: spec.command,
          workdir: spec.workdir,
          timeout_ms: spec.timeoutMs,
        }),
        signal: spec.signal,
      })
      return {
        remoteJobId: body.job_id,
        stdout: body.stdout,
        stderr: body.stderr,
        exitCode: body.exit_code,
        timedOut: body.timed_out,
        aborted: body.aborted,
      }
    },
    async cancel(host, remoteJobId) {
      if (host.transport === 'ssh') return ssh.cancel(host, remoteJobId)
      if (!remoteJobId) return { supported: false, reason: 'HOSTD_JOB_ID_UNAVAILABLE' }
      const url = assertAddress(host.address)
      const result = await request(new URL(`/v1/exec/${remoteJobId}/cancel`, url), {
        method: 'POST',
        headers: authHeaders(host),
      })
      return { supported: result.ok !== false, ...result }
    },
    remove: (host) => host.transport === 'ssh' ? ssh.remove(host) : undefined,
    dispose: () => ssh.dispose(),
  }
}
