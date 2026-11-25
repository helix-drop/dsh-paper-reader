const STORAGE_KEY = 'paper-reader-pipeline-notices'

export function noticeStorageKey(settings) {
  const server = String(settings?.serverUrl ?? '').trim().replace(/\/+$/, '')
  const vault = String(settings?.vaultName ?? '').trim()
  return `${STORAGE_KEY}:${server}:${vault}`
}

export function deviceWantsPipelineNotices(settings) {
  if (!settings || typeof settings !== 'object') return false
  if (settings.deviceMode === 'eink' || settings.theme === 'eink') return false
  return true
}

export function selectFreshNotices(notices, seen, primed) {
  const list = Array.isArray(notices) ? notices.filter(item => item?.id) : []
  const next = new Set(seen)
  if (!primed) {
    for (const item of list) next.add(item.id)
    return { deliver: [], seen: next, primed: true }
  }
  const deliver = []
  for (const item of list) {
    if (next.has(item.id)) continue
    next.add(item.id)
    deliver.push(item)
  }
  return { deliver, seen: next, primed: true }
}

function readSeen(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}')
    return {
      seen: new Set(Array.isArray(saved.ids) ? saved.ids.filter(id => typeof id === 'string') : []),
      primed: saved.primed === true,
    }
  } catch {
    return { seen: new Set(), primed: false }
  }
}

function writeSeen(key, seen, primed) {
  try {
    localStorage.setItem(key, JSON.stringify({ primed, ids: [...seen].slice(-80) }))
  } catch { /* private mode or a full disk can refuse storage */ }
}

export function startPipelineNoticeWatch({
  getSettings,
  pull,
  notify,
  ensurePermission,
  isNative,
  onUnavailable,
} = {}) {
  let running = false
  let asked = false
  let permissionDenied = false
  const kick = () => { void run() }
  async function run() {
    if (running) return
    const settings = getSettings?.()
    if (!settings?.serverUrl || !isNative?.() || !deviceWantsPipelineNotices(settings)) return
    running = true
    try {
      const data = await pull(settings)
      const key = noticeStorageKey(settings)
      const { seen, primed } = readSeen(key)
      const next = selectFreshNotices(data?.notices, seen, primed)
      if (!primed) {
        writeSeen(key, next.seen, next.primed)
        return
      }
      if (!next.deliver.length) return
      if (!asked) {
        asked = true
        const granted = await ensurePermission?.()
        if (granted === false) {
          permissionDenied = true
          onUnavailable?.()
          return
        }
      }
      if (permissionDenied) return
      writeSeen(key, next.seen, next.primed)
      for (const notice of next.deliver) {
        await notify?.({
          id: notice.id,
          title: notice.title,
          body: notice.body,
        })
      }
    } catch { /* the next foreground check retries */ } finally {
      running = false
    }
  }
  const timer = setInterval(kick, 60_000)
  const onVisibility = () => {
    if (document.visibilityState === 'visible') kick()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }
  kick()
  return {
    kick,
    stop() {
      clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    },
  }
}
