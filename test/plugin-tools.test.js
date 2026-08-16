import test from 'node:test'
import assert from 'node:assert/strict'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { renderExecResult } from '../src/plugin/render.js'
import { registerHostTools } from '../src/plugin/tools.js'

function assertValidOutput(tool, value) {
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
}

function changeRecord(overrides = {}) {
  return {
    changeId: 'c1',
    hostId: 'h1',
    path: '/srv/a.txt',
    beforeContent: 'old',
    afterContent: 'new',
    beforeVersion: 'v1',
    afterVersion: 'v2',
    status: 'pending',
    source: 'ai',
    description: 'update',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

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
    ['host_bash', 'host_job_log', 'host_jobs', 'host_list', 'host_list_files', 'host_pair', 'host_read_file', 'host_read_locator', 'host_review_changes', 'host_use', 'host_write_file'],
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

test('远程工具提示词明确要求本地优先且禁止错误转向远程', () => {
  const registered = []
  const sections = []
  registerHostTools({
    tools: { register(definition) { registered.push(definition) } },
    systemPrompt: { section(value) { sections.push(value) } },
    runner: { async list() { return [] } },
  })
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /opt-in/)
  assert.match(sections[0].text, /local workspace/i)
  assert.match(sections[0].text, /local-tool failure/i)
  assert.match(registered.find((tool) => tool.name === 'host_bash').description, /never substitute for local bash/i)
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
    async linkDshJob(controllerJobId, dshJobId) { this.linked = { controllerJobId, dshJobId } },
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
  assert.equal(started.dsh_job_id, 'host-bash-1')
  assert.equal(started.job_id, runner.linked.controllerJobId)
  assert.equal(runner.linked.dshJobId, 'host-bash-1')
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
    async writeRemoteFile(value) { input = value; return changeRecord({ source: value.source }) },
  }
  registerHostTools({ tools, runner })
  const writeTool = registered.find((item) => item.name === 'host_write_file')
  const result = await writeTool.execute({ host: 'one', path: '/srv/a.txt', content: 'new', expected_version: 'v1', description: 'update' })
  assert.equal(input.host, 'h1')
  assert.equal(input.source, 'ai')
  assert.equal(result.change_id, 'c1')
  assertValidOutput(writeTool, result)
})

test('文件与变更工具返回值全部符合 Harness output schema', async () => {
  const registered = []
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async listFiles() {
      return {
        hostId: 'h1',
        path: '/srv',
        entries: [{ name: 'a.txt', path: '/srv/a.txt', type: 'file', size: 3, mtime: 1, mode: 0o100600 }],
      }
    },
    async readRemoteFile() {
      return { hostId: 'h1', path: '/srv/a.txt', content: 'new', size: 3, mtime: 1, version: 'v2' }
    },
    async writeRemoteFile() { return changeRecord() },
    listChanges() { return [changeRecord()] },
    async reviewChange() { return changeRecord({ status: 'accepted' }) },
  }
  registerHostTools({ tools: { register(tool) { registered.push(tool) } }, runner })
  const find = (name) => registered.find((tool) => tool.name === name)

  const cases = [
    ['host_list_files', { host: 'h1', path: '/srv' }],
    ['host_read_file', { host: 'h1', path: '/srv/a.txt' }],
    ['host_write_file', { host: 'h1', path: '/srv/a.txt', content: 'new' }],
    ['host_review_changes', { host: 'h1', status: 'pending' }],
    ['host_review_changes', { change_id: 'c1', action: 'accept' }],
  ]
  for (const [name, args] of cases) {
    const tool = find(name)
    const value = await tool.execute(args, { signal: new AbortController().signal })
    assertValidOutput(tool, value)
  }
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

test('两个 Agent 的默认远程目标互不串扰', async () => {
  const registered = []
  const calls = []
  let operatorCurrent = 'h1'
  const hosts = [
    { hostId: 'h1', displayName: 'one', online: true },
    { hostId: 'h2', displayName: 'two', online: true },
  ]
  const runner = {
    async list() { return hosts },
    getCurrentHost() { return hosts.find((host) => host.hostId === operatorCurrent) },
    async use(hostRef) {
      const host = hosts.find((item) => item.hostId === hostRef || item.displayName === hostRef)
      operatorCurrent = host.hostId
      return host
    },
    resolveHost(hostRef) { return hosts.find((item) => item.hostId === hostRef || item.displayName === hostRef) },
    async exec(input) {
      calls.push(input.host)
      return { jobId: `j-${calls.length}`, status: 'succeeded', exitCode: 0, log: '' }
    },
  }
  registerHostTools({ tools: { register(tool) { registered.push(tool) } }, runner })
  const use = registered.find((tool) => tool.name === 'host_use')
  const bash = registered.find((tool) => tool.name === 'host_bash')
  const agentA = { id: 'session-a' }
  const agentB = { id: 'session-b' }
  await use.execute({ host: 'one' }, { agent: agentA })
  await use.execute({ host: 'two' }, { agent: agentB })
  await bash.execute({ command: 'echo a', description: 'a' }, { agent: agentA, signal: new AbortController().signal })
  await bash.execute({ command: 'echo b', description: 'b' }, { agent: agentB, signal: new AbortController().signal })
  assert.deepEqual(calls, ['h1', 'h2'])
  assert.equal(operatorCurrent, 'h1')
})

test('后台能力缺失时不把后台请求静默改成前台', async () => {
  const registered = []
  let executed = false
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async exec() { executed = true; return { jobId: 'j1', status: 'succeeded', exitCode: 0, log: '' } },
  }
  registerHostTools({ tools: { register(tool) { registered.push(tool) } }, runner })
  const bash = registered.find((tool) => tool.name === 'host_bash')
  await assert.rejects(
    bash.execute({ command: 'sleep 1', description: 'background', run_in_background: true }, { agent: { id: 'a' }, signal: new AbortController().signal }),
    (error) => error.code === 'BACKGROUND_JOBS_UNAVAILABLE',
  )
  assert.equal(executed, false)
})

test('远程工具通过 pre-execute 请求审批且无 Agent 调用被 guard 拒绝', async () => {
  const registered = []
  let policy
  let guard
  registerHostTools({
    tools: {
      register(tool) { registered.push(tool) },
      guard(value) { guard = value; return () => {} },
    },
    runner: { async list() { return [] } },
    onPreExecute(listener) { policy = listener },
  })
  assert.equal(typeof policy, 'function')
  assert.equal(typeof guard, 'function')
  const exec = { name: 'host_write_file', agent: { id: 'session-a' } }
  assert.deepEqual(await policy(exec, async () => ({ kind: 'allow' })), {
    kind: 'ask',
    reason: '远程文件写入需要用户确认',
  })
  assert.deepEqual(await policy(exec, async () => ({ kind: 'deny', reason: 'denied downstream' })), {
    kind: 'deny', reason: 'denied downstream',
  })
  assert.match(guard({ name: 'host_bash' }), /Agent/)
  assert.equal(guard({ name: 'host_bash', agent: { id: 'session-a' } }), undefined)
  assert.equal(guard({ name: 'bash' }), undefined)
})

test('host_read_file 按 UTF-8 字节限制模型结果并返回远程文件 locator', async () => {
  const registered = []
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async readRemoteFile() {
      return { hostId: 'h1', path: '/srv/a.txt', content: '你好世界abcdef', version: 'v2' }
    },
  }
  registerHostTools({
    tools: { register(tool) { registered.push(tool) } },
    runner,
    maxInlineOutputBytes: 8,
  })
  const tool = registered.find((item) => item.name === 'host_read_file')
  const result = await tool.execute({ host: 'h1', path: '/srv/a.txt' })
  assert.ok(Buffer.byteLength(result.content) <= 8)
  assert.doesNotMatch(result.content, /\uFFFD/)
  assert.equal(result.content_bytes, Buffer.byteLength('你好世界abcdef'))
  assert.equal(result.content_truncated, true)
  assert.deepEqual(result.content_locator, {
    kind: 'remote_file',
    host_id: 'h1',
    path: '/srv/a.txt',
    version: 'v2',
    start_byte: 0,
    total_bytes: Buffer.byteLength('你好世界abcdef'),
  })
  assertValidOutput(tool, result)
})

test('模型列表工具使用默认 100 条并把显式上限封顶为 1000 条', async () => {
  const registered = []
  const entries = Array.from({ length: 1200 }, (_, index) => ({
    name: `f-${index}`, path: `/srv/f-${index}`, type: 'file', size: index,
  }))
  const jobs = Array.from({ length: 1200 }, (_, index) => ({
    jobId: `j-${index}`, hostId: 'h1', command: 'true', description: 'job',
    status: 'succeeded', startedAt: index, approvalDenied: false,
  }))
  const changes = Array.from({ length: 1200 }, (_, index) => changeRecord({ changeId: `c-${index}` }))
  const filters = {}
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async listFiles(_host, _path, options) {
      filters.files = options
      return { hostId: 'h1', path: '/srv', entries: entries.slice(options.offset, options.offset + options.limit) }
    },
    listJobs(filter) { filters.jobs = filter; return jobs.slice(0, filter.limit) },
    listChanges(filter) { filters.changes = filter; return changes.slice(0, filter.limit) },
  }
  registerHostTools({ tools: { register(tool) { registered.push(tool) } }, runner })
  const find = (name) => registered.find((tool) => tool.name === name)
  const listedFiles = await find('host_list_files').execute({ host: 'h1', path: '/srv', limit: 5000 })
  const listedJobs = await find('host_jobs').execute({}, { agent: { id: 'session-a' } })
  const listedChanges = await find('host_review_changes').execute({ host: 'h1' }, { agent: { id: 'session-a' } })

  assert.equal(listedFiles.entries.length, 1000)
  assert.equal(listedJobs.length, 100)
  assert.equal(listedChanges.changes.length, 100)
  assert.equal(listedChanges.changes[0].before_content, undefined)
  assert.equal(listedChanges.changes[0].after_content, undefined)
  assert.equal(filters.jobs.limit, 100)
  assert.equal(filters.changes.limit, 100)
  assert.deepEqual(filters.files, { limit: 1000, offset: 0 })
})

test('变更工具不会把完整大文件内容重新内联到模型结果', async () => {
  const registered = []
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async writeRemoteFile() {
      return changeRecord({ beforeContent: 'a'.repeat(2000), afterContent: 'b'.repeat(2000) })
    },
  }
  registerHostTools({
    tools: { register(tool) { registered.push(tool) } },
    runner,
    maxInlineOutputBytes: 64,
  })
  const tool = registered.find((item) => item.name === 'host_write_file')
  const result = await tool.execute({ host: 'h1', path: '/srv/a.txt', content: 'new' })
  assert.ok(Buffer.byteLength(result.before_content) + Buffer.byteLength(result.after_content) <= 64)
  assert.equal(result.before_content_truncated, true)
  assert.equal(result.after_content_truncated, true)
  assert.equal(result.before_content_locator.kind, 'controller_change_content')
  assert.equal(result.after_content_locator.side, 'after')
  assertValidOutput(tool, result)
})

test('后台 Jobs 能力在工具调用点获取而不是 apply 时捕获', async () => {
  const registered = []
  let jobs
  let linked
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async exec() { return { jobId: 'controller-job', status: 'succeeded', exitCode: 0, log: '' } },
    async linkDshJob(controllerJobId, dshJobId) { linked = { controllerJobId, dshJobId } },
  }
  registerHostTools({
    tools: { register(tool) { registered.push(tool) } },
    runner,
    getJobs: () => jobs,
  })
  const bash = registered.find((item) => item.name === 'host_bash')
  jobs = {
    start(spec) {
      void spec.run().done
      return 'dynamic-dsh-job'
    },
  }
  const result = await bash.execute(
    { command: 'true', description: 'dynamic', run_in_background: true },
    { agent: { id: 'session-a' } },
  )
  assert.equal(result.dsh_job_id, 'dynamic-dsh-job')
  assert.equal(linked.dshJobId, 'dynamic-dsh-job')
})

test('远程写入和审阅使用可回放的纯 diff 展示投影', async () => {
  const registered = []
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async writeRemoteFile() { return changeRecord() },
    async reviewChange() { return changeRecord({ status: 'reverted' }) },
  }
  registerHostTools({ tools: { register(tool) { registered.push(tool) } }, runner })
  const write = registered.find((item) => item.name === 'host_write_file')
  const review = registered.find((item) => item.name === 'host_review_changes')
  const writeArgs = { host: 'h1', path: '/srv/a.txt', content: 'new' }
  const writeValue = await write.execute(writeArgs, { agent: { id: 'session-a' } })
  const writeMeta = write.output.presentationMeta(writeArgs, writeValue)
  assert.deepEqual(write.output.presentationMeta(writeArgs, writeValue), writeMeta)
  assert.deepEqual(write.presentCall(writeArgs), {
    card: 'diff',
    title: '写入 /srv/a.txt',
    diffs: [{ path: '/srv/a.txt', oldText: null, newText: 'new' }],
    locations: [{ path: '/srv/a.txt' }],
  })
  assert.deepEqual(write.presentResult(writeArgs, { content: [], isError: false, meta: writeMeta }), {
    card: 'diff',
    title: '已写入 /srv/a.txt',
    diffs: [{ path: '/srv/a.txt', oldText: 'old', newText: 'new' }],
  })

  const reviewArgs = { change_id: 'c1', action: 'revert' }
  const reviewValue = await review.execute(reviewArgs, { agent: { id: 'session-a' } })
  const reviewMeta = review.output.presentationMeta(reviewArgs, reviewValue)
  assert.equal(reviewMeta.status, 'reverted')
  assert.deepEqual(review.presentResult(reviewArgs, { content: [], isError: false, meta: reviewMeta }).diffs, [
    { path: '/srv/a.txt', oldText: 'new', newText: 'old' },
  ])
})

test('host_bash 用结构化回放元数据展示取消终态', async () => {
  const registered = []
  const runner = {
    async list() { return [{ hostId: 'h1', displayName: 'one', online: true }] },
    async exec() { return { jobId: 'j1', status: 'canceled', exitCode: null, log: '[canceled]' } },
  }
  registerHostTools({ tools: { register(tool) { registered.push(tool) } }, runner })
  const bash = registered.find((item) => item.name === 'host_bash')
  const args = { command: 'sleep 30', description: 'wait' }
  const value = await bash.execute(args, { agent: { id: 'session-a' } })
  const meta = bash.output.presentationMeta(args, value)
  assert.deepEqual(meta, { kind: 'remote-command', job_id: 'j1', status: 'canceled' })
  const view = bash.presentResult(args, {
    content: [{ type: 'text', text: value.text }],
    isError: false,
    meta,
  })
  assert.equal(view.card, 'generic')
  assert.equal(view.title, '远程命令已取消')
  assert.match(view.content[0].text, /canceled/)
})

test('host_read_locator 对分页长度封顶并传递 owner session', async () => {
  const registered = []
  let received
  registerHostTools({
    tools: { register(tool) { registered.push(tool) } },
    runner: {
      async readLocator(locator, options) {
        received = { locator, options }
        return { text: 'page', start_byte: 0, end_byte: 4, total_bytes: 10, truncated: true }
      },
    },
    maxInlineOutputBytes: 64,
  })
  const tool = registered.find((item) => item.name === 'host_read_locator')
  const locator = { kind: 'controller_job_log', job_id: 'job-a', start_byte: 0, total_bytes: 10 }
  const result = await tool.execute(
    { locator, start_byte: 0, length_bytes: 1024 },
    { agent: { id: 'session-a' } },
  )
  assert.equal(result.text, 'page')
  assert.deepEqual(received, {
    locator,
    options: { startByte: 0, lengthBytes: 64, ownerSessionId: 'session-a' },
  })
})
