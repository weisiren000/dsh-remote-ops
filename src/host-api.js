const PREFIX = '/remote-ops/v1'
const APPROVAL_OVERRIDES = new Set(['follow', 'auto', 'ask'])

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
    log: log ?? undefined,
  }
}

function publicHost(host, currentHostId) {
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
    approval_override: host.approvalOverride,
    current: host.hostId === currentHostId,
  }
}

function matchRoute(method, pathname) {
  if (method === 'GET' && pathname === '/hosts') return { name: 'list' }
  if (method === 'POST' && pathname === '/hosts/ssh') return { name: 'connectSsh' }
  if (method === 'POST' && pathname === '/hosts/pair') return { name: 'pair' }
  const use = /^\/hosts\/([^/]+)\/use$/.exec(pathname)
  if (method === 'POST' && use) return { name: 'use', hostId: decodeURIComponent(use[1]) }
  const jobs = /^\/hosts\/([^/]+)\/jobs$/.exec(pathname)
  if (method === 'GET' && jobs) return { name: 'hostJobs', hostId: decodeURIComponent(jobs[1]) }
  const host = /^\/hosts\/([^/]+)$/.exec(pathname)
  if (host && method === 'POST') return { name: 'update', hostId: decodeURIComponent(host[1]) }
  if (host && method === 'DELETE') return { name: 'remove', hostId: decodeURIComponent(host[1]) }
  const job = /^\/jobs\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && job) return { name: 'job', jobId: decodeURIComponent(job[1]) }
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
        const current = runner.getCurrentHost()
        json(res, 200, {
          hosts: hosts.map((host) => publicHost(host, current?.hostId)),
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
      if (route.name === 'update') {
        const body = await readJson(req)
        if (body.approval_override && !APPROVAL_OVERRIDES.has(body.approval_override)) {
          json(res, 400, { error: 'invalid approval_override', code: 'INVALID_APPROVAL' })
          return
        }
        const host = await runner.updateHost(route.hostId, {
          displayName: body.display_name,
          approvalOverride: body.approval_override,
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
        const jobs = runner.listJobs({ hostId: route.hostId, limit: 20 })
        json(res, 200, { jobs: jobs.map((job) => publicJob(job)) })
        return
      }
      if (route.name === 'job') {
        const job = await runner.readJob(route.jobId)
        json(res, 200, publicJob(job, job.log))
      }
    } catch (error) {
      const code = error?.code ?? 'REMOTE_OPS_ERROR'
      const status = code === 'HOST_NOT_FOUND'
        ? 404
        : code === 'HOST_KEY_UNTRUSTED'
          ? 409
          : code === 'SSH_CONNECT_FAILED'
            ? 401
            : 400
      json(res, status, {
        error: error instanceof Error ? error.message : 'failed',
        code,
        ...(error?.fingerprint ? { fingerprint: error.fingerprint } : {}),
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
