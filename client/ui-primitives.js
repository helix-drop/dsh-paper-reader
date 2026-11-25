function icon(name, size = 18) {
  const paths = {
    book: 'M5 4.5h6.2c1.7 0 2.8.5 3.8 1.6v13.4c-1-1.1-2.1-1.6-3.8-1.6H5V4.5Zm10 1.6c1-1.1 2.1-1.6 3.8-1.6H21v13.4h-2.2c-1.7 0-2.8.5-3.8 1.6V6.1Z',
    back: 'm14.5 5.5-6.5 6.5 6.5 6.5M8 12h12',
    close: 'M5 5l14 14M19 5 5 19',
    upload: 'M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
    search: 'M10.8 18.2a7.4 7.4 0 1 0 0-14.8 7.4 7.4 0 0 0 0 14.8Zm5.4-2 4.5 4.5',
    refresh: 'M19 9a7 7 0 1 0 .2 5M19 4v5h-5',
    menu: 'M4 6h16M4 12h16M4 18h16',
    file: 'M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6M9 16h6',
    arrow: 'M5 12h14m-5-5 5 5-5 5',
    top: 'M12 20V5m0 0-5 5m5-5 5 5',
    folder: 'M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z',
    trash: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Zm11 3.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
    eyeOff: 'm2 2 20 20M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61',
    external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm-1 1.5L18.5 9H13V3.5Z',
    triangleRight: 'M6 6l8 4-8 4V6z',
    triangleDown: 'M5 8l5 5 5-5z',
    play: 'M4.5 3.5a1 1 0 011.5-.866l11 6.5a1 1 0 010 1.732l-11 6.5A1 1 0 014.5 16.5v-13z',
    grip: 'M4 8h16M4 16h16',
    check: 'M5 13l4 4L19 7',
    info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
    copy: 'M9 9h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm-4 6H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    download: 'M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    note: 'M4 4h16v12H8l-4 4V4Z',
    quote: 'M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3a1 1 0 0 1 1 1v5a5 5 0 0 1-3 4.6M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3a1 1 0 0 1 1 1v5a5 5 0 0 1-3 4.6',
  }
  const isFilled = name.startsWith('triangle') || name === 'play'
  const is20 = isFilled
  return h('svg', {
    viewBox: is20 ? '0 0 20 20' : '0 0 24 24',
    width: size,
    height: size,
    fill: isFilled ? 'currentColor' : 'none',
    stroke: isFilled ? 'none' : 'currentColor',
    strokeWidth: isFilled ? 0 : 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true
  }, h('path', { d: paths[name] ?? paths.file }))
}
function button(label, onClick, cls = '', extra = {}) {
  return h('button', { type: 'button', className: `rr-button ${cls}`.trim(), onClick, ...extra }, label)
}
function PdfModal({ url, title, taskId, onClose }) {
  const [opening, setOpening] = useState(false)
  const [openErr, setOpenErr] = useState('')
  const openInSystem = async () => {
    if (!taskId) return
    setOpening(true); setOpenErr('')
    try {
      const res = await fetch(`/api/paper-reader/pipeline/tasks/${taskId}/open-source`, { method: 'POST' })
      const v = await res.json()
      if (!res.ok) throw new Error(v.error ?? '无法在系统应用打开')
    } catch (e) {
      setOpenErr(e.message)
    } finally {
      setOpening(false)
    }
  }
  return h('div', { className: 'rr-pdfModalOverlay', onClick: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { className: 'rr-pdfModalContent' },
      h('div', { className: 'rr-pdfModalHeader' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' } },
          icon('pdf', 18),
          h('h3', null, title || '原 PDF 预览')
        ),
        h('div', { className: 'rr-rowActions' },
          taskId ? button(h(React.Fragment, null, icon('external', 14), opening ? '正在打开...' : '在系统应用中打开'), openInSystem, 'rr-buttonQuiet', { disabled: opening }) : null,
          button(h(React.Fragment, null, icon('close', 14), '关闭'), onClose, 'rr-buttonPrimary')
        )
      ),
      openErr ? h('div', { style: { padding: '6px 16px', background: '#ffebee', color: '#c62828', fontSize: 12 } }, openErr) : null,
      h('div', { className: 'rr-pdfModalBody' },
        h('iframe', { src: url, title: title || 'PDF Preview' })
      )
    )
  )
}
function CreateFolderModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 60)
  }, [])

  const handleConfirm = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入文件夹名称')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const r = await fetch('/api/paper-reader/pipeline/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      })
      const f = await r.json()
      if (!r.ok) throw new Error(f.error || '创建文件夹失败')
      onCreated(f)
      onClose()
    } catch (e) {
      setError(e.message)
      setSubmitting(false)
    }
  }

  return h('div', { className: 'rr-pdfModalOverlay', onClick: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { style: { background: '#fff', borderRadius: 12, padding: '20px 24px', minWidth: 320, maxWidth: 400, boxShadow: '0 16px 40px rgba(0,0,0,0.2)' } },
      h('h3', { style: { margin: '0 0 12px', fontSize: 16, fontWeight: 600 } }, '新建文件夹'),
      h('input', {
        ref: inputRef,
        type: 'text',
        placeholder: '输入文件夹名称',
        value: name,
        style: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 14, borderRadius: 8, border: '1px solid #d4d4d8', outline: 'none', marginBottom: error ? 8 : 16 },
        onChange: e => { setName(e.target.value); setError('') },
        onKeyDown: e => {
          if (e.key === 'Enter') handleConfirm()
          if (e.key === 'Escape') onClose()
        }
      }),
      error ? h('div', { style: { color: '#ef4444', fontSize: 12, marginBottom: 12 } }, error) : null,
      h('div', { className: 'rr-rowActions', style: { justifyContent: 'flex-end', gap: 8 } },
        button('取消', onClose, 'rr-buttonQuiet'),
        button(submitting ? '创建中...' : '确定', handleConfirm, 'rr-buttonPrimary', { disabled: submitting || !name.trim() })
      )
    )
  )
}
function RenameDocModal({ targetId, currentName, onClose, onRenamed }) {
  const [name, setName] = useState(currentName || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 60)
  }, [])

  const handleConfirm = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('请输入文献名称')
      return
    }
    if (trimmed.length > 150) {
      setError('文献名称须为1至150字')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const r = await fetch('/api/paper-reader/pipeline/tasks/' + encodeURIComponent(targetId) + '/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed })
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '改名失败')
      onRenamed(trimmed)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return h('div', { className: 'rr-pdfModalOverlay', onClick: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { style: { background: '#fff', borderRadius: 12, padding: '20px 24px', minWidth: 320, maxWidth: 460, boxShadow: '0 16px 40px rgba(0,0,0,0.2)' } },
      h('h3', { style: { margin: '0 0 12px', fontSize: 16, fontWeight: 600 } }, '修改文献名称'),
      h('input', {
        ref: inputRef,
        type: 'text',
        placeholder: '输入文献名称',
        value: name,
        maxLength: 150,
        style: { width: '100%', boxSizing: 'border-box', padding: '9px 12px', fontSize: 14, borderRadius: 8, border: '1px solid #d4d4d8', outline: 'none', marginBottom: error ? 8 : 16 },
        onChange: e => { setName(e.target.value); setError('') },
        onKeyDown: e => {
          if (e.key === 'Enter') handleConfirm()
          if (e.key === 'Escape') onClose()
        }
      }),
      error ? h('div', { style: { color: '#ef4444', fontSize: 12, marginBottom: 12 } }, error) : null,
      h('div', { className: 'rr-rowActions', style: { justifyContent: 'flex-end', gap: 8 } },
        button('取消', onClose, 'rr-buttonQuiet', { disabled: submitting }),
        button(submitting ? '保存中...' : '保存', handleConfirm, 'rr-buttonPrimary', { disabled: submitting || !name.trim() })
      )
    )
  )
}
function FolderAssignModal({ targetId, targetName, currentFolderId, folders, onSave, onClose, onCreateFolder }) {
  const [showCreate, setShowCreate] = useState(false)
  const assigned = useMemo(() => (currentFolderId ? String(currentFolderId).split(',').map(s=>s.trim()).filter(Boolean) : []), [currentFolderId])
  const toggle = id => {
    if (!id) { onSave(null); return }
    const next = assigned.includes(id) ? assigned.filter(x => x !== id) : [...assigned, id]
    onSave(next.join(',') || null)
  }
  return h('div', { className: 'rr-pdfModalOverlay', onClick: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { style: { background: '#fff', borderRadius: 12, padding: 20, minWidth: 320, maxWidth: 420, boxShadow: '0 16px 40px rgba(0,0,0,0.2)' } },
      h('h3', { style: { margin: '0 0 6px', fontSize: 16 } }, '文献归类（可多选）'),
      h('p', { className: 'rr-pipelineNote', style: { margin: '0 0 14px' } }, targetName),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflow: 'auto', marginBottom: 16 } },
        h('button', {
          type: 'button',
          className: `rr-button ${assigned.length === 0 ? 'rr-buttonPrimary' : 'rr-buttonQuiet'}`,
          style: { justifyContent: 'flex-start' },
          onClick: () => toggle(null)
        }, '未归类（无文件夹）'),
        folders.map(f => {
          const active = assigned.includes(f.id)
          return h('button', {
            key: f.id,
            type: 'button',
            className: `rr-button ${active ? 'rr-buttonPrimary' : 'rr-buttonQuiet'}`,
            style: { justifyContent: 'space-between' },
            onClick: () => toggle(f.id)
          }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, icon(active ? 'triangleDown' : 'triangleRight', 12), f.name), active ? h('span', { style: { fontSize: 11, opacity: 0.8 } }, '✓ 已选') : null)
        }),
        onCreateFolder ? h('button', {
          type: 'button',
          className: 'rr-button rr-buttonQuiet',
          style: { justifyContent: 'center', marginTop: 4, border: '1px dashed #d4d4d8' },
          onClick: () => setShowCreate(true)
        }, '+ 新建文件夹') : null
      ),
      h('div', { className: 'rr-rowActions', style: { justifyContent: 'flex-end' } },
        button('完成', onClose, 'rr-buttonPrimary')
      ),
      showCreate ? h(CreateFolderModal, {
        onClose: () => setShowCreate(false),
        onCreated: f => {
          onCreateFolder(f)
          toggle(f.id)
        }
      }) : null
    )
  )
}
function CloudSyncModal({ onClose, onSynced }) {
  const [status, setStatus] = useState(null)
  const [authStatus, setAuthStatus] = useState(null)
  const [cloudUrl, setCloudUrl] = useState('')
  const [vaultName, setVaultName] = useState('')
  const [token, setToken] = useState('')
  const [deviceName, setDeviceName] = useState('PC DSH 主机')
  const [includePdf, setIncludePdf] = useState(true)
  const [autoSync, setAutoSync] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resultMsg, setResultMsg] = useState('')
  const [pairCode, setPairCode] = useState(null)
  const [pairCountdown, setPairCountdown] = useState(0)
  const [showRootPanel, setShowRootPanel] = useState(false)
  const [recoveryKeyText, setRecoveryKeyText] = useState('')
  const [storageAudit, setStorageAudit] = useState(null)
  const lastSyncRef = useRef(null)

  const applyStatus = useCallback(v => {
    setStatus(v)
    if (v?.lastSyncAt && lastSyncRef.current && v.lastSyncAt !== lastSyncRef.current) {
      onSynced?.()
    }
    if (v?.lastSyncAt) lastSyncRef.current = v.lastSyncAt
    if (v?.background?.running) {
      setError('')
    } else if (v?.lastError) {
      setError(v.lastError)
    } else {
      setError('')
    }
  }, [onSynced])

  const loadRemoteAuth = useCallback(async () => {
    try {
      const r = await fetch('/api/paper-reader/pipeline/sync/auth/status')
      const v = await r.json()
      if (r.ok) {
        setAuthStatus(v)
        if (v.vaultName) setVaultName(prev => prev || v.vaultName)
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetch('/api/paper-reader/pipeline/sync/status')
      .then(r => r.json())
      .then(v => {
        applyStatus(v)
        setCloudUrl(v.cloudUrl || '')
        setVaultName(v.vaultName || '')
        setDeviceName(v.deviceName || 'PC DSH 主机')
        setIncludePdf(v.includePdf !== undefined ? Boolean(v.includePdf) : true)
        setAutoSync(v.autoSync !== undefined ? Boolean(v.autoSync) : true)
        if (v.configured) void loadRemoteAuth()
      })
      .catch(e => setError(e.message || '读取同步配置失败'))
  }, [loadRemoteAuth])

  useEffect(() => {
    if (!pairCode?.expiresAt) { setPairCountdown(0); return }
    const updateTick = () => {
      const sec = Math.max(0, Math.floor((Date.parse(pairCode.expiresAt) - Date.now()) / 1000))
      setPairCountdown(sec)
      if (sec <= 0) setPairCode(null)
    }
    updateTick()
    const timer = setInterval(updateTick, 1000)
    return () => clearInterval(timer)
  }, [pairCode])

  useEffect(() => {
    if (!status?.background?.running) return
    const timer = setInterval(() => {
      fetch('/api/paper-reader/pipeline/sync/status')
        .then(r => r.json())
        .then(v => {
          applyStatus(v)
          if (!v?.background?.running && v?.lastResult && !v?.lastError) {
            const lr = v.lastResult
            const extras = [
              lr.renamedBooks ? `同步改名 ${lr.renamedBooks} 本` : '',
              lr.deduplicatedPdfs ? `秒传去重 ${lr.deduplicatedPdfs} 份` : '',
              lr.deletedCloudBooks ? `清理云端已删 ${lr.deletedCloudBooks} 本` : '',
            ].filter(Boolean).join('，')
            setResultMsg(`后台同步完成：推送 ${lr.pushedBooks ?? 0} 本书、${lr.pushedPdfs ?? 0} 份 PDF${extras ? `（${extras}）` : ''}；拉取 ${lr.pulledProgress ?? 0} 条进度、${lr.pulledBookmarks ?? 0} 条书签、${lr.appliedCorrections ?? 0} 条移动端勘误。`)
          }
        })
        .catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [status?.background?.running, applyStatus])

  const saveConfig = async (extra = {}) => {
    const r = await fetch('/api/paper-reader/pipeline/sync/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cloudUrl,
        vaultName: vaultName.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        deviceName,
        includePdf,
        autoSync,
        ...extra,
      })
    })
    const v = await r.json()
    if (!r.ok) throw new Error(v.error || '保存配置失败')
    setStatus(v)
    setToken('')
    if (v.configured && vaultName.trim()) {
      const bindRes = await fetch('/api/paper-reader/pipeline/sync/auth/bind-vault', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vaultName: vaultName.trim(), force: true }),
      })
      const bindVal = await bindRes.json().catch(() => ({}))
      if (bindRes.ok) setAuthStatus(bindVal)
    }
    return v
  }

  const handleSave = async () => {
    setBusy(true); setError(''); setResultMsg('')
    try {
      const v = await saveConfig()
      if (v.configured) await loadRemoteAuth()
      setResultMsg(v.configured && v.autoSync
        ? '配置已保存并存入本地数据库，已转入后台自动同步。'
        : '云端连接与书库绑定已保存至本地数据库。')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleSyncNow = async () => {
    setBusy(true); setError(''); setResultMsg('')
    try {
      await saveConfig({ startBackground: false })
      const r = await fetch('/api/paper-reader/pipeline/sync/now', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includePdf, background: true })
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '云端同步启动失败')
      setStatus(v)
      setResultMsg('已转入后台同步，可随时关闭此窗口继续阅读或处理文献。')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleGeneratePairCode = async () => {
    setBusy(true); setError(''); setResultMsg('')
    try {
      await saveConfig({ startBackground: false })
      const r = await fetch('/api/paper-reader/pipeline/sync/auth/pair-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '生成动态配对码失败')
      setPairCode(v)
      await loadRemoteAuth()
      setResultMsg('已生成 6 位一次性动态配对码，请在手机或汉王 APK 输入配对。')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleTogglePairing = async enabled => {
    setBusy(true); setError(''); setResultMsg('')
    try {
      const r = await fetch('/api/paper-reader/pipeline/sync/auth/pairing-toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '切换配对状态失败')
      setAuthStatus(v)
      if (!enabled) setPairCode(null)
      setResultMsg(enabled ? '已重新开放动态码配对。' : '已暂停新设备配对，已配对手机与本机不受影响。')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleRevokeDevice = async (devId, devName) => {
    setBusy(true); setError(''); setResultMsg('')
    try {
      const r = await fetch('/api/paper-reader/pipeline/sync/auth/revoke-device', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: devId }),
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '移除设备失败')
      setAuthStatus(v)
      setResultMsg(`已移除设备「${devName}」的访问权限。`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handleRevealRecovery = async () => {
    const next = !showRootPanel
    setShowRootPanel(next)
    if (next && !recoveryKeyText) {
      try {
        const r = await fetch('/api/paper-reader/pipeline/sync/recovery-key')
        const v = await r.json()
        if (r.ok && v.rootKey) setRecoveryKeyText(v.rootKey)
      } catch {}
    }
  }

  const handleCopyText = async (txt, msg) => {
    try {
      await navigator.clipboard?.writeText?.(txt)
      setResultMsg(msg)
    } catch {
      setError('当前环境不支持自动复制，请手动全选复制')
    }
  }

  const handleAuditStorage = async () => {
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/paper-reader/pipeline/storage/audit?dedupe=true')
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '空间检查失败')
      setStorageAudit(v)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const handlePruneStorage = async mode => {
    setBusy(true); setError(''); setResultMsg('')
    try {
      const r = await fetch('/api/paper-reader/pipeline/storage/prune', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, dedupe: mode === 'compact', purgeTrash: true })
      })
      const v = await r.json()
      if (!r.ok) throw new Error(v.error || '缓存清理失败')
      setStorageAudit(null)
      const dedupeTxt = v.dedupe?.clonedFiles ? `，APFS 去重 ${v.dedupe.clonedFiles} 个大文件（省 ${formatBytes(v.dedupe.potentialSavedBytes)}）` : ''
      setResultMsg(`空间清理完成：释放 ${formatBytes(v.totalBytes)}（${v.totalFiles} 个中间文件）${dedupeTxt}。`)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const bg = status?.background
  const bgProgressText = bg?.running
    ? [
        '后台同步中',
        bg.totalBooks > 0 ? `(${Math.min(bg.completedBooks + 1, bg.totalBooks)}/${bg.totalBooks})` : '',
        bg.currentBook ? `《${bg.currentBook}》` : '',
        bg.detail || '',
      ].filter(Boolean).join(' ')
    : ''
  const pairBundleString = pairCode?.code
    ? `dsh://pair?u=${encodeURIComponent(cloudUrl.trim())}&c=${encodeURIComponent(pairCode.code)}${vaultName.trim() ? `&v=${encodeURIComponent(vaultName.trim())}` : ''}`
    : ''
  const fmtCount = sec => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`

  return h('div', { className: 'rr-pdfModalOverlay', onClick: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { style: { background: '#fff', borderRadius: 12, padding: '20px 24px', minWidth: 340, maxWidth: 520, width: '92vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 16px 40px rgba(0,0,0,0.2)' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } },
        h('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, '云端书库同步（手机 / 汉王墨水屏）'),
        button(icon('close', 16), onClose, 'rr-buttonQuiet rr-buttonIcon', { 'aria-label': '关闭' })
      ),
      h('p', { className: 'rr-pipelineNote', style: { margin: '0 0 12px', fontSize: 12 } },
        '电脑绑定书库并在本地数据库保管根恢复密钥；手机与汉王 APK 输入一次性 6 位动态配对码即可长期授权，不再重复输长密钥。'
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 } },
        h('label', { style: { fontSize: 12, fontWeight: 600, color: '#3f3f46' } },
          '云服务器地址（推荐绑定的域名 HTTPS）',
          h('input', {
            type: 'url',
            placeholder: 'https://dsh-reader.duckdns.org',
            value: cloudUrl,
            onChange: e => setCloudUrl(e.target.value),
            style: { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 10px', fontSize: 13, borderRadius: 8, border: '1px solid #d4d4d8' }
          })
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('label', { style: { fontSize: 12, fontWeight: 600, color: '#3f3f46' } },
            '绑定书库名 (Vault)',
            h('input', {
              type: 'text',
              placeholder: '如 hao-paper-library',
              value: vaultName,
              onChange: e => setVaultName(e.target.value),
              style: { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 10px', fontSize: 13, borderRadius: 8, border: '1px solid #d4d4d8' }
            })
          ),
          h('label', { style: { fontSize: 12, fontWeight: 600, color: '#3f3f46' } },
            '本机名称',
            h('input', {
              type: 'text',
              value: deviceName,
              onChange: e => setDeviceName(e.target.value),
              style: { width: '100%', boxSizing: 'border-box', marginTop: 4, padding: '8px 10px', fontSize: 13, borderRadius: 8, border: '1px solid #d4d4d8' }
            })
          )
        ),
        status?.configured ? h('div', { style: { padding: '10px 12px', borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: '#0f172a' } }, '手机 / 汉王 APK 动态码配对'),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              authStatus ? button(authStatus.pairingEnabled ? '暂停配对' : '开放配对', () => handleTogglePairing(!authStatus.pairingEnabled), 'rr-buttonQuiet', { disabled: busy, style: { padding: '4px 8px', fontSize: 11 } }) : null,
              button('生成 6 位动态配对码', handleGeneratePairCode, 'rr-buttonPrimary', { disabled: busy, style: { padding: '5px 10px', fontSize: 12 } })
            )
          ),
          pairCode?.code ? h('div', { style: { marginTop: 10, padding: '10px 12px', borderRadius: 8, background: '#fff', border: '1px solid #cbd5e1', textAlign: 'center' } },
            h('div', { style: { fontSize: 26, fontWeight: 700, letterSpacing: '0.28em', color: '#0369a1', fontFamily: 'ui-monospace, monospace' } },
              `${pairCode.code.slice(0, 3)} ${pairCode.code.slice(3)}`
            ),
            h('div', { style: { fontSize: 11, color: '#64748b', marginTop: 4 } },
              `单次有效 · 剩余 ${fmtCount(pairCountdown)} 失效${pairCode.vaultName ? ` · 书库「${pairCode.vaultName}」` : ''}`
            ),
            h('div', { style: { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 8 } },
              button('复制 6 位码', () => handleCopyText(pairCode.code, '已复制 6 位动态配对码'), 'rr-buttonQuiet', { style: { padding: '4px 9px', fontSize: 11 } }),
              button('复制一键绑定口令', () => handleCopyText(pairBundleString, '已复制一键绑定口令，可直接粘贴到 APK 配对栏'), 'rr-buttonQuiet', { style: { padding: '4px 9px', fontSize: 11 } })
            )
          ) : null,
          authStatus?.devices?.length ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 } },
            h('span', { style: { fontSize: 11, color: '#64748b' } }, `已授权移动设备 (${authStatus.devices.length})`),
            ...authStatus.devices.map(d => h('div', { key: d.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 8px', background: '#fff', borderRadius: 6, border: '1px solid #e2e8f0' } },
              h('span', null, `${d.name} · 最近活跃 ${new Date(d.lastUsedAt || d.createdAt).toLocaleString()}`),
              button('移除', () => handleRevokeDevice(d.id, d.name), 'rr-buttonQuiet', { disabled: busy, style: { padding: '2px 7px', fontSize: 11, color: '#dc2626' } })
            ))
          ) : null
        ) : null,
        h('div', { style: { border: '1px solid #e4e4d7', borderRadius: 8, padding: '8px 10px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('span', { style: { fontSize: 12, color: '#3f3f46' } },
              status?.hasToken
                ? `本机恢复密钥：${status.rootKeyHint || '已配置'}${status.dbBacked ? ' · 已存本地数据库' : ''}`
                : '首次连接 / 恢复连接密钥（Root Key）'
            ),
            button(showRootPanel ? '收起' : '查看/修改', handleRevealRecovery, 'rr-buttonQuiet', { style: { padding: '2px 8px', fontSize: 11 } })
          ),
          (showRootPanel || !status?.hasToken) ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('input', {
              type: 'password',
              placeholder: status?.hasToken ? '如需更换或恢复密钥可在此粘贴（留空保持不变）' : '输入 VPS 根恢复密钥 SYNC_TOKEN',
              value: token,
              onChange: e => setToken(e.target.value),
              style: { width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 12, borderRadius: 6, border: '1px solid #d4d4d8' }
            }),
            recoveryKeyText ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('code', { style: { flex: 1, fontSize: 11, background: '#f4f4f5', padding: '5px 7px', borderRadius: 6, wordBreak: 'break-all' } }, recoveryKeyText),
              button('复制密钥', () => handleCopyText(recoveryKeyText, '已复制本机根恢复密钥，请妥善备份'), 'rr-buttonQuiet', { style: { padding: '4px 8px', fontSize: 11 } })
            ) : null
          ) : null
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#3f3f46', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: includePdf,
            onChange: e => setIncludePdf(e.target.checked)
          }),
          '推送原 PDF（支持大文件分片后台上传，手机/汉王可按需查看原书 PDF 页）'
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#3f3f46', cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: autoSync,
            onChange: e => setAutoSync(e.target.checked)
          }),
          '后台自动同步（启动与变更后默认在后台定期执行，不占用前台）'
        )
      ),
      bgProgressText ? h('p', { role: 'status', style: { color: '#0369a1', background: '#f0f9ff', padding: '8px 10px', borderRadius: 8, fontSize: 12, margin: '0 0 10px' } },
        bgProgressText
      ) : null,
      status?.lastSyncAt ? h('p', { className: 'rr-pipelineNote', style: { margin: '0 0 10px', fontSize: 11 } },
        `上次同步：${new Date(status.lastSyncAt).toLocaleString()}`
      ) : null,
      error ? h('p', { role: 'alert', style: { color: '#dc2626', fontSize: 12, margin: '0 0 10px', wordBreak: 'break-word' } }, error) : null,
      resultMsg ? h('p', { role: 'status', style: { color: '#15803d', fontSize: 12, margin: '0 0 10px' } }, resultMsg) : null,
      h('div', { className: 'rr-rowActions', style: { justifyContent: 'flex-end', gap: 8 } },
        button('保存配置', handleSave, 'rr-buttonQuiet', { disabled: busy }),
        button(bg?.running ? '后台排队再同步' : '立即后台同步', handleSyncNow, 'rr-buttonPrimary', { disabled: busy || !cloudUrl.trim() })
      ),
      h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid #e4e4e7' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: '#3f3f46' } }, '本地缓存与存储卫生'),
          h('div', { style: { display: 'flex', gap: 6 } },
            button('空间体检', handleAuditStorage, 'rr-buttonQuiet', { disabled: busy }),
            button('安全清理', () => handlePruneStorage('safe'), 'rr-buttonQuiet', { disabled: busy }),
            button('深度瘦身', () => handlePruneStorage('compact'), 'rr-buttonQuiet', { disabled: busy })
          )
        ),
        storageAudit ? h('p', { className: 'rr-pipelineNote', style: { margin: '8px 0 0', fontSize: 11 } },
          `安全可清：${formatBytes(storageAudit.safeBytes)}（${storageAudit.safeFiles} 文件）；深度瘦身共可清：${formatBytes(storageAudit.compactBytes)}${storageAudit.dedupe?.potentialSavedBytes ? `；大文件去重可省：${formatBytes(storageAudit.dedupe.potentialSavedBytes)}` : ''}。`
        ) : null
      )
    )
  )
}
const ZH_HANT_CHAR_RE = /[這個們為說時會國學體經發現實對應問題關於從與無開機業書長當來過進見樣種頭動點認識話語讀寫論義態鬱憂灣還請兩週環沒謂達聲習慣詞異鑑裏麼讓給將並處親愛東門問間聞聽視變產統紀續組織結構聯繫舉辦區準備標記號碼數據資訊歷傳錄選擇斷專廣眾邊際總導師範圍階層級類質價錢買賣費負責務報紙雜誌網絡電腦軟設規畫踐驗證顯隱轉僅優傷寫創剛劇勞勝勸醫協單壓參雙劃]/g
const ZH_HANS_CHAR_RE = /[这个们为说时会国学体经发现实对应问题关于从与无开机业书长当来过进见样种头动点认识话语读写论义态郁忧湾还请两环没谓达声习惯词异鉴让给将处亲爱东门问间闻听视变产统纪续组织结构联系举办区准备标记号码数据资讯历传录选择断专广众边际总导师范围阶层级类质价钱买卖费负责务报纸杂网络电脑软设规划践验证显隐转仅优伤创刚剧劳胜劝医协单压参双]/g
function detectZhScript(text, fallback = 'hans') {
  if (typeof text !== 'string' || !text) return fallback
  const hant = text.match(ZH_HANT_CHAR_RE)?.length ?? 0
  const hans = text.match(ZH_HANS_CHAR_RE)?.length ?? 0
  if (hant > hans && hant >= 2) return 'hant'
  if (hans > hant && hans >= 2) return 'hans'
  return fallback
}
function detectReadingScript(reading, blocks, view) {
  let hant = 0, hans = 0, scanned = 0
  const count = text => {
    if (typeof text !== 'string' || !text) return
    hant += text.match(ZH_HANT_CHAR_RE)?.length ?? 0
    hans += text.match(ZH_HANS_CHAR_RE)?.length ?? 0
    scanned += text.length
  }
  const viewOutline = view === 'original' ? (reading?.originalOutline?.outline ?? reading?.outline) : reading?.outline
  for (const item of viewOutline ?? []) count(item?.label)
  for (const b of blocks ?? []) {
    const value = view === 'translation' ? (b.translation ?? b.text) : (b.sourceText ?? b.text)
    count(value)
    if (hant + hans >= 300 || scanned >= 80000) break
  }
  if (hant + hans < 2) count(reading?.title)
  return hant > hans && hant >= 2 ? 'hant' : 'hans'
}
function zhScriptAttrs(script) {
  return script === 'hant' ? { 'data-zh-script': 'hant', lang: 'zh-Hant' } : {}
}
function SourceDialog({ t, payload, onClose }) {
  const closeRef = useRef(null),dialogRef=useRef(null),closeHandler=useRef(onClose);closeHandler.current=onClose
  useEffect(() => {
    closeRef.current?.focus()
    const keydown = e => {
      if (e.key === 'Escape'&&!document.querySelector('.rr-footnotePreview')&&!document.querySelector('.rr-inlineCorrection')&&!document.querySelector('.rr-correctionMenu')) { e.preventDefault(); e.stopPropagation(); closeHandler.current() }
      if(e.key==='Tab'){const items=[...(dialogRef.current?.querySelectorAll('button:not([disabled]),a[href],select,input,textarea,[tabindex="0"]')??[])];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
    }
    document.addEventListener('keydown', keydown, true)
    return () => { document.removeEventListener('keydown', keydown, true); if(!document.querySelector('.rr-centeredDialog')&&payload.trigger?.isConnected)payload.trigger.focus() }
  }, [payload.block?.id])
  const block = payload.block
  return h('div', { className: 'rr-overlay', onMouseDown: e => { if (e.target === e.currentTarget) onClose() } },
    h('div', { className: 'rr-dialog'+(payload.readingComparison?' rr-bookComparison':''),ref:dialogRef, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rr-dialog-heading' },
      h('div', { className: 'rr-dialogHeader' },
        h('div', { style: { flex: 1 } }, h('h2', { id: 'rr-dialog-heading' }, t('sourceDialog')), h('p', null, [payload.section, block.page != null ? t('page').replace('{page}', String(block.page)) : ''].filter(Boolean).join(' · '))),
        button(icon('close', 17), onClose, 'rr-buttonIcon rr-buttonQuiet', { ref: closeRef, 'aria-label': t('close'), title: t('close') })),
      h('div', { className: 'rr-dialogBody' },
        h('section', { className: 'rr-dialogColumn' }, h('span', { className: 'rr-dialogLabel' }, payload.translationLabel ?? t('translation')), payload.translationNode??h('p', { className: 'rr-dialogZh', ...zhScriptAttrs(detectZhScript(block.text)) }, block.text)),
        h('section', { className: 'rr-dialogColumn' }, h('span', { className: 'rr-dialogLabel' }, payload.sourceLabel??t('source')), payload.originalNode??h('p', { className: 'rr-dialogFr', lang:payload.sourceLanguage, ...(detectZhScript(block.source)==='hant'?zhScriptAttrs('hant'):{}) }, block.source)),
      )))
}
function formatBytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n ?? 0) / 1024))} KB` }

/* 每个文档任务一个受控会话:会话 id 按任务阶段记在本地,重开面板/刷新页面后仍复用同一个。 */
const SESSION_KEY_PREFIX = 'paper-reader:session:'
function readStoredSession(key) { try { return localStorage.getItem(key) ?? '' } catch { return '' } }
function writeStoredSession(key, id) { try { localStorage.setItem(key, id) } catch { /* storage disabled */ } }
/** 会话标题:让侧栏一眼认出是哪个文档任务。 */
function sessionTitle(file) {
  if (file.startsWith('pipeline:')) return `文档编排 · ${file.split(':').slice(2).join(':') === 'environment' ? '环境检查' : file.split(':').slice(2).join(':')}`
  const base = String(file).replace(/\.pdf$/i, '')
  return `阅读 · ${base.length > 48 ? base.slice(0, 47) + '…' : base}`
}
