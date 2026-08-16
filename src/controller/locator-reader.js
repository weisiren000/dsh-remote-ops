import { resolveTarget } from './resolve.js'
import { assertOwner, conflictError, contentVersion } from './runner-support.js'
import { sliceUtf8Text } from '../output-limits.js'

function pageOutput(page) {
  return {
    text: page.text,
    start_byte: page.startByte,
    end_byte: page.endByte,
    total_bytes: page.totalBytes,
    truncated: page.truncated ?? (page.startByte > 0 || page.endByte < page.totalBytes),
  }
}

async function readJobLocator(store, locator, options) {
  const job = store.getJob(locator.job_id) ?? store.getJobByDshJobId?.(locator.job_id)
  if (!job) {
    const error = new Error(`job not found: ${locator.job_id}`)
    error.code = 'JOB_NOT_FOUND'
    throw error
  }
  assertOwner(job, options.ownerSessionId, 'job')
  return pageOutput(await store.readJobLogRange(job.jobId, options.startByte, options.lengthBytes))
}

async function readFileLocator(store, client, locator, options) {
  const host = resolveTarget(store, locator.host_id, { allowOffline: true })
  const file = await client.readRemoteFile(host, locator.path)
  const version = file.version ?? contentVersion(file.content)
  if (version !== locator.version) throw conflictError(locator.version, version)
  return pageOutput(sliceUtf8Text(file.content, options.startByte, options.lengthBytes))
}

function readChangeLocator(store, locator, options) {
  const change = store.getChange(locator.change_id)
  if (!change) {
    const error = new Error(`change not found: ${locator.change_id}`)
    error.code = 'CHANGE_NOT_FOUND'
    throw error
  }
  assertOwner(change, options.ownerSessionId, 'change')
  const content = locator.side === 'before' ? change.beforeContent : change.afterContent
  return pageOutput(sliceUtf8Text(content ?? '', options.startByte, options.lengthBytes))
}

export async function readLocator({ store, client }, locator, options) {
  if (!Number.isSafeInteger(options.startByte) || options.startByte < 0
    || !Number.isSafeInteger(options.lengthBytes) || options.lengthBytes < 1) {
    const error = new Error('locator 字节范围无效')
    error.code = 'LOCATOR_RANGE_INVALID'
    throw error
  }
  if (locator.kind === 'controller_job_log') return readJobLocator(store, locator, options)
  if (locator.kind === 'remote_file') return readFileLocator(store, client, locator, options)
  if (locator.kind === 'controller_change_content') return readChangeLocator(store, locator, options)
  const error = new Error(`unsupported locator: ${locator.kind}`)
  error.code = 'LOCATOR_KIND_INVALID'
  throw error
}
