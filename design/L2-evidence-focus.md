# AutoGrader · L2 设计：Evidence Focus（候选证据定位）

> 输入：canonical rubric（不可变）+ 完整原文（学生原始材料，只读）+ L1 index
> 输出：候选证据 bundle（多 span + asset 引用）+ 可回溯的 source_ref / offset + 检索诊断
> 一句话：**L2 只做定位。它找到的是候选证据，不是已经证明成立的证据。**

**模型接口**：运行时配置；需要视觉信息时按需提供原始页图，不把特定型号写成数据契约。

---

## 0. 全项目核心原则：涉及 LLM 的部分必须提供完整原文

> **原文 = 学生上传的原始材料，只读。任何一层都不允许把「模型改写过的内容」当作原文喂给下游 LLM。**

三条推论（**改动任何一层前先回看这三条**）：

1. **L1 不能摘要、不能转 LaTeX、不能改写** —— 那三个「不做」是架构约束，不是简化选择。
2. **索引是导航层，不是内容层**。给 LLM 两条并行通道：

   | 通道 | 内容 | 规则 |
   |---|---|---|
   | A 正文 | `<name>.txt` 逐字 | **不插任何标记** —— 不插锚点、不插行号、不插页码 |
   | B 导航 | `index.json` 紧凑目录表 | 作为附加信息并列给出 |

3. **图表只能靠「渲染原始页」来真正读**。已实测：`src/page.mjs <file.pdf> <pageNo>` → 1190×1684 PNG。
   目标模型多模态，页图可直接给它看 —— 这条通道完全可满足。

---

## 1. 权威模型（**方向单向，不可逆**）

| 层 | 性质 | 能否改 | 评分地位 |
|---|---|---|---|
| **canonical rubric** | 教师上传原件归一后的规范形式 | **不可变** | **唯一评分权威** |
| **retrieval plan**（R 产物） | 派生工作物 | 可修订（须版本化） | **不参与评分** |
| **候选证据**（F 产物） | 派生工作物 | 可增删 | 候选，不是结论 |

**rubric → plan → 候选。** 反向的「用检索结果回写 rubric」「用候选数量反推分数」都是越界。

**两份工作物各自独立存储，下游只引用不复制**：

| 产物 | 存放 | 下游怎么引用 |
|---|---|---|
| canonical rubric | `*.canonical-rubric.json` | `rubric_id` + `sha256`（原件哈希）+ `file` |
| retrieval plan | `*.retrieval-plan.json` | `plan_id` + `version` + `batch_id` + `sha256`（plan 文件哈希）+ `file` |

理由：都是**版本化的工作物**，每一版只应存在一份权威副本。嵌进下游文件会让它有机会漂移，
也让人分不清「我看到的这份是哪一版」。

---

## 2. rubric 适配层：四种输入 → 一个 canonical rubric

**外部输入同时支持**：已结构化表格 / Word / PDF / 普通自由文本。**内部一律归一成 canonical rubric。**

| 输入 | 结构从哪来 | 层级判据 `derived_by` |
|---|---|---|
| 已结构化表格 | 表格本身就是结构 | `table_structure` |
| Word | 标题样式、编号、缩进 | `docx_style` / `numbering` / `indent` |
| PDF | 字号、编号、缩进（文本层） | `font` / `numbering` / `indent` |
| 自由文本 | 只有编号与缩进 | `numbering` / `indent`；不够时 `llm_structure` |

**层级：大评分点 → 子评分点 → …**，任意深度。扁平存储 + `parent`/`children`/`depth`。

**四条不可动的规则**：
1. `text` 与 `score_raw` 必须是原件的**逐字**片段，带 `source_ref` 可核对
2. 层级是派生结构，**每条必须带 `derived_by` 判据**（宁可写 `llm_structure` 也不留空）
3. **分值不解析、不分配、不改写**；解析**只在校验里用**，结果不写回、不参与评分
4. **LLM 只输出结构引用（哪一行归哪个父项），不产生任何 rubric 文本** ——
   文本一律由系统从原件逐字切出，模型没有机会改写唯一评分权威

**校验只报告、不修改**：`text_verbatim_ok` / `line_coverage` + `unparsed_lines`
（已归入 + 显式未归入 = 非空总行数，**不允许静默丢行**）/ `score_consistency`
（父项分值 vs 子项之和的算术检查 —— 教师常算错，系统只标出来交教师核对，**绝不自动改正**）。

---

## 3. R：产出 retrieval plan

### 3.1 可修订，但必须持久化、版本化、批内固定

| 要求 | 落成字段 | 为什么必须这样 |
|---|---|---|
| **持久化** | 独立成文件 `*.retrieval-plan.json` | 不落盘，召回就无法归因、无法复算 |
| **版本化** | `version` + 追加式 `revision_log` | 修订必须留痕，否则「召回变了」说不清是数据变了还是检索器变了 |
| **批内固定** | `batch_id` + `pinned` | **同批评分必须共用同一 plan 版本** —— 这是同批学生分数可比的前提 |

- **一批 = 同一份 rubric + 同一群学生作业。**
- **初版：plan 只读**（只有 R 重跑才会产生新版本，暂不支持人工编辑）。
- **plan 与 rubric 强绑定**：`plan.rubric_sha256` 必须等于 canonical rubric 的 `sha256`；
  不等 → plan 立即失效、整体重生成。这条让「rubric 不可变」有了机械后果。

### 3.2 检索面（facet）用三个正交维度描述

三者不能混成一个 `kind`：一个是「要找什么样的话」，一个是「材料以什么形态存在」，
一个是「跑哪几条网」。它们回答三个不同的问题，混在一起就没法分别审计。

| 维度 | 回答的问题 | 取值 | 用途 |
|---|---|---|---|
| **`form`** 语义形式 | 要找的是**一句什么样的话** | `value` 数值/指标 · `relation` 比较·因果·对应 · `narrative` 解释·说明·讨论 · `procedure` 步骤·流程·方法 | 决定语义网怎么问 |
| **`modality`** 模态 | 这段材料**以什么形态存在** | `text` · `table` · `figure` · `formula` · `code`（可并列） | 决定走哪些结构通道；**也是 `source_unavailable` 的判据** |
| **`channels`** 检索通道 | 这条面**跑哪几条网** | `rule:numeric` · `rule:relation` · `rule:numbering` · `rule:keyword` · `structure:*` · `llm:semantic` | 显式声明，不由代码隐式推导 —— 便于审计「这条面到底走了哪些通道」 |

例（`R2.1`「对实验结果进行充分且合理的分析」）：

```
F1  结果数值            form=value      modality=[text,table]         channels=[rule:numeric, structure:table, llm:semantic]
F2  趋势解释            form=narrative  modality=[text,figure]        channels=[structure:figure, llm:semantic]
F3  误差来源            form=relation   modality=[text]               channels=[rule:relation, llm:semantic]
F4  异常数据            form=value      modality=[text,table,figure]  channels=[rule:numeric, structure:table, structure:figure, llm:semantic]
F5  与理论值的比较      form=relation   modality=[text,table]         channels=[rule:relation, structure:table, llm:semantic]
F6  结论与数据的关系    form=relation   modality=[text]               channels=[rule:relation, llm:semantic]
```

**plan 覆盖 rubric 的所有条目** —— 但**汇总型父项不生成 facet**（2026-09-23 改，见下）。

#### 3.2b ★ 汇总父项跳过检索（2026-09-23 修正）

早先的规则是「父项也可能带有子项没覆盖的要求，**宁可多不可漏**」，于是父项也拆 facet。
真实模型一跑就看到代价：11 条条目拆出 **34 个检索面**，其中 7 个来自汇总父项（R1/R2/R3），
而它们检出来的材料与子项**高度重复** —— 每个父项 facet 都是又一次把整段正文带过去。

**改法（判据机械，不靠模型判断）**：canonical rubric 里 `children` 非空的条目即汇总父项 → **不生成 facet**。

- 父项**仍然出现在 plan 里**（`summary: true` + `children` 作为跳过的依据），覆盖率仍看得见它；
- 父项上**仍可记 `blind_spots`**（不产生模型调用）；
- 模型若给父项塞了 facet，**丢弃并记进 `revision_log`**（不静默、也不拒收重来）；
- 覆盖率检查放宽为「**非汇总**条目必须全覆盖」；漏了叶子条目依旧整次拒收；
- 证据产物里父项标 `outcome: "skipped_summary"` + `retrieval_skipped: true`
  —— **不能记成 `no_candidate`**，那会被读成「没找到」，是另一件事。

预期收益：检索面数量降一档、重复证据消失、模型调用等量减少。


### 3.3 检索盲点

**检索盲点 = R 无法把某段 rubric 措辞转成任何检索面。**
例：`R2.1` 里的**「充分」「合理」**——它们是**判断**，不是**材料**。

### 3.4 两个概念必须分清

| | 定义 | 例 |
|---|---|---|
| **检索盲点** | R **转不出** facet（措辞本身是判断，不是材料） | 「充分」「合理」 |
| **未找到候选** | **有** facet，但在原文里没有材料 | 「与理论值的比较」有面，但原文确实没有理论值 |

**两者都不能说成「学生没写」。**

### 3.5 plan 不参与评分

`retrieval_plan` 里所有文字都是**模型生成的措辞**，不是原文，也不是量规。
它只作为 `facet_id` 元数据出现，用来说明「这一条是靠哪个面找到的」。

---

## 4. F：逐 facet 多通道检索

### 4.1 逐 facet 独立跑，每个 facet 走它声明的通道

保留逐 facet **不是因为上下文不够**（1M 放得下全文），而是因为**它是召回机制**：
全局扫描会让模型挑重点，直接损失召回。

三通道取并集：`rule:*`（确定性、零成本）/ `structure:*`（按 L1 类型全纳入）/ `llm:semantic`（改述·隐含·跨段）。

### 4.2 预筛只做「标注」，不做「裁剪」

**完整原文照给，预筛命中处只加注意力标注。** 内容一个字都不删 —— 靠裁剪省成本就违反 §0。

### 4.3 纳入门槛低到「可能相关」

不确定性用标签表达，而不是用「纳入与否」表达：`match_type ∈ {verbatim, synonym, implicit, cross_block}`。

### 4.4 引用绑定：每一条 quote 必须能回到原文的具体一处 ← 最重要的一条

1. 模型只输出 `quote`（逐字引用串）—— **不让模型输出偏移**（LLM 擅长照抄、不擅长数字符）
2. **系统**解析出 `source_ref`（file + sha256 + page + entry）和 `offset`（字符区间）
3. 断言 `该原件文本.slice(offset.start, offset.end) === quote`
4. 对不上 → 该证据**直接判废并回报**

**只有"找得到"还不够，还必须"找对地方"。** 同一句话可能在页眉、段落或图表中多次出现；仅取首次命中会使引用指向错误位置而不报错。

所以绑定必须分级，并把选择记下来：

| 优先级 | `binding.mode` | 依据 |
|---|---|---|
| 1 | `entry_hint` | 上游给出的 L1 条目提示，在该条目区间内找（最可信） |
| 2 | `cursor` | 同一 (rubric_item, facet) 内按出现顺序推进游标，保证同批引用不互相抢位 |
| 3 | `first` | 兜底取首次出现，**并标记 `ambiguous: true`** |

`binding` 里同时记 `occurrences`（该引用共出现几次）—— 让歧义**可见**，而不是被默默吞掉。

### 4.5 每个 facet 必须显式记录检索健康度与命中结果

**这两件事必须分开记，否则「读不到」会被记成「没找到」。**

| 字段 | 取值 | 含义 |
|---|---|---|
| **`status`** | `complete` | 声明的通道全部跑完 |
| | `partial` | 只跑了一部分通道 |
| | `source_unavailable` | 该 `modality` 要求形态的材料在原文里读不到（例如要求 `figure` 但原文没有图，或该页无文本层且未渲染） |
| | `channel_error` | 至少一个通道执行失败 |
| **`outcome`** | `located` | 找到候选 |
| | `no_candidate` | **检索正常完成**但没找到 |
| | `undetermined` | 因为 `source_unavailable` / `channel_error`，**无法判定** —— 这不是「学生没写」 |

**硬规则**：`status ∈ {source_unavailable, channel_error}` ⇒ `outcome` 必须是 `undetermined`。

---

## 5. 工具面（**已实现**，2026-09-23）

L2 是 agent，但它能做的决定只有两件：**拆检索面**（R）与**提交逐字引用串**（F）。
所以工具面只有两个提交工具：

| 工具 | 作用 |
|---|---|
| `submit_retrieval_plan` | R：把 rubric 条目拆成 facet（+ 盲点）。**叶子条目必须全覆盖**，漏了整次拒收（不"补齐"）；**汇总父项不给 facet**（给了会丢弃）。facet 的 id 由系统编 |
| `submit_facet_candidates` | F：针对**单个 facet** 提交候选（`quote` + `match_type`）。**不给偏移、不给数字、不写评价** |

**系统的部分**（模型没有自由度）：facet 编号、偏移与绑定、通道归因、硬规则、诊断统计、整页渲染。

### 5.1 材料与页图的提供方式

1. **没有 `read_full()` / `search()` / `read_entry()` 这类"模型主动取材料"的工具**。
   完整原文在**第一条消息里就给全**（这正是 §0「涉及 LLM 的部分必须提供完整原文」的落地方式），
   之后每个 facet 只发一句指令，材料靠会话历史带着。
   更关键的是：让模型自己 `search` 会引入**第二条绑定路径**（它自己的偏移），
   与「偏移一律由系统算」冲突。**检索是通道的事，不是模型的事。**
2. **`read_page(n)` 也不是模型选的**。图/表类 facet 的候选会**自动**附上所在页的整页渲染
   （`asset_refs`，形如 `fixtures/out/report.pdf.p001.png`）—— 要不要渲染由 facet **声明的模态**机械推出。
   渲染失败不掩盖：进 `assets_failed` 并在报告里说出来。

---

## 6. 输出契约

产物：`<name>.evidence.json`（契约见 `evidence-candidates.schema.json`）。

```
{
  authority       —— 权威声明，任何一层不得改写
  doc
  rubric          —— 只引用 canonical rubric
  retrieval_plan  —— 只引用某一版 plan
  evidence        —— 证据 bundle 列表
  diagnostics     —— 检索诊断（status / outcome / 各通道命中数）
  advisory_lint   —— 辅助检查，不阻断
}
```

### 6.1 证据是一个 bundle，不是一句话

图 / 表这类证据天然由多处原文共同构成 —— 例如「趋势解释」的证据 =
**指向图的句子** + **图注** + **那张图的原始页图**。所以一条证据是 bundle：

```json
{
  "id": "ev0001",
  "rubric_item_id": "R2.1",
  "facet_id": "F2",
  "spans": [
    { "quote": "三组学习率下验证损失的下降曲线如图所示。",
      "source_ref": { "file": "report.pdf", "sha256": "…", "page": 1, "entry": "e0018" },
      "offset": { "start": 523, "end": 543 },
      "context": { "before": "…", "after": "…" },
      "match_type": "implicit",
      "found_by": ["rule:relation", "llm:semantic"],
      "binding": { "mode": "entry_hint", "occurrences": 1 } },
    { "quote": "图 3 不同学习率下的验证损失曲线",
      "source_ref": { "file": "report.pdf", "sha256": "…", "page": 3, "entry": "e0033" },
      "offset": { "start": 544, "end": 561 },
      "match_type": "implicit",
      "found_by": ["rule:numbering", "structure:figure", "llm:semantic"],
      "binding": { "mode": "entry_hint", "occurrences": 1 } }
  ],
  "asset_refs": [
    { "kind": "page_render", "ref": "fixtures/out/report.pdf.p003.png", "page": 3,
      "note": "第 3 页整页渲染 —— 图形内容只能靠它来读" }
  ],
  "note": "指向图的句子 + 图注 + 原始页图，共同构成趋势类证据"
}
```

- `spans[]` **至少一个**；`match_type` / `found_by` / `binding` 都在 span 级
  （同一 bundle 的不同片段可以由不同通道命中）
- `asset_refs[]` 指向页图 / 裁剪图 / CSV 导出 —— **这是「完整原文」原则在图表上的落地**
- `source_ref` + `offset` 是回溯凭据：一路回到原始文件的具体字符区间，再经 L1 entry 回到原始像素
- `note` 是唯一自由文本，只允许描述性表述

---

## 7. 诊断 ≠ 召回（写死）

| | 定义 | 在哪算 | 性质 |
|---|---|---|---|
| **evidence recall** | 每条 canonical rubric 条目的真材料里，L2 是否至少召回一条 | **评测环节，用人工 gold set 算** | **主指标** |
| **facet coverage** | 每个 facet 的检索健康度与各通道命中数 | L2 产物里的 `diagnostics` | **只作诊断** |

两条硬保证：

1. **L2 的产物里根本不存在 recall 字段。** 没有字段就没有被冒充的机会。
2. **facet coverage 与 rubric 分值之间不存在任何映射路径。**
   **「命中多」不代表「写得好」**，它只代表检索器找到了东西。

`channels` 是**各通道命中数**（同一 span 可被多通道命中，**故不可相加**）；`hits` 是去重后的 span 数。

---

## 8. 「不带评价」的机械保证：**schema 优先，禁用词表只作辅助**

| 优先级 | 机制 | 说明 |
|---|---|---|
| **主** | **schema 封闭 + 无任何评分字段** | `additionalProperties: false`，字段表里根本没有 score / quality / adequacy。**L2 在结构上就无法产生评分字段** —— 不依赖任何语言层面的判断 |
| 主 | `authority` 块（`const`） | 声明 rubric 是唯一评分权威、plan 不参与评分 |
| 主 | `quote` + `source_ref` + `offset` 逐字断言 + 绑定分级 | 这是**真实性**检测 |
| 辅助 | `advisory_lint` | 禁用词表**降级**：语言变体太多、覆盖不全，而且**会误伤原文 quote**。只扫**模型生成的自由文本字段**，绝不扫 `quote` / `context` / 任何原文派生字段；只提示不阻断 |

---

## 9. 成本（按 1M 上下文评估）

1. **比赛样例尚未使用窗口化**；更长作业需要单独测试上下文与成本边界。
2. **多模态让「图表的完整原文」彻底落地** —— `read_page(n)` 的页图直接喂模型。
3. **主要成本项 = N 个 facet × 全文。** 需要试点实测（按项目既定方法论：先跑 3~5 个 facet 读真实 usage）。

**不能通过「裁剪原文」控制成本**（违反 §0）。可用手段只有：同一 rubric 条目下的 facet 合并成一次调用
（必须记录合并关系，否则召回不可归因）、预筛标注引导注意力。

---

## 10. 工程约束

### 10.1 真正的 schema 校验器

`src/validator.mjs`：自写的 JSON Schema 子集校验器（零依赖），四份契约示例都在回归测试里过一遍。

**关键性质是 fail-closed**：遇到 schema 里**不认识的关键字**、未知 `type`、未实现的 `format`，
一律**抛错**而不是静默忽略。手写校验器最大的危险就是「看起来通过了，其实有一条规则没检查」——
所以宁可报错让人来补实现。已加断言守住这一点。

### 10.2 生成器与测试必须在失败时返回非零退出码

所有生成器（`_mkrubric` / `_mkplan` / `_mkexample`）与 `_selftest` / `_realtest`：
自证失败时 `process.exitCode = 1`。**否则「跑完了」和「跑过了」分不清**，CI 里会静默放过。

---

## 11. 实现状态与实测（2026-09-23）

**已实现**：`src/l2.mjs`（纯逻辑）+ `src/_l2run.mjs`（两步驱动，`--stub` 可离线跑）。
真 `report.pdf` 的实测结果：

```
R 阶段：第 1 次因**少报 rubric 条目**被拒（plan_incomplete）→ 把原因喂回模型 → 第 2 次通过
        10 条条目 / 4 个检索面（R2.1 有 3 个面 + 2 个盲点「充分」「合理」）
F 阶段：逐面一次调用
        R2.1·F1 hits=3  located        通道={"llm:semantic":3,"rule:numeric":3,"structure:table":2}
        R2.1·F2 hits=2  located        通道={"llm:semantic":2,"rule:numbering":1,"structure:figure":1}
        R2.1·F3 hits=0  undetermined ⚠ 硬规则覆写（模型报 located）
        R2.2·F1 hits=2  located        ✗ 判废 1 条（quote 绑不回原文）
```

三条值得单独说：

- **拒收要喂回给模型**。R 阶段少报条目被拒后，把 `plan_incomplete` 与缺失的条目名一起喂回去，
  模型第二次交齐了。拒收不是终点，是**可纠正的信号**（而且拒收本身留痕）。
- **硬规则覆写可见**。F3 那条模型报 `status=source_unavailable` 却给 `outcome=located` ——
  系统把它覆写成 `undetermined` 并写 `outcome_claimed: "located"`：既不放行错误组合，
  也不丢掉模型原本说了什么。另有第二条硬规则：**报 located 但一个候选都没绑上原文 → 也只能 undetermined**
  （提交的东西有问题 ≠ 材料里没有）。
- **判废 ≠ 未找到候选**。绑不回原文的 quote 进 `dropped`（带 `reason` 与原文出现次数），
  只有挂在它所属的那个 facet 上，不影响别处；`no_candidate` 另有其义。

`_l2run --stub` 的自证里包含：plan/证据两份产物都过真 schema、每条 span 的
`slice(offset) === quote`、`source_ref.entry` 覆盖该 span、上下文确实切自原文、
通道归因 ⊆ 声明的通道、每个 facet 都有诊断记录（含 0 命中的）、
**产物任何层级都没有 recall 字段**、整页渲染的 `asset_refs` 指向的文件真实存在。

`_selftest` 里另有 15 条**不依赖模型**的纯函数断言（覆盖检查 / 两条硬规则与**不误伤**的对照 /
绑定与判废 / 通道归因 / 去重 / 候选与盲点的字段封闭）。

---

后续扩展（多文件作业、窗口化与成本控制）统一列于[项目技术总览](PROJECT-OVERVIEW.md#5-未来优化方向)，不作为当前 L2 契约的一部分。
