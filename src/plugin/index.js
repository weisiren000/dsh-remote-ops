import path from 'node:path'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import { createControllerStore } from '../controller/store.js'
import { createHostClient } from '../controller/client.js'
import { createRunner } from '../controller/runner.js'
import { registerHostTools } from './tools.js'
import { registerHostApi } from '../host-api.js'
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from '../protocol.js'

export const name = 'remote-ops'
export const inject = ['tools', 'systemPrompt', 'webServer']

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'remote-ops')

export const Config = z.object({
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  heartbeatTimeoutMs: z.number().min(1000).default(DEFAULT_HEARTBEAT_TIMEOUT_MS),
})

export async function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? DEFAULT_DATA_DIR
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const store = await createControllerStore(dataDir)
  const client = createHostClient({ keysDir: path.join(dataDir, 'keys') })
  const runner = createRunner({
    store,
    client,
  })
  registerHostTools({
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    runner,
    jobs: ctx.get?.('jobs'),
  })
  let heartbeatRunning = false
  const timer = setInterval(async () => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    try {
      await runner.refreshHosts()
    } catch {
      // The settings panel will display the last persisted state while a host is offline.
    } finally {
      heartbeatRunning = false
    }
  }, Math.max(1, Math.floor(heartbeatTimeoutMs / 3)))
  const disposeRoute = registerHostApi(ctx.webServer, runner)
  const dispose = () => {
    clearInterval(timer)
    client.dispose?.()
    disposeRoute?.()
  }
  ctx.effect(() => dispose)
}
