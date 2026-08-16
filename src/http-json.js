export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024

function requestError(code, message, status) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function assertBodyLimit(maxBytes, code) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw requestError(code, 'JSON body 上限配置无效', 500)
  }
}

function declaredLength(req) {
  const value = req.headers?.['content-length']
  if (value === undefined) return undefined
  const length = Number(Array.isArray(value) ? value[0] : value)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw requestError('REQUEST_BODY_INVALID', 'Content-Length 无效', 400)
  }
  return length
}

// 在分配完整 Buffer 前执行硬限制，避免分块传输绕过 Content-Length 检查。
export async function readJsonBody(req, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
  assertBodyLimit(maxBytes, 'REQUEST_BODY_LIMIT_INVALID')
  if ((declaredLength(req) ?? 0) > maxBytes) {
    throw requestError('REQUEST_BODY_TOO_LARGE', `JSON 请求体超过 ${maxBytes} 字节限制`, 413)
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      throw requestError('REQUEST_BODY_TOO_LARGE', `JSON 请求体超过 ${maxBytes} 字节限制`, 413)
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch (error) {
    throw requestError('REQUEST_BODY_INVALID', error?.message ?? 'JSON 请求体无效', 400)
  }
}

function responseDeclaredLength(response) {
  const value = response.headers?.get?.('content-length')
  if (value === null || value === undefined) return undefined
  const length = Number(value)
  if (!Number.isSafeInteger(length) || length < 0) {
    throw requestError('RESPONSE_BODY_INVALID', '远端 Content-Length 无效', 502)
  }
  return length
}

// fetch 的 response.text() 会无界缓冲；这里同时限制声明长度和真实流量。
export async function readJsonResponse(response, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
  assertBodyLimit(maxBytes, 'RESPONSE_BODY_LIMIT_INVALID')
  if ((responseDeclaredLength(response) ?? 0) > maxBytes) {
    await response.body?.cancel?.().catch(() => {})
    throw requestError('RESPONSE_BODY_TOO_LARGE', `远端 JSON 响应超过 ${maxBytes} 字节限制`, 502)
  }
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw requestError('RESPONSE_BODY_TOO_LARGE', `远端 JSON 响应超过 ${maxBytes} 字节限制`, 502)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch (error) {
    throw requestError('RESPONSE_BODY_INVALID', error?.message ?? '远端 JSON 响应无效', 502)
  }
}
