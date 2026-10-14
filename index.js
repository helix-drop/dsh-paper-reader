/**
 * Host half of @local/paper-reader — 统一文档处理与阅读组合根。
 *
 * 全部文档（书籍、论文、章节节选、文章合集；扫描件与原生文字层 PDF、现成 Markdown）
 * 统一经由 modules/pipeline/ 处理：
 *   - 工具：document_pipeline（inspect / task / run）
 *   - 预设：reading-document（受控 6 工具白名单 + sessionGuard 角色/阶段/路径门禁）
 *   - 路由：/api/paper-reader/pipeline/*
 *
 * 历史已完成论文 JSON（shared/paths.js 指向的阅读工作区）仅由 modules/pipeline/papers.js
 * 单向导入为只读阅读记录，不再维护旧版 pdf_paper 工具与 A–F 会话转写流。
 */
import { mkdirSync } from 'node:fs'
import { pinReadingWorkspace } from './shared/paths.js'
import { installPipelineModule } from './modules/pipeline/index.js'

export const inject = ['tools', 'webServer']

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * @param ctx - Host 上下文
 * @param config - 插件配置；`pipelineWorkspace` 指定 K-PdfToMd 根目录，`workspace` 指定历史论文阅读目录
 */
export function apply(ctx, config) {
  const workspace = pinReadingWorkspace(config)
  try {
    mkdirSync(workspace, { recursive: true })
  } catch { /* 目录不可创建时交由具体读写处理 */ }

  const routes = installPipelineModule(ctx, config)
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const rest = url.pathname.slice('/api/paper-reader'.length) || '/'
    try {
      for (const route of routes) {
        if (route.method !== req.method) continue
        const m = rest.match(route.pattern)
        if (m) return await route.handler(req, res, url, m)
      }
      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/paper-reader', handler }), 'paper-reader: 统一文档流水线路由')
}
