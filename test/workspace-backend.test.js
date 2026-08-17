import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createControllerStore } from '../src/controller/store.js'
import { createRunner } from '../src/controller/runner.js'
import { createHostApiHandler } from '../src/host-api.js'
import { startHostd } from '../src/hostd/server.js'
import {
  deleteSftpFile,
  listSftpDirectory,
  readSftpFile,
  writeSftpFile,
} from '../src/controller/sftp.js'

const version = (content) => createHash('sha256').update(String(content)).digest('hex')
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'remote-workspace-'))

function host() {
  return {
    hostId: 'host-a', displayName: 'alpha', address: 'ssh://example:22',
    transport: 'ssh', online: true, cwd: '/srv', os: 'linux', dialect: 'bash',
  }
}

function mockReq({ method, url, body }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  }
  return req
}

function rawMockReq({ method, url, body }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(body)
  }
  return req
}

function mockRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(status) { this.statusCode = status },
    end(payload) { this.body = payload ? JSON.parse(payload) : null },
  }
}

test('变更快照跨重启持久化，删除主机同步清理变更', async () => {
  const dataDir = await tempDir()
  const store = await createControllerStore(dataDir)
  await store.upsertHost(host())
  const change = await store.recordChange({
    hostId: 'host-a', path: '/srv/a.js', beforeContent: 'old', afterContent: 'new',
    beforeVersion: version('old'), afterVersion: version('new'), source: 'ai',
  })
  const reloaded = await createControllerStore(dataDir)
  assert.equal(reloaded.getChange(change.changeId).source, 'ai')
  assert.equal(reloaded.getChange(change.changeId).beforeVersion, version('old'))
  await reloaded.removeHost('host-a')
  assert.equal(reloaded.getChange(change.changeId), undefined)
})

test('runner 写文件校验版本并支持接受、撤销和还原', async () => {
  const store = await createControllerStore(await tempDir())
  await store.upsertHost(host())
  const files = new Map([['/srv/a.js', 'old']])
  let writes = 0
  const client = {
    async readRemoteFile(_host, remotePath) {
      if (!files.has(remotePath)) { const error = new Error('No such file'); error.code = 'ENOENT'; throw error }
      const content = files.get(remotePath)
      return { path: remotePath, content, size: content.length, version: version(content) }
    },
    async writeRemoteFile(_host, remotePath, content) { files.set(remotePath, content); writes += 1; return { path: remotePath, version: version(content) } },
    async deleteRemoteFile(_host, remotePath) { files.delete(remotePath); writes += 1 },
    async listDirectory() { return [{ name: 'a.js', path: '/srv/a.js', type: 'file' }] },
  }
  const runner = createRunner({ store, client })
  await assert.rejects(
    runner.writeRemoteFile({ host: 'host-a', path: '/srv/a.js', content: 'new', expectedVersion: 'stale' }),
    (error) => error.code === 'REMOTE_FILE_CONFLICT',
  )
  const change = await runner.writeRemoteFile({
    host: 'host-a', path: '/srv/a.js', content: 'new', expectedVersion: version('old'), source: 'ai',
  })
  assert.equal(files.get('/srv/a.js'), 'new')
  assert.equal(change.status, 'pending')
  await runner.reviewChange(change.changeId, 'revert')
  assert.equal(files.get('/srv/a.js'), 'old')
  await runner.reviewChange(change.changeId, 'restore')
  assert.equal(files.get('/srv/a.js'), 'new')
  const beforeAcceptWrites = writes
  const accepted = await runner.reviewChange(change.changeId, 'accept')
  assert.equal(accepted.status, 'accepted')
  assert.equal(writes, beforeAcceptWrites)
})

test('工作台 API 使用固定文件、终端和审阅路由', async () => {
  const calls = []
  const runner = {
    async listFiles(hostId, remotePath) { calls.push(['files', hostId, remotePath]); return { hostId, path: remotePath, entries: [] } },
    async readRemoteFile(hostId, remotePath) { return { hostId, path: remotePath, content: 'x', size: 1, version: 'v1' } },
    async writeRemoteFile(input) { calls.push(['write', input]); return { changeId: 'c1', hostId: input.host, path: input.path, beforeContent: 'x', afterContent: input.content, status: 'pending', source: input.source, createdAt: 1, updatedAt: 1 } },
    async exec(input) { calls.push(['terminal', input]); return { jobId: 'j1', hostId: input.host, command: input.command, status: 'succeeded', exitCode: 0, startedAt: 1, finishedAt: 2, log: 'ok' } },
    listChanges({ hostId }) { return [{ changeId: 'c1', hostId, path: '/srv/a', beforeContent: 'x', afterContent: 'y', status: 'pending', createdAt: 1, updatedAt: 1 }] },
    async reviewChange(changeId, action) { calls.push(['review', changeId, action]); return { changeId, hostId: 'h1', path: '/srv/a', status: action === 'accept' ? 'accepted' : 'reverted', createdAt: 1, updatedAt: 2 } },
  }
  const handle = createHostApiHandler({ runner })
  const files = mockRes()
  await handle(mockReq({ method: 'GET', url: '/remote-ssh-ops/v1/hosts/h1/files?path=%2Fsrv' }), files)
  assert.equal(files.statusCode, 200)
  const write = mockRes()
  await handle(mockReq({ method: 'PUT', url: '/remote-ssh-ops/v1/hosts/h1/file', body: { path: '/srv/a', content: 'y', expected_version: 'v1', source: 'ai' } }), write)
  assert.equal(calls.at(-1)[1].expectedVersion, 'v1')
  const terminal = mockRes()
  await handle(mockReq({ method: 'POST', url: '/remote-ssh-ops/v1/hosts/h1/terminal', body: { command: 'pwd' } }), terminal)
  assert.equal(terminal.body.log, 'ok')
  const review = mockRes()
  await handle(mockReq({ method: 'POST', url: '/remote-ssh-ops/v1/changes/c1/revert' }), review)
  assert.deepEqual(calls.at(-1), ['review', 'c1', 'revert'])
})

test('hostd 文件 API 受工作区约束并执行版本冲突检测', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const filePath = path.join(workspaceRoot, 'a.txt')
  await fs.writeFile(filePath, 'old', 'utf8')
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const headers = { authorization: `Bearer ${paired.device_token}` }
    const listed = await (await fetch(`${server.url}/v1/files?path=${encodeURIComponent(workspaceRoot)}`, { headers })).json()
    assert.equal(listed.entries[0].name, 'a.txt')
    const read = await (await fetch(`${server.url}/v1/file?path=${encodeURIComponent(filePath)}`, { headers })).json()
    assert.equal(read.content, 'old')
    const conflict = await fetch(`${server.url}/v1/file`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: 'new', expected_version: 'stale' }),
    })
    assert.equal(conflict.status, 409)
    const saved = await fetch(`${server.url}/v1/file`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: 'new', expected_version: read.version }),
    })
    assert.equal(saved.status, 200)
    assert.equal(await fs.readFile(filePath, 'utf8'), 'new')
    const outside = await fetch(`${server.url}/v1/file?path=${encodeURIComponent(path.dirname(workspaceRoot))}`, { headers })
    assert.equal(outside.status, 403)
  } finally {
    await server.close()
  }
})

test('hostd 目录 API 在生产端分页而不是全量返回', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  await Promise.all(Array.from({ length: 25 }, (_, index) => (
    fs.writeFile(path.join(workspaceRoot, `file-${String(index).padStart(2, '0')}.txt`), 'x')
  )))
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const headers = { authorization: `Bearer ${paired.device_token}` }
    const first = await (await fetch(
      `${server.url}/v1/files?path=${encodeURIComponent(workspaceRoot)}&limit=10&offset=0`,
      { headers },
    )).json()
    assert.equal(first.entries.length, 10)
    assert.equal(first.next_offset, 10)
    const second = await (await fetch(
      `${server.url}/v1/files?path=${encodeURIComponent(workspaceRoot)}&limit=10&offset=${first.next_offset}`,
      { headers },
    )).json()
    assert.equal(second.entries.length, 10)
    assert.equal(second.next_offset, 20)
  } finally {
    await server.close()
  }
})

test('hostd 目录分页在计数前过滤内部临时文件', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  await fs.writeFile(path.join(workspaceRoot, '.dsh-tmp-hidden'), 'temporary')
  await fs.writeFile(path.join(workspaceRoot, 'visible-a.txt'), 'a')
  await fs.writeFile(path.join(workspaceRoot, 'visible-b.txt'), 'b')
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const response = await fetch(
      `${server.url}/v1/files?path=${encodeURIComponent(workspaceRoot)}&limit=2&offset=0`,
      { headers: { authorization: `Bearer ${paired.device_token}` } },
    )
    const page = await response.json()
    assert.deepEqual(page.entries.map((entry) => entry.name).sort(), ['visible-a.txt', 'visible-b.txt'])
    assert.equal(page.next_offset, undefined)
  } finally {
    await server.close()
  }
})

test('hostd 拒绝通过符号链接或目录联接越出工作区', async (t) => {
  const workspaceRoot = await tempDir()
  const outsideRoot = await tempDir()
  const dataDir = await tempDir()
  const outsideFile = path.join(outsideRoot, 'secret.txt')
  const linkPath = path.join(workspaceRoot, 'outside-link')
  await fs.writeFile(outsideFile, 'secret', 'utf8')
  try {
    await fs.symlink(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('当前 Windows 环境不允许创建目录联接')
      return
    }
    throw error
  }
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const headers = { authorization: `Bearer ${paired.device_token}` }
    const escapedFile = path.join(linkPath, 'secret.txt')
    const read = await fetch(`${server.url}/v1/file?path=${encodeURIComponent(escapedFile)}`, { headers })
    assert.equal(read.status, 403)
    assert.equal((await read.json()).code, 'REMOTE_PATH_OUTSIDE_WORKSPACE')

    const write = await fetch(`${server.url}/v1/file`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(linkPath, 'created.txt'), content: 'escaped' }),
    })
    assert.equal(write.status, 403)
    assert.equal(await fs.stat(path.join(outsideRoot, 'created.txt')).then(() => true, () => false), false)
  } finally {
    await server.close()
  }
})

test('hostd 和 Host API 在 JSON 请求体超限时立即返回 413', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const server = await startHostd({
    dataDir,
    workspaceRoot,
    listen: '127.0.0.1:0',
    allowInsecure: true,
    maxRequestBodyBytes: 64,
  })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const hostdResponse = await fetch(`${server.url}/v1/file`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${paired.device_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path: 'large.txt', content: 'x'.repeat(128) }),
    })
    assert.equal(hostdResponse.status, 413)
    assert.equal((await hostdResponse.json()).code, 'REQUEST_BODY_TOO_LARGE')

    let writeCalled = false
    const handle = createHostApiHandler({
      maxRequestBodyBytes: 64,
      runner: {
        async writeRemoteFile() { writeCalled = true; return {} },
      },
    })
    const response = mockRes()
    await handle(rawMockReq({
      method: 'PUT',
      url: '/remote-ssh-ops/v1/hosts/h1/file',
      body: JSON.stringify({ path: '/srv/a', content: 'x'.repeat(128) }),
    }), response)
    assert.equal(response.statusCode, 413)
    assert.equal(response.body.code, 'REQUEST_BODY_TOO_LARGE')
    assert.equal(writeCalled, false)
  } finally {
    await server.close()
  }
})

test('hostd 并发 expected_version 写入最多一个成功', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const filePath = path.join(workspaceRoot, 'cas.txt')
  await fs.writeFile(filePath, 'old', 'utf8')
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const headers = {
      authorization: `Bearer ${paired.device_token}`,
      'content-type': 'application/json',
    }
    const writes = Array.from({ length: 8 }, (_, index) => fetch(`${server.url}/v1/file`, {
      method: 'PUT', headers,
      body: JSON.stringify({ path: filePath, content: `next-${index}`, expected_version: version('old') }),
    }))
    const responses = await Promise.all(writes)
    assert.equal(responses.filter((response) => response.status === 200).length, 1)
    assert.equal(responses.filter((response) => response.status === 409).length, 7)
  } finally {
    await server.close()
  }
})

function fakeSftpConnection(initialFiles) {
  const files = new Map(initialFiles)
  let closed = false
  const handles = new Map()
  const sftp = {
    readdir(_remotePath, callback) {
      callback(null, [...files].map(([name, content]) => ({ filename: path.posix.basename(name), attrs: { size: Buffer.byteLength(content), mtime: 1, mode: 0o100600, isDirectory: () => false } })))
    },
    stat(remotePath, callback) {
      if (!files.has(remotePath)) { const error = new Error('No such file'); error.code = 2; callback(error); return }
      callback(null, { size: Buffer.byteLength(files.get(remotePath)), mtime: 1 })
    },
    open(remotePath, flags, _mode, callback) {
      if (typeof _mode === 'function') callback = _mode
      if (flags.includes('x') && files.has(remotePath)) {
        const error = new Error('File exists')
        error.code = 'EEXIST'
        callback(error)
        return
      }
      if (flags.includes('w') && !files.has(remotePath)) files.set(remotePath, '')
      handles.set(remotePath, { remotePath, flags })
      callback(null, remotePath)
    },
    read(handle, buffer, offset, length, position, callback) {
      const source = Buffer.from(files.get(handle))
      const count = source.copy(buffer, offset, position, position + length)
      callback(null, count, buffer)
    },
    write(handle, buffer, offset, length, position, callback) {
      const current = Buffer.from(files.get(handle) ?? '')
      const next = Buffer.alloc(Math.max(current.length, position + length))
      current.copy(next)
      buffer.copy(next, position, offset, offset + length)
      files.set(handle, next.toString('utf8'))
      callback(null, length)
    },
    close(_handle, callback) { callback(null) },
    rename(from, to, callback) { files.set(to, files.get(from)); files.delete(from); callback(null) },
    ext_openssh_rename(from, to, callback) { files.set(to, files.get(from)); files.delete(from); callback(null) },
    unlink(remotePath, callback) { files.delete(remotePath); callback(null) },
    end() { closed = true },
  }
  return { files, sftp, get closed() { return closed }, connection: { sftp: (callback) => callback(null, sftp) } }
}

test('SFTP 适配器真实使用 SFTP read/write/rename/unlink 调用', async () => {
  const remote = fakeSftpConnection([['/srv/a.txt', 'old']])
  const listed = await listSftpDirectory(remote.connection, '/srv')
  assert.equal(listed[0].name, 'a.txt')
  assert.equal((await readSftpFile(remote.connection, '/srv/a.txt')).content, 'old')
  await writeSftpFile(remote.connection, '/srv/a.txt', 'new')
  assert.equal(remote.files.get('/srv/a.txt'), 'new')
  await deleteSftpFile(remote.connection, '/srv/a.txt')
  assert.equal(remote.files.has('/srv/a.txt'), false)
  assert.equal(remote.closed, true)
})

test('SFTP 写入优先使用 OpenSSH 原子替换扩展覆盖已有文件', async () => {
  const remote = fakeSftpConnection([['/srv/a.txt', 'old']])
  let standardRenameCalled = false
  remote.sftp.rename = (_from, _to, callback) => {
    standardRenameCalled = true
    callback(new Error('standard rename should not be called'))
  }
  await writeSftpFile(remote.connection, '/srv/a.txt', 'new')
  assert.equal(remote.files.get('/srv/a.txt'), 'new')
  assert.equal(standardRenameCalled, false)
})

test('SFTP 并发 expectedVersion 写入最多一个成功', async () => {
  const remote = fakeSftpConnection([['/srv/a.txt', 'old']])
  const expectedVersion = version('old')
  const results = await Promise.allSettled([
    writeSftpFile(remote.connection, '/srv/a.txt', 'first', expectedVersion),
    writeSftpFile(remote.connection, '/srv/a.txt', 'second', expectedVersion),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'REMOTE_FILE_CONFLICT')
})

test('两个控制器遇到陈旧 SFTP 锁时都 fail closed', async () => {
  const remote = fakeSftpConnection([
    ['/srv/a.txt', 'old'],
    ['/srv/a.txt.dsh-cas-lock', 'abandoned'],
  ])
  const secondConnection = { sftp: (callback) => callback(null, remote.sftp) }
  const options = { now: () => 10_000, staleMs: 1_000 }
  const results = await Promise.allSettled([
    writeSftpFile(remote.connection, '/srv/a.txt', 'first', version('old'), options),
    writeSftpFile(secondConnection, '/srv/a.txt', 'second', version('old'), options),
  ])
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2)
  assert.ok(results.every((result) => result.reason.code === 'REMOTE_FILE_LOCK_STALE'))
  assert.equal(remote.files.get('/srv/a.txt'), 'old')
})

test('SFTP 删除同样执行 expectedVersion 条件检查', async () => {
  const remote = fakeSftpConnection([['/srv/a.txt', 'old']])
  await assert.rejects(
    deleteSftpFile(remote.connection, '/srv/a.txt', version('stale')),
    (error) => error.code === 'REMOTE_FILE_CONFLICT',
  )
  assert.equal(remote.files.get('/srv/a.txt'), 'old')
  await deleteSftpFile(remote.connection, '/srv/a.txt', version('old'))
  assert.equal(remote.files.has('/srv/a.txt'), false)
})

test('SFTP 条件写对超过租约的崩溃残留锁 fail closed', async () => {
  const remote = fakeSftpConnection([
    ['/srv/a.txt', 'old'],
    ['/srv/a.txt.dsh-cas-lock', 'abandoned'],
  ])
  await assert.rejects(
    writeSftpFile(remote.connection, '/srv/a.txt', 'new', version('old'), {
      now: () => 10_000,
      staleMs: 1_000,
    }),
    (error) => error.code === 'REMOTE_FILE_LOCK_STALE'
      && error.message.includes('/srv/a.txt.dsh-cas-lock'),
  )
  assert.equal(remote.files.get('/srv/a.txt'), 'old')
  assert.equal(remote.files.has('/srv/a.txt.dsh-cas-lock'), true)
})

test('SFTP 条件写对崩溃残留 reclaim 锁 fail closed', async () => {
  const remote = fakeSftpConnection([
    ['/srv/a.txt', 'old'],
    ['/srv/a.txt.dsh-cas-lock', 'abandoned'],
    ['/srv/a.txt.dsh-cas-lock.reclaim', 'abandoned-reclaim'],
  ])
  await assert.rejects(
    writeSftpFile(remote.connection, '/srv/a.txt', 'new', version('old'), {
      now: () => 10_000,
      staleMs: 1_000,
    }),
    (error) => error.code === 'REMOTE_FILE_LOCK_STALE',
  )
  assert.equal(remote.files.get('/srv/a.txt'), 'old')
  assert.equal(remote.files.has('/srv/a.txt.dsh-cas-lock.reclaim'), true)
})

test('SFTP 条件写不会抢占仍在租约内的活跃锁', async () => {
  const remote = fakeSftpConnection([
    ['/srv/a.txt', 'old'],
    ['/srv/a.txt.dsh-cas-lock', 'active'],
  ])
  await assert.rejects(
    writeSftpFile(remote.connection, '/srv/a.txt', 'new', version('old'), {
      now: () => 1_500,
      staleMs: 1_000,
    }),
    (error) => error.code === 'REMOTE_FILE_BUSY',
  )
  assert.equal(remote.files.get('/srv/a.txt'), 'old')
})
