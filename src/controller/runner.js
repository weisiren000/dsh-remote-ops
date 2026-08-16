import { resolveTarget } from './resolve.js'
import { randomUUID } from 'node:crypto'
import { DEFAULT_MAX_INLINE_OUTPUT_BYTES, DEFAULT_MAX_PROCESS_OUTPUT_BYTES } from '../output-limits.js'
import { readLocator as readStructuredLocator } from './locator-reader.js'
import {
  assertOwner, changeActionStatus, codedError, conflictError, contentVersion, createDeferred,
  hostStatus, isRemoteFileMissing, jobStatus, refreshHost, renderLog, stopOutcome, taskStats,
  withBoundedLog,
} from './runner-support.js'
export function createRunner({ store, client, now = Date.now,
  maxInlineOutputBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES,
  maxProcessOutputBytes = DEFAULT_MAX_PROCESS_OUTPUT_BYTES,
}) {
  const activeJobs = new Map()
  const activatingJobs = new Map()
  const preparingJobs = new Map()
  const pendingCancels = new Set()
  let refreshPromise = null
  let disposed = false
  let disposePromise
  const listSnapshot = () => store.listHosts().map((row) => {
    const { deviceToken: _token, ...host } = store.getHost(row.hostId)
    return { ...host, taskStats: taskStats(store, host.hostId) }
  })
  const refreshHosts = () => {
    if (disposed) return Promise.reject(codedError('RUNNER_DISPOSED', '远程执行服务已卸载'))
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
    resolveHost(hostRef, options = {}) {
      return resolveTarget(store, hostRef, { allowOffline: options.allowOffline === true })
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
      for (const active of activeJobs.values()) {
        if (active.host.hostId !== hostId) continue
        active.setStopReason('host_removed')
        await client.cancel?.(active.host, active.remoteJobId).catch(() => {})
        active.controller.abort('host_removed')
        await active.done
      }
      await client.remove?.(current)
      await store.removeHost(hostId)
    },
    async list() {
      const snapshot = listSnapshot()
      if (!disposed) queueMicrotask(() => { if (!disposed) void refreshHosts().catch(() => {}) })
      return snapshot
    },
    async refreshHosts() {
      return refreshHosts()
    },
    async exec(input) {
      const jobId = input.jobId ?? randomUUID()
      const activation = createDeferred()
      const controller = new AbortController()
      let active
      let stopReason
      const setStopReason = (reason) => {
        if (stopReason === undefined) stopReason = reason
        if (active) active.stopReason = stopReason
      }
      const requestStop = (reason) => {
        setStopReason(reason)
        if (!controller.signal.aborted) controller.abort(reason)
      }
      const assertCanStart = () => {
        if (disposed) throw codedError('RUNNER_DISPOSED', '远程执行服务已卸载')
        if (controller.signal.aborted) throw codedError('ABORTED', '远程命令在启动前已取消')
      }
      const onInputAbort = () => requestStop('user_cancel')
      if (input.signal?.aborted) onInputAbort()
      else input.signal?.addEventListener('abort', onInputAbort, { once: true })
      activatingJobs.set(jobId, activation.promise)
      preparingJobs.set(jobId, requestStop)
      let job
      let target
      try {
        assertCanStart()
        const preview = resolveTarget(store, input.host, { allowOffline: true })
        await refreshHost(store, client, preview)
        assertCanStart()
        target = resolveTarget(store, preview.hostId)
        job = await store.createJob({
          jobId,
          hostId: target.hostId,
          command: input.command,
          description: input.description,
          status: 'running',
          startedAt: now(),
          ownerSessionId: input.ownerSessionId,
        })
        assertCanStart()
      } catch (error) {
        if (job && controller.signal.aborted) {
          await store.updateJob(job.jobId, {
            ...stopOutcome(stopReason, now()),
            finishedAt: now(),
          })
        }
        activatingJobs.delete(jobId)
        preparingJobs.delete(jobId)
        activation.resolve(undefined)
        input.signal?.removeEventListener('abort', onInputAbort)
        throw error
      }
      let logWrite = Promise.resolve()
      let logError
      let stderrStarted = false
      const deferred = createDeferred()
      active = {
        host: target,
        controller,
        remoteJobId: undefined,
        stopReason,
        setStopReason,
        restoreStopReason(reason) {
          stopReason = reason
          active.stopReason = reason
        },
        done: deferred.promise,
      }
      activeJobs.set(job.jobId, active)
      activation.resolve(active)
      activatingJobs.delete(job.jobId)
      preparingJobs.delete(job.jobId)
      if (pendingCancels.delete(job.jobId)) {
        requestStop('user_cancel')
      }
      const appendLog = (chunk) => {
        if (logError) return Promise.reject(logError)
        logWrite = logWrite.then(() => store.appendJobLog(job.jobId, chunk)).catch((error) => {
          logError ??= error
          throw error
        })
        return logWrite
      }
      try {
        if (controller.signal.aborted) throw codedError('ABORTED', '远程命令在启动前已取消')
        const result = await client.exec(target, {
          command: input.command,
          workdir: input.workdir,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: maxProcessOutputBytes,
          signal: controller.signal,
          jobId: job.jobId,
          onRemoteJobId(remoteJobId) { active.remoteJobId = remoteJobId },
          onStdout(chunk) {
            return appendLog(chunk)
          },
          onStderr(chunk) {
            if (!stderrStarted) {
              stderrStarted = true
              appendLog('[stderr]\n')
            }
            return appendLog(chunk)
          },
        })
        if (!result.streamed) appendLog(renderLog(result))
        await logWrite
        const stopped = stopOutcome(active.stopReason, now())
        const updated = await store.updateJob(job.jobId, {
          status: stopped?.status ?? jobStatus(result),
          exitCode: result.exitCode,
          remoteJobId: result.remoteJobId,
          finishedAt: now(),
          canceledAt: stopped?.canceledAt ?? (result.aborted ? now() : undefined),
          ...(stopped?.errorCode ? { errorCode: stopped.errorCode } : {}),
          ...(stopped?.errorMessage ? { errorMessage: stopped.errorMessage } : {}),
          outputTruncated: result.stdoutTruncated === true || result.stderrTruncated === true,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
        })
        return await withBoundedLog(store, updated, maxInlineOutputBytes)
      } catch (error) {
        await logWrite.catch(() => {})
        const failure = logError ?? error
        const stopped = stopOutcome(active.stopReason, now())
        if (!controller.signal.aborted && !logError) {
          await store.upsertHost({ ...store.getHost(target.hostId), online: false, status: hostStatus(failure), lastError: failure?.message, lastErrorAt: now() })
        }
        const updated = await store.updateJob(job.jobId, {
          status: stopped?.status ?? 'interrupted',
          errorCode: stopped?.errorCode ?? failure?.code,
          errorMessage: stopped?.errorMessage ?? failure?.message,
          ...(stopped?.canceledAt ? { canceledAt: stopped.canceledAt } : {}),
          finishedAt: now(),
        })
        return await withBoundedLog(store, updated, maxInlineOutputBytes)
      } finally {
        activeJobs.delete(job.jobId)
        input.signal?.removeEventListener('abort', onInputAbort)
        deferred.resolve()
      }
    },
    async cancelJob(jobId, ownerSessionId) {
      const job = store.getJob(jobId)
      if (!job) {
        const error = new Error(`job not found: ${jobId}`)
        error.code = 'JOB_NOT_FOUND'
        throw error
      }
      assertOwner(job, ownerSessionId, 'job')
      if (job.status !== 'running') return { ...job, status: job.status }
      let active = activeJobs.get(jobId)
      if (!active && activatingJobs.has(jobId)) active = await activatingJobs.get(jobId)
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
      const previousStopReason = active.stopReason
      active.setStopReason('user_cancel')
      const outcome = await client.cancel?.(active.host, active.remoteJobId)
      if (outcome?.supported === false || outcome?.ok === false) {
        if (!active.controller.signal.aborted && active.stopReason === 'user_cancel') {
          active.restoreStopReason(previousStopReason)
        }
        return { ...job, status: 'cancel_unavailable', cancelSupported: false, cancelReason: outcome.reason }
      }
      active.controller.abort('user_cancel')
      await store.updateJob(jobId, { canceledAt: now() })
      await active.done
      return { ...store.getJob(jobId), cancelSupported: true }
    },
    async readJob(jobId, ownerSessionId) {
      const job = store.getJob(jobId) ?? store.getJobByDshJobId?.(jobId)
      if (!job) throw new Error(`job not found: ${jobId}`)
      assertOwner(job, ownerSessionId, 'job')
      return withBoundedLog(store, job, maxInlineOutputBytes)
    },
    async readJobLogTail(jobId, tail, ownerSessionId) {
      const job = store.getJob(jobId) ?? store.getJobByDshJobId?.(jobId)
      if (!job) throw new Error(`job not found: ${jobId}`)
      assertOwner(job, ownerSessionId, 'job')
      const window = await store.readJobLogWindow(job.jobId, tail)
      return {
        ...job,
        log: window.text,
        logBytes: window.totalBytes,
        logTruncated: window.truncated,
        ...(window.locator ? { logLocator: window.locator } : {}),
      }
    },
    async linkDshJob(jobId, dshJobId) {
      if (activatingJobs.has(jobId)) await activatingJobs.get(jobId)
      return store.updateJob(jobId, { dshJobId: String(dshJobId) })
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
    async listFiles(hostRef, remotePath, options = {}) {
      const target = resolveTarget(store, hostRef)
      const entries = await client.listDirectory(target, remotePath || target.cwd || '.', options)
      return { hostId: target.hostId, path: remotePath || target.cwd || '.', entries, nextOffset: entries.nextOffset }
    },
    async readRemoteFile(hostRef, remotePath) {
      const target = resolveTarget(store, hostRef)
      const result = await client.readRemoteFile(target, remotePath)
      return { hostId: target.hostId, ...result, version: result.version ?? contentVersion(result.content) }
    },
    readLocator(locator, options) { return readStructuredLocator({ store, client }, locator, options) },
    async writeRemoteFile(input) {
      const target = resolveTarget(store, input.host)
      let beforeContent = input.beforeContent
      let beforeVersion = null
      if (beforeContent === undefined) {
        try {
          const before = await client.readRemoteFile(target, input.path)
          beforeContent = before.content
          beforeVersion = before.version ?? contentVersion(before.content)
        } catch (error) {
          if (!isRemoteFileMissing(error)) throw error
          beforeContent = null
        }
      } else {
        beforeVersion = contentVersion(beforeContent)
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== beforeVersion) {
        throw conflictError(input.expectedVersion, beforeVersion)
      }
      const write = await client.writeRemoteFile(target, input.path, input.content, beforeVersion)
      const afterVersion = write.version ?? contentVersion(input.content)
      const change = await store.recordChange({
        hostId: target.hostId,
        path: input.path,
        beforeContent,
        afterContent: String(input.content ?? ''),
        beforeVersion,
        afterVersion,
        source: input.source ?? 'manual',
        description: input.description,
        ownerSessionId: input.ownerSessionId,
      })
      return { ...change, write }
    },
    async deleteRemoteFile(input) {
      const target = resolveTarget(store, input.host)
      const before = await client.readRemoteFile(target, input.path)
      const beforeVersion = before.version ?? contentVersion(before.content)
      if (input.expectedVersion !== undefined && input.expectedVersion !== beforeVersion) {
        throw conflictError(input.expectedVersion, beforeVersion)
      }
      const result = await client.deleteRemoteFile(target, input.path, beforeVersion)
      const change = await store.recordChange({
        hostId: target.hostId,
        path: input.path,
        beforeContent: before.content,
        afterContent: '',
        beforeVersion,
        afterVersion: null,
        source: input.source ?? 'manual',
        description: input.description,
      })
      return { ...change, delete: result }
    },
    async uploadRemoteFile(hostRef, remotePath, source, options = {}) {
      const target = resolveTarget(store, hostRef)
      const result = await client.uploadRemoteFile(target, remotePath, source, options)
      return { hostId: target.hostId, ...result }
    },
    async downloadRemoteFile(hostRef, remotePath, options = {}) {
      const target = resolveTarget(store, hostRef)
      const result = await client.downloadRemoteFile(target, remotePath, options)
      return { hostId: target.hostId, ...result }
    },
    listChanges(filter = {}) {
      return store.listChanges(filter)
    },
    async readChange(changeId, ownerSessionId) {
      const change = store.getChange(changeId)
      if (!change) {
        const error = new Error(`change not found: ${changeId}`)
        error.code = 'CHANGE_NOT_FOUND'
        throw error
      }
      assertOwner(change, ownerSessionId, 'change')
      return change
    },
    async reviewChange(changeId, action, ownerSessionId) {
      const change = await this.readChange(changeId, ownerSessionId)
      const status = changeActionStatus(action)
      if (status === 'accepted') return store.updateChange(changeId, { status })
      const target = resolveTarget(store, change.hostId)
      const content = status === 'restored' ? change.afterContent : change.beforeContent
      const current = await client.readRemoteFile(target, change.path).catch((error) => {
        if (isRemoteFileMissing(error)) return { content: null, version: null }
        throw error
      })
      const currentVersion = current.version ?? contentVersion(current.content)
      const expectedVersion = status === 'restored' ? change.beforeVersion : change.afterVersion
      if (expectedVersion !== currentVersion) throw conflictError(expectedVersion, currentVersion)
      if (content === null || content === undefined) {
        await client.deleteRemoteFile(target, change.path, currentVersion)
      } else {
        await client.writeRemoteFile(target, change.path, content, currentVersion)
      }
      return store.updateChange(changeId, { status })
    },
    listJobs(filter) {
      return store.listJobs(filter)
    },
    async dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      disposePromise = (async () => {
        for (const stop of preparingJobs.values()) stop('service_unload')
        await Promise.allSettled([...activatingJobs.values()])
        await refreshPromise?.catch(() => {})
        const active = [...activeJobs.values()]
        for (const job of active) {
          job.setStopReason('service_unload')
          await client.cancel?.(job.host, job.remoteJobId).catch(() => {})
          job.controller.abort('service_unload')
        }
        await Promise.allSettled(active.map((job) => job.done))
        await client.dispose?.()
      })()
      return disposePromise
    },
  }
}
