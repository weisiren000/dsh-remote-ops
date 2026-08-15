const AUTO_COMMANDS = new Set([
  'ls', 'dir', 'pwd', 'ps', 'cat', 'type', 'head', 'tail',
  'whoami', 'hostname', 'uname', 'df', 'free', 'date', 'echo',
  'printf', 'write-output', 'write-host', 'sleep', 'start-sleep',
  'get-process', 'get-service', 'get-content', 'get-date', 'get-childitem',
  'journalctl',
])

const ASK_COMMANDS = new Set([
  'rm', 'del', 'remove-item', 'reboot', 'shutdown', 'halt', 'poweroff',
  'mkfs', 'format', 'dd', 'chmod', 'chown',
  'apt', 'yum', 'dnf', 'pacman', 'brew', 'choco', 'winget',
  'npm', 'pnpm', 'yarn', 'pip',
])

const SYSTEMCTL_AUTO = new Set(['status', 'is-active'])
const SYSTEMCTL_ASK = new Set(['start', 'stop', 'restart', 'enable', 'disable'])

function tokenize(command) {
  return command.trim().split(/\s+/).filter(Boolean)
}

function looksLikeWriteRedirect(command) {
  return /(^|[^0-9])>/.test(command)
}

function classifySystemctl(tokens) {
  const action = (tokens[1] ?? '').toLowerCase()
  if (SYSTEMCTL_AUTO.has(action)) return 'auto'
  if (SYSTEMCTL_ASK.has(action)) return 'ask'
  return 'ask'
}

export function classifyCommand(command) {
  const trimmed = command.trim()
  if (trimmed.length === 0) return 'ask'
  if (looksLikeWriteRedirect(trimmed)) return 'ask'
  if (/\brm\s+-rf\b/i.test(trimmed) || /Remove-Item\s+-Recurse/i.test(trimmed)) return 'ask'
  const tokens = tokenize(trimmed)
  const head = tokens[0].toLowerCase()
  if (head === 'systemctl') return classifySystemctl(tokens)
  if (AUTO_COMMANDS.has(head)) return 'auto'
  if (ASK_COMMANDS.has(head)) return 'ask'
  return 'ask'
}

export function decideApproval({ command, dialect, override }) {
  if (override === 'auto') return 'auto'
  if (override === 'ask') return 'ask'
  return classifyCommand(command, dialect)
}
