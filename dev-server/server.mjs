import http from 'node:http'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installPipelineModule, DEFAULT_PIPELINE_ROOT } from '../modules/pipeline/index.js'
import { readingWorkspace } from '../shared/paths.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT || 4173)

const mockCtx = {
  inject: (deps, fn) => {
    if (deps.includes('agentPresets')) fn({ agentPresets: { register: async () => () => {}, list: async () => [] } })
    if (deps.includes('credentials')) fn({})
  },
  logger: { warn: console.warn, error: console.error, info: console.info },
  tools: { guard: () => {}, register: () => {} },
  on: () => {},
}

const config = {
  pipelineWorkspace: DEFAULT_PIPELINE_ROOT,
  workspace: readingWorkspace(),
}

const routes = installPipelineModule(mockCtx, config)

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  
  // 1. API routes
  if (url.pathname.startsWith('/api/paper-reader')) {
    const rest = url.pathname.slice('/api/paper-reader'.length) || '/'
    try {
      for (const route of routes) {
        if (route.method !== req.method) continue
        const m = rest.match(route.pattern)
        if (m) {
          return await route.handler(req, res, url, m)
        }
      }
      return sendJson(res, 404, { error: 'not-found: ' + rest })
    } catch (err) {
      console.error('API Error:', err)
      return sendJson(res, 500, { error: String(err?.message ?? err) })
    }
  }

  // 2. Static files
  let filePath
  if (url.pathname === '/' || url.pathname === '/index.html') {
    filePath = path.join(__dirname, 'public', 'index.html')
  } else if (url.pathname === '/client.js') {
    filePath = path.join(ROOT_DIR, 'client.js')
  } else if (url.pathname === '/icon.svg') {
    filePath = path.join(ROOT_DIR, 'icon.svg')
  } else if (url.pathname.startsWith('/vendor/')) {
    filePath = path.join(__dirname, 'public', url.pathname)
  }

  if (filePath && existsSync(filePath)) {
    const ext = path.extname(filePath)
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    const content = await fs.readFile(filePath)
    return res.end(content)
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not Found: ' + url.pathname)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[DSH Paper Reader Preview] Server running at http://127.0.0.1:${PORT}/`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
