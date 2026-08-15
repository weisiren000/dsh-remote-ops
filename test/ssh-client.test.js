import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execChannel } from '../src/controller/ssh-client.js'

test('SSH 取消向真实 channel 发送 TERM 后关闭本地 channel', async () => {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  const signals = []
  let closed = false
  channel.signal = (signal) => signals.push(signal)
  channel.close = () => {
    closed = true
    queueMicrotask(() => channel.emit('close', null, 'TERM'))
  }
  const connection = { exec(_command, callback) { callback(null, channel) } }
  const controller = new AbortController()
  const pending = execChannel(connection, 'sleep 30', { signal: controller.signal })
  controller.abort()
  const result = await pending
  assert.deepEqual(signals, ['TERM'])
  assert.equal(closed, true)
  assert.equal(result.aborted, true)
  assert.equal(result.exitCode, null)
})
