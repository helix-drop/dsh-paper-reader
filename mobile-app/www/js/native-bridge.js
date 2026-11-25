function getPlugin() {
  return window.Capacitor?.Plugins?.ReaderNative ?? null
}

let backHandler = null

export const nativeBridge = {
  setBackHandler(fn) {
    backHandler = typeof fn === 'function' ? fn : null
  },

  isNative() {
    return Boolean(window.Capacitor?.isNativePlatform?.() || getPlugin())
  },

  async setImmersive(enabled) {
    const plugin = getPlugin()
    if (plugin?.setImmersive) {
      try { await plugin.setImmersive({ enabled: Boolean(enabled) }) } catch {}
    }
  },

  async setAppearance({ bgColor = '#f6f1e7', dark = false } = {}) {
    const plugin = getPlugin()
    if (plugin?.setAppearance) {
      try { await plugin.setAppearance({ bgColor, dark: Boolean(dark) }) } catch {}
    }
  },

  async setSelectionMenuDisabled(disabled) {
    const plugin = getPlugin()
    if (plugin?.setSelectionMenuDisabled) {
      try { await plugin.setSelectionMenuDisabled({ disabled: Boolean(disabled) }) } catch {}
    }
  },

  async configureKeys({ enabled, prevKeys, nextKeys }) {
    const plugin = getPlugin()
    if (plugin?.configureKeys) {
      try {
        await plugin.configureKeys({
          enabled: Boolean(enabled),
          prevKeyCodes: (prevKeys ?? []).filter(k => typeof k === 'number'),
          nextKeyCodes: (nextKeys ?? []).filter(k => typeof k === 'number'),
        })
      } catch {}
    }
  },

  async startKeyCapture() {
    const plugin = getPlugin()
    if (plugin?.setKeyCapture) {
      try { await plugin.setKeyCapture({ capturing: true }) } catch {}
    }
  },

  async stopKeyCapture() {
    const plugin = getPlugin()
    if (plugin?.setKeyCapture) {
      try { await plugin.setKeyCapture({ capturing: false }) } catch {}
    }
  },

  async requestNotifications() {
    const plugin = getPlugin()
    if (!plugin?.requestNotifications) return false
    try {
      const result = await plugin.requestNotifications()
      return result?.granted !== false
    } catch {
      return false
    }
  },

  async notify({ id, title, body } = {}) {
    const plugin = getPlugin()
    if (!plugin?.notify) return
    try {
      await plugin.notify({
        id: String(id ?? ''),
        title: String(title ?? ''),
        body: String(body ?? ''),
      })
    } catch { /* a denied permission or a missing channel just skips this notice */ }
  },
}

// Allow Android native activity to invoke window.__readerOnPhysicalKey(direction, keyCode, keyName)
window.__readerOnPhysicalKey = (direction, keyCode, keyName) => {
  window.dispatchEvent(new CustomEvent('reader:physical-key', {
    detail: { direction, keyCode, keyName },
  }))
}

window.__readerOnKeyCaptured = (keyCode, keyName) => {
  window.dispatchEvent(new CustomEvent('reader:key-captured', {
    detail: { keyCode, keyName },
  }))
}

window.__readerHandleBack = () => Boolean(backHandler?.())

window.__readerSetSafeInsets = (topDp = 0, bottomDp = 0) => {
  const s = document.documentElement?.style
  if (!s) return
  s.setProperty('--native-safe-top', `${Math.max(0, Number(topDp) || 0)}px`)
  s.setProperty('--native-safe-bottom', `${Math.max(0, Number(bottomDp) || 0)}px`)
  window.dispatchEvent(new CustomEvent('reader:safe-insets'))
}

if (window.__nativeSafeInsets) {
  window.__readerSetSafeInsets(window.__nativeSafeInsets.top, window.__nativeSafeInsets.bottom)
} else if (getPlugin()?.getSafeInsets) {
  getPlugin().getSafeInsets().then(r => { if (r) window.__readerSetSafeInsets(r.top, r.bottom) }).catch(() => {})
}
