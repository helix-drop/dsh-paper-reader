# 阅读插件术语系统设计（精简高效版）

文档日期：2026-11-02  
状态：已实施并完成第二轮精简与实测落地（对应 `modules/pipeline/glossary*.js`、`modules/pipeline/harness-models.js` 与 `prompts/glossary-*.txt`）

---

## 1. 核心设计原则：前轻后实，双层防线

本系统的翻译质量由**两道互补防线**共同保障，而非把所有重担压在翻译前的术语分析阶段：

1. **翻译前：轻量术语脚手架（Pre-Translation Terminology Scaffolding）**
   - **定位**：在全文进入翻译前，快速建立统一的**核心概念、学科方法、机构与关键专名（人名/书名）**映射表，防止长文分批并发翻译时出现前後译名割裂。
   - **边界**：**不追求在翻译前穷尽一切语境微差，不构建按段落动态切分的复杂规则引擎，不要求模型为每个词条撰写长篇学术论证**。真正存在一词多义或译法存疑的词条，直接标记 `uncertain: true`（在术语表中保留原文并记入 `review-issues.json`），交由翻译时结合完整上下文处理及译后审校确认。
2. **翻译后：全文与术语联合审校（Post-Translation Joint Review）**
   - **定位**：整篇论文或整本书翻译完成后，对照**完整原文 + 完整译文 + 本书生效术语表 + 待核查疑点（`review-issues.json`）**进行联合审校。
   - **作用**：解决翻译前无法仅凭局部引文裁定的语境多义、修正局部误译，并在审校通过（`pass`）后将真正具备跨文献复用价值的术语晋升入公共术语库。

---

## 2. 针对旧设计的精简与问题根治

此前版本（及早期《造就人》50 分钟测试）暴露出严重的工程过载与脆弱性，本次精简直接消除了以下瓶颈：

| 痛点维度 | 旧设计 / 旧实现的问题 | 精简后的设计与实现 |
|---|---|---|
| **提取分块与证据负担** | 按 `1800` 字符切分（单篇论文切成 28 块）；强迫模型逐字抄写长句 `quote` 并写长篇 `sense`；模型改写引号/大小写导致大量真实词条被 `unsupported-source-evidence` 误丢弃 | 保持 **`3200` 字符标题感知分块**（`##` 标题与首段同块；经 *Penser la folie* A/B 实测，`8000` 字符分块虽快但会使 `>=5` 次高频词召回率降至 `90.91% < 97%`，故保留 `3200` 默认分块以保召回率）；提示词完全去除 `quote` 抄写（仅需 `blockId`），由 `sourceEvidence` 自动从原文块截取 `-60..+120` 字符真实引文（`derived-from-block`），使证据失配丢弃率下降 **92.7%**（`259 -> 19`），提取输出体积下降 **49.0%** |
| **清洗归并协议（Consolidation）** | 要求模型对批内全部条目输出完整 1:1 分组（4.8 万字符输入、重复输出 26 位哈希 `entryId` 及 `reason`/`scope`/`publicReason` 三段长文），导致单批耗时 6~10 分钟且极易因漏项或输出“占位”假条目而整批报错崩溃 | 改为 **默认保留 + 增量变更（Delta / Default-Keep）+ 低频孤立专名直通（Auto-Pass）模式**：全书仅出现 `<=1` 次、无冲突/存疑且与任何其他候选无词法关联的 `person`/`title`/`institution` 直接跳过 LLM 归并并落盘 `glossary/auto-pass.json`；其余条目使用短整数 `id`（`1, 2, ...`），无异议条目由程序自动保留，模型仅输出删除、改译、合并或标记 `uncertain` 的变更组 |
| **清洗输入载荷** | 同一 `src` 的相同 `dst` 提议重复发送；无冲突词条也附带多段引文与 `2000` 字符 `otherTerms` 凑数 | **线上极简结构（Slim Wire Schema）**：无冲突词条在传输层仅发送 `{id, src, dst, category}`，不附引文与 `proposals`；仅对 `conflict`/`uncertain` 词条附引文上下文；通过法/英单复数词干归一化（`stemToken`）与人名/标题关联聚类分批（上限 `100` 条 / `24000` 字符），使整书归并输入体积下降 **77.0%**（`95.2 万 -> 23.2 万字符`） |
| **额度耗尽与长推理首包超时保护** | 供应商额度耗尽（`RATE_LIMIT`）时无进展空转重试长达 15–20 分钟；推理模型深度思考超 300 秒时触发客户端 `undici` 默认首包头超时中断 | 持续命中额度上限且 **3 分钟**无新增完成单元时立即中止并抛出 `GLOSSARY_PROVIDER_QUOTA` / `TRANSLATION_PROVIDER_QUOTA`（不消耗 3 次内容重试预算，保存断点可一键续跑）；本地 `HarnessModels` 租约网关默认请求与首包头超时设为 **10 分钟（`600s`）**，对 `stream: true` 请求提前刷出 SSE 响应头与 `: keepalive` 心跳 |
| **术语应用与数据模型** | 规划了 8 类独立实体（`candidateId`/`senseId`/`ruleId` 等）、按段落动态生成子术语表、在术语内重复维护 PDF 页码范围 | 保持**扁平、确定性的三层表结构**（公共表 `common.json` + 本书覆盖表 `book-overrides.json` -> 任务生效表 `glossary.json`）；PDF 页码映射完全复用 `source-map.js` 的 `blockId` 溯源，不在术语模块重复造轮子 |
| **原生日志校验性能** | 每次校验都全量重读并解析 `~/LinguaGacha/log/app.*.jsonl` | `glossary-transport.js` 增加基于文件 `size + mtimeMs` 的内存缓存，消除重复磁盘 I/O |

---

## 3. 完整流水线与阶段契约

所有新书、论文、章节及导入的 Markdown 统一按以下轻量流水线执行：

```mermaid
flowchart LR
  A["1. 全文提取\n(3200字/块, 仅提核心术语)"] --> B["2. 程序结构清洗\n(校验 blockId 与原词存在性)"]
  B --> C["3. 一次增量归并\n(短编号 id + 默认保留 + 冲突/别名裁定)"]
  C --> D["4. 扁平生效表装配\n(生成任务级 glossary.json)"]
  D --> E["5. 全文翻译\n(注入固定 glossary.json)"]
  E --> F["6. 译后联合审校\n(原译文 + 术语表 + 疑点核验)"]
  F --> G["7. 公共表晋升\n(仅 pass 后原子写入新增通用项)"]
```

| 阶段 | 执行主体 | 核心动作 | 失败与恢复边界 |
|---|---|---|---|
| **1. 全文提取** | 模型 (`prompts/glossary-analysis.txt`) | 仅提取核心学术概念、方法、机构、关键人名与书名；禁止提取普通叙述分句或常见词；返回 `{src, dst, category, sense?, uncertain?, evidence:{blockId}}` | 按已验证单元断点续跑；同一源文本+提示词+模型直接复用 |
| **2. 程序结构清洗** | 程序 (`cleanCandidates`) | 校验 `blockId` 与 `src` 在原文块中真实存在；自动截取局部引文；按小写规范化键聚合重复提议 | 剔除无原文依据的幻觉词条并记录到 `dropped` |
| **3. 一次增量归并** | 模型 (`prompts/glossary-consolidation.txt`) + 程序 (`applyConsolidation`) | 关联同词根/词形与人名全简称进入同批；模型返回 `checkedCount` 与增量 `groups`（删除非术语、统一全名/姓氏/单复数译名、裁定公共表冲突、标记 `uncertain`）；未提及条目由程序默认保留 | 单批输出体积缩减 70%~85%；自动忽略模型尾部的无效“占位”项；支持按已完成批次增量恢复 |
| **4. 生效表装配** | 程序 (`modules/pipeline/glossary.js`) | 生成本书唯一键生效表 `glossary.json`（含 `shared` 与 `book-overrides`）；对 `uncertain` 或人名姓氏不一致项自动保留原词（`dst = src`）并写入 `review-issues.json` | 保证 `glossary.json` 原词键无重复、无空译名 |
| **5. 正文翻译** | LinguaGacha CLI | 直接使用任务级固定 `glossary.json` 翻译全文，通过 `translationCheck` 后自动生成译后分包审校数据包 | 翻译期间公共库变化不影响当前任务 |
| **6. 译后分包联合审校** | `review-audit.js` + `registerJointReview` | 按章节/段落切分 `review/audit/packets/NNN.json`（内嵌命中术语与 `review-issues.json` 疑点提示），并行子代理提交唯一子串补丁 `patches` 与 `glossary_decisions`，程序门禁校验 100% 行覆盖与脚注多重集守恒后受控合入译文与术语表 | 缺包、行覆盖不全、子串非唯一、脚注标记失配或状态为 `needs-work` 时禁止合并与晋升公共库 |
| **7. 公共表更新** | 程序 (`promoteReviewedGlossary`) | 仅在联合审校 `pass` 后，将 `public-candidates.json` 中无冲突的通用术语原子写入 `.pipeline/glossaries/common.json` | 不覆盖公共库既有不同译名；并发冲突项自动退回本书局部保留 |

---

## 4. 数据模型与文件产物（保持最小完备集）

不再引入多余的中间实体层或段落级规则拆表，完全复用现有清晰的任务目录产物，保证与 `tasks.js`、前端状态展示及历史任务 100% 兼容：

| 路径 | 职责说明 |
|---|---|
| `glossary/source.md` | 本次术语分析绑定的原文快照 |
| `glossary/structural-cleaned.json` | 程序结构清洗后的有效候选与丢弃记录 |
| `glossary/cleaning-inventory.json` | 增量归并分批清单（内部保留完整证据溯源，线上投影仅对冲突/存疑项附 `contexts`） |
| `glossary/auto-pass.json` | 低频（`<=1` 次）、无冲突且无词法关联的孤立专名（`person`/`title`/`institution`）免 LLM 归并直通审计记录 |
| `glossary/semantic-groups.json` | 归并后的概念/别名分组（含模型显式调整组与程序默认保留组） |
| `glossary/semantic-rejections.json` | 被模型判定为非术语而剔除（`action: "drop"`）的条目及简短理由 |
| `glossary/review-issues.json` | 语义存疑（`uncertain`）或全名/姓氏译法不一致的待审校项（翻译阶段保底保留原词） |
| `glossary/common-snapshot.json` | 任务启动时锁定的公共术语库快照 |
| `glossary/book-overrides.json` | 本书特定译法、覆盖公共默认译名的词条及暂不公开的词条 |
| `glossary/public-candidates.json` | 适合跨文献复用、等待译后联合审校确认的候选词条 |
| `glossary/effective.json` & `glossary.json` | 供 LinguaGacha 翻译直接读取的扁平生效术语表（`[{src, dst, info, regex: false, case_sensitive: false}]`） |
| `glossary/pipeline-receipt.json` | 阶段完成回执（`schemaVersion: 4`，记录指纹、统计与验证状态） |
| `review/audit/packets/NNN.json` | 译后分包审校数据包（含 `line`、`blockId`、`source`、`translation`、`classify`、当前行命中的生效术语 `terms` 及自动扫描提示 `hints`） |
| `review/audit/results/NNN.json` | 分包审校结果（含 100% 覆盖的 `checked_lines`、`body_count`、唯一子串最小修订 `patches` 与术语裁决 `glossary_decisions`） |
| `review/audit/validation.json` & `reviewed-preview.md` | 程序门禁校验回执（行覆盖、脚注守恒、结构异常标记）与沙盒合成预览稿 |
| `review/report.md` | 译后联合审校报告（含原文、译文、术语表、疑点列表的 SHA-256 绑定注释与 `pass`/`needs-work` 结论） |

---

## 5. 模型提示词契约（精简版）

### 5.1 提取提示词（`prompts/glossary-analysis.txt`）
- **只提真术语**：只提取专业概念（`concept`）、学科方法（`method`）、技术专名（`technical`）、机构（`institution`）、关键人物（`person`）与著作标题（`title`）。
- **严禁过度提取**：禁止提取完整分句、叙述短语、普通修辞或日常高频词；宁缺毋滥。
- **极简字段**：`sense` 仅写 `<=15` 字核心词义（无歧义可省略）；`evidence` 仅需注明真实的 `blockId`（及可选短词组），无需抄写整段原文。

### 5.2 增量清洗归并提示词（`prompts/glossary-consolidation.txt`）
- **默认保留（Default-Keep）**：输入 `entries` 中译名准确、无冲突且无需合并的独立术语**不要在 `groups` 中输出**，程序会自动保留。
- **只输出变更（Delta Groups）**：仅在以下 4 种情况输出到 `groups`：
  1. **删除非术语**：混入的叙述句、普通词组（`{"id": 编号, "action": "drop", "reason": "简短理由"}`）；
  2. **修正译名或裁定冲突**：默认 `dst` 不准，或存在多个 `proposals` / `publicOptions` 冲突需指定最佳 `dst`；
  3. **同概念合并**：同一人物全名与姓氏/简称、同一概念的单复数/词形变体或同义别名，放入同一 `group.members` 并统一译名；
  4. **存疑保留原词**：上下文不足以确定译名时，输出并设 `"uncertain": true`，交由译后联合审校处理。
- **计数校验**：返回顶层 `"checkedCount": <本批 entries 总数>`，确保批次完整处理且未被截断。

---

## 6. 译后分包联合审校机制（`modules/pipeline/review-audit.js`）

对标 `book-translation-review` 的分包外科手术式审校流程，并与前序术语系统深度打通：

1. **分包准备（`prepareReviewAudit`）**：
   - 锁定 `source.md`、`translation.md`、`glossary.json` 与 `review-issues.json` 快照及 SHA-256 指纹；
   - 按 15–30 个正文段（遇章节标题优先切分）生成 `review/audit/packets/001.json ... NNN.json`；
   - 为每行自动注入命中术语 `terms` 以及三类机器预检 `hints`：`unresolved_term`（来自 `review-issues.json` 的待核查术语）、`glossary_mismatch`（原文含生效术语但译文未体现目标译名）、`untranslated_latin`（正文残留未译西文词）及结构异常预检。
2. **并行分包审校（`results/NNN.json`）**：
   - 支持并行派发 `subagent` 逐包审校，强制要求 `checked_lines` 100% 覆盖包内所有非空行、`body_count` 严格对齐；
   - 正文修订采用**唯一子串最小补丁**（`patches: [{line, base: "translation", edits: [{old, new}], reason}]`），`old` 在目标行必须唯一命中（`occurrences === 1`），杜绝整段重抄导致的意外篡改；
   - 针对 `review-issues.json` 或正文术语不统一问题，在包结果中同步提交 `glossary_decisions`。
3. **程序汇总门禁与受控应用（`assembleReviewAudit` + `applyReviewAudit`）**：
   - 校验全部快照与任务包哈希未篡改、100% 分包与行覆盖、唯一子串替换成功、**逐行与全文脚注标记多重集（`[^...]`）100% 守恒**，并扫描 `short` / `expansion` / `repeat30` / `adjacent_repeat` / `annotation` / `seam` / `quote_balance` / `note_prefix` 结构异常；
   - 先输出沙盒合成稿 `review/audit/reviewed-preview.md` 与 `changes.json`；仅当门禁零错误且联合审校报告为 `pass` 时，备份原译文并原子更新 `translation/translated.md`、映射表、`book-overrides.json`、`glossary.json` 与 `review-issues.json`。

---

## 7. 调度、重试与实测基准（*Making Up People*）

1. **统一重试预算**：遇到供应商 `content_filter`、超时（`timeout`）或长度截断（`output_limit`）时，仅对未完成单元追加重试最多 **3 次**（持久化于任务回执，重启不重置）；已完成的兄弟单元通过原生日志与检查点直接复用，绝不重跑整本书。
2. **向后兼容**：`applyConsolidation` 同时兼容新版增量模式（含 `checkedCount` 与短编号 `id`）与旧版全量分区模式（`entryId`），已有测试与历史检查点无需迁移即可平滑读取。
3. **实测基准（Ian Hacking, *Making Up People*）**：
   - **旧版全量重排设计**：28 个提取单元 + 4 个大包全量重排，耗时 **50 分 35 秒（3,035s）仍因输出超长与校验中断而失败**；
   - **新版精简增量设计**：15 个提取单元（**5 分 31 秒 / 331.25s**）+ 6 个增量归并单元（**6 分 32 秒 / 392.15s**，单批输出仅 68–1,324 字符），**单轮总计约 12.05 分钟即 100% 完成**（提速约 **4 倍**），产出 **178 条有效学术术语**、**5 条本书覆盖译名**及 **5 条真实待核查术语（`reviewIssues`）**。

