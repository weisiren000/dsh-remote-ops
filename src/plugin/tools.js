import { defineTool } from '@deepseek-ai/dsh-tools'
import { classifyCommand } from '../controller/approval.js'
import { presentHostCall, presentHostResult, renderExecResult } from './render.js'

const JOB_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'interrupted',
]

const JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jobId: { type: 'string', required: true },
    hostId: { type: 'string', required: true },
    command: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: JOB_STATUSES },
    exitCode: { type: 'integer' },
    startedAt: { type: 'number', required: true },
    finishedAt: { type: 'number' },
    approvalDenied: { type: 'boolean', required: true },
    remoteJobId: { type: 'string' },
    log: { type: 'string' },
  },
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function toJobOutput(job) {
  return {
    jobId: job.jobId,
    hostId: job.hostId,
    command: job.command,
    description: job.description,
    status: job.status,
    startedAt: job.startedAt,
    approvalDenied: job.approvalDenied === true,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
    ...(job.remoteJobId !== undefined ? { remoteJobId: job.remoteJobId } : {}),
    ...(job.log !== undefined ? { log: job.log } : {}),
  }
}

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

async function requireHost(runner, requestedHost) {
  const hosts = await runner.list()
  const current = runner.getCurrentHost?.() ?? null
  if (requestedHost) return requestedHost
  if (current) return current.hostId
  if (hosts.length === 1) return hosts[0].hostId
  if (hosts.length === 0) throw codedError('HOST_NOT_FOUND', 'host not found')
  const listed = hosts.map((host) => `${host.displayName} (${host.hostId})`).join(', ')
  throw codedError('HOST_REQUIRED', `host required: ${listed}`)
}

function toolError(error) {
  if (error && error.code) throw error
  throw error
}

export function registerHostTools({ tools, systemPrompt, runner, jobs, onPreExecute }) {
  const register = (definition) => tools.register(defineTool(definition))

  if (systemPrompt?.section) {
    systemPrompt.section({
      name: 'tool:host_bash',
      order: 106,
      text: 'Check [exit code: N], [timed out], [canceled], and [interrupted] on host_bash results. Do not retarget an offline host.',
    })
  }

  const preExecute = async (exec) => {
    if (exec.name !== 'host_bash') return { kind: 'allow' }
    const command = exec.arguments?.command ?? ''
    if (classifyCommand(command) === 'ask') {
      return { kind: 'ask', reason: 'remote command requires approval' }
    }
    return { kind: 'allow' }
  }
  onPreExecute?.(preExecute)

  register({
    name: 'host_pair',
    description: 'Pair a remote host with an address and one-time pairing code.',
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
    async execute(args) {
      const host = await runner.pair({
        address: args.address,
        pairingCode: args.pairing_code,
        displayName: args.display_name,
      })
      return { host_id: host.hostId, display_name: host.displayName, dialect: host.dialect }
    },
  })
  register({
    name: 'host_list',
    description: 'List paired hosts, online state, and the current target.',
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
    async execute() {
      const hosts = await runner.list()
      const current = runner.getCurrentHost?.()
      return { hosts: formatHosts(hosts, current?.hostId ?? null) }
    },
  })
  register({
    name: 'host_use',
    description: 'Set the current remote target host.',
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
    async execute(args) {
      const host = await runner.use(args.host)
      return { host_id: host.hostId, display_name: host.displayName }
    },
  })
  register({
    name: 'host_bash',
    description: 'Run one command on a paired host. Omit host to use the current target.',
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
            properties: { job_id: { type: 'string', required: true } },
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
    },
    presentCall: presentHostCall,
    presentResult: presentHostResult,
    async execute(args, exec) {
      try {
        const host = await requireHost(runner, args.host)
        if (args.run_in_background === true && jobs?.start) {
          const jobId = jobs.start({
            kind: 'host-bash',
            label: args.description,
            owner: exec.agent,
            run() {
              const controller = new AbortController()
              const done = runner.exec({
                host,
                command: args.command,
                description: args.description,
                workdir: args.workdir,
                timeoutMs: args.timeoutMs,
                signal: controller.signal,
              })
              return {
                cancel() {
                  controller.abort()
                },
                done,
              }
            },
          })
          return { job_id: jobId }
        }
        const result = await runner.exec({
          host,
          command: args.command,
          description: args.description,
          workdir: args.workdir,
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
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
    description: 'List recent remote jobs by host or job id.',
    parameters: {
      host: { type: 'string', description: 'Filter by host id.' },
      job_id: { type: 'string', description: 'Read one job instead of listing jobs.' },
      limit: { type: 'integer', description: 'Maximum number of jobs to return.' },
    },
    output: {
      schema: { oneOf: [JOB_SCHEMA, { type: 'array', items: JOB_SCHEMA }] },
      render: renderJson,
    },
    async execute(args) {
      if (args.job_id) return toJobOutput(await runner.readJob(args.job_id))
      return runner.listJobs({ hostId: args.host, limit: args.limit }).map(toJobOutput)
    },
  })
  register({
    name: 'host_job_log',
    description: 'Read one remote job log. Long logs are truncated with a file locator.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Remote job id.' },
    },
    output: { schema: JOB_SCHEMA, render: renderJson },
    async execute(args) {
      return toJobOutput(await runner.readJob(args.job_id))
    },
  })
}
