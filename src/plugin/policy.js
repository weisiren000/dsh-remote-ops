const REMOTE_TOOLS = new Set([
  'host_pair',
  'host_list',
  'host_use',
  'host_bash',
  'host_jobs',
  'host_job_log',
  'host_list_files',
  'host_read_file',
  'host_write_file',
  'host_review_changes',
])

const APPROVAL_REASONS = {
  host_pair: '远程主机配对需要用户确认',
  host_list: '读取远程主机列表需要用户确认',
  host_use: '切换远程目标需要用户确认',
  host_bash: '远程命令执行需要用户确认',
  host_jobs: '读取远程任务需要用户确认',
  host_job_log: '读取远程任务日志需要用户确认',
  host_list_files: '浏览远程目录需要用户确认',
  host_read_file: '读取远程文件需要用户确认',
  host_write_file: '远程文件写入需要用户确认',
  host_review_changes: '远程变更操作需要用户确认',
}

// pre-execute 负责交互审批；guard 负责不可被后续 listener 撤销的身份拒绝。
export function registerRemoteToolPolicy({ tools, onPreExecute }) {
  tools.guard?.((exec) => {
    if (!REMOTE_TOOLS.has(exec.name) || exec.agent) return undefined
    return 'Remote host tools require an Agent execution context'
  })
  onPreExecute?.(async (exec, next) => {
    const downstream = await next()
    if (downstream.kind !== 'allow' || !REMOTE_TOOLS.has(exec.name)) return downstream
    return { kind: 'ask', reason: APPROVAL_REASONS[exec.name] }
  })
}
