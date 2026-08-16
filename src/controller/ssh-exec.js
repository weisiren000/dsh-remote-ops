import { randomUUID } from 'node:crypto'
import { createBoundedOutput, DEFAULT_MAX_PROCESS_OUTPUT_BYTES } from '../output-limits.js'

export function execChannel(connection, command, options = {}) {
  return new Promise((resolve, reject) => {
    let stream
    let timer
    let settled = false
    let timedOut = false
    let aborted = false
    const stdout = createBoundedOutput(options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES)
    const stderr = createBoundedOutput(options.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES)
    let pendingWrites = 0
    let channelClosed = false
    let writeError
    let terminationRequested = false
    const writeWaiters = []
    const pauseOutput = () => {
      stream.pause?.()
      stream.stderr.pause?.()
    }
    const resumeOutput = () => {
      stream.resume?.()
      stream.stderr.resume?.()
    }
    // 终止失败不能掩盖触发终止的原始错误，两个动作需要分别尽力执行。
    const requestTermination = (signal) => {
      if (!stream || terminationRequested || channelClosed) return
      terminationRequested = true
      try { stream.signal(signal) } catch {}
      try { stream.close() } catch {}
    }
    const settleWrite = () => {
      pendingWrites -= 1
      if (pendingWrites !== 0) return
      if (!channelClosed && !writeError) resumeOutput()
      for (const waiter of writeWaiters.splice(0)) waiter.resolve()
    }
    const failWrite = (error) => {
      writeError ??= error
      requestTermination('TERM')
      settleWrite()
    }
    const trackWrite = (pending) => {
      if (!pending?.then) return
      if (pendingWrites === 0) pauseOutput()
      pendingWrites += 1
      Promise.resolve(pending).then(settleWrite, failWrite)
    }
    const waitForWrites = () => pendingWrites === 0
      ? Promise.resolve()
      : new Promise((waitResolve, waitReject) => {
        writeWaiters.push({ resolve: waitResolve, reject: waitReject })
      })
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finishError = (error) => {
      if (settled) return
      if (writeError && !channelClosed) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      aborted = true
      requestTermination('TERM')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    connection.exec(command, (error, channel) => {
      if (error) {
        finishError(error)
        return
      }
      stream = channel
      const remoteJobId = options.remoteJobId ?? randomUUID()
      options.onRemoteJobId?.(remoteJobId)
      options.onChannel?.(channel, remoteJobId)
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true
          requestTermination('KILL')
        }, options.timeoutMs)
      }
      stream.on('data', (chunk) => {
        stdout.add(chunk)
        trackWrite(options.onStdout?.(chunk))
      })
      stream.stderr.on('data', (chunk) => {
        stderr.add(chunk)
        trackWrite(options.onStderr?.(chunk))
      })
      stream.once('error', finishError)
      stream.once('close', async (exitCode, signal) => {
        channelClosed = true
        await waitForWrites()
        if (settled) return
        settled = true
        cleanup()
        if (writeError) {
          reject(writeError)
          return
        }
        const stdoutResult = stdout.snapshot()
        const stderrResult = stderr.snapshot()
        resolve({
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          stdoutBytes: stdoutResult.bytes,
          stderrBytes: stderrResult.bytes,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
          exitCode: exitCode ?? (timedOut || aborted ? null : 1),
          signal,
          timedOut,
          aborted,
          remoteJobId,
          streamed: true,
        })
      })
      if (options.signal?.aborted) onAbort()
    })
  })
}
