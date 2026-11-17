import http from 'node:http'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { exportBookmarks } from '../modules/pipeline/bookmarks.js'
import { CloudSyncStore } from './store.mjs'
import { renderPdfPage } from './pdf-renderer.mjs'

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
  res.setHeader('access-control-allow-headers', 'authorization, content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
}

function sendJson(res, status, value) {
  setCors(res)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
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

function checkBearer(req, expectedToken) {
  const header = String(req.headers.authorization ?? '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const got = Buffer.from(match[1].trim(), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  if (got.length !== expected.length) return false
  return timingSafeEqual(got, expected)
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
  const pythonBin = options.pythonBin ?? process.env.PYTHON_BIN ?? 'python3'
  const token = await resolveOrCreateToken(dataDir, options.token ?? process.env.SYNC_TOKEN)
  const store = new CloudSyncStore(dataDir)

  const routes = [
    // Sync endpoints
    {
      method: 'GET',
      pattern: /^\/sync\/health$/,
      handler: async () => {
        const lib = await store.readLibraryState()
        return { ok: true, service: 'dsh-paper-reader-sync', documents: lib.documents.length }
      },
    },
    {
      method: 'GET',
      pattern: /^\/sync\/pull-state$/,
      handler: async () => store.pullState(),
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
      handler: async (_req, _res, _url, m) => store.getReading(decodeURIComponent(m[1])),
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
      handler: async (_req, res, url, m) => {
        const taskId = decodeURIComponent(m[1])
        const page = Number(m[2])
        const dpi = Number(url.searchParams.get('dpi') ?? 180)
        const pdfFile = await store.pdfPath(taskId)
        const result = await renderPdfPage({
          pdfFile,
          cacheDir: path.join(store.bookDir(taskId), 'pdf-pages'),
          page,
          dpi,
          pythonBin,
        })
        if (!result.supported) {
          sendJson(res, 501, { error: result.reason, fallback: 'pdf' })
          return null
        }
        setCors(res)
        res.writeHead(200, {
          'content-type': 'image/png',
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
      return sendJson(res, 200, { ok: true })
    }

    if (url.pathname.startsWith('/api/paper-reader')) {
      if (!checkBearer(req, token)) {
        return sendJson(res, 401, { error: '同步密钥无效或未提供 Authorization: Bearer Token' })
      }
      const rest = url.pathname.slice('/api/paper-reader'.length) || '/'
      try {
        for (const route of routes) {
          if (route.method !== req.method) continue
          const m = rest.match(route.pattern)
          if (!m) continue
          const out = await route.handler(req, res, url, m)
          if (out !== null && !res.writableEnded) sendJson(res, 200, out)
          return
        }
        return sendJson(res, 404, { error: 'not-found: ' + rest })
      } catch (err) {
        const msg = String(err?.message ?? err)
        const status = /不存在|未同步|找不到|无效/.test(msg) ? 400 : 500
        return sendJson(res, status, { error: msg })
      }
    }

    // Static web/PWA mobile reader assets
    if (existsSync(staticDir)) {
      const reqPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
      const resolved = path.resolve(staticDir, '.' + reqPath)
      if (resolved.startsWith(staticDir + path.sep) || resolved === staticDir) {
        try {
          const st = await fs.stat(resolved)
          if (st.isFile()) {
            const ext = path.extname(resolved).toLowerCase()
            res.writeHead(200, {
              'content-type': MIME_TYPES[ext] || 'application/octet-stream',
              'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
            })
            return res.end(await fs.readFile(resolved))
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
  return { server, store, token, dataDir }
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
