import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

const PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_ACTIVE_PAIR_CODES = 3
const IP_WINDOW_MS = 10 * 60 * 1000
const MAX_IP_ATTEMPTS = 5
const GLOBAL_FAIL_WINDOW_MS = 10 * 60 * 1000
const MAX_GLOBAL_FAILS = 8
const LOCKOUT_MS = 15 * 60 * 1000
const LAST_USED_TOUCH_INTERVAL_MS = 5 * 60 * 1000

export function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function timingSafeHexEqual(a, b) {
  const sa = String(a ?? '')
  const sb = String(b ?? '')
  if (!sa || sa.length !== sb.length) return false
  return timingSafeEqual(Buffer.from(sa, 'utf8'), Buffer.from(sb, 'utf8'))
}

export function normalizeVaultName(name) {
  const clean = String(name ?? '').replace(/[\r\n\0]+/g, ' ').trim()
  if (!clean) return ''
  return clean.slice(0, 80)
}

export function normalizePairingCode(code) {
  return String(code ?? '').replace(/[\s-]+/g, '').trim()
}

export function decodeVaultHeader(req) {
  const raw = req?.headers?.['x-dsh-vault']
  if (typeof raw !== 'string' || !raw.trim()) return ''
  try {
    return normalizeVaultName(decodeURIComponent(raw.trim()))
  } catch {
    return normalizeVaultName(raw)
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback
    throw err
  }
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, file)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

export class CloudAuthStore {
  constructor(dataDir, initialRootToken, options = {}) {
    this.dataDir = path.resolve(dataDir)
    this.authFile = path.join(this.dataDir, 'auth-v1.json')
    this.initialRootToken = String(initialRootToken ?? '').trim()
    this.defaultVaultName = normalizeVaultName(options.vaultName ?? process.env.SYNC_VAULT_NAME ?? '')
    this.now = options.now ?? (() => Date.now())
    this.queue = Promise.resolve()
    this.ipAttempts = new Map()
    this.globalFailTimes = []
    this.lockedUntil = 0
  }

  async serialized(fn) {
    const job = this.queue.catch(() => {}).then(fn)
    this.queue = job
    return job
  }

  async _loadRaw() {
    const saved = await readJson(this.authFile, null)
    const fallbackRootHash = this.initialRootToken ? sha256Hex(this.initialRootToken) : ''
    if (!saved || typeof saved !== 'object') {
      const created = {
        schemaVersion: 1,
        vaultName: this.defaultVaultName,
        rootKeyHash: fallbackRootHash,
        pairingEnabled: true,
        devices: [],
        pairingCodes: [],
      }
      await writeAtomic(this.authFile, created)
      return created
    }
    const nowMs = this.now()
    return {
      schemaVersion: 1,
      vaultName: normalizeVaultName(saved.vaultName ?? this.defaultVaultName),
      rootKeyHash: String(saved.rootKeyHash || fallbackRootHash),
      pairingEnabled: saved.pairingEnabled !== false,
      devices: Array.isArray(saved.devices) ? saved.devices : [],
      pairingCodes: (Array.isArray(saved.pairingCodes) ? saved.pairingCodes : [])
        .filter(c => c && !c.usedAt && Number(c.expiresAt) > nowMs),
    }
  }

  async init() {
    return this.serialized(() => this._loadRaw())
  }

  async authenticateRequest(req) {
    const header = String(req?.headers?.authorization ?? '')
    const match = header.match(/^Bearer\s+(.+)$/i)
    if (!match) return { ok: false, reason: 'missing_token' }
    const presented = match[1].trim()
    if (!presented) return { ok: false, reason: 'missing_token' }
    const presentedHash = sha256Hex(presented)
    const envFallbackHash = this.initialRootToken ? sha256Hex(this.initialRootToken) : ''

    const state = await this._loadRaw()
    const isRoot = (state.rootKeyHash && timingSafeHexEqual(presentedHash, state.rootKeyHash))
      || (envFallbackHash && timingSafeHexEqual(presentedHash, envFallbackHash))
    if (isRoot) {
      return { ok: true, role: 'root', deviceId: 'root', deviceName: 'PC DSH Host', vaultName: state.vaultName }
    }

    const device = state.devices.find(d => !d.revokedAt && d.tokenHash && timingSafeHexEqual(presentedHash, d.tokenHash))
    if (device) {
      const nowMs = this.now()
      const lastMs = device.lastUsedAt ? Date.parse(device.lastUsedAt) : 0
      if (!lastMs || nowMs - lastMs >= LAST_USED_TOUCH_INTERVAL_MS) {
        void this.serialized(async () => {
          const latest = await this._loadRaw()
          const target = latest.devices.find(d => d.id === device.id && !d.revokedAt)
          if (target) {
            target.lastUsedAt = new Date(nowMs).toISOString()
            await writeAtomic(this.authFile, latest)
          }
        }).catch(() => {})
      }
      return {
        ok: true,
        role: 'device',
        deviceId: device.id,
        deviceName: device.name || '已配对设备',
        vaultName: state.vaultName,
      }
    }

    return { ok: false, reason: 'invalid_token' }
  }

  async checkVaultMatch(req) {
    const sent = decodeVaultHeader(req)
    if (!sent) return { ok: true }
    const state = await this._loadRaw()
    if (state.vaultName && state.vaultName !== sent) {
      return {
        ok: false,
        status: 409,
        error: `书库名称不匹配（当前云端绑定书库为「${state.vaultName}」，请求为「${sent}」）`,
        expectedVaultName: state.vaultName,
      }
    }
    return { ok: true }
  }

  async publicStatus() {
    const state = await this._loadRaw()
    const nowMs = this.now()
    const activeDevices = state.devices
      .filter(d => !d.revokedAt)
      .map(d => ({
        id: d.id,
        name: d.name || '移动阅读器',
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt ?? d.createdAt,
      }))
    return {
      vaultName: state.vaultName,
      pairingEnabled: state.pairingEnabled,
      activePairingCodes: state.pairingCodes.filter(c => c.expiresAt > nowMs && !c.usedAt).length,
      pairingLockedUntil: this.lockedUntil > nowMs ? new Date(this.lockedUntil).toISOString() : null,
      devices: activeDevices,
    }
  }

  async bindVault(vaultName, { force = false } = {}) {
    const clean = normalizeVaultName(vaultName)
    if (!clean) throw new Error('请输入有效的书库名称')
    return this.serialized(async () => {
      const state = await this._loadRaw()
      if (state.vaultName && state.vaultName !== clean && !force) {
        throw Object.assign(
          new Error(`云端已绑定书库「${state.vaultName}」，如需改绑请确认覆盖`),
          { status: 409 },
        )
      }
      state.vaultName = clean
      await writeAtomic(this.authFile, state)
      return this.publicStatus()
    })
  }

  async setPairingEnabled(enabled) {
    return this.serialized(async () => {
      const state = await this._loadRaw()
      state.pairingEnabled = Boolean(enabled)
      if (!state.pairingEnabled) state.pairingCodes = []
      await writeAtomic(this.authFile, state)
      return this.publicStatus()
    })
  }

  async generatePairingCode({ deviceHint = '', ttlMs = PAIRING_TTL_MS } = {}) {
    return this.serialized(async () => {
      const state = await this._loadRaw()
      const nowMs = this.now()
      state.pairingEnabled = true
      this.lockedUntil = 0
      this.globalFailTimes = []
      const code = String(randomInt(100000, 1000000))
      const expiresAt = nowMs + Math.max(30000, Math.min(30 * 60 * 1000, Number(ttlMs) || PAIRING_TTL_MS))
      const active = state.pairingCodes
        .filter(c => !c.usedAt && c.expiresAt > nowMs)
        .slice(-(MAX_ACTIVE_PAIR_CODES - 1))
      active.push({
        id: randomUUID(),
        codeHash: sha256Hex(code),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt,
        deviceHint: String(deviceHint ?? '').trim().slice(0, 60),
      })
      state.pairingCodes = active
      await writeAtomic(this.authFile, state)
      return {
        ok: true,
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        ttlSeconds: Math.round((expiresAt - nowMs) / 1000),
        vaultName: state.vaultName,
      }
    })
  }

  async revokeDevice(deviceId) {
    const cleanId = String(deviceId ?? '').trim()
    if (!cleanId) throw new Error('设备编号无效')
    return this.serialized(async () => {
      const state = await this._loadRaw()
      const dev = state.devices.find(d => d.id === cleanId)
      if (!dev) throw Object.assign(new Error('未找到该已配对设备'), { status: 404 })
      dev.revokedAt = new Date(this.now()).toISOString()
      await writeAtomic(this.authFile, state)
      return this.publicStatus()
    })
  }

  async rotateRootKey(nextRootKey) {
    const raw = String(nextRootKey ?? '').trim() || `dsh_root_${randomBytes(24).toString('base64url')}`
    if (raw.length < 16) throw new Error('恢复密钥长度至少需要 16 个字符')
    return this.serialized(async () => {
      const state = await this._loadRaw()
      state.rootKeyHash = sha256Hex(raw)
      await writeAtomic(this.authFile, state)
      return { ok: true, rootKey: raw, vaultName: state.vaultName }
    })
  }

  _checkAndRecordRateLimit(clientIp, nowMs) {
    if (this.lockedUntil > nowMs) {
      const waitSec = Math.ceil((this.lockedUntil - nowMs) / 1000)
      throw Object.assign(
        new Error(`配对尝试过于频繁，已临时保护锁定（约 ${Math.max(1, Math.ceil(waitSec / 60))} 分钟后恢复）`),
        { status: 429 },
      )
    }
    const ip = String(clientIp || 'unknown')
    const list = (this.ipAttempts.get(ip) ?? []).filter(t => nowMs - t < IP_WINDOW_MS)
    if (list.length >= MAX_IP_ATTEMPTS) {
      throw Object.assign(
        new Error('当前网络配对尝试过多，请几分钟后再试或从电脑端重新生成配对码'),
        { status: 429 },
      )
    }
    list.push(nowMs)
    this.ipAttempts.set(ip, list)
    if (this.ipAttempts.size > 500) {
      for (const [k, v] of this.ipAttempts) {
        if (!v.some(t => nowMs - t < IP_WINDOW_MS)) this.ipAttempts.delete(k)
      }
    }
  }

  _recordGlobalFailure(nowMs) {
    this.globalFailTimes = this.globalFailTimes.filter(t => nowMs - t < GLOBAL_FAIL_WINDOW_MS)
    this.globalFailTimes.push(nowMs)
    if (this.globalFailTimes.length >= MAX_GLOBAL_FAILS) {
      this.lockedUntil = nowMs + LOCKOUT_MS
    }
  }

  async redeemPairingCode({ code, vaultName = '', deviceId = '', deviceName = '', clientIp = 'unknown' } = {}) {
    const nowMs = this.now()
    this._checkAndRecordRateLimit(clientIp, nowMs)

    const cleanCode = normalizePairingCode(code)
    if (!/^\d{6,8}$/.test(cleanCode)) {
      this._recordGlobalFailure(nowMs)
      throw Object.assign(new Error('请输入电脑端显示的 6 位数字动态配对码'), { status: 400 })
    }

    return this.serialized(async () => {
      const state = await this._loadRaw()
      if (!state.pairingEnabled) {
        throw Object.assign(new Error('电脑端已暂停新设备配对，请先在电脑 DSH 中开启配对'), { status: 403 })
      }
      const wantedVault = normalizeVaultName(vaultName)
      if (wantedVault && state.vaultName && wantedVault !== state.vaultName) {
        throw Object.assign(
          new Error(`书库名称不匹配：云端绑定的是「${state.vaultName}」`),
          { status: 409 },
        )
      }

      const codeHash = sha256Hex(cleanCode)
      const idx = state.pairingCodes.findIndex(
        c => !c.usedAt && c.expiresAt > nowMs && timingSafeHexEqual(c.codeHash, codeHash),
      )
      if (idx < 0) {
        this._recordGlobalFailure(nowMs)
        throw Object.assign(new Error('动态配对码无效或已过期，请在电脑端重新生成'), { status: 401 })
      }

      state.pairingCodes.splice(idx, 1)
      const token = `dsh_dev_${randomBytes(24).toString('base64url')}`
      const cleanDevName = String(deviceName ?? '').trim().slice(0, 80) || '移动阅读器'
      const resolvedDeviceId = String(deviceId ?? '').trim().slice(0, 80) || `dev-${randomUUID()}`

      // Replace prior active entry for the same deviceId to keep list tidy across re-pairings
      const nowIso = new Date(nowMs).toISOString()
      for (const existing of state.devices) {
        if (existing.id === resolvedDeviceId && !existing.revokedAt) {
          existing.revokedAt = nowIso
        }
      }
      state.devices.push({
        id: resolvedDeviceId,
        name: cleanDevName,
        tokenHash: sha256Hex(token),
        createdAt: nowIso,
        lastUsedAt: nowIso,
        revokedAt: null,
      })
      state.devices = state.devices.slice(-40)
      await writeAtomic(this.authFile, state)

      this.globalFailTimes = []
      this.ipAttempts.delete(String(clientIp || 'unknown'))

      return {
        ok: true,
        token,
        deviceId: resolvedDeviceId,
        deviceName: cleanDevName,
        vaultName: state.vaultName,
      }
    })
  }
}
