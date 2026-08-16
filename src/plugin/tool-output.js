import { DEFAULT_MAX_INLINE_OUTPUT_BYTES, truncateUtf8Text } from '../output-limits.js'

export const JOB_STATUSES = ['running', 'succeeded', 'failed', 'canceled', 'timed_out', 'interrupted']
export const DEFAULT_MODEL_LIST_LIMIT = 100
export const MAX_MODEL_LIST_LIMIT = 1000

const LOG_LOCATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['controller_job_log'] },
    job_id: { type: 'string', required: true },
    start_byte: { type: 'integer', required: true },
    total_bytes: { type: 'integer', required: true },
  },
}

const FILE_LOCATOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['remote_file'] },
    host_id: { type: 'string', required: true }, path: { type: 'string', required: true },
    version: { type: 'string', required: true }, start_byte: { type: 'integer', required: true },
    total_bytes: { type: 'integer', required: true },
  },
}

const CHANGE_CONTENT_LOCATOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, enum: ['controller_change_content'] },
    change_id: { type: 'string', required: true },
    side: { type: 'string', required: true, enum: ['before', 'after'] },
    start_byte: { type: 'integer', required: true }, total_bytes: { type: 'integer', required: true },
  },
}

export const LOCATOR_SCHEMA = {
  oneOf: [LOG_LOCATOR_SCHEMA, FILE_LOCATOR_SCHEMA, CHANGE_CONTENT_LOCATOR_SCHEMA],
}

export const JOB_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true }, hostId: { type: 'string', required: true },
    command: { type: 'string', required: true }, description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: JOB_STATUSES }, exitCode: { type: 'integer' },
    startedAt: { type: 'number', required: true }, finishedAt: { type: 'number' },
    approvalDenied: { type: 'boolean', required: true }, remoteJobId: { type: 'string' },
    dshJobId: { type: 'string' }, logBytes: { type: 'integer' }, logTruncated: { type: 'boolean' },
    logLocator: LOG_LOCATOR_SCHEMA, log: { type: 'string' },
  },
}

export const FILE_ENTRY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string', required: true }, path: { type: 'string', required: true },
    type: { type: 'string', required: true, enum: ['file', 'directory', 'symlink'] },
    size: { type: 'number' }, mtime: { type: 'number' }, mode: { type: 'integer' },
  },
}

export const REMOTE_FILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    host_id: { type: 'string', required: true }, path: { type: 'string', required: true },
    content: { type: 'string', required: true }, version: { type: 'string', required: true },
    content_bytes: { type: 'integer', required: true }, content_truncated: { type: 'boolean', required: true },
    content_locator: FILE_LOCATOR_SCHEMA,
  },
}

export const CHANGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    change_id: { type: 'string', required: true }, host_id: { type: 'string', required: true },
    path: { type: 'string', required: true }, before_content: { type: 'string' },
    before_content_bytes: { type: 'integer' }, before_content_truncated: { type: 'boolean' },
    before_content_locator: CHANGE_CONTENT_LOCATOR_SCHEMA, after_content: { type: 'string' },
    after_content_bytes: { type: 'integer' }, after_content_truncated: { type: 'boolean' },
    after_content_locator: CHANGE_CONTENT_LOCATOR_SCHEMA, before_version: { type: 'string' },
    after_version: { type: 'string' }, status: { type: 'string', required: true },
    source: { type: 'string', required: true }, description: { type: 'string' },
    created_at: { type: 'number', required: true }, updated_at: { type: 'number', required: true },
  },
}

export function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

export function toJobOutput(job, maxInlineOutputBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES) {
  const boundedLog = job.log === undefined ? null : truncateUtf8Text(job.log, maxInlineOutputBytes)
  return {
    jobId: job.jobId, hostId: job.hostId, command: job.command, description: job.description,
    status: job.status, startedAt: job.startedAt, approvalDenied: job.approvalDenied === true,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.remoteJobId !== undefined ? { remoteJobId: job.remoteJobId } : {}),
    ...(job.dshJobId !== undefined ? { dshJobId: job.dshJobId } : {}),
    ...(job.logBytes !== undefined || boundedLog ? { logBytes: job.logBytes ?? boundedLog.bytes } : {}),
    ...(job.logTruncated !== undefined || boundedLog ? {
      logTruncated: job.logTruncated === true || boundedLog?.truncated === true,
    } : {}),
    ...(job.logLocator !== undefined ? { logLocator: job.logLocator } : {}),
    ...(boundedLog ? { log: boundedLog.text } : {}),
  }
}

export function toFileEntry(entry) {
  return {
    name: entry.name, path: entry.path, type: entry.type,
    ...(entry.size != null ? { size: entry.size } : {}),
    ...(entry.mtime != null ? { mtime: entry.mtime } : {}),
    ...(entry.mode != null ? { mode: entry.mode } : {}),
  }
}

export function toRemoteFileOutput(result, maxInlineOutputBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES) {
  const bounded = truncateUtf8Text(result.content, maxInlineOutputBytes)
  return {
    host_id: result.hostId, path: result.path, content: bounded.text, version: result.version,
    content_bytes: bounded.bytes, content_truncated: bounded.truncated,
    ...(bounded.truncated ? {
      content_locator: {
        kind: 'remote_file', host_id: result.hostId, path: result.path, version: result.version,
        start_byte: 0, total_bytes: bounded.bytes,
      },
    } : {}),
  }
}

export function normalizeListLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MODEL_LIST_LIMIT
  return Math.min(value, MAX_MODEL_LIST_LIMIT)
}

function boundedChangeContent(change, side, maxBytes) {
  const content = change[side === 'before' ? 'beforeContent' : 'afterContent']
  if (content === null || content === undefined) return {}
  const bounded = truncateUtf8Text(content, maxBytes)
  return {
    [`${side}_content`]: bounded.text,
    [`${side}_content_bytes`]: bounded.bytes,
    [`${side}_content_truncated`]: bounded.truncated,
    ...(bounded.truncated ? {
      [`${side}_content_locator`]: {
        kind: 'controller_change_content', change_id: change.changeId, side,
        start_byte: 0, total_bytes: bounded.bytes,
      },
    } : {}),
  }
}

export function toChangeOutput(change, maxInlineOutputBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES, includeContent = true) {
  const contentCount = Number(change.beforeContent != null) + Number(change.afterContent != null)
  const contentLimit = Math.max(1, Math.floor(maxInlineOutputBytes / Math.max(1, contentCount)))
  return {
    change_id: change.changeId, host_id: change.hostId, path: change.path,
    ...(includeContent ? boundedChangeContent(change, 'before', contentLimit) : {}),
    ...(includeContent ? boundedChangeContent(change, 'after', contentLimit) : {}),
    ...(change.beforeVersion != null ? { before_version: change.beforeVersion } : {}),
    ...(change.afterVersion != null ? { after_version: change.afterVersion } : {}),
    status: change.status, source: change.source,
    ...(change.description != null ? { description: change.description } : {}),
    created_at: change.createdAt, updated_at: change.updatedAt,
  }
}

export function readBackgroundJob(jobs, jobId, owner, meta) {
  const read = jobs.read(jobId, owner)
  const snapshot = read.snapshot ?? {}
  const status = snapshot.status === 'completed' ? 'succeeded'
    : snapshot.status === 'killed' ? 'canceled' : snapshot.status === 'failed' ? 'failed' : 'running'
  return {
    jobId, hostId: meta.hostId, command: meta.command, description: meta.description,
    status, startedAt: meta.startedAt,
    ...(snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {}),
    approvalDenied: false,
    ...(read.text ? { log: read.text } : {}),
    ...(snapshot.detail ? { errorMessage: snapshot.detail } : {}),
  }
}
