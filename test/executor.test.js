import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDialect, runCommand } from '../src/executor.js'

test('resolveDialect 按平台选择', () => {
  assert.equal(resolveDialect('win32'), 'pwsh')
  assert.equal(resolveDialect('linux'), 'bash')
  assert.equal(resolveDialect('darwin'), 'bash')
})

test('runCommand 成功回传 stdout 和退出码 0', async () => {
  const dialect = resolveDialect()
  const command = dialect === 'pwsh' ? 'Write-Output hello-remote' : 'printf hello-remote'
  const result = await runCommand({ command, dialect })
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /hello-remote/)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
})

test('runCommand 非 0 退出不是抛错', async () => {
  const dialect = resolveDialect()
  const command = dialect === 'pwsh' ? 'exit 7' : 'exit 7'
  const result = await runCommand({ command, dialect })
  assert.equal(result.exitCode, 7)
})

test('runCommand 超时会停进程', async () => {
  const dialect = resolveDialect()
  const command = dialect === 'pwsh' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
  const result = await runCommand({ command, dialect, timeoutMs: 200 })
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
})

test('runCommand 响应 AbortSignal', async () => {
  const dialect = resolveDialect()
  const command = dialect === 'pwsh' ? 'Start-Sleep -Seconds 30' : 'sleep 30'
  const controller = new AbortController()
  const pending = runCommand({ command, dialect, signal: controller.signal })
  controller.abort()
  const result = await pending
  assert.equal(result.aborted, true)
})
