/**
 * shared/paths.js — 阅读工作区与论文库目录解析。
 * 三个模块共用同一份目录口径,避免各自猜测工作区根。
 *
 * 阅读插件有且只有一个存储根:**阅读工作区**。默认是插件包同级的 `../papers`
 * (即 link: 安装时的 `<仓库>/papers`),可用插件 config 的 `workspace` 覆盖。
 *
 * 历史实现会去扫描 `workspaceRegistry` / 在跑会话 cwd,挑一个"正好含 papers/ 的根":
 * 数据根会随已注册工作区增减而漂移,派发时还得先在一堆会话里挑一个。现在根是钉死的,
 * 论文库就是阅读工作区目录本身;阅读会话也建在这个工作区里(cwd = 工作区 path)。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包目录(本文件位于 `<包>/shared/`) */
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认阅读工作区:`<包>/../papers`。 */
export const DEFAULT_READING_WORKSPACE = path.resolve(PACKAGE_DIR, '..', 'papers')

let pinned = DEFAULT_READING_WORKSPACE

/**
 * 由组合根在 apply 时用插件 config 固定阅读工作区。
 * 只接受非空绝对路径;其余情况(缺失、相对路径、非字符串)回到默认值,避免留上一次的陈旧值。
 * @param config - 插件行 config(可缺省)
 * @returns 本次生效的阅读工作区绝对路径
 */
export function pinReadingWorkspace(config) {
  const wanted = config?.workspace
  pinned = typeof wanted === 'string' && wanted.trim() !== '' && path.isAbsolute(wanted)
    ? path.resolve(wanted.trim())
    : DEFAULT_READING_WORKSPACE
  return pinned
}

/** 阅读工作区绝对路径:既是插件的数据根,也是阅读会话的 cwd。 */
export function readingWorkspace() {
  return pinned
}

/**
 * 论文库目录:论文 JSON 与 glossary.json 就在这里,源 PDF 在其 `src/` 下。
 * `dir` 为绝对路径时原样使用(工具动作的显式存储根);否则相对阅读工作区解析,
 * 缺省即阅读工作区本身。
 *
 * `ctx` 形参仅为调用点签名一致而保留——根不再从 ctx 推断。
 */
export function papersDir(ctx, dir) {
  if (dir && path.isAbsolute(dir)) return dir
  return dir ? path.resolve(pinned, dir) : pinned
}

export function sourcesDir(ctx, dir) {
  return path.join(papersDir(ctx, dir), 'src')
}

export function glossaryPath(ctx, dir) {
  return path.join(papersDir(ctx, dir), 'glossary.json')
}
