import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export async function writeJsonAtomic(filePath, value, options = {}) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      ...(options.mode ? { mode: options.mode } : {}),
    })
    await (options.renameFile ?? rename)(temporaryPath, filePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export function createRecoverableQueue() {
  let tail = Promise.resolve()
  return (task) => {
    const operation = tail.catch(() => {}).then(task)
    tail = operation
    return operation
  }
}
