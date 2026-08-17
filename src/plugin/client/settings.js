const STATUS_TEXT = {
  online: '在线', connecting: '连接中', offline: '离线', auth_failed: '认证失败', reauth_required: '需要重新认证', key_missing: '缺少密钥', degraded: '降级',
}
const JOB_TEXT = {
  running: '执行中', succeeded: '成功', failed: '失败', canceled: '已取消', timed_out: '超时', interrupted: '已中断',
}
const JOB_ORDER = Object.keys(JOB_TEXT)

function formatTime(value) {
  if (!value) return '暂无'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}

function hostStatus(host) {
  return host.status || host.connection_status || (host.online ? 'online' : 'offline')
}

function hostPlatform(host) {
  return [host.os || host.platform, host.dialect || host.shell].filter(Boolean).join(' · ') || '未上报'
}

function taskStats(host) {
  const stats = host.task_stats || host.taskStats || {}
  return JOB_ORDER.map((key) => `${JOB_TEXT[key]} ${Number(stats[key] || 0)}`).join(' · ')
}

function diagnosisText(result) {
  if (result?.summary || result?.message) return result.summary || result.message
  if (Array.isArray(result?.checks)) return result.checks.map((item) => `${item.name || item.label}: ${item.status || item.result}`).join('；')
  return '诊断已完成'
}

export function createRemoteHostsTab(React, api, ui = {}) {
  const { createElement: h, useEffect, useMemo, useState } = React
  const { Button, Input, IconRefreshOutline16 } = ui
  const icon = (Component) => Component ? h(Component, { size: 14 }) : null
  const button = (props, label) => h(Button || 'button', { size: 'sm', variant: 'outline', type: 'button', ...props }, label)
  const input = (props) => h(Input || 'input', props)

  return function RemoteHostsTab() {
    const [mode, setMode] = useState('ssh')
    const [hosts, setHosts] = useState([])
    const [jobs, setJobs] = useState([])
    const [filter, setFilter] = useState('')
    const [expanded, setExpanded] = useState({})
    const [logs, setLogs] = useState({})
    const [busy, setBusy] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [notice, setNotice] = useState(null)
    const [reauthPasswords, setReauthPasswords] = useState({})
    const [ssh, setSsh] = useState({ host: '', port: '22', username: '', password: '', displayName: '' })
    const [pair, setPair] = useState({ address: '', pairingCode: '', displayName: '' })
    const currentHost = useMemo(() => hosts.find((host) => host.current) ?? null, [hosts])
    const runningJobs = useMemo(() => jobs.some((job) => job.status === 'running'), [jobs])
    const onlineCount = useMemo(() => hosts.filter((host) => hostStatus(host) === 'online').length, [hosts])

    const refresh = async () => {
      const snapshot = await api.list()
      setHosts(snapshot.hosts ?? [])
      const hostId = snapshot.current_host_id || snapshot.hosts?.find((host) => host.current)?.host_id
      if (hostId) {
        const result = await api.jobs(hostId, filter ? { status: filter } : {})
        setJobs(result.jobs ?? [])
      } else setJobs([])
      setError(null)
    }

    useEffect(() => {
      refresh().catch((err) => setError(err.message)).finally(() => setLoading(false))
      const timer = setInterval(() => refresh().catch(() => {}), runningJobs ? 1_000 : 5_000)
      return () => clearInterval(timer)
    }, [filter, runningJobs])

    useEffect(() => {
      const openJobs = jobs.filter((job) => expanded[job.job_id])
      if (!openJobs.length) return undefined
      let disposed = false
      const load = async () => Promise.all(openJobs.map(async (job) => {
        try {
          const result = await api.log(job.job_id, 200)
          if (!disposed) setLogs((current) => ({ ...current, [job.job_id]: result.log ?? '' }))
        } catch (err) {
          if (!disposed) setLogs((current) => ({ ...current, [job.job_id]: `[日志读取失败] ${err.message}` }))
        }
      }))
      load()
      const timer = openJobs.some((job) => job.status === 'running') ? setInterval(load, 1_000) : null
      return () => { disposed = true; if (timer) clearInterval(timer) }
    }, [expanded, jobs])

    // 串行化管理操作，避免界面同时展示互相冲突的恢复状态。
    const action = async (key, callback, successMessage) => {
      setBusy(key)
      setError(null)
      setNotice(null)
      try {
        const result = await callback()
        await refresh()
        setNotice(typeof successMessage === 'function'
          ? successMessage(result)
          : successMessage || diagnosisText(result))
      } catch (err) {
        setError(err.message)
      } finally {
        setBusy(null)
      }
    }

    // 首次连接只在用户确认服务器指纹后重试，密码始终留在当前表单状态中。
    const connectSsh = async (event) => {
      event.preventDefault()
      await action('connect', async () => {
        const payload = { ...ssh, port: Number(ssh.port) }
        let connected
        try {
          connected = await api.ssh(payload)
        } catch (err) {
          if (err.code !== 'HOST_KEY_UNTRUSTED' || !err.fingerprint) throw err
          if (!window.confirm(`首次连接需要确认服务器指纹：\n\n${err.fingerprint}\n\n确认这是你的服务器吗？`)) throw new Error('已取消连接，服务器指纹未被信任。')
          connected = await api.ssh({ ...payload, hostFingerprint: err.fingerprint })
        }
        setSsh((current) => ({ ...current, password: '', displayName: '' }))
        return connected
      }, (host) => host.auth_mode === 'password_session'
        ? 'SSH 主机已连接；网关断线后需要重新输入密码。'
        : 'SSH 主机已连接，后续使用专用密钥。')
    }

    const pairHost = async (event) => {
      event.preventDefault()
      await action('connect', async () => {
        await api.pair(pair)
        setPair({ address: '', pairingCode: '', displayName: '' })
      }, '高级配对已完成。')
    }

    // 指纹变化只走这一处确认，避免普通重连和密码重认证产生不同保护语义。
    const reconnectAfterFingerprintCheck = async (hostId, options, canceledMessage) => {
      try {
        return await api.reconnect(hostId, options)
      } catch (err) {
        if (err.code !== 'HOST_KEY_CHANGED' || !err.fingerprint) throw err
        if (!window.confirm(`服务器 SSH 指纹已变化：\n\n${err.fingerprint}\n\n确认这是你的服务器吗？`)) {
          throw new Error(canceledMessage)
        }
        return api.reconnect(hostId, { ...options, hostFingerprint: err.fingerprint })
      }
    }

    const reconnect = (host) => action(`reconnect:${host.host_id}`, async () => {
      try {
        return await reconnectAfterFingerprintCheck(
          host.host_id,
          {},
          '已取消重连，服务器新指纹未被信任。',
        )
      } catch (err) {
        if (err.code === 'SSH_REAUTH_REQUIRED') {
          setReauthPasswords((current) => ({ ...current, [host.host_id]: '' }))
        }
        throw err
      }
    }, '重连请求已发送。')

    const reauthenticate = (host, event) => {
      event.preventDefault()
      const password = reauthPasswords[host.host_id] ?? ''
      return action(`reauth:${host.host_id}`, async () => {
        try {
          return await reconnectAfterFingerprintCheck(
            host.host_id,
            { password },
            '已取消重认证，服务器新指纹未被信任。',
          )
        } finally {
          setReauthPasswords((current) => {
            const next = { ...current }
            delete next[host.host_id]
            return next
          })
        }
      }, 'SSH 会话已恢复。')
    }

    const toggleJob = (jobId) => setExpanded((current) => ({ ...current, [jobId]: !current[jobId] }))
    const canConnect = mode === 'ssh'
      ? ssh.host.trim() && ssh.username.trim() && ssh.password && Number(ssh.port) > 0
      : pair.address.trim() && pair.pairingCode.trim()

    return h('section', { className: 'remoteSshOps' },
      h('header', { className: 'remoteSshOps__settingsHead' },
        h('div', null, h('h2', null, '远程主机'), h('p', null, `${onlineCount} / ${hosts.length} 在线`)),
        button({ className: 'remoteSshOps__iconButton', icon: icon(IconRefreshOutline16), disabled: busy !== null, onClick: () => action('refresh', refresh), title: '刷新状态' }, busy === 'refresh' ? '刷新中…' : '刷新'),
      ),
      h('div', { className: 'remoteSshOps__overview' },
        h('div', null, h('span', null, '当前目标'), h('strong', null, currentHost?.display_name || currentHost?.host_id || '未选择')),
        h('div', null, h('span', null, '已管理'), h('strong', null, `${hosts.length} 台`)),
        h('div', null, h('span', null, '运行任务'), h('strong', null, String(jobs.filter((job) => job.status === 'running').length))),
      ),
      error ? h('div', { className: 'remoteSshOps__notice remoteSshOps__notice--error', role: 'alert' }, error) : null,
      notice ? h('div', { className: 'remoteSshOps__notice remoteSshOps__notice--success', role: 'status' }, notice) : null,
      h('section', { className: 'remoteSshOps__settingsSection' },
        h('div', { className: 'remoteSshOps__sectionTitle' }, h('span', null, '添加主机'), h('div', { className: 'remoteSshOps__modeSwitch' }, button({ 'data-active': String(mode === 'ssh'), onClick: () => setMode('ssh') }, 'SSH 直连'), button({ 'data-active': String(mode === 'pair'), onClick: () => setMode('pair') }, '高级配对'))),
        mode === 'ssh' ? h('form', { className: 'remoteSshOps__connectForm', onSubmit: connectSsh },
          h('label', { className: 'remoteSshOps__field remoteSshOps__wideInput' }, h('span', null, '服务器'), h('div', { className: 'remoteSshOps__endpoint' }, input({ placeholder: 'IP 或域名', value: ssh.host, required: true, onChange: (event) => setSsh({ ...ssh, host: event.target.value }) }), input({ className: 'remoteSshOps__port', type: 'number', min: 1, max: 65535, value: ssh.port, required: true, 'aria-label': 'SSH 端口', onChange: (event) => setSsh({ ...ssh, port: event.target.value }) }))),
          h('label', { className: 'remoteSshOps__field' }, h('span', null, '用户名'), input({ value: ssh.username, required: true, autoComplete: 'username', onChange: (event) => setSsh({ ...ssh, username: event.target.value }) })),
          h('label', { className: 'remoteSshOps__field' }, h('span', null, '首次登录密码'), input({ type: 'password', value: ssh.password, required: true, autoComplete: 'current-password', onChange: (event) => setSsh({ ...ssh, password: event.target.value }) })),
          h('label', { className: 'remoteSshOps__field remoteSshOps__wideInput' }, h('span', null, '显示名称'), input({ placeholder: '可选', value: ssh.displayName, onChange: (event) => setSsh({ ...ssh, displayName: event.target.value }) })),
          h('div', { className: 'remoteSshOps__formFooter remoteSshOps__wideInput' }, h('span', null, '密码仅用于首次连接'), h(Button || 'button', { className: 'remoteSshOps__primary', variant: 'primary', size: 'sm', type: 'submit', disabled: busy !== null || !canConnect }, busy === 'connect' ? '连接中…' : '连接主机')),
        ) : h('form', { className: 'remoteSshOps__connectForm', onSubmit: pairHost },
          h('label', { className: 'remoteSshOps__field remoteSshOps__wideInput' }, h('span', null, 'remote-hostd 地址'), input({ value: pair.address, required: true, onChange: (event) => setPair({ ...pair, address: event.target.value }) })),
          h('label', { className: 'remoteSshOps__field' }, h('span', null, '配对码'), input({ value: pair.pairingCode, required: true, autoComplete: 'one-time-code', onChange: (event) => setPair({ ...pair, pairingCode: event.target.value }) })),
          h('label', { className: 'remoteSshOps__field' }, h('span', null, '显示名称'), input({ placeholder: '可选', value: pair.displayName, onChange: (event) => setPair({ ...pair, displayName: event.target.value }) })),
          h('div', { className: 'remoteSshOps__formFooter remoteSshOps__wideInput' }, h('span', null, '适用于已部署 remote-hostd 的主机'), h(Button || 'button', { className: 'remoteSshOps__primary', variant: 'primary', size: 'sm', type: 'submit', disabled: busy !== null || !canConnect }, busy === 'connect' ? '配对中…' : '完成配对')),
        ),
      ),
      h('section', { className: 'remoteSshOps__settingsSection' },
        h('div', { className: 'remoteSshOps__sectionTitle' }, '已管理主机'),
        loading ? h('div', { className: 'remoteSshOps__empty' }, '正在读取状态…') : hosts.length ? hosts.map((host) => {
          const status = hostStatus(host)
          return h('article', { className: 'remoteSshOps__hostCard', 'data-current': String(host.current), key: host.host_id },
            h('div', { className: 'remoteSshOps__hostCardHead' }, h('div', null, h('strong', null, host.display_name || host.host_id), h('span', null, host.address)), h('span', { className: `remoteSshOps__status remoteSshOps__status--${status}` }, STATUS_TEXT[status] || status)),
            h('dl', { className: 'remoteSshOps__facts' },
              h('div', null, h('dt', null, '系统 / Shell'), h('dd', { title: hostPlatform(host) }, hostPlatform(host))),
              h('div', null, h('dt', null, '工作目录'), h('dd', { title: host.cwd }, host.cwd || '未上报')),
              h('div', null, h('dt', null, '连接延迟'), h('dd', null, host.latency_ms == null ? '暂无' : `${Math.round(host.latency_ms)} ms`)),
              h('div', null, h('dt', null, '连接持续'), h('dd', null, host.connection_duration || host.connectionDuration || '暂无')),
              h('div', null, h('dt', null, '最近心跳'), h('dd', null, formatTime(host.last_heartbeat_at || host.lastHeartbeatAt))),
              h('div', { className: 'remoteSshOps__factWide' }, h('dt', null, '任务统计'), h('dd', { title: taskStats(host) }, taskStats(host))),
            ),
            host.last_error || host.recent_error ? h('p', { className: 'remoteSshOps__hostError' }, host.last_error || host.recent_error) : null,
            (status === 'reauth_required' || Object.hasOwn(reauthPasswords, host.host_id))
              ? h('form', { className: 'remoteSshOps__reauthForm', onSubmit: (event) => reauthenticate(host, event) },
                h('label', { className: 'remoteSshOps__field' }, h('span', null, '重新输入 SSH 登录密码'), input({ type: 'password', value: reauthPasswords[host.host_id] ?? '', required: true, autoComplete: 'current-password', onChange: (event) => setReauthPasswords((current) => ({ ...current, [host.host_id]: event.target.value })) })),
                button({ type: 'submit', disabled: busy !== null || !(reauthPasswords[host.host_id] ?? '') }, busy === `reauth:${host.host_id}` ? '认证中…' : '重新认证'),
                button({ type: 'button', disabled: busy !== null, onClick: () => setReauthPasswords((current) => { const next = { ...current }; delete next[host.host_id]; return next }) }, '取消'),
              ) : null,
            h('div', { className: 'remoteSshOps__hostActions' },
              button({ disabled: busy !== null, onClick: () => reconnect(host) }, busy === `reconnect:${host.host_id}` ? '重连中…' : '重连'),
              button({ disabled: busy !== null, onClick: () => action(`diagnose:${host.host_id}`, () => api.diagnose(host.host_id)) }, '诊断'),
              button({ disabled: busy !== null || host.current, onClick: () => action(`use:${host.host_id}`, () => api.use(host.host_id), `已切换到 ${host.display_name || host.host_id}。`) }, host.current ? '正在使用' : '设为当前'),
              button({ className: 'remoteSshOps__danger', disabled: busy !== null, onClick: () => { if (window.confirm(`确定不再管理“${host.display_name || host.host_id}”吗？`)) action(`remove:${host.host_id}`, () => api.remove(host.host_id), '主机已移除。') } }, '移除'),
            ),
          )
        }) : h('div', { className: 'remoteSshOps__empty' }, '暂无主机'),
      ),
      h('section', { className: 'remoteSshOps__settingsSection' },
        h('div', { className: 'remoteSshOps__sectionTitle' }, h('span', null, '最近任务'), h('select', { value: filter, onChange: (event) => setFilter(event.target.value), 'aria-label': '任务状态筛选' }, h('option', { value: '' }, '全部状态'), ...Object.entries(JOB_TEXT).map(([key, label]) => h('option', { key, value: key }, label)))),
        currentHost && jobs.length ? h('ul', { className: 'remoteSshOps__jobList' }, jobs.map((job) => h('li', { className: 'remoteSshOps__job', key: job.job_id },
          h('button', { className: 'remoteSshOps__jobRow', type: 'button', onClick: () => toggleJob(job.job_id) }, h('span', null, h('strong', null, job.description || job.command || '未命名任务'), h('small', null, job.command)), h('span', { className: `remoteSshOps__jobStatus remoteSshOps__jobStatus--${job.status}` }, JOB_TEXT[job.status] || job.status)),
          expanded[job.job_id] ? h('div', { className: 'remoteSshOps__jobDetail' }, h('dl', null, h('div', null, h('dt', null, '开始'), h('dd', null, formatTime(job.started_at))), h('div', null, h('dt', null, '结束'), h('dd', null, formatTime(job.finished_at))), h('div', null, h('dt', null, '退出码'), h('dd', null, job.exit_code == null ? '暂无' : String(job.exit_code)))), job.error ? h('p', { className: 'remoteSshOps__hostError' }, typeof job.error === 'string' ? job.error : job.error.message || JSON.stringify(job.error)) : null, h('pre', { className: 'remoteSshOps__jobLog' }, logs[job.job_id] ?? '读取日志中…')) : null,
          job.status === 'running' ? button({ className: 'remoteSshOps__cancel', disabled: busy !== null, onClick: () => action(`cancel:${job.job_id}`, () => api.cancel(job.job_id), '任务取消请求已发送。') }, busy === `cancel:${job.job_id}` ? '取消中…' : '取消任务') : null,
        ))) : h('div', { className: 'remoteSshOps__empty' }, currentHost ? '暂无任务' : '未选择当前主机'),
      ),
    )
  }
}
