import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createControllerStore } from '../controller/store.js'
import { createHostClient } from '../controller/client.js'
import { createRunner } from '../controller/runner.js'
import { registerHostTools } from './tools.js'
import { registerHostApi } from '../host-api.js'
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from '../protocol.js'
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from '../http-json.js'
import { DEFAULT_MAX_INLINE_OUTPUT_BYTES, DEFAULT_MAX_PROCESS_OUTPUT_BYTES } from '../output-limits.js'
import { DEFAULT_SFTP_LOCK_STALE_MS } from '../controller/sftp.js'
import { DEFAULT_MAX_JOB_LOG_BYTES } from '../controller/job-log-store.js'

export const name = 'remote-ops'
export const inject = ['tools', 'systemPrompt', 'webServer']

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'remote-ops')

export const Config = z.object({
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  heartbeatTimeoutMs: z.number().min(1000).step(1).default(DEFAULT_HEARTBEAT_TIMEOUT_MS),
  maxRequestBodyBytes: z.number().min(1024).step(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  maxResponseBodyBytes: z.number().min(1024).step(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  maxInlineOutputBytes: z.number().min(1024).step(1).default(DEFAULT_MAX_INLINE_OUTPUT_BYTES),
  maxProcessOutputBytes: z.number().min(1024).step(1).default(DEFAULT_MAX_PROCESS_OUTPUT_BYTES),
  maxJobLogBytes: z.number().min(1024).step(1).default(DEFAULT_MAX_JOB_LOG_BYTES),
  sftpLockStaleMs: z.number().min(1000).step(1).default(DEFAULT_SFTP_LOCK_STALE_MS),
})

export function createHeartbeatLoop(runner, intervalMs, timers = globalThis) {
  let running = Promise.resolve()
  let active = false
  let disposed = false
  const tick = () => {
    if (disposed || active) return running
    active = true
    running = Promise.resolve()
      .then(() => runner.refreshHosts())
      .catch(() => {})
      .finally(() => { active = false })
    return running
  }
  const timer = timers.setInterval(tick, intervalMs)
  return {
    async dispose() {
      if (disposed) return
      disposed = true
      timers.clearInterval(timer)
      await running
    },
  }
}

export async function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? DEFAULT_DATA_DIR
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const maxResponseBodyBytes = config.maxResponseBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const maxInlineOutputBytes = config.maxInlineOutputBytes ?? DEFAULT_MAX_INLINE_OUTPUT_BYTES
  const maxProcessOutputBytes = config.maxProcessOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES
  const maxJobLogBytes = config.maxJobLogBytes ?? DEFAULT_MAX_JOB_LOG_BYTES
  const sftpLockStaleMs = config.sftpLockStaleMs ?? DEFAULT_SFTP_LOCK_STALE_MS
  const store = await createControllerStore(dataDir, { maxJobLogBytes })
  const client = createHostClient({
    keysDir: path.join(dataDir, 'keys'),
    maxResponseBodyBytes,
    sftpLockStaleMs,
  })
  const runner = createRunner({
    store,
    client,
    maxInlineOutputBytes,
    maxProcessOutputBytes,
  })
  let heartbeat
  let disposeRoute
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    disposeRoute?.()
    await heartbeat?.dispose()
    await runner.dispose()
  }
  try {
    ctx.effect(() => dispose)
    registerHostTools({
      tools: ctx.tools,
      systemPrompt: ctx.systemPrompt,
      runner,
      getJobs: () => ctx.get?.('jobs'),
      maxInlineOutputBytes,
    })
    heartbeat = createHeartbeatLoop(runner, Math.max(1, Math.floor(heartbeatTimeoutMs / 3)))
    disposeRoute = registerHostApi(ctx.webServer, runner, { maxRequestBodyBytes })
  } catch (error) {
    await dispose()
    throw error
  }
}
