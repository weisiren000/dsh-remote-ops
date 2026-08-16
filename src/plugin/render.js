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
  const statusTitle = {
    canceled: '远程命令已取消',
    timed_out: '远程命令已超时',
    interrupted: '远程命令已中断',
  }[result.meta?.status]
  if (statusTitle) {
    return {
      card: 'generic',
      title: statusTitle,
      content: [{ type: 'text', text: `\`\`\`console\n${block.text.replace(/\n+$/, '')}\n\`\`\`` }],
    }
  }
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

export function projectHostExecution(_args, value) {
  return {
    kind: 'remote-command',
    job_id: value.job_id,
    status: value.status ?? 'running',
  }
}

export function presentFileWriteCall(args) {
  return {
    card: 'diff',
    title: `写入 ${args.path}`,
    diffs: [{ path: args.path, oldText: null, newText: String(args.content ?? '') }],
    locations: [{ path: args.path }],
  }
}

export function presentChangeReviewCall(args) {
  if (!args.change_id) {
    return { card: 'generic', title: '查看远程变更', kind: 'read' }
  }
  return {
    card: 'generic',
    title: `${args.action ?? 'review'} ${args.change_id}`,
    kind: args.action === 'revert' ? 'delete' : 'edit',
    rawInput: { change_id: args.change_id, action: args.action },
  }
}

export function projectChangePresentation(args, value) {
  if (!value?.change_id) {
    return { kind: 'remote-change-list', host_id: value?.host_id ?? args.host, count: value?.changes?.length ?? 0 }
  }
  return {
    kind: 'remote-change',
    path: value.path ?? args.path,
    before_text: value.before_content ?? null,
    after_text: value.after_content ?? String(args.content ?? ''),
    status: value.status,
    action: args.action ?? 'write',
  }
}

export function presentChangeResult(_args, result) {
  if (result.isError || result.meta?.kind !== 'remote-change') return undefined
  const meta = result.meta
  const reverted = meta.action === 'revert'
  const oldText = reverted ? meta.after_text : meta.before_text
  const newText = reverted ? meta.before_text : meta.after_text
  return {
    card: 'diff',
    title: `${meta.status === 'reverted' ? '已撤销' : '已写入'} ${meta.path}`,
    diffs: [{ path: meta.path, oldText, newText }],
  }
}
