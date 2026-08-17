const PREFIX = '/remote-ssh-ops/v1'

async function parse(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error ?? `http ${response.status}`)
    Object.assign(error, body, { code: body.code ?? 'REMOTE_SSH_OPS_ERROR' })
    throw error
  }
  return body
}

function transferUrl(hostId, remotePath) {
  return `${PREFIX}/hosts/${encodeURIComponent(hostId)}/transfer?path=${encodeURIComponent(remotePath)}`
}

export function createSettingsClient(fetchImpl = fetch, xhrFactory = () => new XMLHttpRequest()) {
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
    reconnect(hostId, options = {}) {
      const normalized = typeof options === 'string' ? { hostFingerprint: options } : options
      const { hostFingerprint, password } = normalized
      const init = { method: 'POST' }
      if (hostFingerprint || password) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify({
          ...(hostFingerprint ? { host_fingerprint: hostFingerprint } : {}),
          ...(password ? { password } : {}),
        })
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
    files(hostId, remotePath) {
      const query = remotePath ? `?path=${encodeURIComponent(remotePath)}` : ''
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/files${query}`).then(parse)
    },
    file(hostId, remotePath) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/file?path=${encodeURIComponent(remotePath)}`).then(parse)
    },
    saveFile(hostId, input) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/file`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: input.path,
          content: input.content,
          before_content: input.beforeContent,
          expected_version: input.expectedVersion,
          source: input.source,
          description: input.description,
        }),
      }).then(parse)
    },
    deleteFile(hostId, input) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/file`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: input.path, expected_version: input.expectedVersion, source: input.source, description: input.description }),
      }).then(parse)
    },
    terminal(hostId, input) {
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/terminal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: input.command,
          workdir: input.workdir,
          timeout_ms: input.timeoutMs,
          description: input.description,
        }),
      }).then(parse)
    },
    changes(hostId, filters = {}) {
      const query = new URLSearchParams()
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, value)
      })
      const suffix = query.toString() ? `?${query}` : ''
      return fetchImpl(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/changes${suffix}`).then(parse)
    },
    change(changeId) {
      return fetchImpl(`${PREFIX}/changes/${encodeURIComponent(changeId)}`).then(parse)
    },
    reviewChange(changeId, action) {
      return fetchImpl(`${PREFIX}/changes/${encodeURIComponent(changeId)}/${encodeURIComponent(action)}`, { method: 'POST' }).then(parse)
    },
    listFiles(hostId, remotePath) { return this.files(hostId, remotePath) },
    readFile(hostId, remotePath) { return this.file(hostId, remotePath) },
    writeFile(hostId, input) { return this.saveFile(hostId, input) },
    deleteRemoteFile(hostId, input) { return this.deleteFile(hostId, input) },
    uploadFile(hostId, remotePath, file, onProgress, signal) {
      return new Promise((resolve, reject) => {
        const request = xhrFactory()
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const abort = () => request.abort()
        request.open('PUT', transferUrl(hostId, remotePath))
        request.responseType = 'json'
        request.upload.onprogress = (event) => {
          if (!event.lengthComputable) return
          onProgress?.({
            loaded: event.loaded,
            total: event.total,
            percent: Math.round((event.loaded / event.total) * 100),
          })
        }
        request.onload = () => {
          const body = request.response ?? {}
          if (request.status >= 200 && request.status < 300) {
            cleanup()
            resolve(body)
            return
          }
          const error = new Error(body.error ?? `http ${request.status}`)
          Object.assign(error, body, { code: body.code ?? 'REMOTE_SSH_OPS_ERROR' })
          cleanup()
          reject(error)
        }
        request.onerror = () => { cleanup(); reject(new Error('文件上传网络连接失败')) }
        request.onabort = () => { cleanup(); reject(Object.assign(new Error('文件上传已取消'), { code: 'TRANSFER_ABORTED' })) }
        if (signal?.aborted) {
          cleanup()
          reject(Object.assign(new Error('文件上传已取消'), { code: 'TRANSFER_ABORTED' }))
          return
        }
        signal?.addEventListener('abort', abort, { once: true })
        request.send(file)
      })
    },
    downloadUrl(hostId, remotePath) {
      return transferUrl(hostId, remotePath)
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
