import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ssh2 from 'ssh2'

const { utils } = ssh2

// 恢复连接时默认最多尝试的托管密钥数量：远低于 sshd 默认 MaxAuthTries(6)，
// 避免多密钥快速认证触发远端限速或封禁。
export const DEFAULT_MAX_RECOVERY_KEYS = 3

async function keyCandidates(keysDir) {
  const entries = await readdir(keysDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.key'))
    .map((entry) => ({
      hostId: entry.name.slice(0, -4),
      privateKeyPath: path.join(keysDir, entry.name),
    }))
    .sort((left, right) => left.hostId.localeCompare(right.hostId))
}

async function readManagedKey(candidate) {
  const privateKey = await readFile(candidate.privateKeyPath, 'utf8').catch(() => undefined)
  if (!privateKey || utils.parseKey(privateKey) instanceof Error) return undefined
  return privateKey
}

// 记录丢失时仅尝试插件自己生成并保存在 keys 目录中的密钥。
export async function recoverManagedKeyConnection({
  keysDir,
  target,
  hostFingerprint,
  openConnection,
  inspectRemote,
  maxKeys = DEFAULT_MAX_RECOVERY_KEYS,
}) {
  let attempted = 0
  for (const candidate of await keyCandidates(keysDir)) {
    if (attempted >= maxKeys) break
    const privateKey = await readManagedKey(candidate)
    if (!privateKey) continue
    attempted += 1
    try {
      const opened = await openConnection({
        ...target,
        privateKey,
        hostFingerprint,
      })
      try {
        const remote = await inspectRemote(opened.connection)
        return { ...candidate, opened, remote }
      } catch (error) {
        // 已建立但检查失败的连接必须立即关闭，避免泄漏临时 SSH 连接。
        opened.connection.end()
        throw error
      }
    } catch (error) {
      // 仅身份认证失败继续尝试下一个托管密钥；
      // HOST_KEY_CHANGED / SSH_INSPECT_FAILED 等保留原始语义，立即抛出。
      if (error?.code === 'SSH_AUTH_FAILED') continue
      throw error
    }
  }
  return null
}
