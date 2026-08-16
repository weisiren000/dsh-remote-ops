import assert from 'node:assert/strict'
import test from 'node:test'
import { fileCanEdit, joinRemotePath, latencyLevel } from '../src/plugin/client/workspace.js'

test('远程路径按目标目录现有分隔符拼接', () => {
  assert.equal(joinRemotePath('/srv/app', 'archive.tar'), '/srv/app/archive.tar')
  assert.equal(joinRemotePath('C:\\Users\\admin', 'archive.zip'), 'C:\\Users\\admin\\archive.zip')
  assert.equal(joinRemotePath('.', 'notes.txt'), './notes.txt')
})

test('在线主机延迟按快、中、慢分级，离线状态保持中性', () => {
  assert.equal(latencyLevel({ status: 'online', latency_ms: 80 }), 'fast')
  assert.equal(latencyLevel({ status: 'online', latency_ms: 180 }), 'medium')
  assert.equal(latencyLevel({ status: 'online', latency_ms: 530 }), 'slow')
  assert.equal(latencyLevel({ status: 'offline', latency_ms: 20 }), 'unknown')
  assert.equal(latencyLevel({ status: 'online', latency_ms: null }), 'unknown')
})

test('无法预览的文件只提供下载，不进入编辑状态', () => {
  assert.equal(fileCanEdit({ path: '/srv/readme.txt' }), true)
  assert.equal(fileCanEdit({ path: '/srv/archive.bin', previewUnavailable: true }), false)
})
