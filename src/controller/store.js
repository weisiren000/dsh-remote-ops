import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fromWireHost, toWireHost } from '../protocol.js'
import { assertSafeJobId, createJobLogStore } from './job-log-store.js'
import { createRecoverableQueue, readJson, writeJsonAtomic } from './store-persistence.js'

const JOB_STATUSES = new Set([
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'interrupted',
])
const CHANGE_STATUSES = new Set(['pending', 'accepted', 'reverted', 'restored'])

function publicHost(host) {
  const {
    deviceToken: _deviceToken,
    privateKeyPath: _privateKeyPath,
    hostFingerprint: _hostFingerprint,
    password: _password,
    ...rest
  } = host
  return rest
}
function toPersistedHost(host) {
  return {
    ...toWireHost(host),
    transport: host.transport ?? 'hostd',
    ssh_host: host.sshHost ?? null,
    ssh_port: host.sshPort ?? null,
    ssh_username: host.sshUsername ?? null,
    host_fingerprint: host.hostFingerprint ?? null,
    private_key_path: host.privateKeyPath ?? null,
    auth_mode: host.transport === 'ssh' ? host.authMode ?? 'key' : null,
    status: host.status ?? (host.online === false ? 'offline' : 'online'),
    last_error: host.lastError ?? null,
    last_error_at: host.lastErrorAt ?? null,
    latency_ms: host.latencyMs ?? null,
    connection_started_at: host.connectionStartedAt ?? null,
  }
}
function fromPersistedHost(payload, secret = {}) {
  return {
    ...fromWireHost(payload),
    transport: payload.transport ?? 'hostd',
    deviceToken: secret.device_token ?? payload.device_token,
    sshHost: payload.ssh_host ?? undefined,
    sshPort: payload.ssh_port ?? undefined,
    sshUsername: payload.ssh_username ?? undefined,
    hostFingerprint: payload.host_fingerprint ?? undefined,
    privateKeyPath: payload.private_key_path ?? undefined,
    authMode: payload.transport === 'ssh' ? payload.auth_mode ?? 'key' : undefined,
    status: payload.status ?? (payload.online === false ? 'offline' : 'online'),
    lastError: payload.last_error ?? undefined,
    lastErrorAt: payload.last_error_at ?? undefined,
    latencyMs: payload.latency_ms ?? undefined,
    connectionStartedAt: payload.connection_started_at ?? undefined,
  }
}
function toPersistedJob(job) {
  return {
    job_id: job.jobId,
    host_id: job.hostId,
    command: job.command,
    description: job.description,
    status: job.status,
    exit_code: job.exitCode ?? null,
    started_at: job.startedAt,
    finished_at: job.finishedAt ?? null,
    approval_denied: job.approvalDenied === true,
    remote_job_id: job.remoteJobId ?? null,
    error_code: job.errorCode ?? null,
    error_message: job.errorMessage ?? null,
    canceled_at: job.canceledAt ?? null,
    owner_session_id: job.ownerSessionId ?? null,
    dsh_job_id: job.dshJobId ?? null,
    output_truncated: job.outputTruncated === true,
    stdout_bytes: job.stdoutBytes ?? null,
    stderr_bytes: job.stderrBytes ?? null,
  }
}
function fromPersistedJob(payload) {
  return {
    jobId: payload.job_id,
    hostId: payload.host_id,
    command: payload.command,
    description: payload.description,
    status: payload.status,
    exitCode: payload.exit_code ?? undefined,
    startedAt: payload.started_at,
    finishedAt: payload.finished_at ?? undefined,
    approvalDenied: payload.approval_denied === true,
    remoteJobId: payload.remote_job_id ?? undefined,
    errorCode: payload.error_code ?? undefined,
    errorMessage: payload.error_message ?? undefined,
    canceledAt: payload.canceled_at ?? undefined,
    ownerSessionId: payload.owner_session_id ?? undefined,
    dshJobId: payload.dsh_job_id ?? undefined,
    outputTruncated: payload.output_truncated === true,
    stdoutBytes: payload.stdout_bytes ?? undefined,
    stderrBytes: payload.stderr_bytes ?? undefined,
  }
}

function toPersistedChange(change) {
  return {
    change_id: change.changeId,
    host_id: change.hostId,
    path: change.path,
    before_content: change.beforeContent ?? null,
    after_content: change.afterContent ?? '',
    before_version: change.beforeVersion ?? null,
    after_version: change.afterVersion ?? null,
    status: change.status,
    source: change.source ?? 'unknown',
    description: change.description ?? null,
    created_at: change.createdAt,
    updated_at: change.updatedAt,
    owner_session_id: change.ownerSessionId ?? null,
  }
}

function fromPersistedChange(payload) {
  return {
    changeId: payload.change_id,
    hostId: payload.host_id,
    path: payload.path,
    beforeContent: payload.before_content ?? null,
    afterContent: payload.after_content ?? '',
    beforeVersion: payload.before_version ?? null,
    afterVersion: payload.after_version ?? null,
    status: CHANGE_STATUSES.has(payload.status) ? payload.status : 'pending',
    source: payload.source ?? 'unknown',
    description: payload.description ?? undefined,
    createdAt: payload.created_at ?? Date.now(),
    updatedAt: payload.updated_at ?? payload.created_at ?? Date.now(),
    ownerSessionId: payload.owner_session_id ?? undefined,
  }
}

function persistedHostState(hosts, currentHostId, secrets) {
  return {
    version: 2,
    current_host_id: currentHostId,
    host_records: [...hosts.values()].map(toPersistedHost),
    secrets: Object.fromEntries(secrets),
  }
}

function publicHostState(hosts, currentHostId) {
  return {
    current_host_id: currentHostId,
    hosts: [...hosts.values()].map(toPersistedHost),
  }
}

export async function createControllerStore(dataDir, options = {}) {
  const writeJson = options.writeJson ?? ((filePath, value, writeOptions) => writeJsonAtomic(
    filePath,
    value,
    { ...writeOptions, renameFile: options.renameFile },
  ))
  const now = options.now ?? Date.now
  const hostsPath = path.join(dataDir, 'hosts.json')
  const secretsPath = path.join(dataDir, 'host-secrets.json')
  const jobsPath = path.join(dataDir, 'jobs.json')
  const changesPath = path.join(dataDir, 'changes.json')
  const logsDir = path.join(dataDir, 'logs')
  const jobLogs = await createJobLogStore(logsDir, options)

  const secretsFile = await readJson(secretsPath, { version: 1, hosts: {} })
  const authoritativeHostState = secretsFile.version === 2 && Array.isArray(secretsFile.host_records)
  const hostsFile = authoritativeHostState
    ? {
        current_host_id: secretsFile.current_host_id ?? null,
        hosts: secretsFile.host_records,
      }
    : await readJson(hostsPath, { current_host_id: null, hosts: [] })
  const jobsFile = await readJson(jobsPath, { jobs: [] })
  const changesFile = await readJson(changesPath, { changes: [] })
  let secrets = new Map(Object.entries(
    authoritativeHostState ? secretsFile.secrets ?? {} : secretsFile.hosts ?? {},
  ))
  for (const row of hostsFile.hosts) {
    if (row.device_token !== undefined && !secrets.has(row.host_id)) {
      secrets.set(row.host_id, { device_token: row.device_token })
    }
  }
  let hosts = new Map(hostsFile.hosts.map((row) => {
    const host = fromPersistedHost(row, secrets.get(row.host_id))
    return [host.hostId, host]
  }))
  let jobs = new Map(jobsFile.jobs.map((row) => {
    const job = fromPersistedJob(row)
    return [job.jobId, job]
  }))
  const dshJobs = new Map([...jobs.values()]
    .filter((job) => job.dshJobId !== undefined)
    .map((job) => [String(job.dshJobId), job.jobId]))
  let changes = new Map((Array.isArray(changesFile.changes) ? changesFile.changes : []).map((row) => {
    const change = fromPersistedChange(row)
    return [change.changeId, change]
  }))
  let currentHostId = hostsFile.current_host_id
  const queueHostWrite = createRecoverableQueue()
  const queueJobWrite = createRecoverableQueue()
  const queueChangeWrite = createRecoverableQueue()
  const writeProjection = async (
    nextHosts,
    nextCurrentHostId,
    { required = false } = {},
  ) => {
    try {
      await writeJson(hostsPath, publicHostState(nextHosts, nextCurrentHostId))
    } catch (error) {
      options.onProjectionError?.(error)
      if (required) throw error
    }
  }
  const persistHosts = async (
    nextHosts,
    nextCurrentHostId,
    nextSecrets = secrets,
    { requireProjection = false } = {},
  ) => {
    await writeJson(
      secretsPath,
      persistedHostState(nextHosts, nextCurrentHostId, nextSecrets),
      { mode: 0o600 },
    )
    await writeProjection(nextHosts, nextCurrentHostId, { required: requireProjection })
  }
  const persistJobs = (nextJobs) => writeJson(jobsPath, {
    jobs: [...nextJobs.values()].map(toPersistedJob),
  })
  const persistChanges = (nextChanges) => writeJson(changesPath, {
    changes: [...nextChanges.values()].map(toPersistedChange),
  })

  const hasLegacySecrets = secrets.size > 0
    || hostsFile.hosts.some((row) => row.device_token !== undefined)
  if (authoritativeHostState) {
    const projection = publicHostState(hosts, currentHostId)
    const persistedProjection = await readJson(hostsPath, null)
    if (JSON.stringify(projection) !== JSON.stringify(persistedProjection)) {
      const containsLegacySecret = persistedProjection?.hosts?.some(
        (row) => row.device_token !== undefined,
      ) ?? false
      await writeProjection(hosts, currentHostId, { required: containsLegacySecret })
    }
  } else if (hasLegacySecrets) {
    await persistHosts(hosts, currentHostId, secrets, { requireProjection: true })
  }
  const recoveredAt = now()
  let recoveredJobs = false
  for (const [jobId, job] of jobs) {
    if (job.status !== 'running') continue
    recoveredJobs = true
    jobs.set(jobId, {
      ...job,
      status: 'interrupted',
      finishedAt: recoveredAt,
      errorCode: 'CONTROLLER_RESTARTED',
      errorMessage: '控制器重启前任务未正常结束',
    })
  }
  if (recoveredJobs) await persistJobs(jobs)

  return {
    async upsertHost(record) {
      return queueHostWrite(async () => {
        const previous = hosts.get(record.hostId)
        // 密码只属于本次认证请求，主机对象和持久化快照都不得保留。
        const { password: _password, ...safeRecord } = record
        const { password: _previousPassword, ...safePrevious } = previous ?? {}
        const nextHosts = new Map(hosts)
        const nextSecrets = new Map(secrets)
        const next = {
          ...safePrevious,
          ...safeRecord,
          status: record.status ?? (record.online === false ? 'offline' : 'online'),
        }
        nextHosts.set(record.hostId, next)
        if (next.deviceToken !== undefined) {
          nextSecrets.set(record.hostId, { device_token: next.deviceToken })
        }
        await persistHosts(nextHosts, currentHostId, nextSecrets)
        hosts = nextHosts
        secrets = nextSecrets
        return { ...next }
      })
    },
    listHosts() {
      return [...hosts.values()].map(publicHost)
    },
    getHost(hostId) {
      const host = hosts.get(hostId)
      return host ? { ...host } : undefined
    },
    async setCurrentHost(hostId) {
      return queueHostWrite(async () => {
        if (hostId !== null && !hosts.has(hostId)) {
          throw new Error(`host not found: ${hostId}`)
        }
        await persistHosts(hosts, hostId)
        currentHostId = hostId
      })
    },
    getCurrentHost() {
      if (currentHostId === null) return null
      return this.getHost(currentHostId) ?? null
    },
    async removeHost(hostId) {
      return queueHostWrite(() => queueChangeWrite(async () => {
        if (!hosts.has(hostId)) throw new Error(`host not found: ${hostId}`)
        const nextHosts = new Map(hosts)
        const nextChanges = new Map([...changes].filter(([, change]) => change.hostId !== hostId))
        const previousChanges = changes
        const nextCurrentHostId = currentHostId === hostId ? null : currentHostId
        nextHosts.delete(hostId)
        await persistChanges(nextChanges)
        try {
          await persistHosts(nextHosts, nextCurrentHostId)
        } catch (error) {
          await persistChanges(previousChanges).catch((rollbackError) => { error.rollbackError = rollbackError })
          throw error
        }
        hosts = nextHosts
        changes = nextChanges
        currentHostId = nextCurrentHostId
      }))
    },
    async createJob(input) {
      return queueJobWrite(async () => {
        if (!JOB_STATUSES.has(input.status)) {
          throw new Error(`invalid job status: ${input.status}`)
        }
        const jobId = input.jobId ?? randomUUID()
        assertSafeJobId(jobId)
        if (jobs.has(jobId)) {
          const error = new Error(`job already exists: ${jobId}`)
          error.code = 'JOB_ID_CONFLICT'
          throw error
        }
        const job = {
          jobId,
          hostId: input.hostId,
          command: input.command,
          description: input.description,
          status: input.status,
          exitCode: input.exitCode,
          startedAt: input.startedAt ?? now(),
          finishedAt: input.finishedAt,
          approvalDenied: input.approvalDenied === true,
          remoteJobId: input.approvalDenied ? undefined : input.remoteJobId,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          canceledAt: input.canceledAt,
          ownerSessionId: input.ownerSessionId,
          dshJobId: input.dshJobId,
          outputTruncated: input.outputTruncated === true,
          stdoutBytes: input.stdoutBytes,
          stderrBytes: input.stderrBytes,
        }
        const nextJobs = new Map(jobs).set(job.jobId, job)
        await persistJobs(nextJobs)
        jobs = nextJobs
        if (job.dshJobId !== undefined) dshJobs.set(String(job.dshJobId), job.jobId)
        return { ...job }
      })
    },
    async updateJob(jobId, patch) {
      return queueJobWrite(async () => {
        const current = jobs.get(jobId)
        if (!current) throw new Error(`job not found: ${jobId}`)
        if (patch.status !== undefined && !JOB_STATUSES.has(patch.status)) {
          throw new Error(`invalid job status: ${patch.status}`)
        }
        const next = { ...current, ...patch }
        if (next.approvalDenied) next.remoteJobId = undefined
        const nextJobs = new Map(jobs).set(jobId, next)
        await persistJobs(nextJobs)
        jobs = nextJobs
        if (current.dshJobId !== undefined && current.dshJobId !== next.dshJobId) {
          dshJobs.delete(String(current.dshJobId))
        }
        if (next.dshJobId !== undefined) dshJobs.set(String(next.dshJobId), jobId)
        return { ...next }
      })
    },
    getJob(jobId) {
      const job = jobs.get(jobId)
      return job ? { ...job } : undefined
    },
    getJobByDshJobId(dshJobId) {
      const jobId = dshJobs.get(String(dshJobId))
      return jobId === undefined ? undefined : this.getJob(jobId)
    },
    listJobs(filter = {}) {
      let rows = [...jobs.values()]
      if (filter.hostId) rows = rows.filter((job) => job.hostId === filter.hostId)
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        rows = rows.filter((job) => statuses.includes(job.status))
      }
      if (filter.since !== undefined) rows = rows.filter((job) => job.startedAt >= Number(filter.since))
      if (filter.until !== undefined) rows = rows.filter((job) => job.startedAt <= Number(filter.until))
      if (filter.ownerSessionId !== undefined) rows = rows.filter((job) => job.ownerSessionId === filter.ownerSessionId)
      rows.sort((left, right) => right.startedAt - left.startedAt)
      if (filter.limit !== undefined) rows = rows.slice(0, filter.limit)
      return rows.map((job) => ({ ...job }))
    },
    async recordChange(input) {
      return queueChangeWrite(async () => {
        if (!input.hostId || !input.path) throw new Error('change hostId and path are required')
        const createdAt = input.createdAt ?? now()
        const change = {
          changeId: input.changeId ?? randomUUID(),
          hostId: input.hostId,
          path: input.path,
          beforeContent: input.beforeContent ?? null,
          afterContent: input.afterContent ?? '',
          beforeVersion: input.beforeVersion ?? null,
          afterVersion: input.afterVersion ?? null,
          status: input.status ?? 'pending',
          source: input.source ?? 'unknown',
          description: input.description,
          createdAt,
          updatedAt: input.updatedAt ?? createdAt,
          ownerSessionId: input.ownerSessionId,
        }
        if (!CHANGE_STATUSES.has(change.status)) throw new Error(`invalid change status: ${change.status}`)
        const nextChanges = new Map(changes).set(change.changeId, change)
        await persistChanges(nextChanges)
        changes = nextChanges
        return { ...change }
      })
    },
    async updateChange(changeId, patch) {
      return queueChangeWrite(async () => {
        const current = changes.get(changeId)
        if (!current) throw new Error(`change not found: ${changeId}`)
        if (patch.status !== undefined && !CHANGE_STATUSES.has(patch.status)) {
          throw new Error(`invalid change status: ${patch.status}`)
        }
        const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? now() }
        const nextChanges = new Map(changes).set(changeId, next)
        await persistChanges(nextChanges)
        changes = nextChanges
        return { ...next }
      })
    },
    getChange(changeId) {
      const change = changes.get(changeId)
      return change ? { ...change } : undefined
    },
    listChanges(filter = {}) {
      let rows = [...changes.values()]
      if (filter.hostId) rows = rows.filter((change) => change.hostId === filter.hostId)
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
        rows = rows.filter((change) => statuses.includes(change.status))
      }
      if (filter.path) rows = rows.filter((change) => change.path === filter.path)
      if (filter.since !== undefined) rows = rows.filter((change) => change.createdAt >= Number(filter.since))
      if (filter.until !== undefined) rows = rows.filter((change) => change.createdAt <= Number(filter.until))
      if (filter.ownerSessionId !== undefined) rows = rows.filter((change) => change.ownerSessionId === filter.ownerSessionId)
      rows.sort((left, right) => right.createdAt - left.createdAt)
      if (filter.limit !== undefined) rows = rows.slice(0, filter.limit)
      return rows.map((change) => ({ ...change }))
    },
    async appendJobLog(jobId, chunk) {
      if (!jobs.has(jobId)) throw new Error(`job not found: ${jobId}`)
      await jobLogs.append(jobId, chunk)
    },
    async readJobLog(jobId) {
      return jobLogs.read(jobId)
    },
    async readJobLogTail(jobId, tail = 8192) {
      return (await this.readJobLogWindow(jobId, tail)).text
    },
    async readJobLogWindow(jobId, tail = 8192) {
      if (!jobs.has(jobId)) throw new Error(`job not found: ${jobId}`)
      const length = Math.max(0, Number(tail) || 0)
      return jobLogs.readWindow(jobId, length)
    },
    async readJobLogRange(jobId, startByte, lengthBytes) {
      if (!jobs.has(jobId)) throw new Error(`job not found: ${jobId}`)
      return jobLogs.readRange(jobId, startByte, lengthBytes)
    },
  }
}
