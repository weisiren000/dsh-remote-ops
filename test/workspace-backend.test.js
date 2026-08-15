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
  await handle(mockReq({ method: 'GET', url: '/remote-ops/v1/hosts/h1/files?path=%2Fsrv' }), files)
  assert.equal(files.statusCode, 200)
  const write = mockRes()
  await handle(mockReq({ method: 'PUT', url: '/remote-ops/v1/hosts/h1/file', body: { path: '/srv/a', content: 'y', expected_version: 'v1', source: 'ai' } }), write)
  assert.equal(calls.at(-1)[1].expectedVersion, 'v1')
  const terminal = mockRes()
  await handle(mockReq({ method: 'POST', url: '/remote-ops/v1/hosts/h1/terminal', body: { command: 'pwd' } }), terminal)
  assert.equal(terminal.body.log, 'ok')
  const review = mockRes()
  await handle(mockReq({ method: 'POST', url: '/remote-ops/v1/changes/c1/revert' }), review)
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
    unlink(remotePath, callback) { files.delete(remotePath); callback(null) },
    end() { closed = true },
  }
  return { files, get closed() { return closed }, connection: { sftp: (callback) => callback(null, sftp) } }
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
