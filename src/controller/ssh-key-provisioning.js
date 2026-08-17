import ssh2 from 'ssh2'
import { execChannel } from './ssh-exec.js'

const { utils } = ssh2

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
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

export async function installPublicKey(connection, publicKey, dialect) {
  const result = dialect === 'pwsh'
    ? await installPowerShellKey(connection, publicKey)
    : await installPosixKey(connection, publicKey)
  if (result.exitCode !== 0) {
    throw codedError('SSH_KEY_INSTALL_FAILED', result.stderr.trim() || '无法安装 DSH 专用 SSH 密钥')
  }
}

async function installPowerShellKey(connection, publicKey) {
  const key = quotePowerShell(publicKey.trim())
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `$ssh = Join-Path $env:USERPROFILE '.ssh'`,
    `New-Item -ItemType Directory -Force -Path $ssh | Out-Null`,
    `$auth = Join-Path $ssh 'authorized_keys'`,
    `if (!(Test-Path -LiteralPath $auth)) { New-Item -ItemType File -Force -Path $auth | Out-Null }`,
    `$key = ${key}`,
    `if (@(Get-Content -LiteralPath $auth -ErrorAction SilentlyContinue) -notcontains $key) { Add-Content -LiteralPath $auth -Value $key }`,
  ].join('; ')
  return execChannel(connection, `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(command)}`)
}

async function installPosixKey(connection, publicKey) {
  const key = quotePosix(publicKey.trim())
  const command = [
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `(grep -qxF ${key} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${key} >> "$HOME/.ssh/authorized_keys")`,
  ].join(' && ')
  return execChannel(connection, command)
}

export async function removePublicKey(connection, publicKey, dialect, errorCode = 'SSH_KEY_REMOVE_FAILED') {
  // 回滚必须以远端退出码为准；失败时禁止把残留公钥当成已清理。
  const result = dialect === 'pwsh'
    ? await removePowerShellKey(connection, publicKey)
    : await removePosixKey(connection, publicKey)
  if (result.exitCode !== 0) {
    throw codedError(errorCode, result.stderr.trim() || '无法删除 DSH 专用 SSH 密钥')
  }
}

async function removePowerShellKey(connection, publicKey) {
  const key = quotePowerShell(publicKey.trim())
  const command = [
    `$ErrorActionPreference = 'Stop'`,
    `$auth = Join-Path (Join-Path $env:USERPROFILE '.ssh') 'authorized_keys'`,
    `if (Test-Path -LiteralPath $auth) { $key = ${key}; $remaining = [string[]]@(Get-Content -LiteralPath $auth -ErrorAction SilentlyContinue | Where-Object { $_ -ne $key }); [IO.File]::WriteAllLines($auth, $remaining) }`,
  ].join('; ')
  return execChannel(connection, `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(command)}`)
}

async function removePosixKey(connection, publicKey) {
  const key = quotePosix(publicKey.trim())
  const command = 'if [ -f "$HOME/.ssh/authorized_keys" ]; then '
    + [
      'tmp="$HOME/.ssh/authorized_keys.dsh-tmp"',
      `grep -vxF ${key} "$HOME/.ssh/authorized_keys" > "$tmp"`,
      'status=$?',
      'if [ "$status" -le 1 ]; then mv "$tmp" "$HOME/.ssh/authorized_keys"; else rm -f "$tmp"; exit "$status"; fi',
    ].join('; ')
    + '; fi'
  return execChannel(connection, command)
}

export function publicKeyFromPrivate(privateKey) {
  const parsed = utils.parseKey(privateKey)
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  return key?.getPublicSSH?.()
}
