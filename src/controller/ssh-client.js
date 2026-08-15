import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import ssh2 from 'ssh2'

const { Client, utils } = ssh2
const DEFAULT_PORT = 22
const CONNECT_TIMEOUT_MS = 20_000

function codedError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
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
    const fail = (error) => {
      if (settled) return
      settled = true
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
        reject(codedError('HOST_KEY_CHANGED', '服务器 SSH 指纹与已保存记录不一致'))
        return
      }
      reject(codedError('SSH_CONNECT_FAILED', error.message || 'SSH 连接失败', { cause: error }))
    }
    connection.once('ready', () => {
      if (settled) return
      settled = true
      resolve({ connection, fingerprint: actualFingerprint })
    })
    connection.once('error', fail)
    connection.once('close', () => {
      if (!settled) fail(new Error('SSH 连接在握手完成前关闭'))
    })
    connection.connect({
      host: config.sshHost,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
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

function execChannel(connection, command, options = {}) {
  return new Promise((resolve, reject) => {
    let stream
    let timer
    let settled = false
    let timedOut = false
    let aborted = false
    const stdout = []
    const stderr = []
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finishError = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      aborted = true
      if (!stream) return
      stream.signal('KILL')
      stream.close()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    connection.exec(command, (error, channel) => {
      if (error) {
        finishError(error)
        return
      }
      stream = channel
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true
          stream.signal('KILL')
          stream.close()
        }, options.timeoutMs)
      }
      stream.on('data', (chunk) => {
        stdout.push(chunk)
        options.onStdout?.(chunk)
      })
      stream.stderr.on('data', (chunk) => {
        stderr.push(chunk)
        options.onStderr?.(chunk)
      })
      stream.once('error', (streamError) => {
        finishError(streamError)
      })
      stream.once('close', (exitCode, signal) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? (timedOut || aborted ? null : 1),
          signal,
          timedOut,
          aborted,
          remoteJobId: randomUUID(),
          streamed: true,
        })
      })
      if (options.signal?.aborted) onAbort()
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

async function installPublicKey(connection, publicKey, dialect) {
  if (dialect === 'pwsh') {
    const key = quotePowerShell(publicKey.trim())
    const command = [
      `$ssh = Join-Path $env:USERPROFILE '.ssh'`,
      `New-Item -ItemType Directory -Force -Path $ssh | Out-Null`,
      `$auth = Join-Path $ssh 'authorized_keys'`,
      `if (!(Test-Path -LiteralPath $auth)) { New-Item -ItemType File -Force -Path $auth | Out-Null }`,
      `$key = ${key}`,
      `if (@(Get-Content -LiteralPath $auth -ErrorAction SilentlyContinue) -notcontains $key) { Add-Content -LiteralPath $auth -Value $key }`,
    ].join('; ')
    const result = await execChannel(connection, `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(command)}`)
    if (result.exitCode !== 0) {
      throw codedError('SSH_KEY_INSTALL_FAILED', result.stderr.trim() || '无法安装 DSH 专用 SSH 密钥')
    }
    return
  }
  const key = quotePosix(publicKey.trim())
  const command = [
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `(grep -qxF ${key} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${key} >> "$HOME/.ssh/authorized_keys")`,
  ].join(' && ')
  const result = await execChannel(connection, command)
  if (result.exitCode !== 0) {
    throw codedError('SSH_KEY_INSTALL_FAILED', result.stderr.trim() || '无法安装 DSH 专用 SSH 密钥')
  }
}

async function removePublicKey(connection, publicKey, dialect) {
  if (dialect === 'pwsh') {
    const key = quotePowerShell(publicKey.trim())
    const command = [
      `$auth = Join-Path (Join-Path $env:USERPROFILE '.ssh') 'authorized_keys'`,
      `if (Test-Path -LiteralPath $auth) { $key = ${key}; $remaining = [string[]]@(Get-Content -LiteralPath $auth -ErrorAction SilentlyContinue | Where-Object { $_ -ne $key }); [IO.File]::WriteAllLines($auth, $remaining) }`,
    ].join('; ')
    await execChannel(connection, `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(command)}`)
    return
  }
  const key = quotePosix(publicKey.trim())
  const command = 'if [ -f "$HOME/.ssh/authorized_keys" ]; then '
    + [
    'tmp="$HOME/.ssh/authorized_keys.dsh-tmp"',
    `grep -vxF ${key} "$HOME/.ssh/authorized_keys" > "$tmp"`,
    'status=$?',
    'if [ "$status" -le 1 ]; then mv "$tmp" "$HOME/.ssh/authorized_keys"; else rm -f "$tmp"; exit "$status"; fi',
  ].join('; ')
    + '; fi'
  await execChannel(connection, command)
}

function publicKeyFromPrivate(privateKey) {
  const parsed = utils.parseKey(privateKey)
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  return key?.getPublicSSH?.()
}

export function createSshClient({ keysDir }) {
  const sessions = new Map()
  const connecting = new Map()
  let disposed = false

  const rememberSession = (hostId, connection) => {
    const previous = sessions.get(hostId)
    previous?.end()
    sessions.set(hostId, connection)
    connection.once('close', () => {
      if (sessions.get(hostId) === connection) sessions.delete(hostId)
    })
  }

  const ensureSession = async (host) => {
    if (disposed) throw codedError('SSH_CLIENT_DISPOSED', 'SSH 客户端已释放')
    const current = sessions.get(host.hostId)
    if (current) return current
    const pending = connecting.get(host.hostId)
    if (pending) return pending
    const task = (async () => {
      const privateKey = await readFile(host.privateKeyPath, 'utf8').catch(() => {
        throw codedError('SSH_KEY_MISSING', '本机保存的 SSH 专用密钥不存在，请重新连接')
      })
      const opened = await openConnection({
        sshHost: host.sshHost,
        port: host.sshPort,
        username: host.sshUsername,
        privateKey,
        hostFingerprint: host.hostFingerprint,
      })
      rememberSession(host.hostId, opened.connection)
      return opened.connection
    })()
    connecting.set(host.hostId, task)
    try {
      return await task
    } finally {
      if (connecting.get(host.hostId) === task) connecting.delete(host.hostId)
    }
  }

  return {
    async connect(input) {
      if (disposed) throw codedError('SSH_CLIENT_DISPOSED', 'SSH 客户端已释放')
      const target = normalizeConnection(input)
      if (!input.password) throw codedError('SSH_PASSWORD_REQUIRED', '请输入 SSH 登录密码')
      const opened = await openConnection({
        ...target,
        password: input.password,
        hostFingerprint: input.hostFingerprint,
      })
      const hostId = randomUUID()
      const privateKeyPath = path.join(keysDir, `${hostId}.key`)
      try {
        const remote = await inspectRemote(opened.connection)
        const keys = utils.generateKeyPairSync('ed25519', { comment: `dsh-remote-ops-${hostId}` })
        await mkdir(keysDir, { recursive: true })
        await writeFile(privateKeyPath, keys.private, { encoding: 'utf8', mode: 0o600 })
        await installPublicKey(opened.connection, keys.public, remote.dialect)
        const verified = await openConnection({
          ...target,
          privateKey: keys.private,
          hostFingerprint: opened.fingerprint,
        })
        opened.connection.end()
        rememberSession(hostId, verified.connection)
        return {
          hostId,
          displayName: input.displayName || remote.hostname || target.sshHost,
          address: `ssh://${target.sshHost}:${target.port}`,
          transport: 'ssh',
          sshHost: target.sshHost,
          sshPort: target.port,
          sshUsername: target.username,
          hostFingerprint: opened.fingerprint,
          privateKeyPath,
          online: true,
          cwd: input.workdir || remote.cwd,
          os: remote.os,
          dialect: remote.dialect,
          lastHeartbeatAt: Date.now(),
          approvalOverride: 'follow',
        }
      } catch (error) {
        opened.connection.end()
        await unlink(privateKeyPath).catch(() => {})
        throw error
      }
    },
    async heartbeat(host) {
      const connection = await ensureSession(host)
      const remote = await inspectRemote(connection)
      return { hostId: host.hostId, ...remote, ts: Date.now() }
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
      return execChannel(connection, remoteCommand, spec)
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
      disposed = true
      for (const connection of sessions.values()) connection.end()
      sessions.clear()
      connecting.clear()
    },
  }
}
