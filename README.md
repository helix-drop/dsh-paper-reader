# @local/paper-reader — 统一文档处理与双语精读工作台

书籍、论文、章节节选与文章合集共用唯一的 DSH 统一文档流水线（`modules/pipeline/`），不再维护旧版 `pdf_paper` 工具与 A–F 会话转写流。历史已完成论文（`papers/*.json`）与书籍（`Book/*`）通过单向只读导入接入文献库。

> [!TIP]
> 完整技术规格、15 阶段状态机机理、Agent 工具动作入参规范及阻塞排障 SOP，请参阅：  
> 📖 **[统一流水线完整技术手册与编排指南 (docs/PIPELINE-MANUAL.md)](docs/PIPELINE-MANUAL.md)**

---

## 1. 架构与入口

| 组件 | 位置 | 职责 |
|---|---|---|
| 组合根 | `index.js` | 绑定阅读目录并挂载 `installPipelineModule(ctx, config)`（`/api/paper-reader/pipeline/*`） |
| 编排工具与守卫 | `modules/pipeline/index.js` + `guard.js` | 注册 `document_pipeline`、`reading-document` Agent 预设与 `sessionGuard` 权限门禁 |
| 任务状态机 | `modules/pipeline/tasks.js` + `tasks/*.js` | 管理 `.pipeline/tasks/<uuid>/` 的 15 个受控阶段，按领域拆分转写、翻译、审校与发布，调度 Python 脚本与 LinguaGacha CLI |
| 阅读与书签 | `modules/pipeline/reader.js` + `bookmarks.js` + `markdown.js` | 原文/译文块级配对、脚注索引、勘误与跨版本书签 |
| 历史成果兼容 | `modules/pipeline/legacy.js` + `papers.js` | 将 `Book/*` 与 `papers/*.json` 已完成作品单向导入为只读任务记录 |
| Web 工作台 | `client/*` -> `client.js` | 模块化前端源码（样式/文献库/工作台/阅读器），通过 `npm run build:client` 零依赖构建为宿主单文件入口 |

---

## 2. 文档分流与处理方式

| 输入 | 实际处理 |
|---|---|
| Markdown | 确认语言后进入术语与翻译，无需重复转写；有合法配套来源映射时可关联原 PDF |
| 单篇论文、章节 | 确认范围、布局与注释体例，规范化后自动生成单章结构；需要时人工确认细分结构 |
| 多章书籍、合集 | 确认章节范围与注释结构；扫描件或无可靠目录时使用 DSH 结构观察 |
| 有可靠文字层的 PDF | 按用户所选方式执行；默认视觉转写，文字层仅供核对；显式选择 text_layer 后才直接提取 |
| 扫描 PDF、乱码文字层 | 视觉盲读优先；有疑点时使用 `probe_page` 受控提取文本层并渲染原页高清图，结合 `read_image` 校验或局部 `ocr` 辅助 |

---

## 3. 阶段受控与三阶段面板确认

三个阶段分别由用户在面板选择模型并确认。阶段内部自动推进，阶段完成后自动停机，会话续跑不能代替下一阶段的面板确认。模型目录、默认值与凭证统一由 DSH Harness 管理：

1. **第一阶段：转写（Transcription）**
   - 包含输入分析（`inspect`）、范围与布局规范化（`normalize`）、页面图渲染（`images`）、可选 OCR 准备（`paddle` / `mineru`）、分章切片（`prepare`）、视觉转写（`transcribe`）、原文校验（`verify`）与装配（`assemble`）。
2. **第二阶段：术语与翻译（Translation）**
   - 包含术语分析与清洗（`glossary`）、工程准备（`lgProject`）、LinguaGacha CLI 批量翻译（`translate`）与译文注号结构校验（`translationCheck`）。
3. **第三阶段：审校与发布（Review & Publish）**
   - 包含译后分包联合审校（`review`，配合 `review_prepare` / `review_assemble` / `review_apply`）与双语精读库发布（`publish`）。

---

## 4. Agent 编排工具与会话沙箱

编排会话采用 `reading-document` 预设，通过受控白名单工具开展编排工作：

### 4.1 核心工具 `document_pipeline` 动作

- **`task`**：读取绑定任务元数据、当前阶段与证据目录说明。
- **`inspect`**：检查当前运行环境、Python 依赖与模型网关。
- **`probe_page`（别名 `probe`）**：**受控 PDF 页面探测**。传入 `page` 或 `pages`（1–8 页），自动提取 PDF 文本层文本与标题，并在任务目录下渲染 `probe-pages/page_NNNN.png`，可配合 `read_image` 原生查验。
- **`evidence`**：结构化查看章节交付状态、错误报告、路径定位与预算开销（返回 `totalChapters` 已启动交付数、`definedChapters` 总章数及 `pendingChapterIds` 待启动章节）。
- **`files`** 与 **`search`**：任务目录文件分页浏览与文本文件关键词行检索。
- **`ocr`**：对指定页面与归一化坐标 `region: [左, 上, 右, 下]` 执行局部 PaddleOCR。
- **`source_edit`** 与 **`note_continuation`**：在目检原页图像后，受控修补章节正文文字、脚注锚点、注释定义或跨页无编号脚注续段，自动重算 `paragraph_summary` 并绑定 `worker_audit.jsonl` 加密回执。
- **`run`**：启动当前阶段（支持 `options: { reanalyze, retryErrors, singleStep, chapterId, concurrency }`）。
- **`review_prepare` / `review_assemble` / `review_apply`**：审校审计包准备、汇总校验与补丁打入。
- **`sync_profile`**：在底本物理起止页不变时，无损同步体例配置并对齐 scope 与章节交付快照指纹。
- **`reset_transcription`**：清空转写记录与交付快照（可选保留章节结构），重置阶段为待转写。

### 4.2 核心编排 SOP 与沙箱安全门禁 (`sessionGuard`)

- **目录切章三重交叉核验（TOC Tri-Verification）**：专著与合集切分章节时，严禁单凭乱码内嵌文本层盲猜。必须执行：① 目录原页高清目检（`probe_page` + `read_image` 抄录标题与印刷页码）；② 局部 `ocr` 与文本层互校（消除错字）；③ 正文各章起始页与部扉页（Part Title）原图实核（印证该页真实赫然印有章名，严防 1–2 页边界偏差）。
- **底本输入依赖冻结与审计回执约束**：章节启动转写并生成 delivery 后，`book_analysis.json` 等输入文件被 `state.json` 的 `source_hashes` 快照锁定，严禁中途篡改；正文文字、段落增删与注释定义修补必须走 `source_edit` / `note_continuation` 生成加密审计回执，严禁用 `edit`/`write` 无回执手改或手改 `paragraph_summary`。
- **只读资产保护**：原始 PDF 输入、流水线 Python 脚本、执行日志、预算与审校快照受只读保护，禁止 Agent 篡改。
- **凭证绝缘**：自动拦截 `.env`、`credentials`、`auth.json`、`config.toml` 等敏感文件的读取与写入。
- **角色分离与会话接替保护**：真实大模型交互局限在当前活跃 `orchestrator` 会话；程序执行进度、Worker 输出由宿主单向沉淀到 `worker` / `linguagacha` 日志会话中；轮换新编排会话时自动中止旧会话并在 `sessionGuard` 拦截已归档旧会话的残余调用。

---

## 5. 独立开发测试与浏览器预览入口

本项目支持在脱离 DSH Electron 主客户端的情况下，直接启动独立的本地 Web 预览环境进行界面走查、接口调试与流水分流验证。

### 5.1 启动浏览器工作台

在项目根目录下执行：

```bash
npm run preview
```

终端启动 Node.js 开发测试服务后，在浏览器中打开：
👉 **`http://127.0.0.1:4173/`**

### 5.2 独立测试环境特性

1. **真实后端流水线直连**：
   - `dev-server/server.mjs` 内置挂载了本插件全部 40+ 条后端 API（`/api/paper-reader/pipeline/*`），直接调度底层 Python 识别/转写模块与任务状态机。
2. **完整前端交互模拟**：
   - 注入 DSH 专属 CSS Token 样式体系与 Mock Host 上下文，可完整体验新建任务、双轴识别、参数抽屉微调与双语阅读器。
3. **自动化回归套件**：
   ```bash
   node --test scripts/evidence.test.mjs scripts/task-permissions.test.mjs scripts/probe-page.test.mjs scripts/session-execution.test.mjs scripts/sessions.test.mjs
   ```

---

## 6. 技术规范与专题文档索引

| 文档分类 | 路径 | 核心内容 |
|---|---|---|
| **核心全景手册** | [docs/PIPELINE-MANUAL.md](docs/PIPELINE-MANUAL.md) | 15 阶段状态机机理、工具动作参数详解、体例阻塞排障 SOP 与死锁解除指南 |
| **术语系统规范** | [docs/GLOSSARY-WORKFLOW.md](docs/GLOSSARY-WORKFLOW.md) | 术语生命周期、LinguaGacha 清洗合并与公共表流转规则 |
| **术语底层架构** | [docs/TERMINOLOGY-SYSTEM-DESIGN.md](docs/TERMINOLOGY-SYSTEM-DESIGN.md) | 术语数据库设计与对账机制 |
| **来源映射对齐** | [docs/SOURCE-MAP-AND-PIPELINE-REVIEW.md](docs/SOURCE-MAP-AND-PIPELINE-REVIEW.md) | 块级指纹配对、注号映射与 Markdown 装配规范 |
| **阶段确认规则** | [docs/PHASE-CONFIRMATION-2026-10-19.md](docs/PHASE-CONFIRMATION-2026-10-19.md) | 面板模型选定、授权回执与停机门禁验收 |
| **简化实施报告** | [docs/PIPELINE-SIMPLIFICATION-RESULT-2026-10-19.md](docs/PIPELINE-SIMPLIFICATION-RESULT-2026-10-19.md) | 架构精简成果、去除冗余哈希与故障防御实测 |
| **数据迁移归档** | [docs/MIGRATION.md](docs/MIGRATION.md) / [docs/MIGRATION-RESULT.md](docs/MIGRATION-RESULT.md) | 历史 K-PdfToMd 库盘点与迁移验收标准 |

