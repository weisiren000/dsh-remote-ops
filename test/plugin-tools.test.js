import test from 'node:test'
import assert from 'node:assert/strict'
import { renderExecResult } from '../src/plugin/render.js'
import { registerHostTools } from '../src/plugin/tools.js'

test('renderExecResult 把非 0 退出码写成结果标记', () => {
  const text = renderExecResult({
    stdout: 'oops',
    stderr: '',
    exitCode: 3,
    timedOut: false,
    aborted: false,
    status: 'failed',
  })
  assert.match(text, /oops/)
  assert.match(text, /\[exit code: 3\]/)
})

test('注册 host 工具，多机无当前目标时 host_bash 返回工具错误', async () => {
  const registered = []
  const tools = {
    register(def) {
      registered.push(def)
    },
  }
  const runner = {
    async list() {
      return [
        { hostId: 'h1', displayName: 'one', online: true },
        { hostId: 'h2', displayName: 'two', online: true },
      ]
    },
    async exec() {
      throw new Error('should not exec')
    },
  }
  registerHostTools({
    tools,
    systemPrompt: { registerSection() {} },
    runner,
  })
  assert.deepEqual(
    registered.map((item) => item.name).sort(),
    ['host_bash', 'host_job_log', 'host_jobs', 'host_list', 'host_list_files', 'host_pair', 'host_read_file', 'host_review_changes', 'host_use', 'host_write_file'],
  )
  for (const definition of registered) {
    assert.equal(typeof definition.output?.render, 'function')
    assert.equal(typeof definition.output?.schema, 'object')
  }
  const hostBash = registered.find((item) => item.name === 'host_bash')
  await assert.rejects(
    () => hostBash.execute({ command: 'ls', description: 'list' }, { signal: new AbortController().signal }),
    (err) => err.code === 'HOST_REQUIRED',
  )
})

test('后台 host-bash 使用 DSH job id 时 host_job_log 可以读取', async () => {
  const registered = []
  let pending
  const tools = { register(definition) { registered.push(definition) } }
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    getCurrentHost() { return { hostId: 'h1' } },
    async exec() {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { jobId: 'remote-1', status: 'succeeded', exitCode: 0, stdout: 'hello', stderr: '' }
    },
    async readJob() { throw Object.assign(new Error('job not found: host-bash-1'), { code: 'JOB_NOT_FOUND' }) },
  }
  const jobs = {
    start(spec) {
      pending = spec.run()
      pending.done.then((outcome) => { pending.outcome = outcome })
      return 'host-bash-1'
    },
    read() {
      return { snapshot: { status: 'completed', finishedAt: Date.now() }, text: 'hello' }
    },
  }
  registerHostTools({ tools, runner, jobs })
  const hostBash = registered.find((item) => item.name === 'host_bash')
  const logTool = registered.find((item) => item.name === 'host_job_log')
  const started = await hostBash.execute({ command: 'printf hello', description: 'hello', run_in_background: true }, { agent: { id: 'a' } })
  assert.equal(started.job_id, 'host-bash-1')
  const result = await logTool.execute({ job_id: 'host-bash-1' }, { agent: { id: 'a' } })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.log, 'hello')
})

test('host_review_changes 按主机 ID 列出 AI 文件变更', async () => {
  const registered = []
  let filter
  const tools = { register(definition) { registered.push(definition) } }
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    listChanges(value) { filter = value; return [] },
  }
  registerHostTools({ tools, runner })
  const reviewTool = registered.find((item) => item.name === 'host_review_changes')
  await reviewTool.execute({ host: 'one', status: 'pending' })
  assert.equal(filter.hostId, 'h1')
  assert.equal(filter.status, 'pending')
})

test('host_write_file 将显示名解析为主机 ID 并标记 AI 来源', async () => {
  const registered = []
  let input
  const tools = { register(definition) { registered.push(definition) } }
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async writeRemoteFile(value) { input = value; return { changeId: 'c1', source: value.source } },
  }
  registerHostTools({ tools, runner })
  const writeTool = registered.find((item) => item.name === 'host_write_file')
  const result = await writeTool.execute({ host: 'one', path: '/srv/a.txt', content: 'new', expected_version: 'v1', description: 'update' })
  assert.equal(input.host, 'h1')
  assert.equal(input.source, 'ai')
  assert.equal(result.changeId, 'c1')
})

test('显示名重名时工具层拒绝并提示 HOST_AMBIGUOUS', async () => {
  const registered = []
  const tools = { register(definition) { registered.push(definition) } }
  const runner = {
    async list() { return [
      { hostId: 'h1', displayName: 'dup', online: true },
      { hostId: 'h2', displayName: 'dup', online: true },
    ] },
    async listFiles() { throw new Error('should not resolve') },
  }
  registerHostTools({ tools, runner })
  const listTool = registered.find((item) => item.name === 'host_list_files')
  await assert.rejects(listTool.execute({ host: 'dup', path: '/tmp' }), (error) => {
    assert.equal(error.code, 'HOST_AMBIGUOUS')
    assert.match(error.message, /h1/)
    assert.match(error.message, /h2/)
    return true
  })
})
