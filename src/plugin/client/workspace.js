function directoryEntry(entry) {
  return entry?.type === 'directory'
}

function hostLabel(host) {
  const status = host?.status || (host?.online ? 'online' : 'offline')
  const latency = host?.latency_ms == null ? '' : ` · ${Math.round(Number(host.latency_ms))} ms`
  return `${status}${latency}`
}

export function createRemoteWorkspaceAction(React, api, icons = {}) {
  const { createElement: h, Fragment, useEffect, useMemo, useRef, useState } = React
  const {
    Button,
    Input,
    IconChevronDownOutline14,
    IconChevronRightOutline14,
    IconCheckOutline16,
    IconCloseOutline16,
    IconCodeOutline16,
    IconFolderClose16,
    IconFolderOpen16,
    IconRefreshOutline16,
    IconSearchOutline16,
  } = icons
  const icon = (Component, props = {}) => Component ? h(Component, { size: 14, ...props }) : null
  const button = (props, label) => h(Button || 'button', {
    size: 'sm',
    variant: 'toolbar',
    type: 'button',
    ...props,
  }, label)

  return function RemoteWorkspaceAction() {
    const [open, setOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [hosts, setHosts] = useState([])
    const [hostId, setHostId] = useState('')
    const [rootPath, setRootPath] = useState('.')
    const [directories, setDirectories] = useState({})
    const [expanded, setExpanded] = useState({})
    const [loadingPaths, setLoadingPaths] = useState({})
    const [file, setFile] = useState(null)
    const [content, setContent] = useState('')
    const [savedContent, setSavedContent] = useState('')
    const [view, setView] = useState('files')
    const [command, setCommand] = useState('')
    const [history, setHistory] = useState([])
    const [historyIndex, setHistoryIndex] = useState(-1)
    const [output, setOutput] = useState('')
    const [running, setRunning] = useState(false)
    const [changes, setChanges] = useState([])
    const [expandedChanges, setExpandedChanges] = useState({})
    const [treeFilter, setTreeFilter] = useState('')
    const [error, setError] = useState(null)
    const [workspaceLeft, setWorkspaceLeft] = useState(50)
    const [explorerWidth, setExplorerWidth] = useState(320)
    const dragRef = useRef(null)
    const workspaceRef = useRef(null)
    const outputRef = useRef(null)
    const selectedHost = useMemo(() => hosts.find((host) => host.host_id === hostId), [hosts, hostId])
    const dirty = Boolean(file && content !== savedContent)

    const loadHosts = async () => {
      const result = await api.list()
      setHosts(result.hosts ?? [])
    }
    const loadDirectory = async (path, force = false) => {
      if (!hostId || (!force && directories[path])) return
      setLoadingPaths((current) => ({ ...current, [path]: true }))
      try {
        const result = await api.listFiles(hostId, path)
        setDirectories((current) => ({ ...current, [result.path ?? path]: result.entries ?? [] }))
      } finally {
        setLoadingPaths((current) => ({ ...current, [path]: false }))
      }
    }
    const loadChanges = async () => {
      if (!hostId) return
      const result = await api.changes(hostId, { status: 'pending' })
      setChanges(result.changes ?? [])
    }
    const selectHost = (nextHostId) => {
      const host = hosts.find((item) => item.host_id === nextHostId)
      const cwd = host?.cwd || '.'
      setHostId(nextHostId)
      setRootPath(cwd)
      setDirectories({})
      setExpanded({ [cwd]: true })
      setFile(null)
      setContent('')
      setSavedContent('')
      setOutput('')
      setTreeFilter('')
      setView('files')
      setOpen(true)
      setMenuOpen(false)
      setError(null)
    }
    const openEntry = async (entry) => {
      if (directoryEntry(entry)) {
        const next = !expanded[entry.path]
        setExpanded((current) => ({ ...current, [entry.path]: next }))
        if (next) loadDirectory(entry.path).catch((err) => setError(err.message))
        return
      }
      try {
        const result = await api.readFile(hostId, entry.path)
        setFile(result)
        setContent(result.content ?? '')
        setSavedContent(result.content ?? '')
        setView('files')
        setError(null)
      } catch (err) {
        setError(err.message)
      }
    }
    const save = async () => {
      if (!file || !dirty) return
      try {
        const result = await api.writeFile(hostId, {
          path: file.path,
          content,
          expectedVersion: file.version,
          source: 'manual',
          description: '远程工作台保存',
        })
        setFile((current) => ({ ...current, version: result.after_version }))
        setSavedContent(content)
        await loadChanges()
        setError(null)
      } catch (err) {
        setError(err.message)
      }
    }
    const run = async () => {
      const issued = command.trim()
      if (!issued || running) return
      setCommand('')
      setHistory((current) => [issued, ...current.filter((item) => item !== issued)].slice(0, 50))
      setHistoryIndex(-1)
      setOutput((current) => `${current}${current ? '\n\n' : ''}$ ${issued}\n执行中…`)
      setRunning(true)
      try {
        const result = await api.terminal(hostId, { command: issued, workdir: rootPath, description: '远程工作台终端' })
        setOutput((current) => current.replace(/执行中…$/, result.log ?? result.stdout ?? result.error ?? '(no output)'))
        setError(null)
      } catch (err) {
        setOutput((current) => current.replace(/执行中…$/, err.message || '命令执行失败'))
        setError(err.message)
      } finally {
        setRunning(false)
      }
    }
    const review = async (changeId, action) => {
      try {
        await api.reviewChange(changeId, action)
        await loadChanges()
      } catch (err) {
        setError(err.message)
      }
    }
    const close = () => {
      if (dirty && !window.confirm('当前文件有未保存修改，确定关闭工作台吗？')) return
      setOpen(false)
      setMenuOpen(false)
    }
    useEffect(() => {
      if (menuOpen) loadHosts().catch((err) => setError(err.message))
    }, [menuOpen])
    useEffect(() => {
      if (!open || !hostId) return
      loadDirectory(rootPath).catch((err) => setError(err.message))
      loadChanges().catch((err) => setError(err.message))
    }, [open, hostId, rootPath])
    useEffect(() => {
      if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
    }, [output, running])

    useEffect(() => {
      const workspace = workspaceRef.current
      if (!open || !workspace) return undefined
      let center = null
      let frame = null
      let current = workspace
      while (current && !center) {
        const parent = current.parentElement
        frame = parent?.closest?.('[class*="_frame"]') ?? frame
        center = parent?.querySelector?.('[class*="_centerCol"]') ?? null
        current = parent
      }
      frame = frame ?? workspace.closest('[class*="_frame"]')
      if (!center || !frame) return undefined
      const syncCenterWidth = () => {
        const workspaceRect = workspace.getBoundingClientRect()
        // 以宿主整栏右边界计算，避免聊天列收窄后再次把预留宽度算成 0。
        const frameRect = frame.getBoundingClientRect()
        const reserved = Math.max(0, frameRect.right - workspaceRect.left)
        center.style.marginRight = `${Math.round(reserved)}px`
      }
      syncCenterWidth()
      const observer = new ResizeObserver(syncCenterWidth)
      observer.observe(workspace)
      window.addEventListener('resize', syncCenterWidth)
      return () => {
        observer.disconnect()
        window.removeEventListener('resize', syncCenterWidth)
        center.style.removeProperty('margin-right')
      }
    }, [open, workspaceLeft])

    // 统一处理工作台外边界和资源管理器内边界，拖动时只更新对应尺寸。
    const beginResize = (kind, event) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dragRef.current = kind
    }
    const resize = (event) => {
      if (!dragRef.current) return
      if (dragRef.current === 'workspace') {
        const next = (event.clientX / Math.max(window.innerWidth, 1)) * 100
        setWorkspaceLeft(Math.min(68, Math.max(30, next)))
      } else {
        const next = window.innerWidth - event.clientX
        setExplorerWidth(Math.min(520, Math.max(220, next)))
      }
    }
    const endResize = (event) => {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      dragRef.current = null
    }

    const renderTree = (path, depth = 0) => (directories[path] ?? []).filter((entry) => {
      if (!treeFilter.trim()) return true
      return entry.name.toLocaleLowerCase().includes(treeFilter.trim().toLocaleLowerCase())
    }).map((entry) => {
      const folder = directoryEntry(entry)
      const isOpen = Boolean(expanded[entry.path])
      return h(Fragment, { key: entry.path },
        h('button', { className: 'remoteWorkspace__treeEntry', type: 'button', style: { paddingLeft: `${6 + depth * 16}px` }, 'data-active': String(file?.path === entry.path), title: entry.path, onClick: () => openEntry(entry) },
          h('span', { className: 'remoteWorkspace__treeChevron' }, icon(folder ? (isOpen ? IconChevronDownOutline14 : IconChevronRightOutline14) : null)),
          icon(folder ? (isOpen ? IconFolderOpen16 : IconFolderClose16) : IconCodeOutline16),
          h('span', { className: 'remoteWorkspace__treeName' }, entry.name),
        ),
        folder && isOpen ? renderTree(entry.path, depth + 1) : null,
      )
    })
    const renderChanges = changes.length ? changes.map((change) => {
      const expandedChange = Boolean(expandedChanges[change.change_id])
      return h('div', { className: 'remoteWorkspace__change', key: change.change_id },
        h('div', { className: 'remoteWorkspace__changeMain' },
          h('button', { className: 'remoteWorkspace__changePath', type: 'button', onClick: () => setExpandedChanges((current) => ({ ...current, [change.change_id]: !expandedChange })) }, change.path),
          h('span', { className: 'remoteWorkspace__changeMeta' }, `${change.source || '插件'} · ${change.status}`),
          expandedChange ? h('div', { className: 'remoteWorkspace__changePreview' },
            h('div', null, h('span', { className: 'remoteWorkspace__changeMeta' }, '修改前'), h('pre', null, change.before_content ?? '(文件不存在)')),
            h('div', null, h('span', { className: 'remoteWorkspace__changeMeta' }, '修改后'), h('pre', null, change.after_content ?? '')),
          ) : null,
        ),
        h('div', { className: 'remoteWorkspace__changeActions' },
          h('button', { className: 'remoteWorkspace__button', type: 'button', onClick: () => review(change.change_id, 'accept') }, '接受'),
          h('button', { className: 'remoteWorkspace__button', type: 'button', onClick: () => review(change.change_id, 'revert') }, '撤销'),
        ),
      )
    }) : h('div', { className: 'remoteWorkspace__empty' }, '暂无待审阅变更')

    return h('span', { className: 'remoteWorkspace__launcher' },
      button({ className: 'remoteWorkspace__launcherButton', title: '选择服务器并打开远程开发工作台', 'aria-label': '选择服务器并打开远程开发工作台', 'aria-expanded': menuOpen, onClick: () => setMenuOpen((current) => !current) }, '服务器'),
      menuOpen ? h('div', { className: 'remoteWorkspace__serverMenu', role: 'menu' }, hosts.length ? hosts.map((host) => h('button', { className: 'remoteWorkspace__serverOption', key: host.host_id, type: 'button', onClick: () => selectHost(host.host_id) }, h('span', null, host.display_name || host.host_id), h('span', { className: 'remoteWorkspace__serverStatus' }, hostLabel(host)))) : h('div', { className: 'remoteWorkspace__treeMessage' }, '正在加载服务器…')) : null,
      open ? h('section', {
        className: 'remoteWorkspace',
        role: 'dialog',
        'aria-label': '远程开发工作台',
        style: { '--ro-workspace-left': `${workspaceLeft}%`, '--ro-explorer-width': `${explorerWidth}px` },
        onPointerMove: resize,
        ref: workspaceRef,
      },
        h('div', { className: 'remoteWorkspace__workspaceSplitter', role: 'separator', 'aria-label': '调整工作台宽度', onPointerDown: (event) => beginResize('workspace', event), onPointerUp: endResize }),
        h('header', { className: 'remoteWorkspace__head' }, h('div', { className: 'remoteWorkspace__identity' }, h('span', { className: 'remoteWorkspace__statusDot' }), h('span', { className: 'remoteWorkspace__title' }, selectedHost?.display_name || hostId), h('span', { className: 'remoteWorkspace__address' }, selectedHost?.address || hostId)), button({ className: 'remoteWorkspace__headButton', icon: icon(IconCloseOutline16), onClick: close, 'aria-label': '关闭工作台', title: '关闭工作台' }, '关闭')),
        error ? h('div', { className: 'remoteWorkspace__error', role: 'alert' }, error) : null,
        h('div', { className: 'remoteWorkspace__workspace' },
          h('main', { className: 'remoteWorkspace__main' },
            h('nav', { className: 'remoteWorkspace__tabs' },
              h('button', { className: 'remoteWorkspace__tab', type: 'button', 'data-active': String(view === 'files'), onClick: () => setView('files') }, icon(IconCodeOutline16), file?.path || '文件'),
              h('button', { className: 'remoteWorkspace__tab', type: 'button', 'data-active': String(view === 'terminal'), onClick: () => setView('terminal') }, '终端'),
              h('button', { className: 'remoteWorkspace__tab', type: 'button', 'data-active': String(view === 'changes'), onClick: () => setView('changes') }, `变更${changes.length ? ` (${changes.length})` : ''}`),
            ),
            h('div', { className: 'remoteWorkspace__view' },
              view === 'terminal' ? h('section', { className: 'remoteWorkspace__terminal' },
                h('pre', { className: 'remoteWorkspace__output', ref: outputRef }, output || `$ 已连接至 ${selectedHost?.display_name || hostId}\n$ 工作目录: ${rootPath}`),
                h('div', { className: 'remoteWorkspace__terminalbar' },
                  h('span', { className: 'remoteWorkspace__terminalPrompt' }, '$'),
                  h('input', {
                    className: 'remoteWorkspace__input',
                    value: command,
                    disabled: running,
                    autoFocus: true,
                    'aria-label': '输入远程命令',
                    onChange: (event) => setCommand(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') { event.preventDefault(); run() }
                      if (event.key === 'ArrowUp' && history.length) { const next = Math.min(historyIndex + 1, history.length - 1); setHistoryIndex(next); setCommand(history[next]) }
                      if (event.key === 'ArrowDown' && historyIndex >= 0) { const next = historyIndex - 1; setHistoryIndex(next); setCommand(next < 0 ? '' : history[next]) }
                    },
                  }),
                ),
              ) : view === 'changes' ? h('section', { className: 'remoteWorkspace__changes' }, renderChanges) : file ? h('section', { className: 'remoteWorkspace__editor' }, h('div', { className: 'remoteWorkspace__editorbar' }, h('span', { className: 'remoteWorkspace__editorPath' }, file.path), button({ className: 'remoteWorkspace__saveButton', icon: icon(IconCheckOutline16), disabled: !dirty, onClick: save }, '保存')), h('div', { className: 'remoteWorkspace__editorGrid' }, h('pre', { className: 'remoteWorkspace__lineNumbers', 'aria-hidden': true }, content.split('\n').map((_, index) => `${index + 1}\n`).join('')), h('textarea', { value: content, spellCheck: false, 'aria-label': `编辑 ${file.path}`, onChange: (event) => setContent(event.target.value) })), h('footer', { className: 'remoteWorkspace__editorFooter' }, h('span', null, `${content.split('\n').length} 行`), dirty ? h('span', { className: 'remoteWorkspace__dirty' }, '未保存') : h('span', null, '已保存'))) : h('div', { className: 'remoteWorkspace__empty' }, '未打开文件'),
            ),
          ),
          h('div', { className: 'remoteWorkspace__explorerSplitter', role: 'separator', 'aria-label': '调整资源管理器宽度', onPointerDown: (event) => beginResize('explorer', event), onPointerUp: endResize }),
          h('aside', { className: 'remoteWorkspace__explorer' },
            h('div', { className: 'remoteWorkspace__explorerHead' }, h('span', { className: 'remoteWorkspace__label' }, '资源管理器'), button({ className: 'remoteWorkspace__iconButton', icon: icon(IconRefreshOutline16), onClick: () => loadDirectory(rootPath, true).catch((err) => setError(err.message)), 'aria-label': '刷新目录', title: '刷新目录' })),
            h('div', { className: 'remoteWorkspace__search' }, h(Input || 'input', { className: 'remoteWorkspace__searchInput', icon: icon(IconSearchOutline16), value: treeFilter, type: 'search', placeholder: '筛选文件…', 'aria-label': '筛选文件', onChange: (event) => setTreeFilter(event.target.value) })),
            h('div', { className: 'remoteWorkspace__tree' }, h('button', { className: 'remoteWorkspace__treeEntry', type: 'button', onClick: () => setExpanded((current) => ({ ...current, [rootPath]: !current[rootPath] })) }, icon(expanded[rootPath] ? IconChevronDownOutline14 : IconChevronRightOutline14), icon(expanded[rootPath] ? IconFolderOpen16 : IconFolderClose16), h('span', { className: 'remoteWorkspace__treeName' }, rootPath)), expanded[rootPath] ? renderTree(rootPath) : null, loadingPaths[rootPath] ? h('div', { className: 'remoteWorkspace__treeMessage' }, '读取中…') : null),
          ),
        ),
      ) : null,
    )
  }
}
