const PREFIX = '/remote-ops/v1'

export function isLoopbackAddress(address) {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publicJob(job, log) {
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
    error_code: job.errorCode ?? null,
    error_message: job.errorMessage ?? null,
    canceled_at: job.canceledAt ?? null,
    cancel_supported: job.cancelSupported,
    log: log ?? undefined,
  }
}

function publicChange(change) {
  return {
    change_id: change.changeId,
    host_id: change.hostId,
    path: change.path,
    before_content: change.beforeContent ?? null,
    after_content: change.afterContent ?? '',
    before_version: change.beforeVersion ?? null,
    after_version: change.afterVersion ?? null,
    status: change.status,
    source: change.source,
    description: change.description ?? null,
    created_at: change.createdAt,
    updated_at: change.updatedAt,
  }
}

function formatDuration(startedAt, now = Date.now()) {
  if (!startedAt) return undefined
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分钟`
}

function publicHost(host, currentHostId, taskStats = {}) {
  return {
    host_id: host.hostId,
    display_name: host.displayName,
    address: host.address,
    transport: host.transport ?? 'hostd',
    ssh_host: host.sshHost,
    ssh_port: host.sshPort,
    ssh_username: host.sshUsername,
    online: host.online,
    cwd: host.cwd,
    os: host.os,
    dialect: host.dialect,
    last_heartbeat_at: host.lastHeartbeatAt,
    status: host.status ?? (host.online === false ? 'offline' : 'online'),
    latency_ms: host.latencyMs,
    last_error: host.lastError,
    last_error_at: host.lastErrorAt,
    connection_started_at: host.connectionStartedAt,
    task_stats: host.taskStats,
    connection_duration: formatDuration(host.connectionStartedAt),
    task_stats: taskStats,
    current: host.hostId === currentHostId,
  }
}

function summarizeJobs(jobs) {
  const stats = { running: 0, succeeded: 0, failed: 0, timed_out: 0, canceled: 0, interrupted: 0 }
  for (const job of jobs) {
    if (Object.hasOwn(stats, job.status)) stats[job.status] += 1
  }
  return stats
}

function matchRoute(method, pathname) {
  if (method === 'GET' && pathname === '/hosts') return { name: 'list' }
  if (method === 'POST' && pathname === '/hosts/ssh') return { name: 'connectSsh' }
  if (method === 'POST' && pathname === '/hosts/pair') return { name: 'pair' }
  const use = /^\/hosts\/([^/]+)\/use$/.exec(pathname)
  if (method === 'POST' && use) return { name: 'use', hostId: decodeURIComponent(use[1]) }
  const reconnect = /^\/hosts\/([^/]+)\/reconnect$/.exec(pathname)
  if (method === 'POST' && reconnect) return { name: 'reconnect', hostId: decodeURIComponent(reconnect[1]) }
  const diagnose = /^\/hosts\/([^/]+)\/diagnose$/.exec(pathname)
  if (method === 'POST' && diagnose) return { name: 'diagnose', hostId: decodeURIComponent(diagnose[1]) }
  const health = /^\/hosts\/([^/]+)\/health$/.exec(pathname)
  if (method === 'GET' && health) return { name: 'health', hostId: decodeURIComponent(health[1]) }
  const jobs = /^\/hosts\/([^/]+)\/jobs$/.exec(pathname)
  if (method === 'GET' && jobs) return { name: 'hostJobs', hostId: decodeURIComponent(jobs[1]) }
  const files = /^\/hosts\/([^/]+)\/files$/.exec(pathname)
  if (method === 'GET' && files) return { name: 'files', hostId: decodeURIComponent(files[1]) }
  const file = /^\/hosts\/([^/]+)\/file$/.exec(pathname)
  if (method === 'GET' && file) return { name: 'readFile', hostId: decodeURIComponent(file[1]) }
  if (method === 'PUT' && file) return { name: 'writeFile', hostId: decodeURIComponent(file[1]) }
  if (method === 'DELETE' && file) return { name: 'deleteFile', hostId: decodeURIComponent(file[1]) }
  const terminal = /^\/hosts\/([^/]+)\/terminal$/.exec(pathname)
  if (method === 'POST' && terminal) return { name: 'terminal', hostId: decodeURIComponent(terminal[1]) }
  const changes = /^\/hosts\/([^/]+)\/changes$/.exec(pathname)
  if (method === 'GET' && changes) return { name: 'hostChanges', hostId: decodeURIComponent(changes[1]) }
  const host = /^\/hosts\/([^/]+)$/.exec(pathname)
  if (host && method === 'POST') return { name: 'update', hostId: decodeURIComponent(host[1]) }
  if (host && method === 'DELETE') return { name: 'remove', hostId: decodeURIComponent(host[1]) }
  const job = /^\/jobs\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && job) return { name: 'job', jobId: decodeURIComponent(job[1]) }
  const cancel = /^\/jobs\/([^/]+)\/cancel$/.exec(pathname)
  if (method === 'POST' && cancel) return { name: 'cancel', jobId: decodeURIComponent(cancel[1]) }
  const log = /^\/jobs\/([^/]+)\/log$/.exec(pathname)
  if (method === 'GET' && log) return { name: 'log', jobId: decodeURIComponent(log[1]) }
  const review = /^\/changes\/([^/]+)\/(accept|revert|restore)$/.exec(pathname)
  if (method === 'POST' && review) {
    return { name: 'reviewChange', changeId: decodeURIComponent(review[1]), action: review[2] }
  }
  const change = /^\/changes\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && change) return { name: 'change', changeId: decodeURIComponent(change[1]) }
  return null
}

export function createHostApiHandler({ runner }) {
  return async function handle(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      json(res, 403, { error: 'loopback only', code: 'LOOPBACK_ONLY' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://remote-ops.local')
    const pathname = url.pathname.startsWith(PREFIX)
      ? url.pathname.slice(PREFIX.length) || '/'
      : url.pathname
    const route = matchRoute(req.method ?? 'GET', pathname)
    if (!route) {
      json(res, 404, { error: 'not found', code: 'NOT_FOUND' })
      return
    }
    try {
      if (route.name === 'list') {
        const hosts = await runner.list()
        const current = runner.getCurrentHost?.()
        json(res, 200, {
          hosts: hosts.map((host) => publicHost(
            host,
            current?.hostId,
            summarizeJobs(runner.listJobs({ hostId: host.hostId })),
          )),
          current_host_id: current?.hostId ?? null,
        })
        return
      }
      if (route.name === 'pair') {
        const body = await readJson(req)
        const host = await runner.pair({
          address: body.address,
          pairingCode: body.pairing_code,
          displayName: body.display_name,
        })
        const current = runner.getCurrentHost()
        json(res, 200, publicHost(host, current?.hostId))
        return
      }
      if (route.name === 'connectSsh') {
        const body = await readJson(req)
        const host = await runner.connectSsh({
          host: body.host,
          port: body.port,
          username: body.username,
          password: body.password,
          displayName: body.display_name,
          workdir: body.workdir,
          hostFingerprint: body.host_fingerprint,
        })
        const current = runner.getCurrentHost()
        json(res, 200, publicHost(host, current?.hostId))
        return
      }
      if (route.name === 'use') {
        const host = await runner.use(route.hostId)
        json(res, 200, publicHost(host, host.hostId))
        return
      }
      if (route.name === 'reconnect') {
        const body = await readJson(req)
        const host = await runner.reconnectHost(route.hostId, {
          hostFingerprint: body.host_fingerprint,
        })
        const current = runner.getCurrentHost?.()
        json(res, 200, publicHost(host, current?.hostId))
        return
      }
      if (route.name === 'diagnose') {
        json(res, 200, await runner.diagnoseHost(route.hostId))
        return
      }
      if (route.name === 'health') {
        json(res, 200, await runner.healthHost(route.hostId))
        return
      }
      if (route.name === 'update') {
        const body = await readJson(req)
        const host = await runner.updateHost(route.hostId, {
          displayName: body.display_name,
        })
        const current = runner.getCurrentHost()
        json(res, 200, publicHost(host, current?.hostId))
        return
      }
      if (route.name === 'remove') {
        await runner.removeHost(route.hostId)
        json(res, 200, { ok: true })
        return
      }
      if (route.name === 'hostJobs') {
        const status = url.searchParams.get('status') || undefined
        const since = url.searchParams.get('since') || undefined
        const until = url.searchParams.get('until') || undefined
        const jobs = runner.listJobs({ hostId: route.hostId, status, since, until, limit: 20 })
        json(res, 200, { jobs: jobs.map((job) => publicJob(job)) })
        return
      }
      if (route.name === 'files') {
        const result = await runner.listFiles(route.hostId, url.searchParams.get('path') || undefined)
        json(res, 200, {
          host_id: result.hostId,
          path: result.path,
          entries: result.entries,
        })
        return
      }
      if (route.name === 'readFile') {
        const result = await runner.readRemoteFile(route.hostId, url.searchParams.get('path'))
        json(res, 200, {
          host_id: result.hostId,
          path: result.path,
          content: result.content,
          size: result.size,
          mtime: result.mtime,
          version: result.version,
        })
        return
      }
      if (route.name === 'writeFile') {
        const body = await readJson(req)
        const result = await runner.writeRemoteFile({
          host: route.hostId,
          path: body.path,
          content: body.content,
          beforeContent: body.before_content,
          expectedVersion: body.expected_version,
          source: body.source,
          description: body.description,
        })
        json(res, 200, publicChange(result))
        return
      }
      if (route.name === 'deleteFile') {
        const body = await readJson(req)
        const result = await runner.deleteRemoteFile({
          host: route.hostId,
          path: body.path,
          expectedVersion: body.expected_version,
          source: body.source,
          description: body.description,
        })
        json(res, 200, publicChange(result))
        return
      }
      if (route.name === 'terminal') {
        const body = await readJson(req)
        const result = await runner.exec({
          host: route.hostId,
          command: body.command,
          description: body.description ?? '远程终端命令',
          workdir: body.workdir,
          timeoutMs: body.timeout_ms,
        })
        json(res, 200, publicJob(result, result.log))
        return
      }
      if (route.name === 'hostChanges') {
        const changes = runner.listChanges({
          hostId: route.hostId,
          status: url.searchParams.get('status') || undefined,
          path: url.searchParams.get('path') || undefined,
          limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50))),
        })
        json(res, 200, { changes: changes.map(publicChange) })
        return
      }
      if (route.name === 'change') {
        json(res, 200, publicChange(await runner.readChange(route.changeId)))
        return
      }
      if (route.name === 'reviewChange') {
        json(res, 200, publicChange(await runner.reviewChange(route.changeId, route.action)))
        return
      }
      if (route.name === 'job') {
        const job = await runner.readJob(route.jobId)
        json(res, 200, publicJob(job, job.log))
        return
      }
      if (route.name === 'cancel') {
        const result = await runner.cancelJob(route.jobId)
        json(res, 200, publicJob(result))
        return
      }
      if (route.name === 'log') {
        const tail = Math.min(1_000_000, Math.max(1, Number(url.searchParams.get('tail') ?? 8192)))
        const result = await runner.readJobLogTail(route.jobId, tail)
        json(res, 200, publicJob(result, result.log))
      }
    } catch (error) {
      const code = error?.code ?? 'REMOTE_OPS_ERROR'
      const status = code === 'HOST_NOT_FOUND' || code === 'JOB_NOT_FOUND' || code === 'CHANGE_NOT_FOUND'
        ? 404
        : code === 'HOST_KEY_UNTRUSTED' || code === 'HOST_KEY_CHANGED'
          ? 409
          : code === 'SSH_CONNECT_FAILED' || code === 'SSH_AUTH_FAILED'
            ? 401
            : code === 'REMOTE_FILE_CONFLICT'
              ? 409
              : code === 'SSH_SFTP_FAILED'
                ? 502
                : 400
      json(res, status, {
        error: error instanceof Error ? error.message : 'failed',
        code,
        ...(error?.fingerprint ? { fingerprint: error.fingerprint } : {}),
        ...(error?.currentVersion !== undefined ? { current_version: error.currentVersion } : {}),
        ...(error?.expectedVersion !== undefined ? { expected_version: error.expectedVersion } : {}),
      })
    }
  }
}

export function registerHostApi(webServer, runner) {
  return webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: createHostApiHandler({ runner }),
  })
}
