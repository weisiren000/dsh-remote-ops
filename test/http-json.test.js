import test from 'node:test'
import assert from 'node:assert/strict'
import { readJsonResponse } from '../src/http-json.js'

test('JSON 响应按分块累计执行硬上限', async () => {
  const response = new Response(JSON.stringify({ output: 'x'.repeat(2048) }), {
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(
    readJsonResponse(response, 1024),
    (error) => error.code === 'RESPONSE_BODY_TOO_LARGE' && error.status === 502,
  )
})

test('JSON 响应在 Content-Length 超限时不读取 body', async () => {
  let pulled = false
  const body = new ReadableStream({
    pull(controller) {
      pulled = true
      controller.enqueue(new TextEncoder().encode('{}'))
      controller.close()
    },
  })
  const response = new Response(body, { headers: { 'content-length': '4096' } })
  await assert.rejects(
    readJsonResponse(response, 1024),
    (error) => error.code === 'RESPONSE_BODY_TOO_LARGE',
  )
  assert.equal(pulled, false)
})
