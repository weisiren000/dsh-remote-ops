import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readLocator } from '../src/controller/locator-reader.js'

function fixture() {
  const job = { jobId: 'job-a', ownerSessionId: 'session-a' }
  const change = {
    changeId: 'change-a', ownerSessionId: 'session-a',
    beforeContent: '旧内容'.repeat(20), afterContent: '新内容'.repeat(20),
  }
  const store = {
    listHosts: () => [{ hostId: 'host-a' }],
    getHost: (id) => id === 'host-a' ? { hostId: 'host-a', online: true } : undefined,
    getJob: (id) => id === job.jobId ? job : undefined,
    getChange: (id) => id === change.changeId ? change : undefined,
    async readJobLogRange(_id, start, length) {
      return { text: '日志页', startByte: start, endByte: start + length, totalBytes: 500 }
    },
  }
  const client = {
    async readRemoteFile() { return { content: '文件内容'.repeat(20), version: 'v1' } },
  }
  return { store, client }
}

test('locator reader 对日志、文件和变更提供真实字节分页', async () => {
  const { store, client } = fixture()
  const log = await readLocator({ store, client }, {
    kind: 'controller_job_log', job_id: 'job-a', start_byte: 0, total_bytes: 500,
  }, { startByte: 10, lengthBytes: 20, ownerSessionId: 'session-a' })
  assert.equal(log.text, '日志页')
  assert.equal(log.start_byte, 10)

  const file = await readLocator({ store, client }, {
    kind: 'remote_file', host_id: 'host-a', path: '/srv/a.txt', version: 'v1',
    start_byte: 0, total_bytes: 240,
  }, { startByte: 1, lengthBytes: 17, ownerSessionId: 'session-a' })
  assert.doesNotMatch(file.text, /�/)
  assert.ok(file.end_byte <= 18)

  const change = await readLocator({ store, client }, {
    kind: 'controller_change_content', change_id: 'change-a', side: 'before',
    start_byte: 0, total_bytes: 180,
  }, { startByte: 0, lengthBytes: 16, ownerSessionId: 'session-a' })
  assert.doesNotMatch(change.text, /�/)
  assert.equal(change.total_bytes, Buffer.byteLength('旧内容'.repeat(20)))
})

test('locator reader 拒绝版本漂移和跨 owner 读取', async () => {
  const { store, client } = fixture()
  await assert.rejects(
    readLocator({ store, client }, {
      kind: 'remote_file', host_id: 'host-a', path: '/srv/a.txt', version: 'stale',
    }, { startByte: 0, lengthBytes: 16, ownerSessionId: 'session-a' }),
    (error) => error.code === 'REMOTE_FILE_CONFLICT',
  )
  await assert.rejects(
    readLocator({ store, client }, {
      kind: 'controller_job_log', job_id: 'job-a',
    }, { startByte: 0, lengthBytes: 16, ownerSessionId: 'session-b' }),
    (error) => error.code === 'JOB_FORBIDDEN',
  )
})

test('远程文件客户端未返回 version 时 locator 使用内容哈希校验', async () => {
  const { store } = fixture()
  const content = 'ssh 文件内容'
  const version = createHash('sha256').update(content).digest('hex')
  const page = await readLocator({
    store,
    client: { async readRemoteFile() { return { content } } },
  }, {
    kind: 'remote_file', host_id: 'host-a', path: '/srv/a.txt', version,
  }, { startByte: 0, lengthBytes: 64, ownerSessionId: 'session-a' })
  assert.equal(page.text, content)
})
