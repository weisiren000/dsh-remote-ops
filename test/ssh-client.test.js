import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import ssh2 from 'ssh2'
import { createSshClient, execChannel } from '../src/controller/ssh-client.js'

const { Server, utils } = ssh2
const TEST_PASSWORD = 'test-login-password'
const TEST_USERNAME = 'tenant#user#remote'
const TEST_HOST_KEY = utils.generateKeyPairSync('rsa', { bits: 2048 }).private

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

async function startSshAuthServer({
  mode,
  prompts,
  followupPrompts,
  instructions = '',
  partialPassword = false,
  acceptEmpty = false,
  methods = mode === 'keyboard-interactive'
    ? ['keyboard-interactive', 'publickey']
    : ['password', 'keyboard-interactive', 'publickey'],
}) {
  const attempts = []
  const answers = []
  const server = new Server({ hostKeys: [TEST_HOST_KEY] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (context) => {
      attempts.push({ method: context.method, username: context.username })
      if (context.method === 'publickey') {
        context.accept()
        return
      }
      if (mode === 'password' && context.method === 'password') {
        if (context.password === TEST_PASSWORD) context.accept()
        else context.reject(['password', 'publickey'])
        return
      }
      if (partialPassword && context.method === 'password') {
        context.reject(['keyboard-interactive'], true)
        return
      }
      if (mode === 'keyboard-interactive' && context.method === 'keyboard-interactive') {
        context.prompt(prompts, '测试认证', instructions, (responses) => {
          if (!Array.isArray(responses)) return
          answers.push(responses)
          if (acceptEmpty && responses.length === 0) {
            context.accept()
            return
          }
          if (responses.length !== 1 || responses[0] !== TEST_PASSWORD) {
            context.reject(['keyboard-interactive', 'publickey'])
            return
          }
          if (!followupPrompts) {
            context.accept()
            return
          }
          context.prompt(followupPrompts, '附加认证', '', (followupAnswers) => {
            if (Array.isArray(followupAnswers)) answers.push(followupAnswers)
            context.reject(['keyboard-interactive', 'publickey'])
          })
        })
        return
      }
      context.reject(methods)
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec()
          if (info.command.startsWith('hostname;')) {
            stream.write('test-host\n__DSH_CWD__/srv/test\nLinux\n')
          }
          stream.exit(0)
          stream.end()
        })
      })
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    attempts,
    answers,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function connectAfterTrust(client, port) {
  const input = {
    host: '127.0.0.1',
    port,
    username: TEST_USERNAME,
    password: TEST_PASSWORD,
  }
  let fingerprint
  await assert.rejects(client.connect(input), (error) => {
    fingerprint = error.fingerprint
    return error.code === 'HOST_KEY_UNTRUSTED' && Boolean(fingerprint)
  })
  return client.connect({ ...input, hostFingerprint: fingerprint })
}

async function closeSshAuthFixture(client, server, keysDir) {
  await client.dispose()
  await server.close()
  await fs.rm(keysDir, { recursive: true, force: true })
}

test('SSH 首次连接兼容普通 password 并用专用私钥完成二次认证', async () => {
  const server = await startSshAuthServer({ mode: 'password' })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-password-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  const connections = []
  const originalConnect = ssh2.Client.prototype.connect
  ssh2.Client.prototype.connect = function (...args) {
    connections.push(this)
    return originalConnect.apply(this, args)
  }
  try {
    const host = await connectAfterTrust(client, server.port)
    assert.deepEqual([host.sshUsername, host.authMode], [TEST_USERNAME, 'key'])
    assert.ok(server.attempts.some(({ method }) => method === 'password'))
    assert.ok(server.attempts.some(({ method }) => method === 'publickey'))
    assert.ok(connections.every(({ config }) => config.password === undefined))
  } finally {
    ssh2.Client.prototype.connect = originalConnect
    await closeSshAuthFixture(client, server, keysDir)
  }
})

test('SSH 首次连接用登录密码回答明确的 keyboard-interactive 密码挑战', async () => {
  const server = await startSshAuthServer({
    mode: 'keyboard-interactive',
    prompts: [{ prompt: 'Password: ', echo: false }],
  })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-keyboard-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  try {
    const host = await connectAfterTrust(client, server.port)
    assert.equal(host.sshUsername, TEST_USERNAME)
    assert.deepEqual(server.answers, [[TEST_PASSWORD]])
    assert.ok(server.attempts.some(({ method }) => method === 'publickey'))
    assert.ok(server.attempts.every(({ method }) => method !== 'password'))
    assert.ok(server.attempts.every(({ username }) => username === TEST_USERNAME))
  } finally {
    await closeSshAuthFixture(client, server, keysDir)
  }
})

test('SSH 拒绝向 keyboard-interactive OTP 挑战自动提交登录密码', async () => {
  const server = await startSshAuthServer({
    mode: 'keyboard-interactive',
    prompts: [{ prompt: 'One-time verification code: ', echo: false }],
  })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-otp-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  try {
    await assert.rejects(connectAfterTrust(client, server.port), (error) => {
      assert.equal(error.code, 'SSH_INTERACTIVE_AUTH_UNSUPPORTED')
      assert.match(error.message, /OTP|MFA|验证码/)
      assert.equal(error.cause, undefined)
      assert.doesNotMatch(error.message, new RegExp(TEST_PASSWORD))
      assert.doesNotMatch(error.message, /One-time verification code/)
      return true
    })
    assert.deepEqual(server.answers, [])
  } finally {
    await closeSshAuthFixture(client, server, keysDir)
  }
})

test('SSH 回答密码后拒绝第二轮 keyboard-interactive OTP 挑战', async () => {
  const server = await startSshAuthServer({
    mode: 'keyboard-interactive',
    prompts: [{ prompt: 'Password: ', echo: false }],
    followupPrompts: [{ prompt: 'OTP: ', echo: false }],
  })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-multistep-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  try {
    await assert.rejects(connectAfterTrust(client, server.port), (error) => (
      error.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
    ))
    assert.deepEqual(server.answers, [[TEST_PASSWORD]])
  } finally {
    await closeSshAuthFixture(client, server, keysDir)
  }
})

test('SSH 拒绝说明文字中要求 Duo Push 审批的伪密码挑战', async () => {
  const server = await startSshAuthServer({
    mode: 'keyboard-interactive',
    prompts: [{ prompt: 'Password: ', echo: false }],
    instructions: 'Approve the Duo Push notification before continuing.',
  })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-push-mfa-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  try {
    await assert.rejects(connectAfterTrust(client, server.port), (error) => (
      error.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
    ))
    assert.deepEqual(server.answers, [])
  } finally {
    await closeSshAuthFixture(client, server, keysDir)
  }
})

for (const prompt of [
  'Password + SMS code: ', 'Password token: ',
  'Password recovery code: ', 'Password for second factor: ',
  'Password for additional authentication factor: ', 'Password for security key: ',
  'Password for additional-factor: ', 'Additional factor\'s password: ',
  'Secondary factor\'s password: ',
]) {
  test(`SSH 拒绝组合认证提示：${prompt.trim()}`, async () => {
    const server = await startSshAuthServer({
      mode: 'keyboard-interactive',
      prompts: [{ prompt, echo: false }],
    })
    const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-combined-mfa-'))
    const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
    try {
      await assert.rejects(connectAfterTrust(client, server.port), (error) => (
        error.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
      ))
      assert.deepEqual(server.answers, [])
    } finally {
      await closeSshAuthFixture(client, server, keysDir)
    }
  })
}

test('SSH 拒绝 password 部分成功后继续要求交互式认证', async () => {
  const server = await startSshAuthServer({
    mode: 'keyboard-interactive',
    partialPassword: true,
    methods: ['password', 'keyboard-interactive'],
    prompts: [{ prompt: 'Password: ', echo: false }],
  })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-partial-auth-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  try {
    await assert.rejects(connectAfterTrust(client, server.port), (error) => (
      error.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
    ))
    assert.deepEqual(server.answers, [])
  } finally {
    await closeSshAuthFixture(client, server, keysDir)
  }
})

test('SSH 拒绝零提示 keyboard-interactive 外部确认', async () => {
  const server = await startSshAuthServer({
    mode: 'keyboard-interactive',
    prompts: [],
    acceptEmpty: true,
  })
  const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-zero-prompt-'))
  const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
  try {
    await assert.rejects(connectAfterTrust(client, server.port), (error) => (
      error.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
    ))
    assert.deepEqual(server.answers, [[]])
  } finally {
    await closeSshAuthFixture(client, server, keysDir)
  }
})

for (const [name, prompts] of [
  ['未知挑战', [{ prompt: 'Security question: ', echo: false }]],
  ['密码与验证码混合挑战', [
    { prompt: 'Password: ', echo: false },
    { prompt: 'Verification code: ', echo: false },
  ]],
]) {
  test(`SSH 拒绝向 keyboard-interactive ${name}自动提交登录密码`, async () => {
    const server = await startSshAuthServer({ mode: 'keyboard-interactive', prompts })
    const keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-unknown-'))
    const client = createSshClient({ keysDir, sftpLockStaleMs: 60_000 })
    try {
      await assert.rejects(connectAfterTrust(client, server.port), (error) => (
        error.code === 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
      ))
      assert.deepEqual(server.answers, [])
    } finally {
      await closeSshAuthFixture(client, server, keysDir)
    }
  })
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
