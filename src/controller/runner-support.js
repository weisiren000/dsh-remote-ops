import { createHash } from 'node:crypto'

export function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function stopOutcome(reason, timestamp) {
  if (reason === 'user_cancel') return { status: 'canceled', canceledAt: timestamp }
  if (reason === 'host_removed') {
    return { status: 'interrupted', errorCode: 'HOST_REMOVED', errorMessage: '远程主机已移除' }
  }
  if (reason === 'service_unload') {
    return { status: 'interrupted', errorCode: 'RUNNER_DISPOSED', errorMessage: '远程执行服务已卸载' }
  }
  return undefined
}

export function jobStatus(result) {
  if (result.timedOut) return 'timed_out'
  if (result.aborted) return result.abortReason === 'cancel requested' ? 'canceled' : 'interrupted'
  return result.exitCode === 0 ? 'succeeded' : 'failed'
}

export function hostStatus(error) {
  switch (error?.code) {
    case 'SSH_KEY_MISSING': return 'key_missing'
    case 'SSH_AUTH_FAILED':
    case 'SSH_PASSWORD_REQUIRED': return 'auth_failed'
    case 'HOST_KEY_CHANGED':
    case 'HOST_KEY_UNTRUSTED': return 'degraded'
    default: return 'offline'
  }
}

export function renderLog(result) {
  const out = result.stdout ?? ''
  const err = result.stderr ?? ''
  const body = err.length === 0
    ? out
    : `${out}${out.endsWith('\n') || out.length === 0 ? '' : '\n'}[stderr]\n${err}`
  if (!result.stdoutTruncated && !result.stderrTruncated) return body
  const notice = `[remote output truncated: stdout ${result.stdoutBytes ?? 0} bytes, stderr ${result.stderrBytes ?? 0} bytes]`
  return `${body}${body.endsWith('\n') || body.length === 0 ? '' : '\n'}${notice}\n`
}

export async function withBoundedLog(store, job, maxBytes) {
  const window = await store.readJobLogWindow(job.jobId, maxBytes)
  return {
    ...job,
    log: window.text,
    logBytes: window.totalBytes,
    logTruncated: window.truncated,
    ...(window.locator ? { logLocator: window.locator } : {}),
  }
}

export function taskStats(store, hostId) {
  const counts = { running: 0, succeeded: 0, failed: 0, timed_out: 0, canceled: 0, interrupted: 0 }
  for (const job of store.listJobs({ hostId })) counts[job.status] += 1
  return counts
}

export function isRemoteFileMissing(error) {
  const code = error?.cause?.code ?? error?.code
  return code === 2 || code === 'ENOENT' || /no such file|not found/i.test(error?.message ?? '')
}

export function changeActionStatus(action) {
  if (action === 'accept' || action === 'accepted') return 'accepted'
  if (action === 'undo' || action === 'revert' || action === 'reverted') return 'reverted'
  if (action === 'restore' || action === 'restored') return 'restored'
  const error = new Error(`unsupported change action: ${action}`)
  error.code = 'CHANGE_ACTION_INVALID'
  throw error
}

export function contentVersion(content) {
  if (content === null || content === undefined) return null
  return createHash('sha256').update(String(content), 'utf8').digest('hex')
}

export function conflictError(expectedVersion, currentVersion) {
  const error = new Error('远程文件已被其他操作修改，请重新加载后再保存')
  error.code = 'REMOTE_FILE_CONFLICT'
  error.expectedVersion = expectedVersion
  error.currentVersion = currentVersion
  return error
}

export function createDeferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

export function assertOwner(record, ownerSessionId, kind) {
  if (ownerSessionId === undefined || record.ownerSessionId === ownerSessionId) return record
  const error = new Error(`${kind} belongs to another session`)
  error.code = `${kind.toUpperCase()}_FORBIDDEN`
  throw error
}

export async function refreshHost(store, client, host, options = {}) {
  const started = Date.now()
  const wasOnline = host.status === 'online' || host.online === true
  await store.upsertHost({ ...host, status: 'connecting' })
  try {
    const live = await client.heartbeat(host)
    const next = {
      ...host, online: true, status: 'online', latencyMs: Math.max(0, Date.now() - started),
      cwd: live.cwd ?? host.cwd, os: live.os ?? host.os, dialect: live.dialect ?? host.dialect,
      lastHeartbeatAt: live.ts ?? Date.now(),
      connectionStartedAt: wasOnline ? host.connectionStartedAt ?? Date.now() : Date.now(),
      lastError: undefined, lastErrorAt: undefined,
    }
    await store.upsertHost(next)
    return next
  } catch (error) {
    const next = {
      ...host, online: false, status: hostStatus(error), latencyMs: undefined,
      lastError: error?.message ?? String(error), lastErrorAt: Date.now(),
    }
    await store.upsertHost(next)
    if (options.rethrow) throw error
    return next
  }
}
