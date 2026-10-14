# @local/paper-reader — 统一文档处理与双语精读工作台

书籍、论文、章节节选与文章合集共用唯一的 DSH 统一文档流水线（`modules/pipeline/`），不再维护旧版 `pdf_paper` 工具与 A–F 会话转写流。历史已完成论文（`papers/*.json`）与书籍（`Book/*`）通过单向只读导入接入文献库。

## 1. 架构与入口

| 组件 | 位置 | 职责 |
|---|---|---|
| 组合根 | `index.js` | 绑定阅读目录并挂载 `installPipelineModule(ctx, config)`（`/api/paper-reader/pipeline/*`） |
| 编排工具与守卫 | `modules/pipeline/index.js` + `guard.js` | 注册 `document_pipeline`（`inspect` / `task` / `run`）、`reading-document` Agent 预设与 `sessionGuard` 权限门禁 |
| 任务状态机 | `modules/pipeline/tasks.js` | 管理 `.pipeline/tasks/<uuid>/` 的 15 个受控阶段，调度 Python 转写/校验脚本与 LinguaGacha 官方 CLI |
| 阅读与书签 | `modules/pipeline/reader.js` + `bookmarks.js` + `markdown.js` | 原文/译文块级配对、脚注索引、勘误与跨版本书签 |
| 历史成果兼容 | `modules/pipeline/legacy.js` + `papers.js` | 将 `Book/*` 与 `papers/*.json` 已完成作品单向导入为只读任务记录 |
| Web 工作台 | `client.js` | 任务处理面板（`PipelinePanel`）、双语对照阅读页（`ReaderPage`）与书签管理 |

## 2. 双轴文档分流（体裁轴 × 载体轴）

### 轴一：文档体裁（`kind`：`book` / `collection` vs. `paper` / `chapter`）
- **自动建议与确认**：上传或选择 PDF / Markdown 时由 `lingua/detect_document.py` 根据页数、书签层级与文件名给出初始建议，用户在面板确认正文起止页、双页拼版裁切（`single` / `spread`）与注释体例（`footnote_only` / `endnote_only` / `mixed` / `no_notes`）。
- **单篇论文/章节直通结构（`paper` / `chapter`）**：
  - 单篇论文或章节节选（无论原生文字层还是扫描件）在 `prepare` 阶段直接根据已确认的 `document_profile.json` 自动生成单章结构（`id: "001"`，`start_page: 1..N`）的 `toc.json`、`chapters.json` 与 `book_analysis.json`，并立即执行 `gate_check.py --phase 2` 门禁，**无需**强行拉起整书 DSH 会话派发 P0/P1/P2 子代理。
- **多章整书/合集（`book` / `collection`）**：
  - 原生文字层且含有效 PDF 书签时，由 `tl_convert.py prepare` 自动切分章节；
  - 扫描件整书或无 PDF 书签的整书，由面板拉起 `reading-document` 预设会话，派发携带完整 B 面规格的 `P0_VISION` / `P1_SAMPLING` / `P2_NOTESCOUT` 子代理生成章节结构后再执行 `prepare` 门禁。

### 轴二：PDF 载体与视觉优先策略（`BORN-DIGITAL` vs. `SCANNED` / `TEXT-GARBAGE`）
1. **原生文字层（`BORN-DIGITAL`）**：
   - 默认（`auto`）：`tl_convert.py prepare` 提取字号/版心指标与章节结构 → `tl_convert.py extract` 按页提取块级正文与脚注 JSON。
   - 显式视觉模式（`transcription_method === 'vision'`）：`prepare` 阶段先在 `reference/text-layer` 提取 PDF 文字层生成 `raw_pages{,_paddle,_mineru}.json` 作为对账基线，再走视觉转写与 `gate_check --phase 2`。
2. **扫描件与乱码文字层（`SCANNED` / `TEXT-GARBAGE`）—— 视觉转写优先 + 受控 OCR 兜底**：
   - **预生成双 OCR 备查**：`paddle` 与 `mineru` 阶段调用云端双 OCR 生成 `raw_pages_paddle.json` 与 `raw_pages_mineru.json`。
   - **首轮纯视觉盲读（`image_first_no_ocr_v1`）**：`transcribe` 阶段自动先执行 `marker_prescan.py` 预扫注号，随后由 `bounded_chapter.py` 调固定多模态 worker 直接读页面图转写，**首轮严禁向模型提供当前页 OCR 文本**。
   - **仅在模型失败（尤其审核拒答）时启用 OCR 数据**：
     - 仅当首轮明确记录视觉拒答（content moderation / refusal）或图像无法辨读时，程序才授权第二轮降级（OCR Fallback），带来源标签提供双 OCR 文本辅助恢复；若两轮预算耗尽仍缺失结构化转写，才在待核查稿中使用 OCR 应急底稿。
     - 正常视觉转写完成后，双 OCR 仅用于后台差异对账，绝不直接覆盖视觉转写结果。

## 3. 受控阶段与精简门禁

`TaskManager` 的 15 个阶段按 4 个阶段组推进：
1. **输入与结构**：`inspect` → `normalize` → `images` → （扫描件：`paddle` → `mineru`）→ `prepare`（单次调用级联门禁 `gate_check.py --phase 2`，覆盖 Phase 0/1/2）
2. **转写与校验**：
   - `transcribe`：文字层提取或 `marker_prescan.py` + `bounded_chapter.py` 视觉转写 + 交付回执校验
   - `verify`：单次级联门禁 `gate_check.py --phase 3c`（含 Phase 0/1/2/3c）+ `verify_page_json.py --all`（文字层另加 `verify_textlayer_structure.py`）
   - `assemble`：逐章执行 `assemble_chapter.py` + `verify_output.py --chapter`；整书额外执行 `assemble_book.py` + `verify_output.py --book` + `audit_book.py`（不再重复跑三次前置 JSON 门禁）
3. **翻译**：`glossary` → `lgProject` → `translate`（LinguaGacha 官方 CLI + Markdown V2）→ `translationCheck`（块级结构、脚注与附件配对校验）
4. **审校与发布**：`review`（可选独立语义审校）→ `publish`（预览成品与附件清单并确认发布）
