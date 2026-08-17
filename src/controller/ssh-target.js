const DEFAULT_PORT = 22

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function normalizeConnection(input) {
  const sshHost = String(input.host ?? '').trim()
  const username = String(input.username ?? '').trim()
  const port = Number(input.port ?? DEFAULT_PORT)
  if (!sshHost) throw codedError('SSH_HOST_REQUIRED', '请输入 SSH 服务器地址')
  if (!username) throw codedError('SSH_USERNAME_REQUIRED', '请输入 SSH 用户名')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw codedError('SSH_PORT_INVALID', 'SSH 端口必须是 1 到 65535 之间的整数')
  }
  return { sshHost, username, port }
}

export function sshHostRecord({ input, target, remote, hostId, fingerprint, authMode, privateKeyPath }) {
  return {
    hostId,
    displayName: input.displayName || remote.hostname || target.sshHost,
    address: `ssh://${target.sshHost}:${target.port}`,
    transport: 'ssh',
    sshHost: target.sshHost,
    sshPort: target.port,
    sshUsername: target.username,
    hostFingerprint: fingerprint,
    authMode,
    ...(privateKeyPath ? { privateKeyPath } : {}),
    online: true,
    cwd: input.workdir || remote.cwd,
    os: remote.os,
    dialect: remote.dialect,
    lastHeartbeatAt: Date.now(),
  }
}
