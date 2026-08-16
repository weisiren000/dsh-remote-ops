import { realpath } from 'node:fs/promises'
import path from 'node:path'

function codedError(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function nearestRealAncestor(candidate) {
  let current = candidate
  while (true) {
    try {
      return { lexical: current, real: await realpath(current) }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

// 词法边界和真实路径边界都通过后才返回，待创建文件按最近存在父目录校验。
export async function createWorkspacePathResolver(root) {
  const lexicalRoot = path.resolve(root)
  const realRoot = await realpath(lexicalRoot)
  return async function resolveWorkspacePath(requestedPath) {
    const value = String(requestedPath ?? '').trim()
    if (!value || value.includes('\0')) throw codedError('REMOTE_PATH_INVALID', '文件路径无效')
    const candidate = path.resolve(lexicalRoot, value)
    if (!isInside(lexicalRoot, candidate)) {
      throw codedError('REMOTE_PATH_OUTSIDE_WORKSPACE', '文件路径超出 hostd 工作目录', 403)
    }
    const ancestor = await nearestRealAncestor(candidate)
    const resolved = path.resolve(ancestor.real, path.relative(ancestor.lexical, candidate))
    if (!isInside(realRoot, resolved)) {
      throw codedError('REMOTE_PATH_OUTSIDE_WORKSPACE', '文件路径通过链接超出 hostd 工作目录', 403)
    }
    return resolved
  }
}
