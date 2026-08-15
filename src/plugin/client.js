window.__ModuleLoader__.load({
  id: 'dsh-remote-ops',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useMemo, useState } = React
    const PREFIX = '/remote-ops/v1'
    const STYLE_ID = 'dsh-remote-ops-styles'
    const JOB_STATUSES = {
      running: { label: '执行中', tone: 'info' },
      succeeded: { label: '已完成', tone: 'success' },
      failed: { label: '失败', tone: 'error' },
      canceled: { label: '已取消', tone: 'muted' },
      timed_out: { label: '已超时', tone: 'warn' },
      interrupted: { label: '已中断', tone: 'warn' },
    }
    const CSS = `
      .remoteOps { color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 20px; max-width: 760px; padding-bottom: 28px; }
      .remoteOps * { box-sizing: border-box; }
      .remoteOps__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .remoteOps__title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.45; }
      .remoteOps__intro { color: var(--dsw-alias-label-tertiary); margin: 4px 0 0; font-size: 13px; line-height: 1.6; }
      .remoteOps__refresh { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 8px; cursor: pointer; flex: none; height: 32px; padding: 0 12px; font: inherit; font-size: 13px; }
      .remoteOps__refresh:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .remoteOps__refresh:disabled { cursor: default; opacity: .45; }
      .remoteOps__overview { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; display: grid; grid-template-columns: minmax(0, 1.5fr) repeat(2, minmax(88px, .5fr)); overflow: hidden; }
      .remoteOps__metric { min-width: 0; padding: 14px 16px; }
      .remoteOps__metric + .remoteOps__metric { border-left: 1px solid var(--dsw-alias-border-l2); }
      .remoteOps__metricLabel { color: var(--dsw-alias-label-tertiary); display: block; font-size: 11px; line-height: 16px; margin-bottom: 4px; }
      .remoteOps__metricValue { display: block; font-size: 14px; font-weight: 600; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .remoteOps__metricValue--muted { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
      .remoteOps__section { display: flex; flex-direction: column; gap: 10px; }
      .remoteOps__sectionHead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .remoteOps__sectionTitle { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; }
      .remoteOps__sectionMeta { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
      .remoteOps__pairPanel { background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 16px; }
      .remoteOps__modes { background: var(--dsw-alias-bg-module-platform); border-radius: 8px; display: inline-grid; grid-template-columns: 1fr 1fr; padding: 2px; width: 220px; }
      .remoteOps__mode { appearance: none; background: transparent; border: 0; border-radius: 6px; color: var(--dsw-alias-label-tertiary); cursor: pointer; font: inherit; font-size: 12px; height: 28px; }
      .remoteOps__mode[data-active='true'] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px var(--dsw-alias-border-l2); font-weight: 500; }
      .remoteOps__form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .remoteOps__field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .remoteOps__field--wide { grid-column: 1 / -1; }
      .remoteOps__endpoint { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) 88px; }
      .remoteOps__fieldLabel { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; line-height: 18px; }
      .remoteOps__input, .remoteOps__select { width: 100%; height: 36px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 0 11px; font: inherit; font-size: 13px; outline: none; }
      .remoteOps__input::placeholder { color: var(--dsw-alias-label-caption); }
      .remoteOps__input:focus, .remoteOps__select:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); }
      .remoteOps__formFooter { display: flex; align-items: center; justify-content: space-between; gap: 16px; grid-column: 1 / -1; margin-top: 2px; }
      .remoteOps__formHint { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; }
      .remoteOps__primary, .remoteOps__secondary, .remoteOps__danger { appearance: none; border-radius: 8px; cursor: pointer; font: inherit; font-size: 13px; height: 34px; padding: 0 14px; white-space: nowrap; }
      .remoteOps__primary { background: var(--dsw-alias-button-primary-fill); border: 1px solid transparent; color: var(--dsw-alias-label-primary-foreground); font-weight: 500; }
      .remoteOps__primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .remoteOps__secondary { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
      .remoteOps__secondary:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
      .remoteOps__danger { background: transparent; border: 1px solid transparent; color: var(--dsw-alias-state-error-primary); padding: 0 8px; }
      .remoteOps__danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
      .remoteOps button:disabled, .remoteOps select:disabled { cursor: default; opacity: .45; }
      .remoteOps button:focus-visible, .remoteOps select:focus-visible, .remoteOps input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .remoteOps__notice { border-radius: 8px; font-size: 12px; line-height: 18px; margin: -8px 0 0; padding: 9px 12px; }
      .remoteOps__notice--error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); }
      .remoteOps__notice--success { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
      .remoteOps__hostList { display: flex; flex-direction: column; gap: 10px; list-style: none; margin: 0; padding: 0; }
      .remoteOps__host { background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 15px 16px; transition: border-color .16s, background .16s; }
      .remoteOps__host[data-current='true'] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary) 30%, var(--dsw-alias-bg-layer-3)); }
      .remoteOps__hostTop { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .remoteOps__hostIdentity { min-width: 0; }
      .remoteOps__hostNameRow { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
      .remoteOps__hostName { font-size: 14px; font-weight: 600; line-height: 20px; overflow-wrap: anywhere; }
      .remoteOps__badge { align-items: center; border-radius: 999px; display: inline-flex; flex: none; font-size: 11px; font-weight: 500; line-height: 18px; padding: 0 7px; }
      .remoteOps__badge--current, .remoteOps__badge--info { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
      .remoteOps__badge--success { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
      .remoteOps__badge--error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }
      .remoteOps__badge--warn { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
      .remoteOps__badge--muted { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-tertiary); }
      .remoteOps__statusDot { background: currentColor; border-radius: 50%; height: 6px; margin-right: 5px; width: 6px; }
      .remoteOps__address { color: var(--dsw-alias-label-tertiary); display: block; font-size: 12px; line-height: 18px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .remoteOps__hostFacts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 14px 0 0; padding-top: 13px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .remoteOps__fact { min-width: 0; }
      .remoteOps__fact dt { color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 16px; }
      .remoteOps__fact dd { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; margin: 2px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .remoteOps__fact--wide { grid-column: 1 / -1; }
      .remoteOps__hostActions { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: 14px; }
      .remoteOps__buttonGroup { align-items: center; display: flex; gap: 4px; }
      .remoteOps__empty, .remoteOps__loading { border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; color: var(--dsw-alias-label-tertiary); padding: 22px 16px; text-align: center; }
      .remoteOps__emptyTitle { color: var(--dsw-alias-label-secondary); display: block; font-size: 13px; font-weight: 500; line-height: 20px; }
      .remoteOps__emptyText { display: block; font-size: 12px; line-height: 18px; margin-top: 3px; }
      .remoteOps__jobs { border-top: 1px solid var(--dsw-alias-border-l2); list-style: none; margin: 0; padding: 0; }
      .remoteOps__jobToolbar { align-items: center; display: flex; gap: 8px; }
      .remoteOps__jobFilter { height: 30px; width: auto; }
      .remoteOps__job { align-items: center; border-bottom: 1px solid var(--dsw-alias-border-l1); display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto auto; min-height: 48px; padding: 8px 2px; }
      .remoteOps__job--expanded { align-items: start; }
      .remoteOps__jobMain { min-width: 0; }
      .remoteOps__jobDescription { color: var(--dsw-alias-label-secondary); display: block; font-size: 13px; line-height: 19px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .remoteOps__jobTime, .remoteOps__jobExit { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; white-space: nowrap; }
      .remoteOps__jobActions { align-items: center; display: flex; gap: 6px; }
      .remoteOps__jobLogButton { height: 28px; padding: 0 8px; }
      .remoteOps__jobLog { background: var(--dsw-alias-bg-base); border-radius: 6px; color: var(--dsw-alias-label-secondary); font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 6px 0 0; max-height: 180px; overflow: auto; padding: 8px; white-space: pre-wrap; }
      @media (max-width: 680px) {
        .remoteOps__overview { grid-template-columns: 1fr 1fr; }
        .remoteOps__metric:first-child { grid-column: 1 / -1; border-bottom: 1px solid var(--dsw-alias-border-l2); }
        .remoteOps__metric:nth-child(2) { border-left: 0; }
        .remoteOps__form { grid-template-columns: 1fr; }
        .remoteOps__field--wide { grid-column: auto; }
        .remoteOps__formFooter, .remoteOps__hostActions { align-items: stretch; flex-direction: column; }
        .remoteOps__primary { width: 100%; }
        .remoteOps__buttonGroup { justify-content: flex-end; }
        .remoteOps__hostFacts { grid-template-columns: 1fr 1fr; }
        .remoteOps__fact:last-child { grid-column: 1 / -1; }
        .remoteOps__job { grid-template-columns: minmax(0, 1fr) auto; }
        .remoteOps__jobToolbar { align-items: flex-end; flex-direction: column; }
        .remoteOps__jobExit { display: none; }
      }
      @media (prefers-reduced-motion: reduce) { .remoteOps__host { transition: none; } }
    `

    async function parse(response) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(body.error ?? `http ${response.status}`)
        Object.assign(error, body, { code: body.code ?? 'REMOTE_OPS_ERROR' })
        throw error
      }
      return body
    }

    function createApi() {
      return {
        list: () => fetch(`${PREFIX}/hosts`).then(parse),
        ssh: ({ host, port, username, password, displayName, hostFingerprint }) => fetch(`${PREFIX}/hosts/ssh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            host,
            port,
            username,
            password,
            display_name: displayName,
            host_fingerprint: hostFingerprint,
          }),
        }).then(parse),
        pair: ({ address, pairingCode, displayName }) => fetch(`${PREFIX}/hosts/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            address,
            pairing_code: pairingCode,
            display_name: displayName,
          }),
        }).then(parse),
        use: (hostId) => fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/use`, {
          method: 'POST',
        }).then(parse),
        update: (hostId, patch) => fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            display_name: patch.displayName,
          }),
        }).then(parse),
        remove: (hostId) => fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}`, {
          method: 'DELETE',
        }).then(parse),
        reconnect: (hostId, hostFingerprint) => {
          const init = { method: 'POST' }
          if (hostFingerprint) {
            init.headers = { 'content-type': 'application/json' }
            init.body = JSON.stringify({ host_fingerprint: hostFingerprint })
          }
          return fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/reconnect`, init).then(parse)
        },
        diagnose: (hostId) => fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/diagnose`, { method: 'POST' }).then(parse),
        health: (hostId) => fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/health`).then(parse),
        jobs: (hostId, filters = {}) => {
          const query = new URLSearchParams()
          Object.entries(filters).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') query.set(key, value)
          })
          const suffix = query.toString() ? `?${query}` : ''
          return fetch(`${PREFIX}/hosts/${encodeURIComponent(hostId)}/jobs${suffix}`).then(parse)
        },
        cancel: (jobId) => fetch(`${PREFIX}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }).then(parse),
        log: (jobId, tail = 200) => fetch(`${PREFIX}/jobs/${encodeURIComponent(jobId)}/log?tail=${encodeURIComponent(tail)}`).then(parse),
      }
    }

    // Keep plugin styles isolated and removable when the tab unmounts.
    function useStyles() {
      useEffect(() => {
        if (document.getElementById(STYLE_ID)) return undefined
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, [])
    }

    function formatTime(value) {
      if (!value) return '暂无记录'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '时间未知'
      return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    }

    function hostPlatform(host) {
      const system = host.os === 'windows' ? 'Windows' : host.os === 'linux' ? 'Linux' : host.os
      return [host.transport === 'ssh' ? 'SSH' : '代理', system, host.dialect].filter(Boolean).join(' · ') || '未知'
    }

    function StatusBadge({ online }) {
      return h('span', { className: `remoteOps__badge remoteOps__badge--${online ? 'success' : 'muted'}` },
        h('span', { className: 'remoteOps__statusDot', 'aria-hidden': true }),
        online ? '在线' : '离线',
      )
    }

    const HOST_STATUSES = {
      online: { label: '在线', tone: 'success' },
      connecting: { label: '连接中', tone: 'info' },
      offline: { label: '离线', tone: 'muted' },
      auth_failed: { label: '认证失败', tone: 'error' },
      key_missing: { label: '缺少密钥', tone: 'warn' },
      degraded: { label: '降级', tone: 'warn' },
    }

    function HostStatusBadge({ host }) {
      const key = host.status || host.connection_status || (host.online ? 'online' : 'offline')
      const status = HOST_STATUSES[key] || { label: key, tone: 'muted' }
      return h('span', { className: `remoteOps__badge remoteOps__badge--${status.tone}` },
        h('span', { className: 'remoteOps__statusDot', 'aria-hidden': true }), status.label)
    }

    function formatLatency(value) {
      if (value === undefined || value === null || value === '') return '暂无'
      return `${Math.round(Number(value))} ms`
    }

    function formatTaskStats(host) {
      const stats = host.task_stats || host.taskStats || {}
      return ['running', 'succeeded', 'failed', 'timed_out', 'canceled', 'interrupted']
        .map((key) => `${JOB_STATUSES[key]?.label || key} ${stats[key] ?? 0}`).join(' · ')
    }

    function EmptyState({ title, text }) {
      return h('div', { className: 'remoteOps__empty' },
        h('span', { className: 'remoteOps__emptyTitle' }, title),
        h('span', { className: 'remoteOps__emptyText' }, text),
      )
    }

    function RemoteHostsTab() {
      const client = createApi()
      const [connectionMode, setConnectionMode] = useState('ssh')
      const [sshHost, setSshHost] = useState('')
      const [sshPort, setSshPort] = useState('22')
      const [sshUsername, setSshUsername] = useState('')
      const [sshPassword, setSshPassword] = useState('')
      const [address, setAddress] = useState('')
      const [pairingCode, setPairingCode] = useState('')
      const [displayName, setDisplayName] = useState('')
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [hosts, setHosts] = useState([])
      const [jobs, setJobs] = useState([])
      const [jobFilter, setJobFilter] = useState('')
      const [expandedJobs, setExpandedJobs] = useState({})
      const [jobLogs, setJobLogs] = useState({})
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(null)

      useStyles()

      const currentHost = useMemo(() => hosts.find((host) => host.current) ?? null, [hosts])
      const onlineCount = useMemo(() => hosts.filter((host) => host.online).length, [hosts])
      const runningJobs = useMemo(() => jobs.some((job) => job.status === 'running'), [jobs])

      const refresh = async () => {
        const snapshot = await client.list()
        setHosts(snapshot.hosts ?? [])
        setError(null)
        if (snapshot.current_host_id) {
          const listed = await client.jobs(snapshot.current_host_id, { status: jobFilter })
          setJobs(listed.jobs ?? [])
        } else {
          setJobs([])
        }
      }

      useEffect(() => {
        refresh()
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false))
        const timer = setInterval(() => refresh().catch(() => {}), runningJobs ? 1_000 : 5_000)
        return () => clearInterval(timer)
      }, [jobFilter, runningJobs])

      useEffect(() => {
        const openJobs = Object.keys(expandedJobs).filter((id) => expandedJobs[id])
        if (!openJobs.length) return undefined
        let canceled = false
        Promise.all(openJobs.map(async (jobId) => {
          try {
            const result = await client.log(jobId, 200)
            if (!canceled) setJobLogs((current) => ({ ...current, [jobId]: result.log ?? '' }))
          } catch (err) {
            if (!canceled) setJobLogs((current) => ({ ...current, [jobId]: `[日志读取失败] ${err.message}` }))
          }
        }))
        return () => { canceled = true }
      }, [expandedJobs, jobs])

      // Serialize row actions so the screen cannot show conflicting optimistic states.
      const runAction = async (key, action, successMessage) => {
        setBusy(key)
        setError(null)
        setNotice(null)
        try {
          await action()
          await refresh()
          if (successMessage) setNotice(successMessage)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(null)
        }
      }

      const onPair = async (event) => {
        event.preventDefault()
        await runAction('pair', async () => {
          if (connectionMode === 'ssh') {
            const input = {
              host: sshHost,
              port: Number(sshPort),
              username: sshUsername,
              password: sshPassword,
              displayName: displayName || undefined,
            }
            try {
              await client.ssh(input)
            } catch (err) {
              if (err.code !== 'HOST_KEY_UNTRUSTED' || !err.fingerprint) throw err
              const trusted = window.confirm(`首次连接需要确认服务器指纹：\n\nSHA-256（十六进制） ${err.fingerprint}\n\n确认这是你的服务器吗？`)
              if (!trusted) throw new Error('已取消连接，服务器指纹未被信任。')
              await client.ssh({ ...input, hostFingerprint: err.fingerprint })
            }
            setSshPassword('')
          } else {
            await client.pair({ address, pairingCode, displayName: displayName || undefined })
            setPairingCode('')
          }
          setDisplayName('')
        }, connectionMode === 'ssh' ? 'SSH 主机已连接，后续将使用专用密钥自动重连。' : '主机已配对并加入管理列表。')
      }

      const refreshPage = () => runAction('refresh', refresh)
      const toggleJobLog = (jobId) => setExpandedJobs((current) => ({ ...current, [jobId]: !current[jobId] }))
      const cancelJob = (jobId) => runAction(`cancel:${jobId}`, () => client.cancel(jobId), '已请求取消任务。')
      const reconnectHost = (hostId) => runAction(`reconnect:${hostId}`, async () => {
        try {
          await client.reconnect(hostId)
        } catch (err) {
          if (err.code !== 'HOST_KEY_CHANGED' || !err.fingerprint) throw err
          const trusted = window.confirm(`服务器 SSH 指纹已变化：\n\n${err.fingerprint}\n\n确认这是你的服务器吗？`)
          if (!trusted) throw new Error('已取消重连，服务器新指纹未被信任。')
          await client.reconnect(hostId, err.fingerprint)
        }
      }, '正在重连主机。')
      const diagnoseHost = (hostId) => runAction(`diagnose:${hostId}`, async () => {
        const result = await client.diagnose(hostId)
        if (result?.message || result?.summary) setNotice(result.message || result.summary)
      }, '诊断已完成。')
      const canSubmit = connectionMode === 'ssh'
        ? sshHost.trim() && sshUsername.trim() && sshPassword
        : address.trim() && pairingCode.trim()

      return h('section', { className: 'remoteOps' },
        h('header', { className: 'remoteOps__header' },
          h('div', null,
            h('h3', { className: 'remoteOps__title' }, '远程主机'),
            h('p', { className: 'remoteOps__intro' }, '管理已配对设备、连接状态与最近执行记录。'),
          ),
          h('button', {
            className: 'remoteOps__refresh',
            type: 'button',
            disabled: busy !== null,
            onClick: refreshPage,
          }, busy === 'refresh' ? '刷新中…' : '刷新状态'),
        ),
        h('div', { className: 'remoteOps__overview', 'aria-label': '远程主机概览' },
          h('div', { className: 'remoteOps__metric' },
            h('span', { className: 'remoteOps__metricLabel' }, '当前执行目标'),
            h('span', {
              className: `remoteOps__metricValue${currentHost ? '' : ' remoteOps__metricValue--muted'}`,
              title: currentHost?.display_name,
            }, currentHost?.display_name ?? '尚未选择'),
          ),
          h('div', { className: 'remoteOps__metric' },
            h('span', { className: 'remoteOps__metricLabel' }, '已添加'),
            h('span', { className: 'remoteOps__metricValue' }, `${hosts.length} 台`),
          ),
          h('div', { className: 'remoteOps__metric' },
            h('span', { className: 'remoteOps__metricLabel' }, '当前在线'),
            h('span', { className: 'remoteOps__metricValue' }, `${onlineCount} 台`),
          ),
        ),
        error ? h('div', { className: 'remoteOps__notice remoteOps__notice--error', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'remoteOps__notice remoteOps__notice--success', role: 'status' }, notice) : null,
        h('section', { className: 'remoteOps__section' },
          h('div', { className: 'remoteOps__sectionHead' },
            h('h4', { className: 'remoteOps__sectionTitle' }, '添加远程主机'),
            h('div', { className: 'remoteOps__modes', role: 'group', 'aria-label': '连接方式' },
              h('button', { className: 'remoteOps__mode', type: 'button', 'data-active': String(connectionMode === 'ssh'), onClick: () => setConnectionMode('ssh') }, 'SSH 直连'),
              h('button', { className: 'remoteOps__mode', type: 'button', 'data-active': String(connectionMode === 'hostd'), onClick: () => setConnectionMode('hostd') }, '高级配对'),
            ),
          ),
          h('div', { className: 'remoteOps__pairPanel' },
            h('form', { className: 'remoteOps__form', onSubmit: onPair },
              connectionMode === 'ssh'
                ? [
                  h('label', { className: 'remoteOps__field remoteOps__field--wide', key: 'endpoint' },
                    h('span', { className: 'remoteOps__fieldLabel' }, 'SSH 服务器与端口'),
                    h('div', { className: 'remoteOps__endpoint' },
                      h('input', { className: 'remoteOps__input', required: true, placeholder: '服务器 IP 或域名', value: sshHost, onChange: (event) => setSshHost(event.target.value) }),
                      h('input', { className: 'remoteOps__input', type: 'number', min: 1, max: 65535, required: true, 'aria-label': 'SSH 端口', value: sshPort, onChange: (event) => setSshPort(event.target.value) }),
                    ),
                  ),
                  h('label', { className: 'remoteOps__field', key: 'username' },
                    h('span', { className: 'remoteOps__fieldLabel' }, '用户名'),
                    h('input', { className: 'remoteOps__input', required: true, autoComplete: 'username', placeholder: '例如：ubuntu', value: sshUsername, onChange: (event) => setSshUsername(event.target.value) }),
                  ),
                  h('label', { className: 'remoteOps__field', key: 'password' },
                    h('span', { className: 'remoteOps__fieldLabel' }, '登录密码'),
                    h('input', { className: 'remoteOps__input', type: 'password', required: true, autoComplete: 'current-password', placeholder: '仅用于首次连接', value: sshPassword, onChange: (event) => setSshPassword(event.target.value) }),
                  ),
                ]
                : [
                  h('label', { className: 'remoteOps__field remoteOps__field--wide', key: 'address' },
                    h('span', { className: 'remoteOps__fieldLabel' }, '代理地址'),
                    h('input', { className: 'remoteOps__input', type: 'url', required: true, placeholder: 'http://127.0.0.1:7680', value: address, onChange: (event) => setAddress(event.target.value) }),
                  ),
                  h('label', { className: 'remoteOps__field', key: 'code' },
                    h('span', { className: 'remoteOps__fieldLabel' }, '一次性暗号'),
                    h('input', { className: 'remoteOps__input', required: true, autoComplete: 'one-time-code', placeholder: '输入配对暗号', value: pairingCode, onChange: (event) => setPairingCode(event.target.value) }),
                  ),
                ],
              h('label', { className: 'remoteOps__field' },
                h('span', { className: 'remoteOps__fieldLabel' }, '显示名称（可选）'),
                h('input', {
                  className: 'remoteOps__input',
                  placeholder: '例如：工作室主机',
                  value: displayName,
                  onChange: (event) => setDisplayName(event.target.value),
                }),
              ),
              h('div', { className: 'remoteOps__formFooter' },
                h('p', { className: 'remoteOps__formHint' }, connectionMode === 'ssh' ? '密码不会保存；确认指纹后会自动安装 DSH 专用密钥。' : '适用于已部署 remote-hostd 的高级环境。'),
                h('button', {
                  className: 'remoteOps__primary',
                  type: 'submit',
                  disabled: busy !== null || !canSubmit,
                }, busy === 'pair' ? '正在连接…' : connectionMode === 'ssh' ? '连接主机' : '配对主机'),
              ),
            ),
          ),
        ),
        h('section', { className: 'remoteOps__section' },
          h('div', { className: 'remoteOps__sectionHead' },
            h('h4', { className: 'remoteOps__sectionTitle' }, '远程主机'),
            h('span', { className: 'remoteOps__sectionMeta' }, `${onlineCount} / ${hosts.length} 在线`),
          ),
          loading
            ? h('div', { className: 'remoteOps__loading' }, '正在读取主机状态…')
            : hosts.length === 0
              ? h(EmptyState, { title: '还没有远程主机', text: '在上方输入 SSH 登录信息即可直接连接。' })
              : h('ul', { className: 'remoteOps__hostList' }, hosts.map((host) => h('li', {
                className: 'remoteOps__host',
                'data-current': String(host.current),
                key: host.host_id,
              },
              h('div', { className: 'remoteOps__hostTop' },
                h('div', { className: 'remoteOps__hostIdentity' },
                  h('div', { className: 'remoteOps__hostNameRow' },
                    h('span', { className: 'remoteOps__hostName' }, host.display_name || host.host_id),
                    h(HostStatusBadge, { host }),
                    host.current ? h('span', { className: 'remoteOps__badge remoteOps__badge--current' }, '当前目标') : null,
                  ),
                  h('span', { className: 'remoteOps__address', title: host.address }, host.address),
                ),
              ),
              h('dl', { className: 'remoteOps__hostFacts' },
                h('div', { className: 'remoteOps__fact' }, h('dt', null, '运行环境'), h('dd', { title: hostPlatform(host) }, hostPlatform(host))),
                h('div', { className: 'remoteOps__fact' }, h('dt', null, '连接延迟'), h('dd', null, formatLatency(host.latency_ms ?? host.latencyMs ?? host.connection_latency_ms))),
                h('div', { className: 'remoteOps__fact' }, h('dt', null, '连接持续'), h('dd', null, host.connection_duration || host.connectionDuration || '暂无')),
                h('div', { className: 'remoteOps__fact' }, h('dt', null, '最近心跳'), h('dd', null, formatTime(host.last_heartbeat_at ?? host.lastHeartbeatAt))),
                h('div', { className: 'remoteOps__fact' }, h('dt', null, '工作目录'), h('dd', { title: host.cwd }, host.cwd || '未上报')),
                h('div', { className: 'remoteOps__fact remoteOps__fact--wide' }, h('dt', null, '最近错误'), h('dd', { title: host.last_error || host.recent_error }, host.last_error || host.recent_error || '暂无')),
                h('div', { className: 'remoteOps__fact remoteOps__fact--wide' }, h('dt', null, '任务统计'), h('dd', { title: formatTaskStats(host) }, formatTaskStats(host))),
              ),
              h('div', { className: 'remoteOps__hostActions' },
                h('div', { className: 'remoteOps__buttonGroup' },
                  h('button', {
                    className: 'remoteOps__secondary',
                    type: 'button',
                    disabled: busy !== null,
                    onClick: () => reconnectHost(host.host_id),
                  }, busy === `reconnect:${host.host_id}` ? '重连中…' : '重连'),
                  h('button', {
                    className: 'remoteOps__secondary',
                    type: 'button',
                    disabled: busy !== null,
                    onClick: () => diagnoseHost(host.host_id),
                  }, '诊断'),
                  h('button', {
                    className: 'remoteOps__secondary',
                    type: 'button',
                    disabled: busy !== null || host.current,
                    onClick: () => runAction(`use:${host.host_id}`, () => client.use(host.host_id), `已切换到 ${host.display_name || host.host_id}。`),
                  }, host.current ? '正在使用' : '设为当前'),
                  h('button', {
                    className: 'remoteOps__danger',
                    type: 'button',
                    disabled: busy !== null,
                    onClick: () => {
                      if (!window.confirm(`确定不再管理“${host.display_name || host.host_id}”吗？`)) return
                      runAction(`remove:${host.host_id}`, () => client.remove(host.host_id), '主机已移出管理列表。')
                    },
                  }, '移除'),
                ),
              ),
              ))),
        ),
        h('section', { className: 'remoteOps__section' },
          h('div', { className: 'remoteOps__sectionHead' },
            h('h4', { className: 'remoteOps__sectionTitle' }, '最近任务'),
            h('div', { className: 'remoteOps__jobToolbar' },
              h('span', { className: 'remoteOps__sectionMeta' }, currentHost ? currentHost.display_name : '未选择主机'),
              h('select', {
                className: 'remoteOps__select remoteOps__jobFilter',
                value: jobFilter,
                onChange: (event) => setJobFilter(event.target.value),
                'aria-label': '任务状态筛选',
              }, [h('option', { key: 'all', value: '' }, '全部状态'), ...Object.entries(JOB_STATUSES).map(([value, item]) => h('option', { key: value, value }, item.label))]),
            ),
          ),
          !currentHost
            ? h(EmptyState, { title: '没有当前执行目标', text: '选择一台主机后，这里会显示它的最近任务。' })
            : jobs.length === 0
              ? h(EmptyState, { title: '暂无执行记录', text: '该主机收到远程命令后，任务会显示在这里。' })
              : h('ul', { className: 'remoteOps__jobs' }, jobs.map((job) => {
                const status = JOB_STATUSES[job.status] ?? { label: job.status, tone: 'muted' }
                const expanded = expandedJobs[job.job_id] === true
                return h('li', { className: `remoteOps__job${expanded ? ' remoteOps__job--expanded' : ''}`, key: job.job_id },
                  h('div', { className: 'remoteOps__jobMain' },
                    h('span', { className: 'remoteOps__jobDescription', title: job.description || job.command }, job.description || job.command || '未命名任务'),
                    h('span', { className: 'remoteOps__jobTime' }, formatTime(job.started_at)),
                    expanded ? h('pre', { className: 'remoteOps__jobLog' }, jobLogs[job.job_id] ?? '正在读取日志…') : null,
                  ),
                  h('span', { className: 'remoteOps__jobExit' }, job.exit_code === null ? '' : `退出码 ${job.exit_code}`),
                  h('div', { className: 'remoteOps__jobActions' },
                    h('button', { className: 'remoteOps__secondary remoteOps__jobLogButton', type: 'button', onClick: () => toggleJobLog(job.job_id) }, expanded ? '收起日志' : '查看日志'),
                    job.status === 'running' ? h('button', { className: 'remoteOps__danger', type: 'button', disabled: busy !== null, onClick: () => cancelJob(job.job_id) }, busy === `cancel:${job.job_id}` ? '取消中…' : '取消') : null,
                    h('span', { className: `remoteOps__badge remoteOps__badge--${status.tone}` }, status.label),
                  ),
                )
              })),
        ),
      )
    }

    return {
      name: 'remote-ops-client',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'remote-hosts',
          order: 40,
          label: () => '远程主机',
        }, RemoteHostsTab))
      },
    }
  },
})
