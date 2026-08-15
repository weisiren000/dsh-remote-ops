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
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  dataDir: z.string(),
  heartbeatTimeoutMs: z.number().default(DEFAULT_HEARTBEAT_TIMEOUT_MS),
})

export async function apply(ctx, config = {}) {
  const dataDir = config.dataDir ?? path.join(os.homedir(), '.dsh', 'remote-ops')
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const store = await createControllerStore(dataDir)
  const client = createHostClient({ keysDir: path.join(dataDir, 'keys') })
  const runner = createRunner({
    store,
    client,
    ask: async (reason) => {
      const approval = ctx.get?.('approval')
      if (!approval?.request) return 'unavailable'
      return approval.request({
        agent: ctx.agent,
        toolName: 'host_bash',
        reason,
      })
    },
  })
  registerHostTools({
    tools: ctx.tools,
    systemPrompt: ctx.systemPrompt,
    runner,
    jobs: ctx.get?.('jobs'),
    onPreExecute(fn) {
      ctx.on?.('tools/pre-execute', async (exec, next) => {
        if (exec.name !== 'host_bash') return next()
        const decision = await fn(exec)
        if (decision.kind === 'ask') return decision
        return next()
      })
    },
  })
  let heartbeatRunning = false
  const timer = setInterval(async () => {
    if (heartbeatRunning) return
    heartbeatRunning = true
    try {
      await runner.list()
    } catch {
      // The settings panel will display the last persisted state while a host is offline.
    } finally {
      heartbeatRunning = false
    }
  }, Math.max(1, Math.floor(heartbeatTimeoutMs / 3)))
  let disposeRoute
  ctx.inject?.(['webServer'], (webCtx) => {
    disposeRoute = registerHostApi(webCtx.webServer, runner)
  })
  const dispose = () => {
    clearInterval(timer)
    client.dispose?.()
    disposeRoute?.()
  }
  ctx.effect?.(() => dispose)
  if (!ctx.effect) ctx.on?.('dispose', dispose)
}
