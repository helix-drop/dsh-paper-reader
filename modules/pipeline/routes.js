import fs from 'node:fs/promises'
import path from 'node:path'
import { profileReadiness } from './profile-analysis.js'
import { deliveryState } from './task-list.js'
import { transcriptionProgress } from './progress.js'
import { reviewFeedback } from './review-feedback.js'
import { reviewMonitorHtml } from './review-monitor.js'
import { exportBookmarks } from './bookmarks.js'
import { resolveWorkspaceAsset } from '../../shared/workspace.js'
import { taskSourcePdf, loadSourceMap } from './source-map.js'
import { hash } from './markdown.js'
import { TaskManager, STAGES } from './tasks.js'
import { openLinguaGacha, adapterStatus, startSubscriptionAdapter } from './linguagacha.js'

const MAX_JSON_BODY_BYTES = 1024 * 1024
const MAX_TRANSLATION_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_SOURCE_UPLOAD_BYTES = 100 * 1024 * 1024

async function body(req, limit = MAX_JSON_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('请求内容过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function payload(req) {
  try {
    return JSON.parse((await body(req)).toString('utf8'))
  } catch {
    throw new Error('任务请求格式无效')
  }
}

function send(res, value) {
  if (value?.id && value?.stages) {
    value = {
      ...value,
      deliveryState: deliveryState(value),
      profileReadiness: profileReadiness(value),
    }
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function assetMimeType(filePath) {
  if (/\.png$/i.test(filePath)) return 'image/png'
  if (/\.gif$/i.test(filePath)) return 'image/gif'
  if (/\.webp$/i.test(filePath)) return 'image/webp'
  return 'image/jpeg'
}

export function taskRoutes(manager, registerSession) {
  return [
    // --- Legacy import, catalog & folders ---
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/adopt$/,
      handler: async (_req, res, _url, m) => send(res, await manager.adoptLegacy(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/legacy-import$/,
      handler: async (_req, res) => send(res, await manager.importLegacy()),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/detect-source$/,
      handler: async (req, res) => send(res, await manager.detectSource((await payload(req)).sourceId)),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/folders$/,
      handler: async (_req, res) => send(res, {
        folders: await manager.folders(),
        meta: await manager.itemMeta(),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/folders$/,
      handler: async (req, res) => {
        const { id, name } = await payload(req)
        send(res, await manager.saveFolder(id, name))
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/pipeline\/folders\/([^/]+)$/,
      handler: async (_req, res, _url, m) => send(res, await manager.deleteFolder(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/items\/([^/]+)\/meta$/,
      handler: async (req, res, _url, m) => send(res, await manager.setItemMeta(m[1], await payload(req))),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/library$/,
      handler: async (_req, res) => send(res, {
        documents: await manager.library(),
        folders: await manager.folders(),
        meta: await manager.itemMeta(),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/catalog$/,
      handler: async (_req, res) => send(res, {
        sources: await manager.catalog(),
        stages: STAGES,
        modelCatalog: await manager.modelCatalog(),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/upload$/,
      handler: async (req, res, url) => send(
        res,
        await manager.upload(url.searchParams.get('name'), await body(req, MAX_SOURCE_UPLOAD_BYTES)),
      ),
    },

    // --- Bookmarks & highlights ---
    {
      method: 'GET',
      pattern: /^\/pipeline\/bookmarks$/,
      handler: async (_req, res, url) => send(res, {
        bookmarks: await manager.bookmarks({
          documentId: url.searchParams.get('documentId') ?? '',
          q: url.searchParams.get('q') ?? '',
        }),
      }),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/highlights$/,
      handler: async (_req, res, url) => send(res, {
        marks: await manager.readingMarks({
          kind: url.searchParams.get('kind') ?? 'task',
          id: url.searchParams.get('id') ?? '',
        }),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/bookmarks$/,
      handler: async (req, res) => send(res, await manager.saveSelectionBookmark(await payload(req))),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/bookmarks\/export$/,
      handler: async (_req, res, url) => {
        const format = url.searchParams.get('format') === 'markdown' ? 'markdown' : 'json'
        const marks = await manager.bookmarks({
          documentId: url.searchParams.get('documentId') ?? '',
          q: url.searchParams.get('q') ?? '',
        })
        res.writeHead(200, {
          'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="bookmarks.${format === 'json' ? 'json' : 'md'}"`,
        })
        res.end(exportBookmarks(marks, format))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/bookmarks$/,
      handler: async (req, res, _url, m) => send(res, await manager.bookmark(m[1], await payload(req))),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/progress$/,
      handler: async (_req, res, url) => send(
        res,
        await manager.getReadingProgress(url.searchParams.get('documentId') ?? ''),
      ),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/progress$/,
      handler: async (req, res) => send(res, await manager.saveReadingProgress(await payload(req))),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/sync\/status$/,
      handler: async (_req, res) => send(res, await manager.cloudSyncStatus()),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/sync\/config$/,
      handler: async (req, res) => send(res, await manager.saveCloudSync(await payload(req))),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/sync\/now$/,
      handler: async (req, res) => send(
        res,
        await manager.syncCloud(await payload(req).catch(() => ({}))),
      ),
    },

    // --- Models, adapters & LinguaGacha service ---
    {
      method: 'GET',
      pattern: /^\/pipeline\/subscription-adapter$/,
      handler: async (_req, res) => send(res, await adapterStatus()),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/subscription-adapter$/,
      handler: async (req, res) => send(
        res,
        await startSubscriptionAdapter(manager.root, (await payload(req)).kind),
      ),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/translation-model$/,
      handler: async (req, res) => send(
        res,
        await manager.selectTranslationModel((await payload(req)).profile),
      ),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/translation-concurrency$/,
      handler: async (req, res) => send(
        res,
        await manager.translationConcurrency((await payload(req)).concurrency),
      ),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/translation-service$/,
      handler: async (_req, res) => send(res, await manager.cliStatus()),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/translation-service\/open$/,
      handler: async (_req, res) => send(res, openLinguaGacha()),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/models$/,
      handler: async (_req, res) => send(res, await manager.modelCatalog()),
    },

    // --- Task CRUD, sessions & execution ---
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks$/,
      handler: async (_req, res, url) => send(res, {
        ...(await manager.listPage({
          q: url.searchParams.get('q') ?? '',
          offset: url.searchParams.get('offset'),
          limit: url.searchParams.get('limit'),
          category: url.searchParams.get('category') ?? 'all',
          folderId: url.searchParams.get('folderId') ?? 'all',
          includeHidden: url.searchParams.get('includeHidden') !== 'false',
        })),
        folders: await manager.folders(),
        meta: await manager.itemMeta(),
      }),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks$/,
      handler: async (req, res) => {
        const t = await manager.create(await payload(req))
        if (manager.requireExecutionSessions && !manager.sessionMonitor) {
          throw new Error('任务已保存，会话服务尚未就绪；恢复后可打开原任务')
        }
        await manager.sessionMonitor?.ensure(t)
        send(res, t)
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)$/,
      handler: async (_req, res, _url, m) => {
        const t = await manager.get(m[1])
        send(res, {
          ...t,
          executionSessions: await manager.sessionMonitor?.status(t.id),
          transcriptionProgress: await transcriptionProgress(t, manager.dir(t.id)),
          stuckPages: t.input?.type === 'pdf' ? await manager.listStuckPages(t) : [],
          reviewFeedback: await reviewFeedback(manager, t).catch(e => ({
            error: '无法读取审校反馈：' + e.message,
          })),
        })
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/pipeline\/tasks\/([^/]+)$/,
      handler: async (_req, res, _url, m) => send(res, await manager.deleteTask(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/name$/,
      handler: async (req, res, _url, m) => send(res, await manager.rename(m[1], (await payload(req)).name)),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/open-source$/,
      handler: async (_req, res, _url, m) => send(res, await manager.openSource(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/reset-transcription$/,
      handler: async (req, res, _url, m) => {
        const opts = await payload(req).catch(() => ({}))
        send(res, await manager.resetTranscription(m[1], opts))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/retry-stuck-pages$/,
      handler: async (req, res, _url, m) => send(
        res,
        await manager.retryStuckPages(m[1], (await payload(req)).workerId),
      ),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/sessions$/,
      handler: async (req, res, _url, m) => {
        const t = await manager.get(m[1])
        const b = await payload(req)
        if (!manager.sessionMonitor) throw new Error('DSH 会话服务尚未就绪，任务未派发')
        if (b.stage && !STAGES.some(s => s.id === b.stage) && b.stage !== 'diagnose') {
          throw new Error('会话授权阶段无效')
        }
        if (b.resetOrchestrator && manager.active.has(t.id)) {
          throw new Error('任务运行中不能更换编排会话')
        }
        const data = b.resetOrchestrator
          ? await manager.sessionMonitor.rotateOrchestrator(t, b.stage ?? null)
          : (b.stage ? await manager.sessionMonitor.authorize(t, b.stage) : await manager.sessionMonitor.ensure(t))
        await manager.sessionMonitor.attempt(async () => {
          await manager.sessionMonitor.observe(t)
          await manager.sessionMonitor.scan(t)
        }, t.id)
        send(res, { ...data, error: (await manager.sessionMonitor.status(t.id)).error })
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/session$/,
      handler: async (req, res, _url, m) => {
        await manager.get(m[1])
        const { sessionId, mode, stage } = await payload(req)
        await registerSession(sessionId, m[1], mode === 'inspect' ? 'inspect' : 'processing', stage)
        send(res, { ok: true })
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/confirm-phase$/,
      handler: async (req, res, _url, m) => send(res, await manager.confirmPhase(m[1], await payload(req))),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/worker$/,
      handler: async (req, res, _url, m) => {
        const b = await payload(req)
        if (Array.isArray(b.fallbackIds)) return send(res, await manager.updateFallbacks(m[1], b.fallbackIds))
        return send(res, await manager.updateWorker(m[1], b.workerId))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/concurrency$/,
      handler: async (req, res, _url, m) => {
        const b = await payload(req)
        send(res, await manager.updateConcurrency(m[1], b.concurrency, b.pageConcurrency))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/profile$/,
      handler: async (req, res, _url, m) => send(res, await manager.updateProfile(m[1], await payload(req))),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/structure$/,
      handler: async (_req, res, _url, m) => send(res, await manager.structureCandidates(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/structure$/,
      handler: async (req, res, _url, m) => send(res, await manager.confirmStructure(m[1], await payload(req))),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/run$/,
      handler: async (req, res, _url, m) => {
        const args = await payload(req)
        const binding = await manager.sessionMonitor?.status(m[1])
        const sessionId = args.sessionId ?? binding?.sessions?.orchestrator
        if (!['review', 'publish'].includes(args.stage) && manager.requireExecutionSessions && !sessionId) {
          throw new Error('处理任务必须派发到编排者 session 执行')
        }
        send(res, await manager.start(m[1], args.stage, args.options ?? {}, sessionId ? { sessionId } : {}))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/stop$/,
      handler: async (_req, res, _url, m) => send(res, await manager.stop(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/connection$/,
      handler: async (req, res, _url, m) => send(
        res,
        await manager.setConnection(m[1], (await payload(req)).url),
      ),
    },

    // --- Review, reading, source-map & publication ---
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/review-feedback$/,
      handler: async (_req, res, _url, m) => {
        const t = await manager.get(m[1])
        send(res, {
          task: { name: t.name, state: t.state, stage: t.stage, message: t.message },
          p: await reviewFeedback(manager, t),
        })
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/review-monitor$/,
      handler: async (_req, res, _url, m) => {
        await manager.get(m[1])
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(reviewMonitorHtml)
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/review$/,
      handler: async (_req, res, _url, m) => {
        await manager.get(m[1])
        send(res, { text: await fs.readFile(path.join(manager.dir(m[1]), 'review/report.md'), 'utf8') })
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/review-audit$/,
      handler: async (req, res, _url, m) => {
        const b = await payload(req)
        const result = b.action === 'agy'
          ? await manager.runAgyReviewAudit(m[1], b)
          : b.action === 'assemble'
            ? await manager.assembleReviewAudit(m[1], b)
            : b.action === 'apply'
              ? await manager.applyReviewAudit(m[1], b)
              : await manager.prepareReviewAudit(m[1], b)
        send(res, result)
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/review-config$/,
      handler: async (req, res, _url, m) => send(res, await manager.updateReviewConfig(m[1], await payload(req))),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/source$/,
      handler: async (_req, res, _url, m) => {
        const t = await manager.get(m[1])
        const source = await taskSourcePdf(manager, t)
        if (!source) throw new Error('此任务没有源PDF')
        const bytes = await fs.readFile(source)
        if (!t.legacy && t.input.fingerprint && hash(bytes) !== t.input.fingerprint) {
          throw new Error('源文件已变化，重新检查后再预览')
        }
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'x-content-type-options': 'nosniff',
        })
        res.end(bytes)
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/reading$/,
      handler: async (_req, res, _url, m) => send(res, await manager.reading(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/source-map$/,
      handler: async (req, res, url, m) => {
        let map
        try {
          map = JSON.parse((await body(req, MAX_TRANSLATION_UPLOAD_BYTES)).toString('utf8'))
        } catch {
          throw new Error('来源映射格式无效')
        }
        send(
          res,
          await manager.importSourceMap(
            m[1],
            url.searchParams.get('view') ?? 'original',
            map,
            url.searchParams.get('pdfSourceId') ?? '',
          ),
        )
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/source-map$/,
      handler: async (_req, res, url, m) => {
        const t = await manager.get(m[1])
        const file = url.searchParams.get('view') === 'translation' ? t.translationPath : await manager.original(t)
        if (!file) throw new Error('尚无对应译文')
        const map = await loadSourceMap(manager, file, await fs.readFile(file, 'utf8'))
        if (!map) throw new Error('当前文档没有来源映射')
        const { pdfPath: _pdfPath, ...data } = map
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="document.md.source-map.json"',
        })
        res.end(JSON.stringify(data, null, 2))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/corrections$/,
      handler: async (req, res, _url, m) => send(res, await manager.correctReading(m[1], await payload(req))),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/zh-convert$/,
      handler: async (req, res, _url, m) => {
        const b = await payload(req).catch(() => ({}))
        send(res, await manager.convertTraditionalToSimplified(m[1], b))
      },
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/translation$/,
      handler: async (req, res, _url, m) => send(
        res,
        await manager.importTranslation(m[1], await body(req, MAX_TRANSLATION_UPLOAD_BYTES)),
      ),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/publication-preview$/,
      handler: async (_req, res, _url, m) => send(res, await manager.publicationPreview(m[1])),
    },
    {
      method: 'POST',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/publish$/,
      handler: async (req, res, _url, m) => send(res, await manager.publish(m[1], (await payload(req)).accepted)),
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/download$/,
      handler: async (_req, res, url, m) => {
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="document.md"',
        })
        res.end(await manager.readingDownload(m[1], url.searchParams.get('kind')))
      },
    },
    {
      method: 'GET',
      pattern: /^\/pipeline\/tasks\/([^/]+)\/asset$/,
      handler: async (_req, res, url, m) => {
        const t = await manager.get(m[1])
        const original = t.legacy && url.searchParams.get('kind') !== 'original'
          ? t.legacy.artifacts.readingPath
          : await manager.original(t)
        const base = await fs.realpath(path.dirname(original))
        const wanted = resolveWorkspaceAsset(manager.root, base, url.searchParams.get('path'))
        const real = await fs.realpath(wanted)
        const allowedRoots = [manager.root, manager.readingRoot, manager.publishRoot]
        if (!allowedRoots.some(root => real.startsWith(root + path.sep)) || !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(real)) {
          throw new Error('附件路径无效')
        }
        if (/\.svg$/i.test(real)) throw new Error('SVG 请从原文 Markdown 查看')
        res.writeHead(200, {
          'content-type': assetMimeType(real),
          'x-content-type-options': 'nosniff',
        })
        res.end(await fs.readFile(real))
      },
    },
  ]
}

export { TaskManager }
