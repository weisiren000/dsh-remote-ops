import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createSshClient, execChannel } from '../src/controller/ssh-client.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

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

test('SSH channel 对超大输出执行字节硬限制并保留计数', async () => {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  channel.signal = () => {}
  channel.close = () => {}
  const connection = {
    exec(_command, callback) {
      callback(null, channel)
      queueMicrotask(() => {
        channel.emit('data', Buffer.alloc(200000, 'x'))
        channel.stderr.emit('data', Buffer.alloc(200000, 'y'))
        channel.emit('close', 0, null)
      })
    },
  }
  const result = await execChannel(connection, 'large', { maxOutputBytes: 1024 })
  assert.ok(Buffer.byteLength(result.stdout) <= 1024)
  assert.ok(Buffer.byteLength(result.stderr) <= 1024)
  assert.equal(result.stdoutTruncated, true)
  assert.equal(result.stderrTruncated, true)
  assert.equal(result.stdoutBytes, 200000)
  assert.equal(result.stderrBytes, 200000)
})

test('SSH stdout 和 stderr 共享背压并等待所有异步写入完成', async () => {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  const stdoutWrite = deferred()
  const stderrWrite = deferred()
  let pauses = 0
  let resumes = 0
  channel.pause = () => { pauses += 1 }
  channel.resume = () => { resumes += 1 }
  channel.stderr.pause = () => { pauses += 1 }
  channel.stderr.resume = () => { resumes += 1 }
  channel.signal = () => {}
  channel.close = () => {}
  const connection = { exec(_command, callback) { callback(null, channel) } }
  let settled = false
  const result = execChannel(connection, 'streamed', {
    onStdout: () => stdoutWrite.promise,
    onStderr: () => stderrWrite.promise,
  }).then((value) => {
    settled = true
    return value
  })

  channel.emit('data', Buffer.from('out'))
  channel.stderr.emit('data', Buffer.from('err'))
  assert.equal(pauses, 2)
  stderrWrite.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(resumes, 0)
  channel.emit('close', 0, null)
  await Promise.resolve()
  assert.equal(settled, false)

  stdoutWrite.resolve()
  assert.equal((await result).exitCode, 0)
  assert.equal(resumes, 0)
})

test('SSH 日志写入失败会终止 channel 并等待 close 后才拒绝', async () => {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  channel.pause = () => {}
  channel.resume = () => {}
  channel.stderr.pause = () => {}
  channel.stderr.resume = () => {}
  const signals = []
  let closeCalls = 0
  channel.signal = (signal) => signals.push(signal)
  channel.close = () => { closeCalls += 1 }
  const connection = { exec(_command, callback) { callback(null, channel) } }
  const writeError = new Error('disk full')
  let settled = false
  const pending = execChannel(connection, 'streamed', {
    onStdout: () => Promise.reject(writeError),
  }).then(
    (value) => { settled = true; return { value } },
    (error) => { settled = true; return { error } },
  )
  channel.emit('data', Buffer.from('out'))
  await new Promise((resolve) => setImmediate(resolve))
  const beforeClose = { signals: [...signals], closeCalls, settled }
  channel.emit('close', null, 'TERM')
  const outcome = await pending

  assert.deepEqual(beforeClose.signals, ['TERM'])
  assert.equal(beforeClose.closeCalls, 1)
  assert.equal(beforeClose.settled, false)
  assert.match(outcome.error?.message ?? '', /disk full/)
})

test('SSH 日志写入失败时终止方法抛错仍保留原始写入错误', async () => {
  const channel = new EventEmitter()
  channel.stderr = new EventEmitter()
  channel.pause = () => {}
  channel.stderr.pause = () => {}
  channel.signal = () => { throw new Error('signal failed') }
  channel.close = () => { throw new Error('close failed') }
  const connection = { exec(_command, callback) { callback(null, channel) } }
  const writeError = new Error('disk full')
  const pending = execChannel(connection, 'streamed', {
    onStdout: () => Promise.reject(writeError),
  })

  channel.emit('data', Buffer.from('out'))
  await new Promise((resolve) => setImmediate(resolve))
  channel.emit('close', null, 'TERM')

  await assert.rejects(pending, (error) => error === writeError)
})

test('SSH dispose 唤醒并等待退避中的连接且不会在卸载后继续连接', async () => {
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-dispose-'))
  const privateKeyPath = path.join(keysDir, 'host.key')
  await fs.writeFile(privateKeyPath, 'invalid-test-key', 'utf8')
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  const host = {
    hostId: 'host-a', transport: 'ssh', sshHost: '127.0.0.1', sshPort: 1,
    sshUsername: 'nobody', privateKeyPath, hostFingerprint: 'SHA256:test',
  }
  await assert.rejects(client.heartbeat(host))
  let connectionSettled = false
  let connectionError
  const connecting = client.heartbeat(host).catch((error) => {
    connectionSettled = true
    connectionError = error
  })
  await Promise.resolve()
  await client.dispose()
  const settledWhenDisposed = connectionSettled
  await connecting

  assert.equal(settledWhenDisposed, true)
  assert.equal(connectionError?.code, 'SSH_CLIENT_DISPOSED')
})

test('SSH dispose 并发调用都会等待初始连接关闭', async () => {
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-connect-dispose-'))
  const opening = deferred()
  let endCalls = 0
  const client = createSshClient({
    keysDir,
    sftpLockStaleMs: 60_000,
    openConnection: () => opening.promise,
  })
  let connectError
  const connecting = client.connect({
    host: '127.0.0.1', port: 1, username: 'nobody', password: 'secret',
    hostFingerprint: 'SHA256:test',
  }).catch((error) => { connectError = error })
  let firstSettled = false
  let secondSettled = false
  const firstDispose = client.dispose().then(() => { firstSettled = true })
  const secondDispose = client.dispose().then(() => { secondSettled = true })

  await Promise.resolve()
  assert.equal(firstSettled, false)
  assert.equal(secondSettled, false)
  opening.resolve({
    fingerprint: 'SHA256:test',
    connection: { end() { endCalls += 1 } },
  })
  await Promise.all([connecting, firstDispose, secondDispose])

  assert.equal(connectError?.code, 'SSH_CLIENT_DISPOSED')
  assert.equal(endCalls, 1)
})
