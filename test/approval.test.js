import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCommand, decideApproval } from '../src/controller/approval.js'

test('查看类命令自动放行', () => {
  assert.equal(classifyCommand('ls -la', 'bash'), 'auto')
  assert.equal(classifyCommand('systemctl status nginx', 'bash'), 'auto')
  assert.equal(classifyCommand('Get-Process', 'pwsh'), 'auto')
})

test('变更类命令需要询问', () => {
  assert.equal(classifyCommand('systemctl restart nginx', 'bash'), 'ask')
  assert.equal(classifyCommand('rm -rf /tmp/a', 'bash'), 'ask')
  assert.equal(classifyCommand('unknown-bin --help', 'bash'), 'ask')
})

test('主机覆盖优先于命令分类', () => {
  assert.equal(decideApproval({ command: 'rm -rf /tmp/a', dialect: 'bash', override: 'auto' }), 'auto')
  assert.equal(decideApproval({ command: 'ls', dialect: 'bash', override: 'ask' }), 'ask')
  assert.equal(decideApproval({ command: 'ls', dialect: 'bash', override: 'follow' }), 'auto')
})
