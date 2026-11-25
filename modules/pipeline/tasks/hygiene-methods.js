import {
  auditWorkspace,
  prunePublicGlossaryHistory,
  pruneTaskCaches,
  pruneTrash,
  pruneWorkspace,
} from '../hygiene.js'

export const hygieneMethods = {
  async auditStorage(options = {}) {
    return auditWorkspace(this, options)
  },

  async pruneStorage(options = {}) {
    return pruneWorkspace(this, options)
  },

  async pruneTaskStorage(id, options = {}) {
    const t = await this.get(id)
    return pruneTaskCaches(this, t, options)
  },

  async runStartupHygiene() {
    if (this._startupHygieneRan) return
    this._startupHygieneRan = true
    await pruneTrash(this.root).catch(() => {})
    await prunePublicGlossaryHistory(this.root, { keepLatest: 2 }).catch(() => {})
  },
}
