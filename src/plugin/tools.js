import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import {
  presentChangeResult,
  presentChangeReviewCall,
  presentFileWriteCall,
  presentHostCall,
  presentHostResult,
  projectChangePresentation,
  projectHostExecution,
  renderExecResult,
} from './render.js'
import { registerRemoteToolPolicy } from './policy.js'
import { registerLocatorTool } from './locator-tool.js'
import {
  CHANGE_SCHEMA,
  MAX_MODEL_LIST_LIMIT,
  REMOTE_FILE_SCHEMA,
  FILE_ENTRY_SCHEMA,
  JOB_SCHEMA,
  JOB_STATUSES,
  normalizeListLimit,
  readBackgroundJob,
  renderJson,
  toChangeOutput,
  toFileEntry,
  toJobOutput,
  toRemoteFileOutput,
} from './tool-output.js'

const REMOTE_TOOL_RULES = [
  'Remote host tools are opt-in and must never be used by default.',
  'For local workspace, repository, or code-change requests, use the host application local tools first (for example bash or str_replace_editor).',
  'Only call host_* after the user explicitly asks for a remote/server/host operation, names a remote host, or opens the remote development workbench.',
  'A local-tool failure or a Windows platform limitation is not permission to switch to host_*; report the local limitation instead.',
  'Never probe drive letters, guessed directories, or remote hosts to recover from a local-tool failure.',
  'Remote tools are for the paired host selected by the user; do not retarget another host implicitly.',
].join(' ')

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function formatHosts(hosts, currentHostId) {
  return hosts.map((host) => ({
    host_id: host.hostId,
    display_name: host.displayName,
    online: host.online,
    dialect: host.dialect,
    current: host.hostId === currentHostId,
  }))
}

async function requireHost(runner, requestedHost, agent, agentTargets) {
  const hosts = await runner.list()
  if (requestedHost) {
    if (hosts.some((host) => host.hostId === requestedHost)) return requestedHost
    // 与 resolveTarget 一致：显示名重名时拒绝，避免静默选中第一台。
    const byName = hosts.filter((host) => host.displayName === requestedHost)
    if (byName.length === 1) return byName[0].hostId
    if (byName.length > 1) {
      const listed = byName.map((host) => `${host.displayName} (${host.hostId})`).join(', ')
      throw codedError('HOST_AMBIGUOUS', `ambiguous host: ${listed}`)
    }
    return requestedHost
  }
  const scoped = agent ? agentTargets.get(agent) : undefined
  if (scoped && hosts.some((host) => host.hostId === scoped)) return scoped
  if (hosts.length === 1) return hosts[0].hostId
  if (hosts.length === 0) throw codedError('HOST_NOT_FOUND', 'host not found')
  const listed = hosts.map((host) => `${host.displayName} (${host.hostId})`).join(', ')
  throw codedError('HOST_REQUIRED', `host required: ${listed}`)
}

function toolError(error) {
  if (error && error.code) throw error
  throw error
}

export function registerHostTools({
  tools,
  systemPrompt,
  runner,
  jobs,
  getJobs,
  onPreExecute,
  maxInlineOutputBytes,
}) {
  const register = (definition) => tools.register(defineTool(definition))
  const backgroundMeta = new Map()
  const agentTargets = new WeakMap()
  const currentJobs = () => getJobs?.() ?? jobs
  registerRemoteToolPolicy({ tools, onPreExecute })
  registerLocatorTool(register, runner, maxInlineOutputBytes)

  if (systemPrompt?.section) {
    systemPrompt.section({
      name: 'tool:remote_ops',
      order: 106,
      text: `${REMOTE_TOOL_RULES} Check [exit code: N], [timed out], [canceled], and [interrupted] on host_bash results.`,
    })
  }

  register({
    name: 'host_pair',
    description: 'Remote-only: pair a remote host with an address and one-time pairing code. Do not use for local workspace tasks.',
    parameters: {
      address: { type: 'string', required: true, description: 'Remote host URL.' },
      pairing_code: { type: 'string', required: true, description: 'One-time pairing code.' },
      display_name: { type: 'string', description: 'Optional local display name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host_id: { type: 'string', required: true },
          display_name: { type: 'string', required: true },
          dialect: { type: 'string', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const host = await runner.pair({
        address: args.address,
        pairingCode: args.pairing_code,
        displayName: args.display_name,
      })
      if (exec?.agent) agentTargets.set(exec.agent, host.hostId)
      return { host_id: host.hostId, display_name: host.displayName, dialect: host.dialect }
    },
  })
  register({
    name: 'host_list',
    description: 'Remote-only: list paired hosts, online state, and the current target. Do not use for local workspace tasks or after a local-tool failure.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                host_id: { type: 'string', required: true },
                display_name: { type: 'string', required: true },
                online: { type: 'boolean', required: true },
                dialect: { type: 'string', required: true },
                current: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(_args, exec) {
      const hosts = await runner.list()
      return { hosts: formatHosts(hosts, exec?.agent ? agentTargets.get(exec.agent) ?? null : null) }
    },
  })
  register({
    name: 'host_use',
    description: 'Remote-only: set the current remote target host after the user explicitly selects or names it.',
    parameters: {
      host: { type: 'string', required: true, description: 'Host id or unique display name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host_id: { type: 'string', required: true },
          display_name: { type: 'string', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (!exec?.agent) throw codedError('REMOTE_AGENT_REQUIRED', 'host_use requires an Agent execution context')
      const hostId = await requireHost(runner, args.host, exec.agent, agentTargets)
      const host = runner.resolveHost?.(hostId, { allowOffline: true })
        ?? (await runner.list()).find((item) => item.hostId === hostId)
      agentTargets.set(exec.agent, hostId)
      return { host_id: host.hostId, display_name: host.displayName }
    },
  })
  register({
    name: 'host_bash',
    description: 'Remote-only: run one command on a paired host. Use only when the user explicitly requests a remote/server operation; never substitute for local bash.',
    parameters: {
      command: { type: 'string', required: true, description: 'Command to execute remotely.' },
      description: { type: 'string', required: true, description: 'Short description shown in the UI.' },
      host: { type: 'string', description: 'Host id or unique display name.' },
      workdir: { type: 'string', description: 'Remote working directory.' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      run_in_background: { type: 'boolean', description: 'Run as a managed background job.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              job_id: { type: 'string', required: true },
              dsh_job_id: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              job_id: { type: 'string', required: true },
              status: { type: 'string', required: true, enum: JOB_STATUSES },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.text ?? `started background job ${value.job_id}`,
      }],
      presentationMeta: projectHostExecution,
    },
    presentCall: presentHostCall,
    presentResult: presentHostResult,
    async execute(args, exec) {
      try {
        const host = await requireHost(runner, args.host, exec.agent, agentTargets)
        const jobService = currentJobs()
        if (args.run_in_background === true && !jobService?.start) {
          throw codedError('BACKGROUND_JOBS_UNAVAILABLE', '后台任务能力未安装，不能静默改为前台执行')
        }
        if (args.run_in_background === true) {
          const controllerJobId = randomUUID()
          const dshJobId = jobService.start({
            kind: 'host-bash',
            label: args.description,
            ...(exec.agent ? { owner: exec.agent } : {}),
            run() {
              const controller = new AbortController()
              const done = runner.exec({
                jobId: controllerJobId,
                host,
                command: args.command,
                description: args.description,
                workdir: args.workdir,
                timeoutMs: args.timeoutMs,
                signal: controller.signal,
                ownerSessionId: exec.agent?.id,
              })
              return {
                cancel() {
                  controller.abort()
                },
                done: done.then((result) => ({
                  status: result.status === 'succeeded' ? 'completed' : result.status === 'canceled' ? 'killed' : 'failed',
                  output: renderExecResult({ ...result, stdout: result.log ?? result.stdout ?? '' }),
                  ...(result.errorMessage ? { detail: result.errorMessage } : {}),
                })),
              }
            },
          })
          await runner.linkDshJob?.(controllerJobId, dshJobId)
          backgroundMeta.set(dshJobId, {
            controllerJobId,
            hostId: host.hostId,
            command: args.command,
            description: args.description,
            startedAt: Date.now(),
            ownerSessionId: exec.agent?.id,
          })
          return { job_id: controllerJobId, dsh_job_id: dshJobId }
        }
        const result = await runner.exec({
          host,
          command: args.command,
          description: args.description,
          workdir: args.workdir,
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
          ownerSessionId: exec.agent?.id,
        })
        return {
          text: renderExecResult({ ...result, stdout: result.log ?? result.stdout ?? '' }),
          job_id: result.jobId,
          status: result.status,
        }
      } catch (error) {
        toolError(error)
      }
    },
  })
  register({
    name: 'host_jobs',
    description: 'Remote-only: list recent remote jobs by host or job id. Do not use for local task history.',
    parameters: {
      host: { type: 'string', description: 'Filter by host id.' },
      job_id: { type: 'string', description: 'Read one job instead of listing jobs.' },
      limit: { type: 'integer', description: 'Maximum number of jobs to return.' },
    },
    output: {
      schema: { oneOf: [JOB_SCHEMA, { type: 'array', items: JOB_SCHEMA }] },
      render: renderJson,
    },
    async execute(args, exec) {
      const jobService = currentJobs()
      if (args.job_id) {
        try {
          return toJobOutput(await runner.readJob(args.job_id, exec?.agent?.id), maxInlineOutputBytes)
        } catch (error) {
          if (!jobService?.read || !backgroundMeta.has(args.job_id)) throw error
          return toJobOutput(
            await readBackgroundJob(jobService, args.job_id, exec?.agent, backgroundMeta.get(args.job_id)),
            maxInlineOutputBytes,
          )
        }
      }
      const limit = normalizeListLimit(args.limit)
      return runner.listJobs({ hostId: args.host, limit, ownerSessionId: exec?.agent?.id })
        .map((job) => toJobOutput(job, maxInlineOutputBytes))
    },
  })
  register({
    name: 'host_job_log',
    description: 'Remote-only: read a bounded tail of one remote job log. Truncated results include a structured locator.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Remote job id.' },
      tail_bytes: { type: 'integer', description: 'UTF-8 byte tail to return, capped by the inline output limit.' },
    },
    output: { schema: JOB_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const jobService = currentJobs()
      try {
        const tailBytes = Math.min(maxInlineOutputBytes ?? 64 * 1024, Math.max(1, args.tail_bytes ?? 64 * 1024))
        return toJobOutput(
          await runner.readJobLogTail(args.job_id, tailBytes, exec?.agent?.id),
          maxInlineOutputBytes,
        )
      } catch (error) {
        if (!jobService?.read || !backgroundMeta.has(args.job_id)) throw error
        return toJobOutput(
          await readBackgroundJob(jobService, args.job_id, exec?.agent, backgroundMeta.get(args.job_id)),
          maxInlineOutputBytes,
        )
      }
    },
  })
  register({
    name: 'host_list_files',
    description: 'Remote-only: list files and directories on a paired remote host. Never use to inspect the local workspace.',
    parameters: {
      host: { type: 'string', description: 'Host id or unique display name.' },
      path: { type: 'string', description: 'Remote directory path.' },
      limit: { type: 'integer', description: `Maximum entries; defaults to 100 and is capped at ${MAX_MODEL_LIST_LIMIT}.` },
      offset: { type: 'integer', description: 'Directory entry offset for the next page.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { host_id: { type: 'string', required: true }, path: { type: 'string', required: true }, entries: { type: 'array', required: true, items: FILE_ENTRY_SCHEMA }, next_offset: { type: 'integer' } } }, render: renderJson },
    async execute(args, exec) {
      try {
        const host = await requireHost(runner, args.host, exec?.agent, agentTargets)
        const limit = normalizeListLimit(args.limit)
        const result = await runner.listFiles(host, args.path, { limit, offset: Math.max(0, args.offset ?? 0) })
        return {
          host_id: result.hostId,
          path: result.path,
          entries: result.entries.map(toFileEntry),
          ...(result.nextOffset !== undefined ? { next_offset: result.nextOffset } : {}),
        }
      } catch (error) {
        toolError(error)
      }
    },
  })
  register({
    name: 'host_read_file',
    description: 'Remote-only: read a UTF-8 text file from a paired remote host. Never use to inspect the local workspace.',
    parameters: {
      host: { type: 'string', description: 'Host id or unique display name.' },
      path: { type: 'string', required: true, description: 'Remote file path.' },
    },
    output: { schema: REMOTE_FILE_SCHEMA, render: renderJson },
    async execute(args, exec) {
      try {
        const host = await requireHost(runner, args.host, exec?.agent, agentTargets)
        const result = await runner.readRemoteFile(host, args.path)
        return toRemoteFileOutput(result, maxInlineOutputBytes)
      } catch (error) {
        toolError(error)
      }
    },
  })
  register({
    name: 'host_write_file',
    description: 'Remote-only: write a complete UTF-8 text file on a paired remote host and create a reviewable change record. Never use for local files.',
    parameters: {
      host: { type: 'string', description: 'Host id or unique display name.' },
      path: { type: 'string', required: true, description: 'Remote file path.' },
      content: { type: 'string', required: true, description: 'Complete replacement file content.' },
      expected_version: { type: 'string', description: 'Version returned by host_read_file.' },
      description: { type: 'string', description: 'Reason for the change.' },
    },
    output: { schema: CHANGE_SCHEMA, render: renderJson, presentationMeta: projectChangePresentation },
    presentCall: presentFileWriteCall,
    presentResult: presentChangeResult,
    async execute(args, exec) {
      try {
        const host = await requireHost(runner, args.host, exec?.agent, agentTargets)
        const change = await runner.writeRemoteFile({ host, path: args.path, content: args.content, expectedVersion: args.expected_version, source: 'ai', description: args.description, ownerSessionId: exec?.agent?.id })
        return toChangeOutput(change, maxInlineOutputBytes)
      } catch (error) {
        toolError(error)
      }
    },
  })
  register({
    name: 'host_review_changes',
    description: 'Remote-only: list remote file changes or apply an accept, revert, or restore review action. Never use for local repository changes.',
    parameters: {
      host: { type: 'string', description: 'Host id or unique display name.' },
      change_id: { type: 'string', description: 'Change id to review.' },
      action: { type: 'string', enum: ['accept', 'revert', 'restore'], description: 'Review action used with change_id.' },
      status: { type: 'string', enum: ['pending', 'accepted', 'reverted', 'restored'], description: 'Change status filter.' },
      limit: { type: 'integer', description: 'Maximum number of changes.' },
    },
    output: {
      schema: {
        oneOf: [
          CHANGE_SCHEMA,
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              host_id: { type: 'string', required: true },
              changes: { type: 'array', required: true, items: CHANGE_SCHEMA },
            },
          },
        ],
      },
      render: renderJson,
      presentationMeta: projectChangePresentation,
    },
    presentCall: presentChangeReviewCall,
    presentResult: presentChangeResult,
    async execute(args, exec) {
      try {
        if (args.change_id) {
          if (!args.action) throw codedError('CHANGE_ACTION_REQUIRED', 'action required when change_id is provided')
          return toChangeOutput(
            await runner.reviewChange(args.change_id, args.action, exec?.agent?.id),
            maxInlineOutputBytes,
          )
        }
        const host = await requireHost(runner, args.host, exec?.agent, agentTargets)
        const limit = normalizeListLimit(args.limit)
        const changes = runner.listChanges({ hostId: host, status: args.status, limit, ownerSessionId: exec?.agent?.id })
        return { host_id: host, changes: changes.map((change) => toChangeOutput(change, maxInlineOutputBytes, false)) }
      } catch (error) {
        toolError(error)
      }
    },
  })
}
