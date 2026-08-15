import { decideApproval } from './approval.js'
import { resolveTarget } from './resolve.js'

function jobStatus(result) {
  if (result.timedOut) return 'timed_out'
  if (result.aborted) return 'canceled'
  if (result.exitCode === 0) return 'succeeded'
  return 'failed'
}

function renderLog(result) {
  const out = result.stdout ?? ''
  const err = result.stderr ?? ''
  if (err.length === 0) return out
  return `${out}${out.endsWith('\n') || out.length === 0 ? '' : '\n'}[stderr]\n${err}`
}

async function refreshHost(store, client, host) {
  try {
    const live = await client.heartbeat(host)
    const next = {
      ...host,
      online: true,
      cwd: live.cwd ?? host.cwd,
      os: live.os ?? host.os,
      dialect: live.dialect ?? host.dialect,
      lastHeartbeatAt: live.ts ?? Date.now(),
    }
    await store.upsertHost(next)
    return next
  } catch {
    const next = { ...host, online: false }
    await store.upsertHost(next)
    return next
  }
}

export function createRunner({ store, client, now = Date.now, ask }) {
  return {
    async connectSsh(input) {
      const host = await client.connectSsh(input)
      await store.upsertHost(host)
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
        approvalOverride: 'follow',
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
      if (patch.approvalOverride !== undefined) next.approvalOverride = patch.approvalOverride
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
      await store.removeHost(hostId)
    },
    async list() {
      const hosts = store.listHosts().map((row) => store.getHost(row.hostId))
      const refreshed = []
      for (const host of hosts) {
        refreshed.push(await refreshHost(store, client, host))
      }
      return refreshed.map(({ deviceToken: _token, ...rest }) => rest)
    },
    async exec(input) {
      const preview = resolveTarget(store, input.host, { allowOffline: true })
      await refreshHost(store, client, preview)
      const target = resolveTarget(store, preview.hostId)
      const decision = decideApproval({
        command: input.command,
        dialect: target.dialect,
        override: target.approvalOverride,
      })
      if (decision === 'ask') {
        const outcome = ask ? await ask('remote command requires approval') : 'rejected'
        if (outcome !== 'allowed-once') {
          const denied = await store.createJob({
            hostId: target.hostId,
            command: input.command,
            description: input.description,
            status: 'failed',
            approvalDenied: true,
            startedAt: now(),
            finishedAt: now(),
          })
          return { ...denied, log: '' }
        }
      }
      const job = await store.createJob({
        hostId: target.hostId,
        command: input.command,
        description: input.description,
        status: 'running',
        startedAt: now(),
      })
      let logWrite = Promise.resolve()
      let stderrStarted = false
      const appendLog = (chunk) => {
        logWrite = logWrite.then(() => store.appendJobLog(job.jobId, chunk))
      }
      try {
        const result = await client.exec(target, {
          command: input.command,
          workdir: input.workdir,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
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
        })
        return { ...updated, log: await store.readJobLog(job.jobId) }
      } catch {
        await logWrite
        await store.upsertHost({ ...store.getHost(target.hostId), online: false })
        return store.updateJob(job.jobId, {
          status: 'interrupted',
          finishedAt: now(),
        })
      }
    },
    async readJob(jobId) {
      const job = store.getJob(jobId)
      if (!job) throw new Error(`job not found: ${jobId}`)
      return { ...job, log: await store.readJobLog(jobId) }
    },
    listJobs(filter) {
      return store.listJobs(filter)
    },
  }
}
