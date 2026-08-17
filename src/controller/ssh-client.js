import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import ssh2 from 'ssh2'
import {
  deleteSftpFile,
  downloadSftpFile,
  listSftpDirectory,
  readSftpFile,
  uploadSftpFile,
  writeSftpFile,
} from './sftp.js'
import { execChannel } from './ssh-exec.js'
import { createKeyboardInteractiveAuth } from './ssh-auth.js'
import {
  installPublicKey,
  publicKeyFromPrivate,
  removePublicKey,
} from './ssh-key-provisioning.js'

export { execChannel } from './ssh-exec.js'

const { Client, utils } = ssh2
const DEFAULT_PORT = 22
const CONNECT_TIMEOUT_MS = 20_000

function codedError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function connectionError(error) {
  if (error?.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED') return error
  if (error?.code === 'AUTH_FAILED' || error?.level === 'client-authentication') {
    return codedError('SSH_AUTH_FAILED', 'SSH 身份认证失败', { cause: error })
  }
  return codedError('SSH_CONNECT_FAILED', error?.message || 'SSH 连接失败', { cause: error })
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function encodePowerShell(value) {
  return Buffer.from(value, 'utf16le').toString('base64')
}

function normalizeConnection(input) {
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

// Open one authenticated connection while enforcing explicit host-key trust.
function openConnection(config) {
  return new Promise((resolve, reject) => {
    const connection = new Client()
    let actualFingerprint = null
    let settled = false
    let interactiveAuth
    const clearInteractiveAuth = () => {
      if (!interactiveAuth) return
      // ssh2 会缓存认证配置，认证结束后主动清除其中的密码引用。
      config.password = undefined
      connection.config.password = undefined
      connection.config.authHandler = undefined
      connection.removeListener('keyboard-interactive', interactiveAuth.handle)
      interactiveAuth.clear()
      interactiveAuth = undefined
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearInteractiveAuth()
      connection.end()
      if (actualFingerprint && !config.hostFingerprint) {
        reject(codedError(
          'HOST_KEY_UNTRUSTED',
          '请确认服务器 SSH 指纹后重试',
          { fingerprint: actualFingerprint },
        ))
        return
      }
      if (actualFingerprint && actualFingerprint !== config.hostFingerprint) {
        reject(codedError(
          'HOST_KEY_CHANGED',
          '服务器 SSH 指纹与已保存记录不一致',
          { fingerprint: actualFingerprint },
        ))
        return
      }
      reject(connectionError(error))
    }
    connection.once('ready', () => {
      if (settled) return
      const readyError = interactiveAuth?.readyError()
      if (readyError) {
        fail(readyError)
        return
      }
      settled = true
      clearInteractiveAuth()
      resolve({ connection, fingerprint: actualFingerprint })
    })
    connection.once('error', fail)
    connection.once('close', () => {
      if (!settled) fail(new Error('SSH 连接在握手完成前关闭'))
    })
    if (config.password) {
      interactiveAuth = createKeyboardInteractiveAuth(config.password, fail)
      connection.on('keyboard-interactive', interactiveAuth.handle)
    }
    connection.connect({
      host: config.sshHost,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      tryKeyboard: Boolean(interactiveAuth),
      authHandler: interactiveAuth?.authHandler,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier(fingerprint) {
        actualFingerprint = fingerprint
        return Boolean(config.hostFingerprint && fingerprint === config.hostFingerprint)
      },
    })
  })
}

async function inspectRemote(connection) {
  const unix = await execChannel(connection, 'hostname; printf "\\n__DSH_CWD__%s\\n" "$PWD"; uname -s')
  const marker = unix.stdout.indexOf('\n__DSH_CWD__')
  if (unix.exitCode === 0 && marker !== -1) {
    const hostname = unix.stdout.slice(0, marker).trim()
    const remainder = unix.stdout.slice(marker + 1).split('\n')
    const cwd = remainder.find((line) => line.startsWith('__DSH_CWD__'))?.slice(11) || undefined
    const system = remainder.at(-1)?.trim().toLowerCase() || 'linux'
    return { hostname, cwd, os: system.includes('darwin') ? 'macos' : 'linux', dialect: 'bash' }
  }
  const windows = await execChannel(
    connection,
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell("Write-Output $env:COMPUTERNAME; Write-Output ('__DSH_CWD__' + (Get-Location).Path); Write-Output '__DSH_OS__windows'")}`,
  )
  if (windows.exitCode !== 0) throw codedError('SSH_INSPECT_FAILED', '无法读取远程主机信息')
  const lines = windows.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const cwd = lines.find((line) => line.startsWith('__DSH_CWD__'))?.slice(11)
  if (!cwd || !lines.includes('__DSH_OS__windows')) {
    throw codedError('SSH_UNSUPPORTED_SHELL', '远程 SSH Shell 需要 bash 或 PowerShell')
  }
  return { hostname: lines[0], cwd, os: 'windows', dialect: 'pwsh' }
}

function sshHostRecord({ input, target, remote, hostId, fingerprint, authMode, privateKeyPath }) {
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

export function createSshClient({ keysDir, sftpLockStaleMs, openConnection: open = openConnection }) {
  const sessions = new Map()
  const connecting = new Map()
  const reconnectState = new Map()
  const activeChannels = new Map()
  const disposal = new AbortController()
  let disposed = false
  let disposePromise

  const disposedError = () => codedError('SSH_CLIENT_DISPOSED', 'SSH 客户端已释放')
  const assertActive = () => {
    if (disposed) throw disposedError()
  }
  const waitForReconnect = (delayMs) => new Promise((resolve, reject) => {
    if (disposal.signal.aborted) {
      reject(disposedError())
      return
    }
    const timer = setTimeout(finish, delayMs)
    function finish() {
      disposal.signal.removeEventListener('abort', cancel)
      resolve()
    }
    function cancel() {
      clearTimeout(timer)
      disposal.signal.removeEventListener('abort', cancel)
      reject(disposedError())
    }
    disposal.signal.addEventListener('abort', cancel, { once: true })
  })

  const markReconnectFailure = (hostId) => {
    const state = reconnectState.get(hostId) ?? { attempts: 0, nextAt: 0 }
    state.attempts += 1
    state.nextAt = Date.now() + Math.min(30_000, 500 * (2 ** Math.min(state.attempts, 6)))
    reconnectState.set(hostId, state)
  }

  const rememberSession = (hostId, connection) => {
    const previous = sessions.get(hostId)
    previous?.end()
    sessions.set(hostId, connection)
    connection.once('close', () => {
      if (sessions.get(hostId) === connection) {
        sessions.delete(hostId)
        markReconnectFailure(hostId)
      }
    })
  }

  const ensureSession = async (host) => {
    assertActive()
    const current = sessions.get(host.hostId)
    if (current) return current
    if (host.authMode === 'password_session') {
      throw codedError('SSH_REAUTH_REQUIRED', 'SSH 会话已断开，请重新输入登录密码')
    }
    const pending = connecting.get(host.hostId)
    if (pending) return pending
    const task = (async () => {
      const state = reconnectState.get(host.hostId)
      if (state?.nextAt > Date.now()) await waitForReconnect(state.nextAt - Date.now())
      assertActive()
      const privateKey = await readFile(host.privateKeyPath, 'utf8').catch(() => {
        throw codedError('SSH_KEY_MISSING', '本机保存的 SSH 专用密钥不存在，请重新连接')
      })
      assertActive()
      const opened = await open({
        sshHost: host.sshHost,
        port: host.sshPort,
        username: host.sshUsername,
        privateKey,
        hostFingerprint: host.hostFingerprint,
      })
      if (disposed) {
        opened.connection.end()
        throw disposedError()
      }
      rememberSession(host.hostId, opened.connection)
      reconnectState.delete(host.hostId)
      return opened.connection
    })()
    connecting.set(host.hostId, task)
    try {
      return await task
    } catch (error) {
      if (!disposed) markReconnectFailure(host.hostId)
      throw error
    } finally {
      if (connecting.get(host.hostId) === task) connecting.delete(host.hostId)
    }
  }

  const reauthenticate = async (host, options) => {
    if (!options.password) {
      throw codedError('SSH_REAUTH_REQUIRED', 'SSH 会话已断开，请重新输入登录密码')
    }
    const opened = await open({
      sshHost: host.sshHost,
      port: host.sshPort,
      username: host.sshUsername,
      password: options.password,
      hostFingerprint: options.hostFingerprint ?? host.hostFingerprint,
    })
    try {
      const remote = await inspectRemote(opened.connection)
      rememberSession(host.hostId, opened.connection)
      reconnectState.delete(host.hostId)
      return { hostId: host.hostId, ...remote, ts: Date.now() }
    } catch (error) {
      opened.connection.end()
      throw error
    }
  }

  return {
    async connect(input) {
      assertActive()
      const target = normalizeConnection(input)
      if (!input.password) throw codedError('SSH_PASSWORD_REQUIRED', '请输入 SSH 登录密码')
      const hostId = randomUUID()
      const privateKeyPath = path.join(keysDir, `${hostId}.key`)
      const task = (async () => {
        let opened
        let verified
        try {
          opened = await open({
            ...target,
            password: input.password,
            hostFingerprint: input.hostFingerprint,
          })
          assertActive()
          const remote = await inspectRemote(opened.connection)
          assertActive()
          const keys = utils.generateKeyPairSync('ed25519', { comment: `dsh-remote-ssh-ops-${hostId}` })
          await mkdir(keysDir, { recursive: true })
          assertActive()
          await writeFile(privateKeyPath, keys.private, { encoding: 'utf8', mode: 0o600 })
          assertActive()
          await installPublicKey(opened.connection, keys.public, remote.dialect)
          assertActive()
          try {
            verified = await open({
              ...target,
              privateKey: keys.private,
              hostFingerprint: opened.fingerprint,
            })
          } catch (error) {
            if (error?.code !== 'SSH_AUTH_FAILED') throw error
            // 网关只接受会话密码时，必须先回滚目标机公钥再保留首次连接。
            await removePublicKey(
              opened.connection,
              keys.public,
              remote.dialect,
              'SSH_KEY_ROLLBACK_FAILED',
            )
            await unlink(privateKeyPath).catch(() => {})
            rememberSession(hostId, opened.connection)
            return sshHostRecord({
              input,
              target,
              remote,
              hostId,
              fingerprint: opened.fingerprint,
              authMode: 'password_session',
            })
          }
          assertActive()
          opened.connection.end()
          rememberSession(hostId, verified.connection)
          return sshHostRecord({
            input,
            target,
            remote,
            hostId,
            fingerprint: opened.fingerprint,
            authMode: 'key',
            privateKeyPath,
          })
        } catch (error) {
          opened?.connection?.end?.()
          verified?.connection?.end?.()
          await unlink(privateKeyPath).catch(() => {})
          throw error
        }
      })()
      connecting.set(hostId, task)
      try {
        return await task
      } finally {
        if (connecting.get(hostId) === task) connecting.delete(hostId)
      }
    },
    async heartbeat(host) {
      const connection = await ensureSession(host)
      const remote = await inspectRemote(connection)
      return { hostId: host.hostId, ...remote, ts: Date.now() }
    },
    async listDirectory(host, remotePath, options) {
      const connection = await ensureSession(host)
      return listSftpDirectory(connection, remotePath || host.cwd || '.', options)
    },
    async readRemoteFile(host, remotePath) {
      const connection = await ensureSession(host)
      return readSftpFile(connection, remotePath)
    },
    async writeRemoteFile(host, remotePath, content, expectedVersion) {
      const connection = await ensureSession(host)
      return writeSftpFile(connection, remotePath, content, expectedVersion, { staleMs: sftpLockStaleMs })
    },
    async deleteRemoteFile(host, remotePath, expectedVersion) {
      const connection = await ensureSession(host)
      return deleteSftpFile(connection, remotePath, expectedVersion, { staleMs: sftpLockStaleMs })
    },
    async uploadRemoteFile(host, remotePath, source) {
      const connection = await ensureSession(host)
      return uploadSftpFile(connection, remotePath, source)
    },
    async downloadRemoteFile(host, remotePath) {
      const connection = await ensureSession(host)
      return downloadSftpFile(connection, remotePath)
    },
    async reconnect(host, options = {}) {
      sessions.get(host.hostId)?.end()
      sessions.delete(host.hostId)
      reconnectState.delete(host.hostId)
      if (host.authMode === 'password_session') return reauthenticate(host, options)
      return this.heartbeat(host)
    },
    async exec(host, spec) {
      const connection = await ensureSession(host)
      const command = spec.workdir && host.dialect === 'pwsh'
        ? `Set-Location -LiteralPath ${quotePowerShell(spec.workdir)}; ${spec.command}`
        : spec.workdir
          ? `cd -- ${quotePosix(spec.workdir)} && ${spec.command}`
          : spec.command
      const remoteCommand = host.dialect === 'pwsh'
        ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(command)}`
        : command
      return execChannel(connection, remoteCommand, {
        ...spec,
        remoteJobId: spec.remoteJobId,
        onRemoteJobId(remoteJobId) {
          spec.onRemoteJobId?.(remoteJobId)
        },
        onChannel(channel, remoteJobId) {
          let resolveDone
          const done = new Promise((resolve) => { resolveDone = resolve })
          activeChannels.set(remoteJobId, { channel, hostId: host.hostId, done })
          channel.once('close', () => {
            if (activeChannels.get(remoteJobId)?.channel === channel) activeChannels.delete(remoteJobId)
            resolveDone()
          })
        },
      })
    },
    async cancel(host, remoteJobId) {
      if (!remoteJobId) return { supported: false, reason: 'SSH_CHANNEL_NOT_READY' }
      const active = activeChannels.get(remoteJobId)
      if (!active || active.hostId !== host.hostId) return { supported: false, reason: 'SSH_CHANNEL_NOT_FOUND' }
      active.channel.signal('TERM')
      active.channel.close()
      await active.done
      return { supported: true, remoteJobId }
    },
    async remove(host) {
      let connection = sessions.get(host.hostId)
      if (!connection && host.transport === 'ssh') {
        connection = await ensureSession(host).catch(() => undefined)
      }
      if (connection && host.privateKeyPath) {
        const privateKey = await readFile(host.privateKeyPath, 'utf8').catch(() => undefined)
        const publicKey = privateKey
          ? (() => {
            try {
              return publicKeyFromPrivate(privateKey)
            } catch {
              return undefined
            }
          })()
          : undefined
        if (publicKey) {
          const dialect = host.dialect ?? 'bash'
          await removePublicKey(connection, publicKey, dialect).catch(() => {})
        }
      }
      connection?.end()
      sessions.delete(host.hostId)
      connecting.delete(host.hostId)
      if (host.privateKeyPath) await unlink(host.privateKeyPath).catch(() => {})
    },
    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      disposal.abort()
      disposePromise = (async () => {
        const channels = [...activeChannels.values()]
        for (const active of channels) {
          active.channel.signal('KILL')
          active.channel.close()
        }
        await Promise.allSettled(channels.map((active) => active.done))
        await Promise.allSettled([...connecting.values()])
        for (const connection of sessions.values()) connection.end()
        sessions.clear()
        connecting.clear()
        reconnectState.clear()
        activeChannels.clear()
      })()
      return disposePromise
    },
  }
}
