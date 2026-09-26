# AutoGrader · L4 设计：Rubric-native Assessment（按原 rubric 条目的**定性评估**）

> **版本：v0.3**（`src/l4.mjs` 里的 `L4_VERSION`，2026-09-24 定向）。
> 一句话：**按原 rubric 的条目给出结构化定性发现 + 判断/候选档位 + 可回溯依据 + 审查路由；不产生分数 —— 分数权归教师。**
>
> 上游：canonical rubric（评分权威）+ **assessment profile（L4 执行配置）** + L1 索引 + L2 证据 + L3 验证
> 下游：教师（三选 + 给分）→ 总结评语层

---

## 0. v0.3 定位：定性评价，教师给分

```text
原始 rubric        = 教师权威（冻结、只读、唯一评分权威）
assessment profile = 系统执行配置（可版本化，不进 rubric）
assessment         = 结构化定性评估（发现 + 判断/候选档位 + 依据）    ← 无分值
教师               = 定最终分数（三选确认评价 + 给分）
总结评语           = 吸收教师给分后的整篇叙述（另一层）
```

已有样本暴露出明显的**分数校准问题**；以下诊断说明为什么比赛版不让模型提交精确分，并不构成定性发现普遍正确的证明。

| 实测 | 定性层面 | 定量层面 |
|---|---|---|
| VerAs R6 | 对照组模型能正确写出「未将其归类为随机或系统误差，故不计分」；另一份 rationale 自己写「归类不严谨」 | **仍给分**；2 份把 gold=0 打成 4（单向高估） |
| VerAs R1 | — | 9/9 全给 4，gold=5 的 3 份全给 4（无分辨力） |
| VerAs 0 分端点 | — | 漏判 6/6 |
| 人类上限 | — | 评分者间 Pearson 仅 0.72/0.69（论文）；SOTA 总分 MSE 19.11（35 分量表） |

比赛版把模型输出限制在有依据的定性判断；全项目各层的 `layer_produces_score` 为 `false`，最终分数由教师确定。

### 七条不可动的原则

1. **按 rubric 条目评估，不按 facet 评估。** facet 是检索中间物，不能成为评估原子。
2. **L2 evidence 是注意力信号，不是信息边界** —— L4 仍能访问完整原文，可用 `supplemental_quotes` 补料。
3. **L3 check 是辅助事实，不是结论**：

   | L3 结论 | 对 L4 的意义 |
   |---|---|
   | `pass` | 只证明对应机械关系成立 |
   | `fail` | 一项**可引用的反证**（finding 也可挂钩它） |
   | `unverified` | 既不支持也不反对，只能 neutral |
   | 被拒的调用 | 仅系统诊断，不影响任何结论 |

4. L4 不修改 rubric、不重新拆评分标准。
5. 只评 `scorable=true` 的**叶子**；**父项与总分不聚合出分值**（教师给分），模型与程序都不产生分数。
6. **没有找到证据 ≠ 学生没写**；**「检索没找到」≠「通读后确认没写」**（见 §4 的 `outside_defined_levels`）。
7. **契约按 scoring_strategy 分支**（points/binary → judgment；levels → level_status + 候选档），两个分支**物理隔离**（工具 schema 按条目动态生成）。

---

## 1. 哈希链：rubric → assessment profile → assessment

```text
原始 rubric（冻结、评分权威）
        ↓ source_sha256   ← 绑的是 rubric **原件**的哈希（rubric.source.sha256）
assessment profile（L4 执行配置）
        ↓ profile_sha256
L4 assessment
```

| 变化 | 后果 |
|---|---|
| 原始 rubric 字节变 | L2 / L3 / L4 全部失效 |
| assessment profile 变 | **只**让 L4 及以后失效，L2/L3 继续有效 |

- `design/rubric-assessment-profile.schema.json` / `…cs3223-test.json`（由 `src/_mkprofile.mjs` 生成）。
- **分值不从天上掉**：`max` 从 rubric 原件那一行逐字读出，`strategy_source_ref` 断言原件切片等于该条目原文。
- 三种策略：`points`（min/max/step，可带 `criteria[]`）· `levels`（`levels[]`，可带**等级原文描述**）· `binary`。
  ★ v0.3 起 profile **不再要求**模型提交分数，但保留 min/max/levels 定义 —— 它们是**档位定义**与**满分参考**，
  教师给分时要用；`levels` 的档位表也是"不许自造档"的机械依据。
- CS3223 测试 profile 是 `provisional_test`（测试 rubric，不是教师 gold）。

---

## 2. L3 check 的显式作用域（`scope`）—— 不变

```json
{ "scope": "rubric_item", "rubric_item_id": "R2.1" }
{ "scope": "document",    "rubric_item_id": null }
```

- `rubric_item` → 按 id 归到对应条目；`document` → 进 `document_checks`，**不自动影响任何评价**，只能显式引用（且只能 neutral）。
- v0.1 上游没有 `scope` → 按 `rubric_item_id` 是否为空**推导**并标 `scope_inferred: true`（不当确定事实）。

---

## 3. 调用粒度与材料

一个可评分叶子条目**一次独立调用**（CS3223：8 个叶子 → 8 次会话）。每次模型拿到：

```text
rubric 条目原文 + 它的出处          ← 评分权威（不可改写）
评分策略（type + 档位定义/条项/满分参考）  ← 系统执行配置
该条目的 L2 候选证据（bundle + span）
该条目的 L3 机械验证结论（含 stance 与 reason codes）
文档级 L3 结论（单独列出，不归属）
页面图（asset_refs 指向的整页渲染 —— 视觉内容只能看图判断）
L1 索引导航
完整原文（逐字；所有 quote 都必须能在这里找到）
```

★ 工具面（`l4Tools(strategyType)`）**按条目动态生成** —— 见 §4。
★ 图表类条目把页面图作为**图片附件**发出；纯文本条目不重复塞无关图片。

---

## 4. ★ 工具契约：`submit_rubric_assessment`（按 strategy 分支）

```text
points / binary 分支                 levels 分支
------------------------------       ------------------------------------
rubric_item_id  (必填)               rubric_item_id      (必填)
judgment        (必填，五值)          level_status        (必填，四态)
findings        (必填，可空数组)       candidate_level_ids (candidate 时 1–2 个相邻档)
evidence_refs   (必填)               boundary_condition  (双候选时必填，卡点)
asset_refs / verification_refs / supplemental_quotes / rationale （同上）
```

**两个分支都没有 `score` 字段** —— 模型给分没有落点（v0.2 的 score 已被删除；
`additionalProperties: false` + 动态生成让"走错分支"在 schema 层**物理不可能**，
这比 `if/then` 更强 —— validator 不支持 `not`/`anyOf`）。

### judgment 枚举（points / binary）

```text
satisfied / partially_satisfied / not_satisfied / insufficient_evidence / not_applicable
```

- `not_satisfied` = 已有材料支持"不满足"；`insufficient_evidence` = 现有材料不足以可靠判断。
- ★ **不砍成红黄绿三值**：「部分做到」「没有做到」「材料不足」「不适用」是不同情况，合成一色会误导教师。
  红黄绿只能是**界面的派生提示**，不是底层契约。

### level_status 枚举（levels）★ 重点

```text
candidate              → candidate_level_ids: [L4] 或相邻 [L3, L4] + boundary_condition（卡点）
insufficient_evidence  → 原件不可读 / 关键图表无法核实 / 原文覆盖本身不可靠 → 不能断言缺项
not_applicable         → 标准不适用（≠ 学生没写），交教师确认
outside_defined_levels → 已通读可靠完整原文仍无相关内容，但所有档位都预设"学生写了"
                         → 留空候选 + 送审；不硬选低档，不自造档
```

- 非 candidate 状态一律 `candidate_level_ids = []`，不产生分数。
- **候选档只能用 profile 已定义的 level_id**（`level_not_in_rubric`）——严禁自造（VerAs 的 L0 是无出处的发明，污染 5 个维度）。
- **相邻** = profile 等级按 score 升序后紧邻（中间没有别的档）；**双候选必须写 `boundary_condition`**。
- 唯一候选时它就是「**AI 建议档位**」——明示来源，不暗中包装成无分的定性判断。
- **核心区分**：`L2 没召回 ≠ 学生没写`。L2 没召回时要**继续核查原文**；只有原文覆盖本身不可靠才落 `insufficient_evidence`；
  只有**通读确认**没有才落 `outside_defined_levels`。

### finding 契约（两个分支共用）

```text
polarity   strength / concern / neutral     ← 封闭三值（不合并红黄绿）
kind       calculation / reasoning / completeness / presentation / other   ← 宽类别，帮助统计
note       具体说明（≤500 字）—— 细节由评价文本自然覆盖，不做成硬枚举
severity   major / minor（可选；不用 impact 这个词，避免与 verification_refs 混淆）
quote      （可选）逐字原文定位 → 系统绑定后回填 located
check_id   （可选）L3 挂钩：可机械验证的断言（如"计算错误"）应当挂钩，而不是凭眼睛断言
```

系统**回填**（不是模型填）：`located`（quote 绑定结果）、`verification`（check 挂钩的 stance/scope）。
**不设模型自报的 certainty 字段** —— 项目原则"不采信模型自报置信度"；
「是否确定/是否经 L3 验证」由 `check_id` 是否有效挂上来表达，「影响多大」由 `severity` 表达。

★ **finding 定位失败不丢弃 finding 本身**（丢观察比丢引用代价大）：`located=null`、原始请求进
`diagnostics.dropped_findings`、并触发送审；评语层与教师都能看到"这条观察的定位断了"。

★ **kind 不参与任何送审路由**（送审看证据断链，不看标签）。

---

## 5. Evidence 与补充引用（沿用 v0.2）

`evidence_refs` 每条都要过：bundle 真实存在 → span index 存在 → `full.slice(offset) === quote`
（全项目唯一那条不变量）→ `source_ref` 指向当前文档。角色固定 `support / counterevidence / context`。

`supplemental_quotes` 复用 `src/quote-binding.mjs`（三级绑定 `entry_hint > cursor > first`），
但 **L4 的接纳规则比检索阶段更严**：必须 unambiguous（ambiguous → 丢弃，不许"取首次出现"当已确认事实）、
切片一致、entry 覆盖。绑不回去 → 只进 `diagnostics.dropped_supplemental_quotes`，**不能作为依据**。

> **实测（v0.2 真实模型第一次跑）**：25 条补充引用里 6 条是"像原文但不是原文"的改写 → 全部被
> `quote_not_found` 丢掉。这正是"绑定必须逐字"的意义：模型擅长照抄、不擅长数字符，
> 但**改写比抄错更危险** —— 它读起来完全合理。

---

## 6. impact 约束

```text
pass → 不能标 contradict        fail → 不能标 support        unverified → 只能 neutral
```

违规的引用直接丢弃（`impact_conflicts_*`）。

---

## 7. ★ 候选档校验（v0.3 取代了分数校验）

| 检查 | 拒收码 |
|---|---|
| level_status 不在四态内 | `arguments_failed_schema` |
| candidate 但没给候选档 | `arguments_failed_schema` |
| 候选档不在 profile 定义的等级里 | `level_not_in_rubric` |
| 候选档超过 2 个（或重复） | `too_many_candidates` |
| 两个候选档不相邻 | `levels_not_adjacent` |
| 双候选没写 boundary_condition | `boundary_condition_required` |
| 非 candidate 状态却给了候选档 | `candidates_with_non_candidate_status` |
| levels 条目交了 judgment | `judgment_forbidden_for_levels` |
| points/binary 条目交了 level_status / candidate_level_ids | `level_status_forbidden_for_points` |

后两条是**防御性**的（正常会被动态工具 schema 先拦下）—— 谁配错了都能拦住。

---

## 8. rationale 边界（沿用 v0.2）

- **长度是软上限**：建议 ≤**300 字**，超过**不拒收、不改写**，只记 `over_limit: true` + 强制送审；
  另有 **2000 字**工程上限（撞到才被调用闸拒收）。
- 必填；永远标 `derived_by: 'model'`；带 `limit` / `over_limit` / `chars` 记账。
- **每条 rationale 至少要有起作用依据**（`support` / `counterevidence` / **带定位的 finding** 都算），
  或状态本身就是"材料不足/不适用" → 否则强制送审。

---

## 9. 审查路由（系统强制，模型无此通道）

```text
insufficient_evidence           状态本身就说材料不够
not_applicable                  ★ v0.3：标准不适用 ≠ 学生没写 → 交教师确认
outside_defined_levels          ★ v0.3：通读后仍无内容的档位缺口 → 教师裁决
l3_fail_for_item                该条目存在 L3 fail
referenced_l3_fail              显式引用了 fail
referenced_l3_unverified        显式引用了 unverified（= 模型认为它对判断必要）
source_conflict                 同时引用了支持与反证
supplemental_evidence_used      用了 L2 之外的补充引用
visual_asset_unreadable         视觉资产读不到
missing_support_evidence        给了判断/候选档却没有任何起作用的依据
dropped_assessment_ref          ★ evidence / check / asset / 补充引用 / finding 定位，任一被丢弃
rationale_over_limit            rationale 超过建议长度（软上限：不拒收，但让人看见）
model_output_rejected           该条目的提交被拒过（只进诊断，不影响结论）
incomplete_assessment           该条目最终没有产出 assessment
```

**路由哲学**：看**证据断链、check 冲突、未解决的不确定性**，不凭 `kind` 标签触发。

---

## 10. 产物与覆盖账目

`design/rubric-assessment.schema.json`；实例：

```text
fixtures/real/out/cs3223-writeup.pdf.assessment.json        ← 真实模型
fixtures/real/out/cs3223-writeup.pdf.assessment.stub.json   ← 离线 stub
```

```text
authority / doc / rubric / assessment_profile / evidence / verification / index
assessments[]        ← 只含可评分叶子（含 strategy_type / judgment|level_status / findings / 依据）
aggregation.sections ← 每个顶层父项的覆盖明细
aggregation.total    ← maximum（满分参考）+ complete + incomplete_items
                        rule = "no_machine_scores_teacher_decides"   ★ 没有 awarded
diagnostics          ← 账目（accepted + rejected = attempted）、缺哪些条目、送审数、
                        丢弃的引用（含 dropped_findings）、逐条回合数
```

★ v0.3 起 `authority.layer_produces_score = false`（全项目一致）：机器不产生分值，教师给分。

---

## 11. 三阶段教师协作流程

```text
① L4 逐条定性评估（本层）          findings + judgment/候选档 + 原文定位
        ↓
② 教师（工作表 / 网页入口）          三选：准确 / 不准确 / 部分准确；可改写评价并给分
        ↓
③ 总结评语（另一层，吸收①与②）      重读完整报告 + 教师给分 + 教师确认后的各条评价 → 整篇评语
```

**为什么③放在教师之后**（关键决策）：
- 评语与分数在结构上**不可能矛盾**（教师给分是输入，评语围绕已定分数组织）。
- 任务性质是「翻译」（把教师的定量决策 + 系统的定性发现翻成学生能读的话），不是「评判」——
  前者 LLM 擅长且错得便宜（评语偏了教师还能改），后者正是我们已证明做不稳的事。
- 系统从头到尾没有先于教师下定量结论 —— 「教师协作式」的完整闭环。

**②的默认粒度**是条目级三选，也允许教师改写评价；**未标注 ≠ 准确**，评语层不能把未经确认的 AI 初判当作教师意见。

**②的入口（已实现，`src/_teacheredit.mjs`）**：

```text
生成工作表   node _teacheredit.mjs --assessment <L4 产物> --profile <profile> --rubric <rubric> [--out <json>]
校验填写     node _teacheredit.mjs --check <教师填好的 json> --profile <profile> --assessment <L4 产物>
```

- 工作表 = 每个叶子一条：**条目原文 + 系统结论（judgment / level_status + 候选档）+ 送审原因 + 观察摘要（标注是否可回原文核对）** + **待填槽位**（verdict / score / note / final_level_id）。
- ★ **模板态 `status = needs_teacher_input`，不是结果**：空 score 会被校验器拒；填完必须把 status 改成 `teacher_confirmed`（发布评语还要加 `approval`）。
- 校验口径**复用 `verifySummaryInputs`**（不再写第二套）；本脚本只管"教师填写这一层"，正文/索引绑定由 `_summaryrun` 的完整闸负责。
- ★ 两条不变量的实测：**未填的模板 → 校验失败（exit 1）**；已填的 → ALL PASS，并如实显示三选分布。
- 「已给分」的判据是**每条都有 score**；`verdict` 允许留空（= 内容未获确认，是设计里的合法态，不算"没填"）。

**一键闭环 + 端到端账目（`src/_e2e.mjs`）**：

```text
node _e2e.mjs --doc <学生原件> --rubric <canonical> --profile <profile> [--scores <教师给分>] [--stub] [--turns N]
node _e2e.mjs --audit-only [...]      # ★ 只对账，不跑层（用已有产物；账目可独立重算）
node _e2e.mjs --strict   [...]        # 账目有偏离时也返回 1（CI 用）
```

- **唯一真相**（对账基准，不采信任何产物自报）：① 学生**原件**的字节 sha256（现算）；② profile 里 `scorable` 的**叶子集合**。
- 各层对账：L1 索引是否绑当前原件 + 正文能否逐字切回；L2 有证据的条目是否 ⊆ 叶子（不许挂在非叶子上）；L3 check 归属是否 ⊆ 叶子 + 账目是否平；**L4 结论集合是否恰好等于叶子集合（缺一个/多一个都列进 `diffs`）**；评语覆盖同理。
- ★ **fail-closed**：任一层 exit≠0 → 不跑下游，报告写明在哪一层断的。
- ★ **退出码分档**（不把"结果状态"与"工具坏了"混在一起）：编排失败或自证失败 → exit 1；账目偏离 → 默认只报告，`--strict` 时才 exit 1。
- 实测（真实产物 `--audit-only`）：**账目全平** —— L1 entries=54 且绑原件 ✓、L2 覆盖 8/8、L4 结论 8/8（findings 48，无锚 5）、评语 8/8（release=draft）。
  附带信息：L3 只对 1/8 个条目做过机械检查 —— **L3 是按需验证（不要求全覆盖）**，但"哪些条目没有 check"必须看得见，账目里显式列出。

**③的边界**：评语是给人看的自由叙述，**不加闸**（上游教师已把关）；
但输入里每条评价都自带定位，模型复述事实时会带上出处。评语必须以教师给分为准绳。

**已实现**（`src/summary.mjs` + `src/_summaryrun.mjs` + `design/summary.schema.json`）：

```text
输入   <case>.assessment.json（L4 产物）+ <case>.txt（完整原文）+ teacher-scores.*.json（教师给分）
输出   <case>.summary.json / <case>.summary.stub.json
```

- **教师给分夹具**：`design/teacher-scores.cs3223-test.json` —— 每条 = `{rubric_item_id, score, max, verdict, note}`，
  `verdict ∈ {accurate, inaccurate, partially_accurate, null}`（null = 教师未三选）；另有 `approval`（发布批准记录，缺省 null）。
  ★ **只有 `verdict='accurate'` 才意味着"内容被逐条确认"**；部分准确/不准确/未三选都属于**内容未确认**。

#### 输入闸（fail-closed）

教师文件自报的 `max` 不是权威上界；校验须回到 rubric/profile，并检查以下条件：

| # | 判据 | 为什么 |
|---|---|---|
| 1 | doc.sha256 / rubric.source_sha256 与 L4 产物一致 | 同一份作业、同一份 rubric |
| 2 | 条目**唯一** | 重复 = 总分被灌水 |
| 3 | 条目**齐全**（= profile 可评分叶子集合） | 少一条 = 漏评被隐藏 |
| 4 | 每条 `max` **等于 profile 的权威满分** | ★ **自报的上界不是上界** —— 必须回到 profile 核 |
| 5 | `score ∈ [0, max]` 且为整数；verdict 在枚举内 | 基本合法性 |
| 6 | **全文逐字绑定 L1 索引**：`index.doc.sha256 === A.doc.sha256`、每条 entry `full.slice(start,end) === entry.text`、offset 单调且落在文内 | ★ "把全文换成无关文字"唯一机械可达的拦截（实测 54/54 成立） |
| 7 | profile 绑同一份 rubric，且 profile 字节对得上产物记录的 sha | profile 换了 → 满分口径就变了 |

负向回归 **11 条 + 1 条正向对照**（`_summaryrun.mjs`）：
`max 10→100` / 重复条目 / 缺条目 / **正文换成无关文字** / 索引条目与正文不符 / profile 绑别的 rubric /
profile 字节不符 / 非可评分叶子 / 分数越界 / 三选值非法 / 绑别的作业或 rubric，**全部必须被拦下**。

#### ★★ 发布闸 `release`（不再自称"教师已确认"）

```json
"authority": { "scores_are_teacher_final": false, "teacher_scores_status": "provisional_test" }
"release": { "status": "draft", "approved_by": null, "approved_at": null,
             "blockers": ["provisional_teacher_scores", "no_release_approval",
                          "unconfirmed_items:2", "disputed_items:1",
                          "unanchored_findings:5", "over_target_length"] }
```

- `scores_are_teacher_final` **由输入 status 决定**（只有 `teacher_confirmed` 才 true）——模拟三选不能代替教师确认。
- `status` 默认 `draft`；只有输入带显式批准记录（`approval.approved_by / approved_at / scope='summary_release'`）**且 blockers 全空**才可能 `teacher_approved`。
- **未经批准的评语不得交付学生** —— 这条是产品层面的硬边界，不只是标注。

#### ★★ 发布边界：`text` 与 `pending_notes` —— **两次调用，物理隔离**

```text
调用 A（工具 submit_student_summary）材料 = 教师已确认条目 + 完整原文  → summary.text（学生可见）
调用 B（工具 submit_pending_notes）  材料 = 未确认/有异议条目 + 完整原文 → summary.pending_notes（不发布）
```

- 依据：`verdict='accurate'` 才算内容被确认；未三选/部分准确/不准确的条目一律只出现在调用 B 的材料里。
- ★ **为什么必须是两次调用**（实测教训）：先做的版本是"一次调用 + 两个字段 + 分段材料 + 措辞约束"，
  实测真实模型**把同一条未确认的观察同时写进了正文与 pending** —— 措辞约束挡不住改写措辞的重复。
  改成两次调用后，模型在 A 里**根本看不到**未确认内容，「泄漏」在结构上不可能发生。
- 成本几乎不变：材料被切成两半（各带一份完整原文），实测两次调用合计 prompt 与原来一次相当。
- 每次调用只暴露自己那一个工具（工具名不同），比在同一个 schema 里加 `part` 字段约束更强。
- ★ 自证钉住（stub）：A 的材料里**不含**任何未确认条目、B 的材料里**不含**任何已确认条目。

#### ★★ 定位传递 `source_index`

「L4 有定位」不等于「教师能从最终评语点回原文」。程序把每条 finding 的定位**回抄**进产物：

```json
"source_index": [ { "rubric_item_id", "polarity", "kind", "severity", "note", "derived_by": "model",
                    "quote", "located": { "offset", "source_ref" } | null,
                    "l3": { "check_id", "stance" } | null, "anchored": true } ],
"anchor_summary": { "total": 48, "anchored": 43, "unanchored": 5 },
"unanchored_findings": [ … 既无定位也无 L3 挂钩的观察 —— 无法核对，不得写进 text … ]
```

- 48 条 findings → 48 条 `source_index`，其中 **5 条无法核对**（R2.2/R3.1/R3.3）被单独列出。
- 自证钉住：`source_index` 覆盖全部 findings、`anchored ⇔ (located || l3)`、`located` 的 offset 能逐字切回 `full`。

#### 实测（真实模型，CS3223）

一次调用产出评语（16.7k prompt / 4k completion / 21 s）：

- 教师 R2.2 标「部分准确」→ 评语显式写「这一条教师的判断是『部分准确』……那处笔误被算得过重了」；
- 未三选的 R2.3/R3.3 → 降级成「（初步观察，以教师判定为准）」；
- 全文**没有任何分数**，复述事实带具体图号/数值/行号；
- 长度 2327 字 > 1200 建议长度 → `over_target: true` 并进入 `release.blockers`（需教师过目）。

**明确不做**：教师风格学习、多模型仲裁、跨作业校准、自动长反馈闭环。

---

## 12. 测试

离线 stub（`node _l4run.mjs --stub`）与真实模型（`node _l4run.mjs`）**共用同一个装配器与同一套自证**。

| # | 要求 | 落在哪 |
|---|---|---|
| 1 | 只为 scorable 叶子生成 assessment | `_l4run` + `_selftest` |
| 2 | 产物里没有分值字段（score/awarded 不存在） | `_l4run` + `_selftest` |
| 3 | 契约按 strategy 分支；levels 无 judgment、points 无 level_status | `_selftest`（工具 schema 动态生成 + 防御性校验） |
| 4 | levels：候选档必须在 rubric 已定义档内、≤2、相邻、双档必写卡点 | `_selftest`（5 条） |
| 5 | levels：非 candidate 状态一律空候选（不硬选、不自造） | `_selftest` + `_l4run` |
| 6 | outside_defined_levels / not_applicable / insufficient_evidence 强制送审 | `_selftest` + `_l4run` |
| 7 | finding：干净定位被接纳、歧义/找不到 → finding 保留 + located=null + 诊断 + 送审 | `_selftest` + `_l4run` |
| 8 | finding 的 check 挂钩：有效回填 stance、无效进 dropped_findings | `_selftest` |
| 9 | kind 标签不触发任何送审路由 | `_selftest` |
| 10 | 不存在的引用被拒/被丢弃；impact 三条约束 | `_l4run` + `_selftest` |
| 11 | 覆盖账目：四态（judged/candidate/non_candidate_state/missing）如实记录，无分值 | `_l4run` + `_selftest` |
| 12 | accepted + rejected = attempted | 两处 |
| 13 | 跨层身份校验 + 四条负向回归 + 一条正向对照 | `_l4run` |
| 14 | 审查/拒收原因码在 schema 与工具层同源 | `_selftest` |
| 15 | 调用闸在 runner 里真的做 schema 校验（含 score 字段、facet_score、枚举外值） | `_selftest` |
