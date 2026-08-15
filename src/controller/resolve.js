function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertOnline(host) {
  if (host.online === false) {
    throw codedError('HOST_OFFLINE', `host offline: ${host.displayName} (${host.hostId})`)
  }
  return host
}

function findRequested(hosts, requestedHost) {
  const byId = hosts.find((host) => host.hostId === requestedHost)
  if (byId) return byId
  const byName = hosts.filter((host) => host.displayName === requestedHost)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw codedError('HOST_AMBIGUOUS', `ambiguous host: ${requestedHost}`)
  }
  throw codedError('HOST_NOT_FOUND', `host not found: ${requestedHost}`)
}

function findDefault(store, hosts) {
  const current = store.getCurrentHost()
  if (current) return current
  if (hosts.length === 1) return hosts[0]
  const listed = hosts.map((host) => `${host.displayName} (${host.hostId})`).join(', ')
  throw codedError('HOST_REQUIRED', `host required: ${listed}`)
}

export function resolveTarget(store, requestedHost, options = {}) {
  const hosts = store.listHosts().map((host) => store.getHost(host.hostId))
  const target = requestedHost
    ? findRequested(hosts, requestedHost)
    : findDefault(store, hosts)
  return options.allowOffline ? target : assertOnline(target)
}
