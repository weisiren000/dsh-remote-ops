const PREFIX = '/remote-ops/v1'

async function parse(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error ?? `http ${response.status}`)
    Object.assign(error, body, { code: body.code ?? 'REMOTE_OPS_ERROR' })
    throw error
  }
  return body
}

export function createSettingsClient(fetchImpl = fetch) {
  return {
    list() {
      return fetchImpl(`${PREFIX}/hosts`).then(parse)
    },
    pair({ address, pairingCode, displayName }) {
      return fetchImpl(`${PREFIX}/hosts/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          address,
          pairing_code: pairingCode,
          display_name: displayName,
        }),
      }).then(parse)
    },
    ssh({ host, port, username, password, displayName, hostFingerprint }) {
      return fetchImpl(`${PREFIX}/hosts/ssh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host,
          port,
          username,
          password,
          display_name: displayName,
          host_fingerprint: hostFingerprint,
        }),
      }).then(parse)
    },
    use(hostId) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/use`, {
        method: 'POST',
      }).then(parse)
    },
    update(hostId, patch) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          display_name: patch.displayName,
        }),
      }).then(parse)
    },
    remove(hostId) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}`, {
        method: 'DELETE',
      }).then(parse)
    },
    reconnect(hostId, hostFingerprint) {
      const init = { method: 'POST' }
      if (hostFingerprint) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify({ host_fingerprint: hostFingerprint })
      }
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/reconnect`, init).then(parse)
    },
    diagnose(hostId) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/diagnose`, { method: 'POST' }).then(parse)
    },
    health(hostId) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/health`).then(parse)
    },
    jobs(hostId, filters = {}) {
      const query = new URLSearchParams()
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, value)
      })
      const suffix = query.toString() ? `?${query}` : ''
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/jobs${suffix}`).then(parse)
    },
    job(jobId) {
      return fetchImpl(`${PREFIX}/jobs/${encodeURIComponent(jobId)}`).then(parse)
    },
    cancel(jobId) {
      return fetchImpl(`${PREFIX}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).then(parse)
    },
    log(jobId, tail = 200) {
      const query = new URLSearchParams({ tail: String(tail) })
      return fetchImpl(`${PREFIX}/jobs/${encodeURIComponent(jobId)}/log?${query}`).then(parse)
    },
  }
}

export function reduceHostsState(state, event) {
  if (event.type === 'load-error') {
    return { ...state, error: event.message, hosts: state.hosts }
  }
  if (event.type === 'loaded') {
    return { error: null, hosts: event.hosts, currentHostId: event.currentHostId }
  }
  if (event.type === 'paired') {
    const hosts = state.hosts
      .filter((host) => host.host_id !== event.host.host_id)
      .concat(event.host)
    return {
      error: null,
      hosts,
      currentHostId: event.host.current ? event.host.host_id : state.currentHostId,
    }
  }
  return state
}
