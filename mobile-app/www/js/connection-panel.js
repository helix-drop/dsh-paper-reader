import { escapeHtml } from './reading-core.js'

export function parsePairingInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (!text) return null
  if (/^dsh:\/\/pair\b/i.test(text)) {
    try {
      const u = new URL(text.replace(/^dsh:/i, 'https:'))
      const url = u.searchParams.get('u') || ''
      const code = (u.searchParams.get('c') || '').replace(/\D+/g, '')
      const vault = u.searchParams.get('v') || ''
      if (code) return { serverUrl: url.trim(), code, vaultName: vault.trim() }
    } catch {}
  }
  const digits = text.replace(/[\s-]+/g, '')
  if (/^\d{6,8}$/.test(digits)) {
    return { code: digits, serverUrl: '', vaultName: '' }
  }
  return null
}

export function renderConnectionCardHtml(s, { syncing, syncAbortActive, syncStatusCardHtml } = {}) {
  const pairedLabel = s.token
    ? (s.vaultName
        ? `已授权书库「${s.vaultName}」· ${s.authMode === 'root' ? '恢复密钥直连' : '本机长期授权'}`
        : `已配置凭证 · ${s.authMode === 'root' ? '恢复密钥直连' : '长期授权'}`)
    : '尚未配对（在电脑 DSH 生成 6 位动态配对码后即可一键绑定）'

  return `
    <div class="wr-card">
      <h3 class="wr-cardTitle">云端书库连接（6 位动态码一键配对）</h3>
      <p style="margin:0 0 10px;font-size:12px;color:${s.token ? 'var(--accent)' : 'var(--fg-muted)'};">${escapeHtml(pairedLabel)}</p>
      <label class="wr-field">云服务器地址（域名 HTTPS 或 IP 地址）
        <input type="url" class="wr-input" id="set-url" placeholder="https://dsh-reader.duckdns.org" value="${escapeHtml(s.serverUrl)}" />
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <label class="wr-field">6 位动态配对码
          <input type="text" class="wr-input" id="set-pair-code" placeholder="如 482916 / 一键口令" autocomplete="off" />
        </label>
        <label class="wr-field">书库名（选填）
          <input type="text" class="wr-input" id="set-vault" placeholder="留空自动读取" value="${escapeHtml(s.vaultName || '')}" />
        </label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <button type="button" class="wr-btnPrimary" data-act="pair-connect" ${syncing ? 'disabled' : ''}>动态码配对并同步</button>
        <button type="button" class="wr-btnGhost" data-act="test-conn">测试连通</button>
        <button type="button" class="wr-btnGhost" data-act="sync-now" ${syncing ? 'disabled' : ''}>${syncing ? '同步中...' : '立即同步'}</button>
      </div>
      <details style="margin:6px 0 10px;">
        <summary style="font-size:12px;color:var(--fg-muted);cursor:pointer;">高级：手动密钥 / 根恢复密钥直连与设备名</summary>
        <div style="margin-top:8px;">
          <label class="wr-field">手动连接密钥 / 本机恢复密钥（可选兜底）
            <input type="password" class="wr-input" id="set-token" placeholder="配对后自动写入；仅断联恢复时手动填写" value="${escapeHtml(s.token)}" />
          </label>
          <label class="wr-field">当前设备名称（用于跨端设备识别）
            <input type="text" class="wr-input" id="set-devname" value="${escapeHtml(s.deviceName)}" />
          </label>
          <button type="button" class="wr-btnGhost" data-act="save-conn">手动保存连接设置</button>
        </div>
      </details>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        <button type="button" class="wr-btnGhost" data-act="dl-all-md" ${syncing ? 'disabled' : ''}>↓ 下载所有 MD 文件</button>
        <button type="button" class="wr-btnGhost" data-act="dl-all-files" ${syncing ? 'disabled' : ''}>↓ 下载所有文件（含 PDF）</button>
        ${syncing && syncAbortActive ? '<button type="button" class="wr-btnGhost" data-act="cancel-sync">取消下载</button>' : ''}
      </div>
      <div class="wr-field" style="margin-top:10px;margin-bottom:0;">顶部「↻ 同步」默认下载范围
        <div class="wr-segGroup">
          <button type="button" class="wr-segBtn ${!s.syncIncludePdfs ? 'active' : ''}" data-sync-scope="md">所有 MD 文件（推荐，PDF 按需）</button>
          <button type="button" class="wr-segBtn ${s.syncIncludePdfs ? 'active' : ''}" data-sync-scope="all">所有文件（含全部 PDF）</button>
        </div>
      </div>
      <div data-role="sync-card-host" style="margin-top:10px;">${syncStatusCardHtml || ''}</div>
    </div>
  `
}

export function bindConnectionCard(root, {
  state,
  readerApi,
  updateSettings,
  performSync,
  showToast,
  render,
  bindDownloadActions,
}) {
  const readConnFields = () => ({
    serverUrl: document.getElementById('set-url')?.value.trim().replace(/\/+$/, '') || '',
    vaultName: document.getElementById('set-vault')?.value.trim() || '',
    token: document.getElementById('set-token')?.value.trim() || '',
    deviceName: document.getElementById('set-devname')?.value.trim() || '我的移动设备',
  })

  const pairBtn = root.querySelector('[data-act="pair-connect"]')
  if (pairBtn) {
    pairBtn.onclick = async () => {
      const pairInput = document.getElementById('set-pair-code')?.value.trim() || ''
      const parsed = parsePairingInput(pairInput)
      if (!parsed?.code) {
        showToast('请输入电脑端 DSH 显示的 6 位动态配对码，或粘贴一键绑定口令')
        return
      }
      const fields = readConnFields()
      const targetUrl = parsed.serverUrl || fields.serverUrl
      const targetVault = parsed.vaultName || fields.vaultName
      if (!targetUrl) {
        showToast('请先填写云服务器地址')
        return
      }
      pairBtn.disabled = true
      try {
        const res = await readerApi.pairWithCode(state.settings, {
          serverUrl: targetUrl,
          code: parsed.code,
          vaultName: targetVault,
          deviceId: state.settings.deviceId,
          deviceName: fields.deviceName,
        })
        await updateSettings({
          serverUrl: res.serverUrl || targetUrl,
          token: res.token,
          vaultName: res.vaultName || targetVault,
          authMode: 'device',
          deviceId: res.deviceId || state.settings.deviceId,
          deviceName: fields.deviceName,
        })
        showToast(`配对成功${res.vaultName ? `（已绑定「${res.vaultName}」）` : ''}，正在同步...`)
        await performSync(false)
      } catch (err) {
        showToast(`配对失败：${err.message}`)
      } finally {
        pairBtn.disabled = false
      }
    }
  }

  const saveBtn = root.querySelector('[data-act="save-conn"]')
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const f = readConnFields()
      await updateSettings({ ...f, ...(f.token && !f.token.startsWith('dsh_dev_') ? { authMode: 'root' } : {}) })
      showToast('连接配置已保存')
      render()
    }
  }

  const testBtn = root.querySelector('[data-act="test-conn"]')
  if (testBtn) {
    testBtn.onclick = async () => {
      const f = readConnFields()
      await updateSettings(f)
      try {
        const res = await readerApi.testConnection(state.settings)
        showToast(`连接成功：云端共 ${res.documents} 本文献${res.vaultName ? ` · 书库「${res.vaultName}」` : ''}`)
      } catch (err) {
        showToast(`连接失败：${err.message}`)
      }
    }
  }

  root.querySelectorAll('[data-sync-scope]').forEach(btn => {
    btn.onclick = async () => {
      await updateSettings({ syncIncludePdfs: btn.dataset.syncScope === 'all' })
      render()
    }
  })

  bindDownloadActions(async () => {
    await updateSettings(readConnFields())
  })

  const syncNowBtn = root.querySelector('[data-act="sync-now"]')
  if (syncNowBtn) {
    syncNowBtn.onclick = async () => {
      await updateSettings(readConnFields())
      await performSync(false)
    }
  }
}
