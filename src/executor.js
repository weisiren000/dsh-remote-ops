import { spawn } from 'node:child_process'
import { createBoundedOutput, DEFAULT_MAX_PROCESS_OUTPUT_BYTES } from './output-limits.js'

export function resolveDialect(platform = process.platform) {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

function commandArgs(command, dialect) {
  if (dialect === 'pwsh') {
    return {
      file: 'pwsh',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    }
  }
  return {
    file: 'bash',
    args: ['-lc', command],
  }
}

function killProcessTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

export function runCommand(spec) {
  const dialect = spec.dialect ?? resolveDialect()
  const { file, args } = commandArgs(spec.command, dialect)
  return new Promise((resolve, reject) => {
    let timedOut = false
    let aborted = false
    let settled = false
    const stdout = createBoundedOutput(spec.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES)
    const stderr = createBoundedOutput(spec.maxOutputBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES)
    const child = spawn(file, args, {
      cwd: spec.workdir,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    const finish = (exitCode, signalName) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      const stdoutResult = stdout.snapshot()
      const stderrResult = stderr.snapshot()
      resolve({
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutBytes: stdoutResult.bytes,
        stderrBytes: stderrResult.bytes,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        exitCode,
        signal: signalName,
        timedOut,
        aborted,
      })
    }

    const onAbort = () => {
      if (settled || timedOut) return
      aborted = true
      killProcessTree(child)
    }

    let timer
    if (spec.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        if (settled || aborted) return
        timedOut = true
        killProcessTree(child)
      }, spec.timeoutMs)
    }

    child.stdout.on('data', (chunk) => {
      stdout.add(chunk)
      spec.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.add(chunk)
      spec.onStderr?.(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code, signalName) => {
      finish(code, signalName)
    })

    if (spec.signal) {
      if (spec.signal.aborted) onAbort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
