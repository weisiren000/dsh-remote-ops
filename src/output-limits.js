import { StringDecoder } from 'node:string_decoder'

export const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_MAX_INLINE_OUTPUT_BYTES = 64 * 1024

function assertLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    const error = new Error('输出字节上限必须是正安全整数')
    error.code = 'OUTPUT_LIMIT_INVALID'
    throw error
  }
}

function decodeCompleteUtf8(buffer) {
  const decoder = new StringDecoder('utf8')
  return decoder.write(buffer)
}

// 按字节保留完整 UTF-8 字符，避免截断多字节字符时产生替换符。
export function truncateUtf8Text(value, maxBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES) {
  assertLimit(maxBytes)
  const buffer = Buffer.from(String(value ?? ''), 'utf8')
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), bytes: buffer.length, truncated: false }
  }
  return {
    text: decodeCompleteUtf8(buffer.subarray(0, maxBytes)),
    bytes: buffer.length,
    truncated: true,
  }
}

export function sliceUtf8Buffer(buffer, startByte, maxBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES) {
  assertLimit(maxBytes)
  if (!Number.isSafeInteger(startByte) || startByte < 0) {
    const error = new Error('输出起始字节必须是非负安全整数')
    error.code = 'OUTPUT_OFFSET_INVALID'
    throw error
  }
  let start = Math.min(startByte, buffer.length)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  let end = Math.min(buffer.length, start + maxBytes)
  while (end > start && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1
  return {
    text: buffer.subarray(start, end).toString('utf8'),
    startByte: start,
    endByte: end,
    totalBytes: buffer.length,
    truncated: start > 0 || end < buffer.length,
  }
}

export function sliceUtf8Text(value, startByte, maxBytes = DEFAULT_MAX_INLINE_OUTPUT_BYTES) {
  return sliceUtf8Buffer(Buffer.from(String(value ?? ''), 'utf8'), startByte, maxBytes)
}

// 保留输出开头并持续统计原始字节数，内存占用永远不超过 maxBytes。
export function createBoundedOutput(maxBytes = DEFAULT_MAX_PROCESS_OUTPUT_BYTES) {
  assertLimit(maxBytes)
  const chunks = []
  let keptBytes = 0
  let totalBytes = 0
  return {
    add(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.length
      const remaining = maxBytes - keptBytes
      if (remaining <= 0) return
      const kept = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining)
      chunks.push(kept)
      keptBytes += kept.length
    },
    snapshot() {
      const buffer = Buffer.concat(chunks, keptBytes)
      return {
        text: totalBytes > keptBytes ? decodeCompleteUtf8(buffer) : buffer.toString('utf8'),
        bytes: totalBytes,
        truncated: totalBytes > keptBytes,
      }
    },
  }
}
