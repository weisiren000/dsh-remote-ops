import { createElement as h, useEffect, useState } from 'react'
import { createSettingsClient } from './client-api.js'

const OVERRIDES = [
  { value: 'follow', label: '跟随默认' },
  { value: 'auto', label: '这台全自动' },
  { value: 'ask', label: '这台全要问' },
]

export function RemoteHostsTab({ api = createSettingsClient() }) {
  const [address, setAddress] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(null)
  const [hosts, setHosts] = useState([])
  const [currentHostId, setCurrentHostId] = useState(null)
  const [jobs, setJobs] = useState([])
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const snapshot = await api.list()
    setHosts(snapshot.hosts ?? [])
    setCurrentHostId(snapshot.current_host_id ?? null)
    setError(null)
    const selected = snapshot.current_host_id
    if (selected) {
      const listed = await api.jobs(selected)
      setJobs(listed.jobs ?? [])
    } else {
      setJobs([])
    }
  }

  useEffect(() => {
    refresh().catch((err) => {
      setError(err.message)
    })
  }, [])

  const onPair = async (event) => {
    event.preventDefault()
    setBusy(true)
    try {
      await api.pair({ address, pairingCode, displayName: displayName || undefined })
      setPairingCode('')
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const onUse = async (hostId) => {
    try {
      await api.use(hostId)
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  const onOverride = async (hostId, approvalOverride) => {
    try {
      await api.update(hostId, { approvalOverride })
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  const onRemove = async (hostId) => {
    try {
      await api.remove(hostId)
      await refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  return h('section', { className: 'remote-ops-tab' },
    h('h3', null, '远程主机'),
    error ? h('p', { className: 'remote-ops-error' }, error) : null,
    h('form', { onSubmit: onPair, className: 'remote-ops-pair' },
      h('input', {
        placeholder: '地址，例如 http://127.0.0.1:7680',
        value: address,
        onChange: (event) => setAddress(event.target.value),
      }),
      h('input', {
        placeholder: '暗号',
        value: pairingCode,
        onChange: (event) => setPairingCode(event.target.value),
      }),
      h('input', {
        placeholder: '显示名（可选）',
        value: displayName,
        onChange: (event) => setDisplayName(event.target.value),
      }),
      h('button', { type: 'submit', disabled: busy || !address || !pairingCode }, '配对'),
    ),
    h('ul', { className: 'remote-ops-hosts' },
      hosts.map((host) => h('li', { key: host.host_id },
        h('strong', null, host.display_name),
        h('span', null, host.online ? '在线' : '离线'),
        h('span', null, host.dialect),
        host.current ? h('span', null, '当前目标') : null,
        h('button', { type: 'button', onClick: () => onUse(host.host_id) }, '设为当前'),
        h('select', {
          value: host.approval_override,
          onChange: (event) => onOverride(host.host_id, event.target.value),
        }, OVERRIDES.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
        h('button', { type: 'button', onClick: () => onRemove(host.host_id) }, '不再管理'),
      )),
    ),
    h('h4', null, '最近任务'),
    h('ul', { className: 'remote-ops-jobs' },
      jobs.map((job) => h('li', { key: job.job_id },
        `${job.description} · ${job.status}`,
      )),
    ),
  )
}
