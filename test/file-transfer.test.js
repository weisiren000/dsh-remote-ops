import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { createHostApiHandler } from '../src/host-api.js'
import { startHostd } from '../src/hostd/server.js'
import { createHostClient } from '../src/controller/client.js'
import { downloadSftpFile, uploadSftpFile } from '../src/controller/sftp.js'

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'remote-transfer-'))

class MemoryResponse extends Writable {
  constructor() {
    super()
    this.body = []
    this.headers = {}
    this.statusCode = 0
  }

  _write(chunk, _encoding, callback) {
    this.body.push(Buffer.from(chunk))
    callback()
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode
    this.headers = headers
  }

  bytes() {
    return Buffer.concat(this.body)
  }
}

function request(url, method, body = Buffer.alloc(0)) {
  const req = Readable.from([body])
  req.url = url
  req.method = method
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = { 'content-length': String(body.length) }
  return req
}

test('Host API 以流方式转发二进制上传和下载', async () => {
  const source = Buffer.from([0, 1, 2, 255, 9])
  let uploaded
  const handler = createHostApiHandler({
    runner: {
      async uploadRemoteFile(hostId, remotePath, stream, options) {
        const chunks = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        uploaded = { hostId, remotePath, bytes: Buffer.concat(chunks), size: options.size }
        return { hostId, path: remotePath, size: uploaded.bytes.length }
      },
      async downloadRemoteFile(hostId, remotePath) {
        return { hostId, path: remotePath, size: source.length, stream: Readable.from([source]) }
      },
    },
  })

  const uploadResponse = new MemoryResponse()
  await handler(request('/remote-ops/v1/hosts/h%2F1/transfer?path=%2Fsrv%2Farchive.bin', 'PUT', source), uploadResponse)
  assert.equal(uploadResponse.statusCode, 200)
  assert.equal(uploaded.hostId, 'h/1')
  assert.equal(uploaded.remotePath, '/srv/archive.bin')
  assert.equal(uploaded.size, source.length)
  assert.deepEqual(uploaded.bytes, source)

  const downloadResponse = new MemoryResponse()
  await handler(request('/remote-ops/v1/hosts/h%2F1/transfer?path=%2Fsrv%2Farchive.bin', 'GET'), downloadResponse)
  assert.equal(downloadResponse.statusCode, 200)
  assert.equal(downloadResponse.headers['content-length'], source.length)
  assert.match(downloadResponse.headers['content-disposition'], /archive\.bin/)
  assert.deepEqual(downloadResponse.bytes(), source)
})

test('Host API 不因文件声明大小超过 1 GiB 而拒绝上传', async () => {
  const declaredSize = (1024 ** 3) + 1
  let forwardedSize
  const handler = createHostApiHandler({
    runner: {
      async uploadRemoteFile(hostId, remotePath, _stream, options) {
        forwardedSize = options.size
        return { hostId, path: remotePath, size: 0 }
      },
    },
  })
  const req = request('/remote-ops/v1/hosts/h1/transfer?path=%2Fsrv%2Flarge.bin', 'PUT')
  req.headers['content-length'] = String(declaredSize)
  const res = new MemoryResponse()

  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(forwardedSize, declaredSize)
})

test('hostd 不再应用 maxTransferBytes 旧配置', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const server = await startHostd({
    dataDir,
    workspaceRoot,
    listen: '127.0.0.1:0',
    allowInsecure: true,
    maxTransferBytes: 1024,
  })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const target = path.join(workspaceRoot, 'large.bin')
    const content = Buffer.alloc(2048, 7)
    const upload = await fetch(`${server.url}/v1/transfer?path=${encodeURIComponent(target)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${paired.device_token}` },
      body: content,
    })

    assert.equal(upload.status, 200)
    assert.deepEqual(await fs.readFile(target), content)
  } finally {
    await server.close()
  }
})

test('hostd 文件传输保留二进制内容并限制工作区边界', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const server = await startHostd({
    dataDir,
    workspaceRoot,
    listen: '127.0.0.1:0',
    allowInsecure: true,
    maxTransferBytes: 1024,
  })
  try {
    const paired = await (await fetch(`${server.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairing_code: server.pairingCode }),
    })).json()
    const headers = { authorization: `Bearer ${paired.device_token}` }
    const target = path.join(workspaceRoot, 'archive.bin')
    const content = Buffer.from([0, 1, 2, 255, 9])

    const upload = await fetch(`${server.url}/v1/transfer?path=${encodeURIComponent(target)}`, {
      method: 'PUT',
      headers,
      body: content,
    })
    assert.equal(upload.status, 200)
    assert.deepEqual(await fs.readFile(target), content)

    const download = await fetch(`${server.url}/v1/transfer?path=${encodeURIComponent(target)}`, { headers })
    assert.equal(download.status, 200)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), content)

    const outside = path.join(path.dirname(workspaceRoot), 'outside.bin')
    const denied = await fetch(`${server.url}/v1/transfer?path=${encodeURIComponent(outside)}`, {
      method: 'PUT',
      headers,
      body: content,
    })
    assert.equal(denied.status, 403)
    assert.equal(await fs.stat(outside).then(() => true, () => false), false)
  } finally {
    await server.close()
  }
})

test('控制器客户端通过 hostd 流式上传并下载文件', async () => {
  const workspaceRoot = await tempDir()
  const dataDir = await tempDir()
  const server = await startHostd({ dataDir, workspaceRoot, listen: '127.0.0.1:0', allowInsecure: true })
  try {
    const client = createHostClient()
    const host = await client.pair(server.url, server.pairingCode)
    const remotePath = path.join(workspaceRoot, 'controller.bin')
    const content = Buffer.from([255, 0, 8, 7, 6])

    const uploaded = await client.uploadRemoteFile(host, remotePath, Readable.from([content]), { size: content.length })
    assert.equal(uploaded.size, content.length)
    const downloaded = await client.downloadRemoteFile(host, remotePath)
    const chunks = []
    for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), content)
  } finally {
    await server.close()
  }
})

test('SSH SFTP 文件传输使用流并保留二进制内容', async () => {
  const files = new Map()
  let reportedSize
  const sftp = {
    stat(remotePath, callback) {
      const content = files.get(remotePath)
      if (!content) { callback(Object.assign(new Error('missing'), { code: 2 })); return }
      callback(null, { size: reportedSize ?? content.length, mtime: 1 })
    },
    createWriteStream(remotePath) {
      const chunks = []
      return new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() },
        final(callback) { files.set(remotePath, Buffer.concat(chunks)); callback() },
      })
    },
    createReadStream(remotePath) {
      return Readable.from([files.get(remotePath)])
    },
    ext_openssh_rename(from, to, callback) {
      files.set(to, files.get(from))
      files.delete(from)
      callback(null)
    },
    unlink(remotePath, callback) { files.delete(remotePath); callback(null) },
    end() {},
  }
  const connection = { sftp: (callback) => callback(null, sftp) }
  const content = Buffer.from([0, 255, 1, 254])

  const uploaded = await uploadSftpFile(connection, '/srv/archive.bin', Readable.from([content]))
  assert.equal(uploaded.size, content.length)
  reportedSize = (1024 ** 3) + 1
  const downloaded = await downloadSftpFile(connection, '/srv/archive.bin')
  assert.equal(downloaded.size, reportedSize)
  const chunks = []
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), content)
})
