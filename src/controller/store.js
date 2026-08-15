import { mkdir, readFile, rename, writeFile, appendFile, open, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fromWireHost, toWireHost } from '../protocol.js'

const JOB_STATUSES = new Set([
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'interrupted',
])

function publicHost(host) {
  const {
    deviceToken: _deviceToken,
    privateKeyPath: _privateKeyPath,
    hostFingerprint: _hostFingerprint,
    ...rest
  } = host
  return rest
}

function toPersistedHost(host) {
  return {
    ...toWireHost(host),
    transport: host.transport ?? 'hostd',
    device_token: host.deviceToken,
    ssh_host: host.sshHost ?? null,
    ssh_port: host.sshPort ?? null,
    ssh_username: host.sshUsername ?? null,
    host_fingerprint: host.hostFingerprint ?? null,
    private_key_path: host.privateKeyPath ?? null,
    status: host.status ?? (host.online === false ? 'offline' : 'online'),
    last_error: host.lastError ?? null,
    last_error_at: host.lastErrorAt ?? null,
    latency_ms: host.latencyMs ?? null,
    connection_started_at: host.connectionStartedAt ?? null,
  }
}

function fromPersistedHost(payload) {
  return {
    ...fromWireHost(payload),
    transport: payload.transport ?? 'hostd',
    deviceToken: payload.device_token,
    sshHost: payload.ssh_host ?? undefined,
    sshPort: payload.ssh_port ?? undefined,
    sshUsername: payload.ssh_username ?? undefined,
    hostFingerprint: payload.host_fingerprint ?? undefined,
    privateKeyPath: payload.private_key_path ?? undefined,
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
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempPath, filePath)
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

export async function createControllerStore(dataDir) {
  const hostsPath = path.join(dataDir, 'hosts.json')
  const jobsPath = path.join(dataDir, 'jobs.json')
  const logsDir = path.join(dataDir, 'logs')
  await mkdir(logsDir, { recursive: true })

  const hostsFile = await readJson(hostsPath, { current_host_id: null, hosts: [] })
  const jobsFile = await readJson(jobsPath, { jobs: [] })
  const hosts = new Map(hostsFile.hosts.map((row) => {
    const host = fromPersistedHost(row)
    return [host.hostId, host]
  }))
  const jobs = new Map(jobsFile.jobs.map((row) => {
    const job = fromPersistedJob(row)
    return [job.jobId, job]
  }))
  let currentHostId = hostsFile.current_host_id

  let hostWrite = Promise.resolve()
  let jobWrite = Promise.resolve()
  const persistHosts = () => {
    hostWrite = hostWrite.then(() => writeJsonAtomic(hostsPath, {
      current_host_id: currentHostId,
      hosts: [...hosts.values()].map(toPersistedHost),
    }))
    return hostWrite
  }
  const persistJobs = () => {
    jobWrite = jobWrite.then(() => writeJsonAtomic(jobsPath, {
      jobs: [...jobs.values()].map(toPersistedJob),
    }))
    return jobWrite
  }

  return {
    async upsertHost(record) {
      const previous = hosts.get(record.hostId)
      hosts.set(record.hostId, {
        ...previous,
        ...record,
        status: record.status ?? (record.online === false ? 'offline' : 'online'),
      })
      await persistHosts()
      return this.getHost(record.hostId)
    },
    listHosts() {
      return [...hosts.values()].map(publicHost)
    },
    getHost(hostId) {
      const host = hosts.get(hostId)
      return host ? { ...host } : undefined
    },
    async setCurrentHost(hostId) {
      if (hostId !== null && !hosts.has(hostId)) {
        throw new Error(`host not found: ${hostId}`)
      }
      currentHostId = hostId
      await persistHosts()
    },
    getCurrentHost() {
      if (currentHostId === null) return null
      return this.getHost(currentHostId) ?? null
    },
    async removeHost(hostId) {
      if (!hosts.has(hostId)) throw new Error(`host not found: ${hostId}`)
      hosts.delete(hostId)
      if (currentHostId === hostId) currentHostId = null
      await persistHosts()
    },
    async createJob(input) {
      if (!JOB_STATUSES.has(input.status)) {
        throw new Error(`invalid job status: ${input.status}`)
      }
      const job = {
        jobId: input.jobId ?? randomUUID(),
        hostId: input.hostId,
        command: input.command,
        description: input.description,
        status: input.status,
        exitCode: input.exitCode,
        startedAt: input.startedAt ?? Date.now(),
        finishedAt: input.finishedAt,
        approvalDenied: input.approvalDenied === true,
        remoteJobId: input.approvalDenied ? undefined : input.remoteJobId,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        canceledAt: input.canceledAt,
      }
      jobs.set(job.jobId, job)
      await persistJobs()
      return { ...job }
    },
    async updateJob(jobId, patch) {
      const current = jobs.get(jobId)
      if (!current) throw new Error(`job not found: ${jobId}`)
      if (patch.status !== undefined && !JOB_STATUSES.has(patch.status)) {
        throw new Error(`invalid job status: ${patch.status}`)
      }
      const next = { ...current, ...patch }
      if (next.approvalDenied) next.remoteJobId = undefined
      jobs.set(jobId, next)
      await persistJobs()
      return { ...next }
    },
    getJob(jobId) {
      const job = jobs.get(jobId)
      return job ? { ...job } : undefined
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
      rows.sort((left, right) => right.startedAt - left.startedAt)
      if (filter.limit !== undefined) rows = rows.slice(0, filter.limit)
      return rows.map((job) => ({ ...job }))
    },
    async appendJobLog(jobId, chunk) {
      if (!jobs.has(jobId)) throw new Error(`job not found: ${jobId}`)
      await appendFile(path.join(logsDir, `${jobId}.log`), chunk, 'utf8')
    },
    async readJobLog(jobId) {
      try {
        return await readFile(path.join(logsDir, `${jobId}.log`), 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return ''
        throw error
      }
    },
    async readJobLogTail(jobId, tail = 8192) {
      if (!jobs.has(jobId)) throw new Error(`job not found: ${jobId}`)
      const filePath = path.join(logsDir, `${jobId}.log`)
      const length = Math.max(0, Number(tail) || 0)
      if (length === 0) return ''
      let size
      try {
        size = (await stat(filePath)).size
      } catch (error) {
        if (error && error.code === 'ENOENT') return ''
        throw error
      }
      const handle = await open(filePath, 'r')
      try {
        const bytes = Math.min(length, size)
        const buffer = Buffer.alloc(bytes)
        await handle.read(buffer, 0, bytes, size - bytes)
        return buffer.toString('utf8')
      } finally {
        await handle.close()
      }
    },
  }
}
