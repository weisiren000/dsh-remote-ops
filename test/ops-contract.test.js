import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostApiHandler } from '../src/host-api.js'

function request(url, method = 'GET') {
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  }
}

function response() {
  return {
    status: 0,
    body: null,
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.body = payload ? JSON.parse(payload) : null
    },
  }
}

test('任务 API 统一返回错误字段并把主机任务筛选参数传给 runner', async () => {
  let filter
  const runner = {
    listJobs(value) {
      filter = value
      return [{
        jobId: 'job-1',
        hostId: 'host-1',
        command: 'false',
        description: 'failed command',
        status: 'failed',
        exitCode: 1,
        startedAt: 100,
        finishedAt: 200,
        errorCode: 'SSH_EXEC_FAILED',
        errorMessage: 'remote command failed',
        canceledAt: undefined,
      }]
    },
    async readJob() {
      return {
        jobId: 'job-1',
        hostId: 'host-1',
        command: 'false',
        description: 'failed command',
        status: 'failed',
        exitCode: 1,
        startedAt: 100,
        finishedAt: 200,
        errorCode: 'SSH_EXEC_FAILED',
        errorMessage: 'remote command failed',
        log: 'full log',
      }
    },
    async readJobLogTail(jobId, tail) {
      assert.equal(jobId, 'job-1')
      assert.equal(tail, 12)
      return {
        jobId: 'job-1',
        hostId: 'host-1',
        status: 'failed',
        log: 'tail log',
      }
    },
  }
  const handle = createHostApiHandler({ runner })

  const jobs = response()
  await handle(request('/remote-ops/v1/hosts/host-1/jobs?status=failed&since=100&until=200'), jobs)
  assert.equal(jobs.status, 200)
  assert.equal(filter.hostId, 'host-1')
  assert.equal(filter.status, 'failed')
  assert.equal(Number(filter.since), 100)
  assert.equal(Number(filter.until), 200)
  assert.equal(filter.limit, 20)
  assert.equal(jobs.body.jobs[0].command, 'false')
  assert.equal(jobs.body.jobs[0].status, 'failed')
  assert.equal(jobs.body.jobs[0].error_code, 'SSH_EXEC_FAILED')
  assert.equal(jobs.body.jobs[0].error_message, 'remote command failed')

  const detail = response()
  await handle(request('/remote-ops/v1/jobs/job-1'), detail)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.error_code, 'SSH_EXEC_FAILED')
  assert.equal(detail.body.error_message, 'remote command failed')
  assert.equal(detail.body.log, 'full log')

  const tail = response()
  await handle(request('/remote-ops/v1/jobs/job-1/log?tail=12'), tail)
  assert.equal(tail.status, 200)
  assert.equal(tail.body.log, 'tail log')
})

test('指纹变更错误通过可识别错误码和指纹返回', async () => {
  const error = Object.assign(new Error('host key changed'), {
    code: 'HOST_KEY_CHANGED',
    fingerprint: 'SHA256:new-fingerprint',
  })
  const handle = createHostApiHandler({
    runner: {
      async reconnectHost() {
        throw error
      },
    },
  })
  const res = response()
  await handle(request('/remote-ops/v1/hosts/host-1/reconnect', 'POST'), res)
  assert.equal(res.status, 409)
  assert.equal(res.body.code, 'HOST_KEY_CHANGED')
  assert.equal(res.body.fingerprint, 'SHA256:new-fingerprint')
})
