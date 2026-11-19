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
