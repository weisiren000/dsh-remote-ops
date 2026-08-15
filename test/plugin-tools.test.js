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

test('注册 6 个 host 工具，多机无当前目标时 host_bash 返回工具错误', async () => {
  const registered = []
  let preExecute
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
    onPreExecute(fn) {
      preExecute = fn
    },
  })
  assert.deepEqual(
    registered.map((item) => item.name).sort(),
    ['host_bash', 'host_job_log', 'host_jobs', 'host_list', 'host_pair', 'host_use'],
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
  const decision = await preExecute({
    name: 'host_bash',
    arguments: { command: 'rm -rf /tmp/a', description: 'danger' },
  })
  assert.equal(decision.kind, 'ask')
})
