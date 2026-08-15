function appendSection(body, extra) {
  if (!extra) return body
  if (body.length === 0) return extra
  return `${body.endsWith('\n') ? body : `${body}\n`}${extra}`
}

export function renderExecResult(result) {
  let body = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (stderr.length > 0) {
    body = appendSection(body, `[stderr]\n${stderr}`)
  }
  if (body.length === 0) body = '(no output)'
  if (result.timedOut || result.status === 'timed_out') {
    return appendSection(body, `[timed out after ${result.timeoutMs ?? result.timeout_ms ?? 0}ms]`)
  }
  if (result.aborted || result.status === 'canceled') {
    return appendSection(body, '[canceled]')
  }
  if (result.status === 'interrupted') {
    return appendSection(body, '[interrupted]')
  }
  if (result.exitCode !== 0 && result.exitCode !== null && result.exitCode !== undefined) {
    return appendSection(body, `[exit code: ${result.exitCode}]`)
  }
  return body
}

export function presentHostCall(args) {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
  }
}

export function presentHostResult(args, result) {
  const block = result.content?.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  if (args?.run_in_background === true || result.isError) {
    return {
      card: 'generic',
      content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }],
    }
  }
  return {
    card: 'terminal',
    output: block.text,
  }
}
