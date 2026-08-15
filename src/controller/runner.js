import { resolveTarget } from './resolve.js'

function jobStatus(result) {
  if (result.timedOut) return 'timed_out'
  if (result.aborted) return 'canceled'
  if (result.exitCode === 0) return 'succeeded'
  return 'failed'
}

function hostStatus(error) {
  switch (error?.code) {
    case 'SSH_KEY_MISSING': return 'key_missing'
    case 'SSH_AUTH_FAILED':
    case 'SSH_PASSWORD_REQUIRED': return 'auth_failed'
    case 'HOST_KEY_CHANGED':
    case 'HOST_KEY_UNTRUSTED': return 'degraded'
    default: return 'offline'
  }
}

function renderLog(result) {
  const out = result.stdout ?? ''
  const err = result.stderr ?? ''
  if (err.length === 0) return out
  return `${out}${out.endsWith('\n') || out.length === 0 ? '' : '\n'}[stderr]\n${err}`
}

function taskStats(store, hostId) {
  const counts = {
    running: 0, succeeded: 0, failed: 0, timed_out: 0, canceled: 0, interrupted: 0,
  }
  for (const job of store.listJobs({ hostId })) counts[job.status] += 1
  return counts
}

async function refreshHost(store, client, host, options = {}) {
  const started = Date.now()
  const wasOnline = host.status === 'online' || host.online === true
  await store.upsertHost({ ...host, status: 'connecting' })
  try {
    const live = await client.heartbeat(host)
    const next = {
      ...host,
      online: true,
      status: 'online',
      latencyMs: Math.max(0, Date.now() - started),
      cwd: live.cwd ?? host.cwd,
      os: live.os ?? host.os,
      dialect: live.dialect ?? host.dialect,
      lastHeartbeatAt: live.ts ?? Date.now(),
      connectionStartedAt: wasOnline ? host.connectionStartedAt ?? Date.now() : Date.now(),
      lastError: undefined,
      lastErrorAt: undefined,
    }
    await store.upsertHost(next)
    return next
  } catch (error) {
    const next = {
      ...host,
      online: false,
      status: hostStatus(error),
      latencyMs: undefined,
      lastError: error?.message ?? String(error),
      lastErrorAt: Date.now(),
    }
    await store.upsertHost(next)
    if (options.rethrow) throw error
    return next
  }
}

export function createRunner({ store, client, now = Date.now }) {
  const activeJobs = new Map()
  const pendingCancels = new Set()
  let refreshPromise = null
  const listSnapshot = () => store.listHosts().map((row) => {
    const { deviceToken: _token, ...host } = store.getHost(row.hostId)
    return { ...host, taskStats: taskStats(store, host.hostId) }
  })
  const refreshHosts = () => {
    if (refreshPromise) return refreshPromise
    const hosts = store.listHosts().map((row) => store.getHost(row.hostId))
    refreshPromise = Promise.all(hosts.map((host) => refreshHost(store, client, host)))
      .then(() => listSnapshot())
      .finally(() => { refreshPromise = null })
    return refreshPromise
  }
  return {
    async connectSsh(input) {
      const host = await client.connectSsh(input)
      await store.upsertHost({ ...host, status: 'online', connectionStartedAt: now() })
      if (store.getCurrentHost() === null) await store.setCurrentHost(host.hostId)
      return host
    },
    async pair({ address, pairingCode, displayName }) {
      const paired = await client.pair(address, pairingCode)
      const host = {
        hostId: paired.hostId,
        displayName: displayName ?? paired.hostname ?? paired.hostId,
        address: paired.address ?? address,
        transport: 'hostd',
        deviceToken: paired.deviceToken,
        online: true,
        cwd: paired.cwd,
        os: paired.dialect === 'pwsh' ? 'windows' : 'linux',
        dialect: paired.dialect,
        lastHeartbeatAt: now(),
        status: 'online',
        connectionStartedAt: now(),
      }
      await store.upsertHost(host)
      if (store.getCurrentHost() === null) await store.setCurrentHost(host.hostId)
      return host
    },
    async use(host) {
      const target = resolveTarget(store, host)
      await store.setCurrentHost(target.hostId)
      return target
    },
    getCurrentHost() {
      return store.getCurrentHost()
    },
    async updateHost(hostId, patch) {
      const current = store.getHost(hostId)
      if (!current) {
        const error = new Error(`host not found: ${hostId}`)
        error.code = 'HOST_NOT_FOUND'
        throw error
      }
      const next = { ...current }
      if (patch.displayName !== undefined) next.displayName = patch.displayName
      await store.upsertHost(next)
      const { deviceToken: _token, ...publicHost } = store.getHost(hostId)
      return publicHost
    },
    async removeHost(hostId) {
      const current = store.getHost(hostId)
      if (!current) {
        const error = new Error(`host not found: ${hostId}`)
        error.code = 'HOST_NOT_FOUND'
        throw error
      }
      await client.remove?.(current)
      for (const [jobId, active] of activeJobs) {
        if (active.host.hostId !== hostId) continue
        active.controller.abort()
        activeJobs.delete(jobId)
        await store.updateJob(jobId, { status: 'interrupted', finishedAt: now() }).catch(() => {})
      }
      await store.removeHost(hostId)
    },
    async list() {
      const snapshot = listSnapshot()
      queueMicrotask(() => { void refreshHosts().catch(() => {}) })
      return snapshot
    },
    async refreshHosts() {
      return refreshHosts()
    },
    async exec(input) {
      const preview = resolveTarget(store, input.host, { allowOffline: true })
      await refreshHost(store, client, preview)
      const target = resolveTarget(store, preview.hostId)
      const job = await store.createJob({
        hostId: target.hostId,
        command: input.command,
        description: input.description,
        status: 'running',
        startedAt: now(),
      })
      let logWrite = Promise.resolve()
      let stderrStarted = false
      const controller = new AbortController()
      const onInputAbort = () => controller.abort()
      input.signal?.addEventListener('abort', onInputAbort, { once: true })
      const active = { host: target, controller, remoteJobId: undefined, cancelRequested: false }
      activeJobs.set(job.jobId, active)
      if (pendingCancels.delete(job.jobId)) {
        active.cancelRequested = true
        controller.abort()
      }
      const appendLog = (chunk) => {
        logWrite = logWrite.then(() => store.appendJobLog(job.jobId, chunk))
      }
      try {
        const result = await client.exec(target, {
          command: input.command,
          workdir: input.workdir,
          timeoutMs: input.timeoutMs,
          signal: controller.signal,
          jobId: job.jobId,
          onRemoteJobId(remoteJobId) { active.remoteJobId = remoteJobId },
          onStdout(chunk) {
            appendLog(chunk)
          },
          onStderr(chunk) {
            if (!stderrStarted) {
              stderrStarted = true
              appendLog('[stderr]\n')
            }
            appendLog(chunk)
          },
        })
        if (!result.streamed) appendLog(renderLog(result))
        await logWrite
        const updated = await store.updateJob(job.jobId, {
          status: jobStatus(result),
          exitCode: result.exitCode,
          remoteJobId: result.remoteJobId,
          finishedAt: now(),
          canceledAt: result.aborted ? now() : undefined,
        })
        activeJobs.delete(job.jobId)
        input.signal?.removeEventListener('abort', onInputAbort)
        return { ...updated, log: await store.readJobLog(job.jobId) }
      } catch (error) {
        await logWrite
        await store.upsertHost({ ...store.getHost(target.hostId), online: false, status: hostStatus(error), lastError: error?.message, lastErrorAt: now() })
        activeJobs.delete(job.jobId)
        input.signal?.removeEventListener('abort', onInputAbort)
        const updated = await store.updateJob(job.jobId, {
          status: active.cancelRequested || controller.signal.aborted ? 'canceled' : 'interrupted',
          errorCode: error?.code,
          errorMessage: error?.message,
          finishedAt: now(),
        })
        return { ...updated, log: await store.readJobLog(job.jobId) }
      }
    },
    async cancelJob(jobId) {
      const job = store.getJob(jobId)
      if (!job) {
        const error = new Error(`job not found: ${jobId}`)
        error.code = 'JOB_NOT_FOUND'
        throw error
      }
      if (job.status !== 'running') return { ...job, status: job.status }
      const active = activeJobs.get(jobId)
      if (!active) {
        const host = store.getHost(job.hostId)
        const outcome = await client.cancel?.(host, undefined)
        if (outcome?.supported === false || outcome?.ok === false) {
          return { ...job, status: 'cancel_unavailable', cancelSupported: false, cancelReason: outcome.reason }
        }
        pendingCancels.add(jobId)
        await store.updateJob(jobId, { canceledAt: now() })
        return { ...store.getJob(jobId), status: 'cancel_requested', cancelSupported: true }
      }
      const outcome = await client.cancel?.(active.host, active.remoteJobId)
      if (outcome?.supported === false || outcome?.ok === false) {
        return { ...job, status: 'cancel_unavailable', cancelSupported: false, cancelReason: outcome.reason }
      }
      active.cancelRequested = true
      active.controller.abort()
      await store.updateJob(jobId, { canceledAt: now() })
      return { ...store.getJob(jobId), status: 'cancel_requested' }
    },
    async readJob(jobId) {
      const job = store.getJob(jobId)
      if (!job) throw new Error(`job not found: ${jobId}`)
      return { ...job, log: await store.readJobLog(jobId) }
    },
    async readJobLogTail(jobId, tail) {
      const job = store.getJob(jobId)
      if (!job) throw new Error(`job not found: ${jobId}`)
      return { ...job, log: await store.readJobLogTail(jobId, tail) }
    },
    async reconnectHost(hostId, options = {}) {
      const current = store.getHost(hostId)
      if (!current) { const error = new Error(`host not found: ${hostId}`); error.code = 'HOST_NOT_FOUND'; throw error }
      const reconnectClient = client.reconnect
        ? { heartbeat: (host) => client.reconnect(host) }
        : client
      if (!options.hostFingerprint) {
        const refreshed = await refreshHost(store, reconnectClient, current, { rethrow: true })
        return { ...refreshed, taskStats: taskStats(store, hostId) }
      }
      if (current.transport !== 'ssh') {
        const error = new Error('只有 SSH 主机支持指纹确认')
        error.code = 'SSH_FINGERPRINT_UNSUPPORTED'
        throw error
      }
      try {
        const verified = await refreshHost(store, reconnectClient, {
          ...current,
          hostFingerprint: options.hostFingerprint,
        }, { rethrow: true })
        return { ...verified, taskStats: taskStats(store, hostId) }
      } catch (error) {
        const failed = store.getHost(hostId)
        await store.upsertHost({ ...failed, hostFingerprint: current.hostFingerprint })
        throw error
      }
    },
    async diagnoseHost(hostId) {
      const current = store.getHost(hostId)
      if (!current) { const error = new Error(`host not found: ${hostId}`); error.code = 'HOST_NOT_FOUND'; throw error }
      const started = now()
      try {
        const live = await client.diagnose?.(current) ?? await client.heartbeat(current)
        const latencyMs = Math.max(0, now() - started)
        await store.upsertHost({ ...current, ...live, online: true, status: 'online', latencyMs, lastHeartbeatAt: live.ts ?? now(), lastError: undefined, lastErrorAt: undefined })
        return { hostId, ok: true, latencyMs, ...live }
      } catch (error) {
        await store.upsertHost({ ...current, online: false, status: hostStatus(error), lastError: error.message, lastErrorAt: now() })
        return { hostId, ok: false, status: hostStatus(error), error: error.message, code: error.code }
      }
    },
    async healthHost(hostId) {
      const host = store.getHost(hostId)
      if (!host) { const error = new Error(`host not found: ${hostId}`); error.code = 'HOST_NOT_FOUND'; throw error }
      return {
        hostId,
        status: host.status ?? (host.online === false ? 'offline' : 'online'),
        online: host.online !== false,
        latencyMs: host.latencyMs,
        lastHeartbeatAt: host.lastHeartbeatAt,
        lastError: host.lastError,
        lastErrorAt: host.lastErrorAt,
        connectionStartedAt: host.connectionStartedAt,
        cwd: host.cwd,
        os: host.os,
        dialect: host.dialect,
        taskStats: taskStats(store, hostId),
      }
    },
    listJobs(filter) {
      return store.listJobs(filter)
    },
  }
}
