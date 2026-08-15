const PREFIX = '/remote-ops/v1'

async function parse(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error ?? `http ${response.status}`)
    error.code = body.code ?? 'REMOTE_OPS_ERROR'
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
          approval_override: patch.approvalOverride,
        }),
      }).then(parse)
    },
    remove(hostId) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}`, {
        method: 'DELETE',
      }).then(parse)
    },
    jobs(hostId) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/jobs`).then(parse)
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
