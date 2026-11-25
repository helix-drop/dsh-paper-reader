import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib'
import { exportBookmarks } from '../modules/pipeline/bookmarks.js'
import { CloudSyncStore } from './store.mjs'
import { CloudAuthStore } from './auth.mjs'
import { renderPdfPage } from './pdf-renderer.mjs'

const gzipAsync = promisify(gzip)
const brotliAsync = promisify(brotliCompress)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const DEFAULT_STATIC_DIR = path.join(ROOT_DIR, 'mobile-app', 'www')

const MAX_JSON_BYTES = 128 * 1024 * 1024
const MAX_CHUNK_BYTES = 32 * 1024 * 1024
const MAX_PDF_BYTES = Number(process.env.MAX_PDF_BYTES || 4 * 1024 * 1024 * 1024)

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdf': 'application/pdf',
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-dsh-vault')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-max-age', '86400')
}

async function sendJson(res, status, value, req = null) {
  setCors(res)
  const raw = Buffer.from(JSON.stringify(value), 'utf8')
  const ae = req ? String(req.headers['accept-encoding'] ?? '') : ''
  if (raw.length >= 1024) {
    if (/\bbr\b/i.test(ae)) {
      const br = await brotliAsync(raw, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
      })
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'br',
        'vary': 'Accept-Encoding',
        'content-length': String(br.length),
        'cache-control': 'no-store',
      })
      res.end(br)
      return
    }
    if (/\bgzip\b/i.test(ae)) {
      const gz = await gzipAsync(raw, { level: 6 })
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'vary': 'Accept-Encoding',
        'content-length': String(gz.length),
        'cache-control': 'no-store',
      })
      res.end(gz)
      return
    }
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(raw.length),
    'cache-control': 'no-store',
  })
  res.end(raw)
}

async function readBody(req, limit = MAX_JSON_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('请求内容超过大小限制')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function streamBodyToFile(req, destFile, limit = MAX_PDF_BYTES) {
  await fs.mkdir(path.dirname(destFile), { recursive: true })
  const ws = createWriteStream(destFile, { mode: 0o600, flags: 'wx' })
  const hasher = createHash('sha256')
  let total = 0
  try {
    for await (const chunk of req) {
      total += chunk.length
      if (total > limit) throw new Error('请求内容超过大小限制')
      hasher.update(chunk)
      if (!ws.write(chunk)) {
        await new Promise((resolve, reject) => {
          ws.once('drain', resolve)
          ws.once('error', reject)
        })
      }
    }
    await new Promise((resolve, reject) => {
      ws.end(resolve)
      ws.once('error', reject)
    })
    return { bytesLen: total, sha256: hasher.digest('hex') }
  } catch (err) {
    ws.destroy()
    await fs.unlink(destFile).catch(() => {})
    throw err
  }
}

async function readJsonBody(req, limit = MAX_JSON_BYTES) {
  const raw = await readBody(req, limit)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('JSON 请求体格式无效')
  }
}

function clientIpFromReq(req) {
  const realIp = String(req?.headers?.['x-real-ip'] ?? '').trim()
  if (realIp) return realIp
  const xff = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()
  return xff || req?.socket?.remoteAddress || 'unknown'
}

export async function resolveOrCreateToken(dataDir, explicitToken) {
  if (explicitToken && String(explicitToken).trim()) {
    return String(explicitToken).trim()
  }
  const tokenFile = path.join(dataDir, 'sync-token.txt')
  try {
    const existing = (await fs.readFile(tokenFile, 'utf8')).trim()
    if (existing) return existing
  } catch {}
  await fs.mkdir(dataDir, { recursive: true })
  const generated = randomBytes(24).toString('hex')
  await fs.writeFile(tokenFile, generated + '\n', { mode: 0o600 })
  return generated
}

async function servePdfWithRange(req, res, filePath) {
  const stat = await fs.stat(filePath)
  const total = stat.size
  setCors(res)
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Math.min(total - 1, Number(m[2])) : total - 1
      if (start <= end && start < total) {
        res.writeHead(206, {
          'content-type': 'application/pdf',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': end - start + 1,
          'x-content-type-options': 'nosniff',
        })
        createReadStream(filePath, { start, end }).pipe(res)
        return
      }
    }
  }
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'accept-ranges': 'bytes',
    'content-length': total,
    'x-content-type-options': 'nosniff',
  })
  createReadStream(filePath).pipe(res)
}

export async function createSyncServer(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.SYNC_DATA_DIR ?? path.join(__dirname, 'data'))
  const staticDir = path.resolve(options.staticDir ?? DEFAULT_STATIC_DIR)
  const disablePublicWeb = options.disablePublicWeb ?? process.env.DISABLE_PUBLIC_WEB === '1'
  const pythonBin = options.pythonBin ?? process.env.PYTHON_BIN ?? 'python3'
  const token = await resolveOrCreateToken(dataDir, options.token ?? process.env.SYNC_TOKEN)
  const store = new CloudSyncStore(dataDir)
  const authStore = new CloudAuthStore(dataDir, token, { vaultName: options.vaultName, now: options.now })
  await authStore.init()
  void store.cleanupStaleUploads().catch(() => {})

  const routes = [
    // Auth & pairing endpoints
    {
      method: 'POST',
      pattern: /^\/sync\/auth\/pair$/,
      public: true,
      handler: async req => {
        const body = await readJsonBody(req, 64 * 1024)
        return authStore.redeemPairingCode({
          code: body.code,
          vaultName: body.vaultName,
          deviceId: body.deviceId,
          deviceName: body.deviceName,
          clientIp: clientIpFromReq(req),
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/sync\/auth\/status$/,
      rootOnly: true,
      handler: async () => authStore.publicStatus(),
    },
    {
      method: 'POST',
      pattern: /^\/sync\/auth\/bind-vault$/,
      rootOnly: true,
      handler: async req => {
        const body = await readJsonBody(req, 64 * 1024)
        return authStore.bindVault(body.vaultName, { force: body.force === true })
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/auth\/pairing-toggle$/,
      rootOnly: true,
      handler: async req => {
        const body = await readJsonBody(req, 64 * 1024)
        return authStore.setPairingEnabled(body.enabled)
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/auth\/pair-code$/,
      rootOnly: true,
      handler: async req => {
        const body = await readJsonBody(req, 64 * 1024)
        return authStore.generatePairingCode({ deviceHint: body.deviceHint, ttlMs: body.ttlMs })
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/auth\/revoke-device$/,
      rootOnly: true,
      handler: async req => {
        const body = await readJsonBody(req, 64 * 1024)
        return authStore.revokeDevice(body.deviceId)
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/auth\/rotate-root$/,
      rootOnly: true,
      handler: async req => {
        const body = await readJsonBody(req, 64 * 1024)
        return authStore.rotateRootKey(body.rootKey)
      },
    },

    // Sync endpoints
    {
      method: 'GET',
      pattern: /^\/sync\/health$/,
      handler: async (req, _res, _url, _m, authCtx) => {
        const lib = await store.readLibraryState()
        return {
          ok: true,
          service: 'dsh-paper-reader-sync',
          documents: lib.documents.length,
          vaultName: authCtx?.vaultName ?? '',
          role: authCtx?.role ?? 'root',
          deviceName: authCtx?.deviceName ?? '',
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/sync\/pull-state$/,
      handler: async () => store.pullState(),
    },
    {
      method: 'GET',
      pattern: /^\/sync\/notices$/,
      handler: async () => ({ notices: await store.listPipelineNotices() }),
    },
    {
      method: 'POST',
      pattern: /^\/sync\/push-state$/,
      handler: async req => store.pushState(await readJsonBody(req)),
    },
    {
      method: 'POST',
      pattern: /^\/sync\/push-bundle$/,
      handler: async req => store.pushBundle(await readJsonBody(req)),
    },
    {
      method: 'POST',
      pattern: /^\/sync\/push-pdf\/([^/]+)$/,
      handler: async (req, _res, url, m) => {
        const taskId = decodeURIComponent(m[1])
        const tmpFile = path.join(store.bookDir(taskId), `source.pdf.${randomUUID()}.tmp`)
        try {
          const { bytesLen, sha256 } = await streamBodyToFile(req, tmpFile, MAX_PDF_BYTES)
          const expectedSha = url.searchParams.get('sha256') ?? ''
          if (expectedSha && expectedSha !== sha256) {
            throw new Error('PDF 校验失败（SHA-256 不匹配）')
          }
          return await store.savePdfFromFile(taskId, tmpFile, bytesLen, expectedSha || sha256)
        } finally {
          await fs.unlink(tmpFile).catch(() => {})
        }
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/push-pdf-chunk\/([^/]+)$/,
      handler: async (req, _res, url, m) => {
        const taskId = decodeURIComponent(m[1])
        const uploadId = url.searchParams.get('uploadId') ?? ''
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const totalBytes = Number(url.searchParams.get('total') ?? 0)
        if (totalBytes > MAX_PDF_BYTES) throw new Error('请求内容超过大小限制')
        const chunk = await readBody(req, MAX_CHUNK_BYTES)
        if (offset + chunk.length > MAX_PDF_BYTES) throw new Error('请求内容超过大小限制')
        return store.writePdfChunk(taskId, { uploadId, offset, chunk, totalBytes })
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/commit-pdf\/([^/]+)$/,
      handler: async (req, _res, _url, m) => {
        const taskId = decodeURIComponent(m[1])
        const body = await readJsonBody(req)
        return store.commitPdfUpload(taskId, body)
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/link-pdf\/([^/]+)$/,
      handler: async (req, _res, _url, m) => {
        const taskId = decodeURIComponent(m[1])
        const { sha256 } = await readJsonBody(req)
        return store.linkPdfBySha(taskId, sha256)
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/delete-tasks$/,
      handler: async req => {
        const { taskIds } = await readJsonBody(req)
        return store.deleteTasks(taskIds)
      },
    },
    {
      method: 'POST',
      pattern: /^\/sync\/prune$/,
      handler: async req => store.pruneCache(await readJsonBody(req).catch(() => ({}))),
    },

    // Reader & Pipeline compatible endpoints
    {
      method: 'GET',
      pattern: /^\/pipeline\/library$/,
      handler: async () => store.libraryPayload(),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/folders$/,
      handler: async () => {
        const state = await store.readLibraryState()
        return { folders: state.folders, meta: state.itemMeta }
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/folders$/,
      handler: async req => {
        const { id, name } = await readJsonBody(req)
        return store.saveFolder(id, name)
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/pipeline\/folders\/([^/]+)$/,
      handler: async (_req, _res, _url, m) => store.deleteFolder(decodeURIComponent(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/items\/([^/]+)\/meta$/,
      handler: async (req, _res, _url, m) => store.setItemMeta(
        decodeURIComponent(m[1]),
        await readJsonBody(req),
      ),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/progress$/,
      handler: async (_req, _res, url) => {
        const docId = url.searchParams.get('documentId') ?? ''
        if (docId) return { entry: await store.progressStore.get(docId) }
        return { items: await store.progressStore.list() }
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/progress$/,
      handler: async req => {
        const body = await readJsonBody(req)
        return store.progressStore.put(body, { force: body?.force === true })
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/bookmarks$/,
      handler: async (_req, _res, url) => ({
        bookmarks: await store.bookmarkStore.list({
          documentId: url.searchParams.get('documentId') ?? '',
          q: url.searchParams.get('q') ?? '',
        }),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/highlights$/,
      handler: async (_req, _res, url) => ({
        marks: await store.readingMarks({
          kind: url.searchParams.get('kind') ?? 'task',
          id: url.searchParams.get('id') ?? '',
        }),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/search$/,
      handler: async (_req, _res, url) => store.searchLibrary({
        q: url.searchParams.get('q') ?? '',
        taskId: url.searchParams.get('taskId') ?? '',
        view: url.searchParams.get('view') ?? 'all',
        includeHidden: url.searchParams.get('includeHidden') === '1',
        limitBooks: Number(url.searchParams.get('limitBooks') ?? 30) || 30,
        maxMatchesPerBook: Number(url.searchParams.get('maxMatches') ?? 6) || 6,
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/bookmarks$/,
      handler: async req => store.saveSelectionBookmark(await readJsonBody(req)),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/bookmarks\/export$/,
      handler: async (_req, res, url) => {
        const format = url.searchParams.get('format') === 'markdown' ? 'markdown' : 'json'
        const marks = await store.bookmarkStore.list({
          documentId: url.searchParams.get('documentId') ?? '',
          q: url.searchParams.get('q') ?? '',
        })
        setCors(res)
        res.writeHead(200, {
          'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="bookmarks.${format === 'json' ? 'json' : 'md'}"`,
        })
        res.end(exportBookmarks(marks, format))
        return null
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/reading$/,
      handler: async (_req, _res, url, m) => store.getReading(decodeURIComponent(m[1]), {
        includeGlossary: url.searchParams.get('glossary') === '1',
        slimBlocks: url.searchParams.get('lean') === '1',
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/corrections$/,
      handler: async (req, _res, _url, m) => store.correctReading(
        decodeURIComponent(m[1]),
        await readJsonBody(req),
      ),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/cover$/,
      handler: async (req, res, _url, m) => {
        try {
          const asset = await store.getAsset(decodeURIComponent(m[1]), '__cover__.jpg')
          setCors(res)
          res.writeHead(200, {
            'content-type': asset.mimeType || 'image/jpeg',
            'content-length': String(asset.bytes.length),
            'cache-control': 'private, max-age=86400',
            'x-content-type-options': 'nosniff',
          })
          res.end(asset.bytes)
          return null
        } catch (err) {
          return sendJson(res, 404, { error: String(err?.message ?? '静态封面不存在') }, req)
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/asset$/,
      handler: async (_req, res, url, m) => {
        const { bytes, mimeType } = await store.getAsset(
          decodeURIComponent(m[1]),
          url.searchParams.get('path') ?? '',
        )
        setCors(res)
        res.writeHead(200, {
          'content-type': mimeType,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        })
        res.end(bytes)
        return null
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/source$/,
      handler: async (req, res, _url, m) => {
        const file = await store.pdfPath(decodeURIComponent(m[1]))
        await servePdfWithRange(req, res, file)
        return null
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/pdf-page\/(\d+)$/,
      handler: async (req, res, url, m) => {
        const taskId = decodeURIComponent(m[1])
        const page = Number(m[2])
        const dpi = Number(url.searchParams.get('dpi') ?? 180)
        const reqFormat = url.searchParams.get('format')
        const isThumbDefault = !reqFormat && page === 1 && dpi <= 120
        const format = reqFormat === 'jpeg' || reqFormat === 'jpg' || isThumbDefault ? 'jpeg' : 'png'
        const maxWidth = url.searchParams.has('maxWidth')
          ? Math.max(0, Math.min(2400, Number(url.searchParams.get('maxWidth')) || 0))
          : (isThumbDefault ? 480 : 0)
        const pdfFile = await store.pdfPath(taskId)
        const result = await renderPdfPage({
          pdfFile,
          cacheDir: path.join(store.bookDir(taskId), 'pdf-pages'),
          page,
          dpi: isThumbDefault ? Math.min(dpi, 96) : dpi,
          format,
          maxWidth,
          pythonBin,
        })
        if (!result.supported) {
          await sendJson(res, 501, { error: result.reason, fallback: 'pdf' }, req)
          return null
        }
        setCors(res)
        res.writeHead(200, {
          'content-type': result.mimeType || 'image/png',
          'content-length': String(result.bytes.length),
          'cache-control': 'public, max-age=86400',
          'x-content-type-options': 'nosniff',
        })
        res.end(result.bytes)
        return null
      },
    },
  ]

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      setCors(res)
      res.writeHead(204)
      return res.end()
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true }, req)
    }

    if (url.pathname.startsWith('/api/paper-reader')) {
      setCors(res)
      const rest = url.pathname.slice('/api/paper-reader'.length) || '/'
      try {
        for (const route of routes) {
          if (route.method !== req.method) continue
          const m = rest.match(route.pattern)
          if (!m) continue
          let authCtx = null
          if (!route.public) {
            authCtx = await authStore.authenticateRequest(req)
            if (!authCtx.ok) {
              return sendJson(res, 401, { error: '同步凭证无效或已失效，请在手机端输入电脑端 6 位动态配对码重新配对' }, req)
            }
            const vaultCheck = await authStore.checkVaultMatch(req)
            if (!vaultCheck.ok) {
              return sendJson(res, vaultCheck.status, {
                error: vaultCheck.error,
                expectedVaultName: vaultCheck.expectedVaultName,
              }, req)
            }
            if (route.rootOnly && authCtx.role !== 'root') {
              return sendJson(res, 403, { error: '此操作仅限电脑端根恢复密钥执行' }, req)
            }
          }
          const out = await route.handler(req, res, url, m, authCtx)
          if (out !== null && !res.writableEnded) await sendJson(res, 200, out, req)
          return
        }
        const authCtx = await authStore.authenticateRequest(req)
        if (!authCtx.ok) {
          return sendJson(res, 401, { error: '同步凭证无效或已失效，请在手机端输入电脑端 6 位动态配对码重新配对' }, req)
        }
        return sendJson(res, 404, { error: 'not-found: ' + rest }, req)
      } catch (err) {
        const msg = String(err?.message ?? err)
        const status = Number.isInteger(err?.status)
          ? err.status
          : (/不存在|未同步|找不到|无效|不能为空/.test(msg) ? 400 : 500)
        return sendJson(res, status, { error: msg }, req)
      }
    }

    // Static web/PWA mobile reader assets (disabled when DISABLE_PUBLIC_WEB=1 on exposed VPS)
    if (!disablePublicWeb && existsSync(staticDir)) {
      const reqPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
      const resolved = path.resolve(staticDir, '.' + reqPath)
      if (resolved.startsWith(staticDir + path.sep) || resolved === staticDir) {
        try {
          const st = await fs.stat(resolved)
          if (st.isFile()) {
            const ext = path.extname(resolved).toLowerCase()
            const raw = await fs.readFile(resolved)
            const compressible = ['.html', '.js', '.mjs', '.css', '.json', '.svg'].includes(ext)
            const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))
            if (compressible && acceptsGzip && raw.length >= 1024) {
              const gz = await gzipAsync(raw, { level: 6 })
              res.writeHead(200, {
                'content-type': MIME_TYPES[ext] || 'application/octet-stream',
                'content-encoding': 'gzip',
                'vary': 'Accept-Encoding',
                'content-length': String(gz.length),
                'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
              })
              return res.end(gz)
            }
            res.writeHead(200, {
              'content-type': MIME_TYPES[ext] || 'application/octet-stream',
              'content-length': String(raw.length),
              'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
            })
            return res.end(raw)
          }
        } catch {}
      }
      // SPA fallback
      const indexFile = path.join(staticDir, 'index.html')
      if (existsSync(indexFile)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        return res.end(await fs.readFile(indexFile))
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  })

  server.requestTimeout = 0
  return { server, store, authStore, token, dataDir }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4180)
  const host = process.env.HOST || '0.0.0.0'
  const { server, token, dataDir } = await createSyncServer()
  server.listen(port, host, () => {
    console.log(`[DSH Paper Reader Cloud Sync] Listening on http://${host}:${port}`)
    console.log(`[DSH Paper Reader Cloud Sync] Data dir: ${dataDir}`)
    console.log(`[DSH Paper Reader Cloud Sync] Bearer token: ${token}`)
  })
}
