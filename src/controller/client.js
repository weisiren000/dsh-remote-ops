import { createSshClient } from './ssh-client.js'
import { DEFAULT_MAX_REQUEST_BODY_BYTES, readJsonResponse } from '../http-json.js'

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

async function request(url, init, maxResponseBodyBytes) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw codedError(isConnectionRefused(error) ? 'ECONNREFUSED' : 'REMOTE_NETWORK', String(error), error)
  }
  const body = await readJsonResponse(response, maxResponseBodyBytes)
  if (!response.ok) {
    throw codedError(
      body.code ?? 'REMOTE_HTTP',
      body.error ?? `http ${response.status}`,
      undefined,
      {
        ...(body.fingerprint ? { fingerprint: body.fingerprint } : {}),
        ...(body.current_version !== undefined ? { currentVersion: body.current_version } : {}),
        ...(body.expected_version !== undefined ? { expectedVersion: body.expected_version } : {}),
      },
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
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const ssh = createSshClient({
    keysDir: options.keysDir,
    sftpLockStaleMs: options.sftpLockStaleMs,
  })
  return {
    connectSsh: (input) => ssh.connect(input),
    async pair(address, pairingCode) {
      const url = assertAddress(address)
      const body = await request(new URL('/v1/pair', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairing_code: pairingCode }),
      }, maxResponseBodyBytes)
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
      }, maxResponseBodyBytes)
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
      const remoteJobId = spec.jobId
      if (!remoteJobId) throw codedError('HOSTD_JOB_ID_REQUIRED', 'hostd 执行缺少稳定任务 ID')
      if (spec.signal?.aborted) throw codedError('ABORTED', '远程命令在启动前已取消')
      spec.onRemoteJobId?.(remoteJobId)
      let cancelPromise
      const onAbort = () => {
        cancelPromise ??= this.cancel(host, remoteJobId).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      }
      spec.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const body = await request(new URL('/v1/exec', url), {
          method: 'POST',
          headers: authHeaders(host, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            job_id: remoteJobId,
            command: spec.command,
            workdir: spec.workdir,
            timeout_ms: spec.timeoutMs,
          }),
        }, maxResponseBodyBytes)
        const cancellation = cancelPromise ? await cancelPromise : undefined
        if (cancellation?.error && !body.aborted) throw cancellation.error
        return {
          remoteJobId: body.job_id,
          stdout: body.stdout,
          stderr: body.stderr,
          exitCode: body.exit_code,
          timedOut: body.timed_out,
          aborted: body.aborted,
          abortReason: body.abort_reason,
          stdoutBytes: body.stdout_bytes,
          stderrBytes: body.stderr_bytes,
          stdoutTruncated: body.stdout_truncated,
          stderrTruncated: body.stderr_truncated,
        }
      } finally {
        spec.signal?.removeEventListener('abort', onAbort)
      }
    },
    async listDirectory(host, remotePath, options = {}) {
      if (host.transport === 'ssh') return ssh.listDirectory(host, remotePath, options)
      const url = assertAddress(host.address)
      const query = new URLSearchParams({
        path: remotePath || host.cwd || '.',
        limit: String(options.limit ?? 100),
        offset: String(options.offset ?? 0),
      })
      const body = await request(new URL(`/v1/files?${query}`, url), { headers: authHeaders(host) }, maxResponseBodyBytes)
      const entries = body.entries ?? body
      if (body.next_offset !== undefined) entries.nextOffset = body.next_offset
      return entries
    },
    async readRemoteFile(host, remotePath) {
      if (host.transport === 'ssh') return ssh.readRemoteFile(host, remotePath)
      const url = assertAddress(host.address)
      const query = new URLSearchParams({ path: remotePath })
      return request(new URL(`/v1/file?${query}`, url), { headers: authHeaders(host) }, maxResponseBodyBytes)
    },
    async writeRemoteFile(host, remotePath, content, expectedVersion) {
      if (host.transport === 'ssh') return ssh.writeRemoteFile(host, remotePath, content, expectedVersion)
      const url = assertAddress(host.address)
      return request(new URL('/v1/file', url), {
        method: 'PUT',
        headers: authHeaders(host, { 'content-type': 'application/json' }),
        body: JSON.stringify({ path: remotePath, content, expected_version: expectedVersion }),
      }, maxResponseBodyBytes)
    },
    async deleteRemoteFile(host, remotePath, expectedVersion) {
      if (host.transport === 'ssh') return ssh.deleteRemoteFile(host, remotePath, expectedVersion)
      const url = assertAddress(host.address)
      return request(new URL('/v1/file', url), {
        method: 'DELETE',
        headers: authHeaders(host, { 'content-type': 'application/json' }),
        body: JSON.stringify({ path: remotePath, expected_version: expectedVersion }),
      }, maxResponseBodyBytes)
    },
    async terminal(host, spec) {
      return this.exec(host, spec)
    },
    async cancel(host, remoteJobId) {
      if (host.transport === 'ssh') return ssh.cancel(host, remoteJobId)
      if (!remoteJobId) return { supported: false, reason: 'HOSTD_JOB_ID_UNAVAILABLE' }
      const url = assertAddress(host.address)
      const result = await request(new URL(`/v1/exec/${remoteJobId}/cancel`, url), {
        method: 'POST',
        headers: authHeaders(host),
      }, maxResponseBodyBytes)
      return { supported: result.ok !== false, ...result }
    },
    remove: (host) => host.transport === 'ssh' ? ssh.remove(host) : undefined,
    dispose: () => ssh.dispose(),
  }
}
