# AutoGrader · L3 设计：对候选证据的机械验证

> **契约版本：v0.2。** 每条 check 带显式作用域 `scope` 和 `authority.layer_version`。
> 兼容旧 v0.1 产物时，若须从 `rubric_item_id` 推导作用域，必须标记 `scope_inferred: true`，不得把推导结果当确定事实。

> 输入：L2 的 evidence bundle（带 source_ref + offset）+ canonical rubric + 完整原文
> 输出：验证结论（pass / fail / unverified）+ 可复算的依据 + 审计行
> 一句话：**对 L2 找到的候选证据做有限、可复现、有来源绑定的验证。不评分。**

当前 LLM 只能调用**预先定义**的验证工具（`src/verify-tools.mjs`）。受控程序生成属于[未来研究方向](PROJECT-OVERVIEW.md#5-未来优化方向)，不属于本版 L3。

---

## 0. 全项目核心原则
**涉及 LLM 的部分必须提供完整原文**（详见 L1/L2 文档）。图表只能靠渲染原始页来读。

---

## 1. 三条约束的落地

| 约束 | 落地 |
|---|---|
| **有限** | 检查种类 + 算子 + 容差**全部枚举**，越界抛错（fail-closed） |
| **可复现** | 纯函数；`computed` / `expected` / `delta` / 各操作数 offset 全进结果，可逐字复算 |
| **有来源绑定** | **模型只负责「指哪里」，数值一律由系统从原文解析**；期望值也必须来自原文 |
| **表态可证伪** | 数值 span 必须**声明量纲来源状态**（`inline` / `cited` / `undeclared`）；系统拿原文核对，填错则该操作数作废（§3.1）。表格通道由规则解析，模型无表态权 |

**模型连数字都抄不了。** 它给 `quote`，系统在指定区间内定位、切片、解析出数值与单位。
**唯一被"强制"的东西是它的表态**（枚举、可被原文证伪）—— 而不是"材料里必须存在什么"。

---

## 2. 检查目录（有限）+ 每个算子的输入 / 输出维度

| kind | 允许的算子 |
|---|---|
| `numeric_recompute` | `sum_of` `mean_of` `ratio_of` `percent_of` `difference` `relative_change` `product` |
| `unit_check` | `unit_consistent` |
| `internal_consistency` | `agree` `difference` `relative_change` `ratio_of` `percent_of` `sum_of` `mean_of` |
| `numbering` | `numbering_continuity` `equals_text` |
| `cross_reference` | `equals_text` `agree` `difference` |
| `magnitude_sanity` | `range_in` |

算子表（`arity` / `inDim` / `outDim` / `outUnit`，全部显式）：

| 算子 | arity | 输入维度 | 输出维度 | 输出刻度 | 备注 |
|---|---|---|---|---|---|
| `sum_of` / `mean_of` | ≥1 | 必须同维 | 同输入 | 基准 | |
| `difference` | 2 | **必须同维** | 同输入 | 基准 | |
| `ratio_of` | 2 | 必须同维 | `dimensionless` | 基准 | 分母不得为 0 |
| `percent_of` | 2 | 必须同维 | `ratio` | **`%`** | 输出在百分数刻度上 |
| `relative_change` | 2 | 必须同维 | `ratio` | 基准 | **操作数顺序 = [旧, 新]**；旧值不得为 0 |
| `product` | 2 | 不限 | 两维之积 | 基准 | |
| `unit_consistent` | ≥2 | 不限 | bool | — | 至少两个**已声明**量纲 |
| `range_in` | 1 | 不限 | bool | — | 范围名从枚举取，先归一 |
| `monotonic` | ≥2 | 必须同维 | bool | — | **按文档顺序**判 |
| `numbering_continuity` | ≥1 | text | bool | — | **按文档顺序**判「恰为 1..n」 |
| `equals_text` | 2 | text | bool | — | |
| `agree` | 2 | 必须同维 | bool | — | 差异须在容差内 |

容差枚举：`exact` / `abs_1e_3` / `abs_1e_2` / `abs_0_5` / `rel_1pct` / `rel_5pct`。
**不让模型自由给容差数字** —— 那也是自由度。

### 2.1 不进 L3 的
**图表观感类**（图例、坐标轴、配色）**不进 L3** —— 需要"看图判断"，不满足「可复现」。

---

## 3. 单位 / 量纲：**「没有单位」叫 `unknown`，不叫 `scalar`**

未写单位仅表示**量纲未声明**，不能当作无量纲；否则可能把时长与比率误判为同维。

| 单位后缀 | 量纲 `dim` | 基准 | 换算 |
|---|---|---|---|
| 无（`''`） | **`unknown`**（量纲未声明） | —（不参与同维运算） | — |
| `%` `pp` `百分点` `个百分点` `百分比` | `ratio` | ratio | ×0.01 |
| `ms` `s` `min` `分钟` `h` | `duration` | second | 到秒 |
| `KB` `MB` `GB` | `bytes` | byte | 到字节 |
| 其他拉丁缩写（如 `kg`） | **未知 → 不猜** | — | 转 `unverified(unknown_unit)` |

**真正无量纲必须有额外依据。** 机制是 `dim_evidence`：一段**可回溯到原文**的文字 + 一张**枚举的**
关键词表（`DIM_KEYWORDS`：准确率/占比/概率 → `ratio`；时长/耗时 → `duration`；大小/内存 → `bytes`）。
拿不到依据 → `unknown` → 参与同维运算一律 `unverified(unknown_dimension)`。

判定依据会完整写进产物：`operand.dim_source = { quote, offset, dim, via: unit_marker|keyword, marker }`。
`via` 与 `marker` 都可审计，`quote` 同样满足 `slice(start,end) === quote`。

示例里 `ck0001` / `ck0002` 是一对**同一个算式**的对照：

```
ck0001 [pass      ] 给了列头「验证准确率」作依据 → 两个操作数都判为 ratio → 可判定
ck0002 [unverified] 不给依据 → 两个都记 unknown → unknown_dimension（做不了，但如实说）
```

### 3.1 ★★ 数值 span 必须**表态**量纲来源状态（枚举、必填）

「这个数的量纲从哪来」由模型**表态**，取值只有三个：

| 状态 | 含义 | 系统怎么证伪 |
|---|---|---|
| `inline` | 值自己就带单位标记（写 `7.1 ms` 才算，写 `7.1` 不算） | 值里有没有可识别的单位标记，机械可查 |
| `cited` | 另给一段 `dim_evidence` 指向原文 | 依据必须**逐字命中**且过 `DIM_KEYWORDS` |
| `undeclared` | 明确表态：找不到来源 | 值里有单位标记、或另给了依据 → 这个表态就是假的 |

**为什么这一条能做成硬约束，而「数值操作数一律必须带 `dim_evidence`」不能** ——
这是两种约束的**对象不同**：

- 状态是**枚举表态**，系统能拿原文**证伪**它 → 强制它不会逼出伪造；
- 「原文里必须存在一段能过关键词表的文字」是**材料的事实**。材料没有就是没有，
  强制只能逼模型抓一段不相干的字来凑（即 `llm.mjs` 已写明的"买一个通过"风险），
  而且会把「模型没给依据」与「材料没依据」混成同一种 `unverified`。**故不采用后者。**

**边界同样是机械的**：表态为 `undeclared` **不会**导致 fail —— 它只是让量纲停在 `unknown`，
下游照旧走 `unknown_dimension`（"不知道"是诚实的答案，不是错误）。被证伪的表态各有各的码：

| 情形 | 原因码 |
|---|---|
| 没有给状态（非工具通路的兜底；工具通路上**调用闸直接拒收**，不产生 check） | `dim_source_status_missing` |
| 说 `inline`，值里却没有单位标记 | `dim_status_inline_without_unit` |
| 说 `cited`，却没给依据 | `dim_status_cited_without_evidence` |
| 说 `undeclared`，值里却有单位标记、或另给了依据 | `dim_status_undeclared_with_source` |

**两条通道的差别是有意设计的**：表格通道的单位**全部由规则解析**（§4.1b），
模型在那里**没有表态权** → 表格操作数的 `dim_source_status` 恒为 `null`（= 不适用，
不是"漏了"）。文本操作数同理（没有量纲可言）。

**为什么要在调用闸强制**：这样「模型漏参数」与「原文没单位」在数据上就**不可能混** ——
前者根本不产生 check（进 `rejected_calls`），后者是一条诚实的 `unverified(unknown_dimension)`。
L4 消费 L3 结果时，这个区分必须是数据层面的，而不是靠读措辞猜的。

**实测（同一份外部样本 CS3223，真实模型 `deepseek-flash`，加上这条约束后重跑）**：

```
9 回合 / 8 次工具调用 / 拒收 0 —— 模型每一次都给出了 dim_source_status
（20 个 span 操作数 + 3 个 span 期望值全是 cited；表格通道的操作数是 null）
counts：pass 6 / fail 1 / unverified 1
```

对照上一版（没有这条约束）的 `pass 6 / fail 1 / unverified 4`：**变的正是那 3 条
`unknown_dimension`** —— 期望值（报告自己的均值行）过去拿不到量纲，现在模型主动指出依据，
于是 `ck0007` / `ck0008` 从 unverified 变成 **pass**；剩下的那 1 条 `unverified` 是**真歧义**
（`ambiguous_operand_selection`）。也就是说：强制表态把"模型没给参数"这一层噪声清掉了，
**剩下的 unverified 才是真的**。那条 `fail` 也照旧复现（报告 4-table 查询的均值 0.744 vs
报告自己写的 0.62，四项前置条件全 true）—— 这不是误判，是报告内部不自洽。

其余规则：

- **同维要求**：`difference` / `sum_of` / `mean_of` / `agree` / `ratio_of` / `percent_of` /
  `relative_change` 要求输入同维。已声明的两个维度不同 → `unverified(incompatible_dimensions)`；
  有任一侧未声明 → `unverified(unknown_dimension)`。**不做补齐推断。**
- **所有 `computed` / `expected` / `delta` 一律在基准刻度上**（比较才一致）；
  算子的自然刻度记在 `computed.scale` 里，信息不丢。
- **两条通道共用同一套换算**（`scaleFromDimSource`）：只有依据是**单位标记**时它才说明刻度。
  曾有个不一致：表格通道按列头「训练时长(min)」把 7.1 换成了 426 秒，而 span 通道只识别了量纲、
  没做换算 → 同一个量在两条通道给出不同的基准值。现在有断言钉住：
  **span 的 `7.1` + 依据「训练时长(min)」与表格的 `7.1` 必须得到同一个 `426`**。
- **内联单位优先于依据**；两者都声明却矛盾 → `unverified(dim_evidence_unusable)`（不猜哪个对）。
- `unit_consistent` 的诚实语义：**已声明量纲少于两个时它什么也证明不了** → `unverified(all_dims_undeclared)`。
  示例里的 `ck0004` 就是这样 —— 三个操作数里只有结论行那个带单位 → 做不了。
  这不是缺陷，这是本层能给出的最有用的诚实。

---

## 4. ★ 「不能让 LLM 选错对象」

工具能保证算对，**喂什么进去**是模型的决定。四层收窄 + 一条降级规则：

| 层 | 机制 | 抓什么 |
|---|---|---|
| ① 空间收窄 | operand 只能从 L2 **已绑定来源**的 span 里取 | 指到 L2 没找到的地方 |
| ② 区间校验 | `quote` 必须在**声明的那个 span 内**逐字命中 | 跨行 / 跨表 / 跨段选错 |
| ③ 同处校验 | `label` 必须与值**同一个 span** | 标签与值不在一处 |
| ③b 贴标签定位 + **完整 numeric token** | 先看值是否就在标签内（「基准 0」「占比 50%」），否则取标签**之后最近**一处，再退到标签之前；**且它必须是一个完整的数值 token** | 值被"就近原则"绑错；值只是某个更长数值的子串 |
| ④ 唯一性校验 | `label` 在**去重后的** span 空间里、按**绝对偏移**出现次数必须 = 1 | 「同一标签对应多处」 |
| **降级** | **任一层不过 ⇒ 最高只能 `unverified`；不执行计算，也绝不产出 `fail`** | 用错误操作数否定学生 |

③b 处理两个不同的定位风险：

1. **先修「就近原则」**：合成文本 `总量 1，部分 0.5，占比 50%，…，放大 1e308，基准 0` 里，
   `quote='0'` + `label='基准 0'` 在旧逻辑下会绑到 `1e308` 里的那个 `0`（在 span 里盲目取首次出现）。
   → 改为**值的定位由标签锚定**，绑到「基准 0」里那个 0 ✓。
2. **再修「子串不是 token」**：`'0'` 在 `'1e308'` 里、`'30'` 在 `'300'` 里都只是子串。
   → 新判据 `isCompleteNumericToken()`：前后都不能再是数字/小数点，也不能被 `e/E` 指数续上。

搜索窗口不能截断数值 token；只用距离判断是否贴近标签。两种失败原因分别记录：

```
值只是更长数值的子串      → operand_not_a_complete_numeric_token
值是完整 token 但离标签太远 → operand_quote_not_near_label
```

### 4.0c ★ 完整 token 必须在**完整原文**上判定（第三条修正）

前两版都在**切片内部**做 `isCompleteNumericToken`：先切出标签区间，再在区间里找值并判它是否完整。
问题在于 **切片的末端会伪造出一个"数值到此结束"**：

```
原文：      准确率 0.8612，其余 1
模型给的标签：准确率 0.861        ← 标签被截断（仍然是原文的逐字子串，所以能找到）
模型给的值：  0.861              ← 在标签区间内部，"0.861" 后面就是区间末尾 → 看起来完整
结果：       把 0.8612 当成了 0.861 → **改变了原文含义**
```

修法是把顺序倒过来，两步都只在完整原文上做：

1. **先在完整原文上枚举**所有满足 `isCompleteNumericToken(full, i, len)` 的出现位置（`allCompleteTokens`）
2. **再判位置关系**：候选落在标签区间内 / 紧随标签之后（≤`GAP_AFTER`）/ 紧贴标签之前（≤`GAP_BEFORE`）

于是上例没有候选（`0.861` 后面紧跟 `2`，不是完整 token）→ `operand_not_a_complete_numeric_token`。
回归里同时钉了两条：**截断的标签不能把 `0.861` 从 `0.8612` 里切出来**；
以及**同类情形下绑到的是那处完整的 `1`（原文末尾），而不是 `0.8612` 里的子串**。

顺带补上一条：**期望值的来源信息不能丢**。上一版只存 `value/dim/unit/raw`，等于把"这个期望从材料哪一处来"
这最要紧的一半扔了。现在 `expected` 带 `quote` + `offset` + `source_ref`（或 `cell`），
自洽型检查则带 `rule` 说明期望是算子自身定义的。全项目唯一那条不变量在期望值上也成立：
`full.slice(offset) === quote`。

产物里记下 `value_anchor`（`inside_label` / `after_label` / `before_label`），锚定方式可审计。

④ 的计数也必须精细：**按绝对偏移去重**。同一段图注被两个 bundle 引用（粗细粒度不同的重叠 span）时，
旧逻辑会把它数成 2 次 → 误判歧义。实测对照：旧逻辑 2 次，新逻辑 1 次。

### 4.1 多行表格 span 不得判定
**operand 所在 span 若跨多行且是多行数值块（至少两行各含 ≥2 个数值）→ 一律 `unverified
(multiline_span_not_structured)`。** 理由：跨行意味着这个 span 里并排放着多行数据，
「这个值属于哪一列」在这个 span 内部没有机械依据。
示例里 `ck0008` 与 `ck0001` 是同一个算式，只因为来源的 span 一个是整块、一个是单行，结局就不同：

```
ck0001 [pass]       操作数取自单行表体行（struct=yes）
ck0008 [unverified] 操作数取自多行整块（struct=NO）→ multiline_span_not_structured
```

**L1 已经有最小表格行列还原了（v1.3.0）**，所以这条限制的适用范围收窄为「span 本身跨行」：
在 L1 索引里每一行都是独立行单元、带 `cell_breaks`。

上面三条都是**同一种错误**：在切片或残缺的 token 上做判断。第四条同类（2026-09-23）：

### 4.0d ★ 负号也是完整 token 的一部分

引 `0.25` 而原文是 `-0.25` 时，丢掉的不是格式 —— **值本身变了**（0.25 vs −0.25）。
判据：token 前面若有一个"真负号"，这个 token 就不完整。而**真负号**要排除区间与编号：

| 原文 | 引 | 判定 |
|---|---|---|
| `共 -0.25` | `0.25` | **不完整**（丢了负号） |
| `= -0.25` / `(-0.25)` / 行首 `-0.25` | `0.25` | 不完整 |
| `3-1` | `1` | 完整（`-` 前是数字 → 区间） |
| `v-1` / `图-1` / `(a)-1` | `1` | 完整（编号/区间，不是负号） |

判据是"负号前的字符是不是数字/字母/右括号/CJK" —— 是则不是负号。

### 4.1b 表格通道：键值查询（对象定位的第二条通道）

操作数支持两套形状，由 `table_id` 是否存在决定走哪条：

```json
{ "table_id": "t0001", "row_label": "baseline", "column": "验证准确率" }
```

**必须带表格身份** —— 同一份报告里两张表都可能有 `baseline` 和「准确率」。

程序负责解析成**唯一** `cell_id`，返回：**原始单元格内容 + 行列标题 + 单位来源 + `source_ref`**。
实测（真 `report.pdf`）：

```
模型提交查询：{"table_id":"t0001","row_label":"+ attention","column":"验证准确率"}
解析成唯一 cell：t0001:r2:c2  "0.847"  offset=739-744
行标签："+ attention"   列头："验证准确率"
单位来源："验证准确率" → dim=ratio via=keyword marker="准确率"
结构来源：l1_rule_parse（列边界 pdf_geometry）· 表格 t0001 · 条目 e0018 · 第 1 页
```

**单位不来自单元格** —— 单元格里是裸数字。`unit_source` 必须连同 `quote` + `offset` 一起存下来，
它也是一个「来自材料某处」的事实。

### ★★ 表格单位的确定语义（作用域由声明位置决定，2026-09-23）

真实实验表逼出了这一条：那张表的**列头是连接方案名**（`Index-join` / `Merge-join` / …），
单位却写在**行标签**「`Average Time (ms)`」里。只看列头 → 一律判成「单位不明确」→ 一个结论都出不来。
而模型自己在 span 通道里**正确指向了那一行标签**拿到了 `ms` —— 这反证了表格通道也该去行标签找。

**四条量纲来源，全由规则判定**（模型只说"查哪一格"，不说"单位是什么"）：

| # | 情形 | 作用域 | 典型例子 |
|---|---|---|---|
| ① | **列头**声明了单位 | `applies_to: column`（整列） | 列头「验证准确率」→ ratio |
| ② | **行标签**声明了单位 | `applies_to: row`（整行） | 行「Average Time (ms)」→ duration |
| ③ | 行列都没声明，但**整张表只声明了一种量纲** | `applies_to: table`（整表） | 单位只在 Average 那行写了一次，但整表都是 ms |
| ④ | **表注**（`from: caption`）声明了单位 | `applies_to: table`（整表） | 表注「Table 3: Memory usage of each join plan」→ bytes |

优先级就是 ① < ② < ③ < ④ 的顺序（数字越大越"远"），判定**是逐级下沉的**：

- ③ 是"整表只有一种量纲"这种排版（单位只写一次）的兜底；**声明了 ≥2 种就不兜底** ——
  那说明各行列量纲本来就不同，不能混。
- ④ 表注在表**外**，只能靠**位置邻接**判定（L1 的 `caption_entry`，或紧邻表区的上/下一条），
  所以它是**最后一级**，只在**表内一处都没声明**时才启用。它**不与表内声明做冲突判定** ——
  表外的注解不该覆盖表内的声明（否则会把隔壁表的注解算到这张表头上）。
  表注**自己**声明了两种量纲 → 才判 `dim_evidence_unusable`。
- 冲突判定只发生在**同级**（列头 vs 行标签）之间 → 两种不同量纲 ⇒ 这一格量的是什么无法判定 ⇒ 不猜
  （`dim_evidence_unusable`）。
- **量纲与刻度可以不同源**：③/④ 只声明量纲（常常是关键词，如「Memory usage」），
  刻度则取自**同表、同量纲、且带单位标记**的那一处，记进 `scale_from`。
  不记就等于把刻度丢了 —— 同一张表会算出两种基准值（实测差 1000 倍）。
  （但若声明量纲的那一处**自己**就带单位标记，就以它为准，不去别处找 —— 否则查
  「平均耗时(ms)」那行时会被列头「时长(min)」抢走刻度。）

四种情况下 `unit_source` 都指回**声明它的那一处**（`quote` + `offset` + `from` + `applies_to`，
必要时外加 `scale_from`），所以来源照样可回溯。

实测价值：有了 ③，那份报告的均值检查第一次能算出数 ——
`mean_of(Run 1..5) = 5.8 ms` 对上「Average Time (ms)」行给出的 `5.8` → **容差内 → pass**（5 列各自可比）。

**表注关键词只认枚举表**：表注仍要过 `DIM_KEYWORDS`。**实测补过一条** —— 真实报告里最常见的
表注写法「Figure 3: **Timings** for 2-table join query」原本**认不出来**：`Timings` 里并没有子串
`time`（词形是 tim-ing，不是 time-ing）。已在 `duration` 里补上 `timing`（2026-09-24，冻结前
最后一处改动），现在这种表注能给出 duration；回归里钉住了这条真实写法。

**五类情形一律 `unverified`**（零匹配 / 多匹配 / 单位推不出来）：

| 情形 | 原因码 |
|---|---|
| `table_id` 不在 L1 已解析的表格里 | `table_not_found` |
| 该表 `key_query_safe = false`（无列头或有截断） | `table_not_key_query_safe` |
| 列头里没有这一列 | `column_not_found` |
| 列头里这一列名出现多次 | `column_ambiguous` |
| 行标签里没有这一行 | `row_label_not_found` |
| 行标签里这一行出现多次 | `row_label_ambiguous` |
| 列头 / 行标签 / 表注都推不出量纲 | `column_unit_undetermined` |
| 声明量纲的那一处与另一处**同级**声明了不同量纲 | `dim_evidence_unusable` |

### 4.1c ★ 它解决的是定位歧义，**不是**「选对业务对象」

> 键值查询能消掉大量定位歧义，但**不能保证模型选对业务对象**。
> 模型仍可能选错表、错指标、错实验配置。

示例里有一条专门做这个反例：真实列头是「验证准确率」，模型写「准确率」→ **零匹配 → unverified**。
程序不会替它猜「大概是想指那一列」。这一条比「键值查询让选对对象机械化了」那句旧话更准确 —— 旧话已删。

**确定性是分层的，产物里逐字段标注**（`provenance`）：

| 字段 | 来源 | 确定性 |
|---|---|---|
| `table_id` / `row_label` / `column` | **模型给的字符串** | 只经过「必须在已解析的列头/行标签里逐字命中」这一道校验 |
| 列头 / 行标签 / 单元格边界 | L1 **规则解析** | 可回溯、可复现（`cell_split` 进一步说明依据是几何还是制表符） |
| 单位 | **列头 / 行标签 / 整表唯一量纲 / 表注**（作用域由声明位置定，见 §4.1b）**全部由规则解析，模型没有表态权** | 带 `quote` + `offset` + `from` + `applies_to`（必要时 `scale_from`），逐字可回溯；操作数的 `dim_source_status` 恒为 `null` = 不适用 |

**结构化字段如果来自模型识别，也必须保存派生来源，不能直接升级成确定事实。** 这条现在有字段承载它。


### 4.2 诚实的边界：剩下的抓不住
③/③b/④ 抓不住**子串重叠造成的误选**（`+ attention` 是 `+ attention + 数据增强` 的前缀）。
设计目标因此不是"保证选对"，而是：
1. **让选错无法隐藏** —— 每条 check 强制带 `claim` 原文 + 每个操作数的 `label` / 值 / 原文片段（审计行）
2. **让选错的代价受控** —— 可检测的选错一律降级为 `unverified`

### 4.3 claim 也走同一套来源验证
`claim` 现在不是一个自由字符串，而是一个 **spec**（`bundle_id` + `span_index` + `quote`），
经 `resolveClaim` 走与操作数**完全相同**的定位与逐字断言。
claim 落不到原文上 → 整条 check `unverified(claim_not_source_bound)`；没有 claim → `claim_missing`。

### 4.4 三条减少自由度的设计

| | 做法 | 为什么 |
|---|---|---|
| **容差由服务端决定** | `TOLERANCE_BY_OPERATOR` 按算子定死（纯算术 `rel_5pct`、`agree` `abs_1e_3`、布尔/文本 `exact`）。**传入的 tolerance 被整体忽略** | 少一个自由度就少一种不稳。示例里显式传 `abs_0_5`，产物里记的仍是 `rel_5pct` |
| **措辞不进产物** | 产物里**没有任何自由措辞字段**（没有 `statement` / `message`）。展示句由程序 `renderStatement(result)` 从 `reason_codes` + `basis` 生成 | 「不能写成学生算错了」变成**结构性保证**：没有字段，就没地方写。模板全项目只有一份定义 |
| **原因码进 schema** | `reason_codes` 的 `enum` 必须等于工具层的码表（回归测试断言两边一致，防漂移） | 措辞只是码的函数；未知码在校验阶段就被拦掉 |

### 4.4b ★ fail 的四项前置条件（这才是「判断正确」的依据）

> 模板只能约束措辞，**不能证明判断正确**。
> 更关键的是：`fail` 必须同时具备 ①有效的输入绑定 ②适用的检查规则 ③容差策略 ④完整计算结果。

四项写在 `basis.preconditions` 里，**缺一即降级**为 `unverified(fail_precondition_missing)`：

| 前置条件 | 机械判据 |
|---|---|
| `input_binding` | claim 与全部操作数都绑回材料（`ok`）、选择无歧义、片段结构化 |
| `rule_applicable` | `kind` 与 `operator` 在枚举内且互相允许 |
| `tolerance_policy` | 服务端按算子登记了容差（不是模型给的） |
| `computation_complete` | `computed` / `expected` / `delta` 三者齐全且为有限数 |

`expected` 可以来自材料（`origin: source_bound`），也可以由算子自身定义（`origin: rule_constant`，
自洽型检查如 `unit_consistent` 期望恒为 1）—— 后者让"④计算完整"对自洽检查也成立，而不是留个空。

`diagnostics.fail_precondition_status` 里逐条记下实测值，**每条 fail 都必须四项全 true**（有断言守着）。
另外「容差策略缺失」是可测的：`preconditionsOf()` 被单独导出，回归测试对四项各做一次"断电"。

### 4.5 tool calling 已接：**两道闸，位置不同、后果不同**

`toolSpecs()` 按 kind 分组导出 6 个 tool；`llmTools()` 转成 LLM 的 function calling 形态。
一次调用 = 一条 check。模型能决定的只有三件事：**选哪个 kind、用哪个算子、指哪里**。

| 闸 | 在哪 | 管什么 | 不合格的后果 |
|---|---|---|---|
| **① 调用闸** | `toolcalling.mjs` | 工具名在不在枚举；`arguments` 是不是合法 JSON；参数是否过该 tool 的 schema（含 `additionalProperties:false` 与 if/then 的通道必填） | **不产生 check**，落进 `rejected_calls[]` |
| **② 语义闸** | `verify-tools.mjs` | 参数结构合法但指错地方：零匹配 / 多匹配 / 量纲不明 / 多行块… | **照样产生一条 check**，`stance = unverified` |

为什么调用闸必须是"拒收"而不是"降级成 unverified"：契约要求 `checks[]` 里的 `kind`/`operator` 都在枚举内，
工具名都不认识，就表达不出一条合法 check。硬塞进去会污染产物，丢掉不说会掩盖模型错误 —— 所以单开一张可见的拒收表。

**系统决定的部分（模型没有自由度）**：`id` 由调用循环分配（模型不能自报，否则既撞号又是自由度）；
`kind` 由**工具名**推出（模型无法把算子与 kind 拆开组合）；容差由服务端按算子登记；
数值由系统从材料解析；展示句由程序生成。

**账目必须平**：`accepted + rejected === attempted`（有断言守着）—— 一次调用要么变成 check，
要么出现在拒收表里，**不允许凭空消失**。另外两条：

- **重复调用只计数不丢弃**（记 `duplicate_calls[].of_index`）—— 模型的重复行为本身是要看的。
- **调用次数上限是机械上限**（`maxCalls`），不是 prompt 里的礼貌请求；撞上了 `budget_exhausted` 置位，
  因为那意味着**这一轮有检查没做**。

产物里新增 `diagnostics.tool_calling`（账目）与 `diagnostics.rejected_calls`（拒收表），
每条 check 带 `tool_call_index`（它由第几次调用产生）。

**离线可测**：`_toolrun.mjs` 是一个**假模型**——按脚本回放 12 次调用（6 条合法、6 条各类不合法），
不依赖任何 API 就能验证两道闸、去重、上限，并产出**仍然过真 schema** 的产物。

### 4.5c ★ 显式作用域 `scope`（v0.2 新增）

`rubric_item_id = null` **不允许**被下游猜测性归属 —— 下游（L4）要按条目归集检查，
而"文档级检查"与"模型忘了填条目"在旧产物里是同一个 `null`。所以 v0.2 让每条 check 显式表态：

```json
{ "scope": "rubric_item", "rubric_item_id": "R2.1" }
{ "scope": "document",    "rubric_item_id": null }
```

| 规则 | 在哪强制 |
|---|---|
| `scope` 必填（枚举两值） | 工具 schema 的 `required` |
| `scope=rubric_item` → `rubric_item_id` 必填且非空 | schema（`required` + `minLength: 1`） |
| `scope=document` → `rubric_item_id` 必须**显式为 null** | schema（`const: null`）—— 于是 `null` 不能再表示"忘了填" |
| `scope=rubric_item` → id 必须**真的存在于 canonical rubric** | 调用闸（`createRunner` 拿得到 rubric）→ 不合格 `unknown_rubric_item`，不产生 check |
| 产物里的 `scope` / `rubric_item_id` 成对一致 | 产物 schema 的 `allOf` + `runCheck` 落盘时归一（`document` 一律把 id 压成 null） |

**比赛版可以更严**：只有编号连续性、全局引用完整性这类*真正的*文档级检查才允许 `scope=document`；
为某个 rubric 触发的检查必须带非空 id。

用它的地方：L4 按 `rubric_item` 归条、把 `document` 放进 `document_checks`（**不自动影响任何分数**，
只可被显式引用且照样受 impact 约束）。

> 当前 CS3223 的 8 条 check 全部是 `R2.1`，所以这次 bump **不需要迁移也不需要重跑**：
> 旧产物由下游按 id 推导 + 标 `scope_inferred`。

### 4.5b 真实模型的调用链（`src/llm.mjs` + `src/_llmrun.mjs`）

最小实现：发消息 → 收 `tool_calls` → 执行 → 把结论喂回去 → 模型收尾 → 装配产物。
没有重试、没有流式、没有并发。`fetch` 可注入，所以整条链**不联网也能被证明**。

```
node src/_llmrun.mjs --stub     本地 stub 服务把整条链走一遍（不需要凭据）
node src/_llmrun.mjs            打真实模型，需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
```

**材料只在第一条消息里给一次**：逐字完整正文 + 索引导航 + 表格结构 + 候选证据 + rubric 条目。
之后每一轮喂回去的只有**结论**（`stance` + 原因码 + 算出的数），没有措辞、不再重复材料。
`--stub` 的实测证明了这一点：3 个回合、每个请求都带 6 个 tool、第一条 user 消息 9634 字符且包含完整原文。

★ **已知风险，写明不遮盖**：把结论喂回去，模型可能为了拿到 `pass` 而反复试探（"买一个通过"）。
对策**不靠 prompt**，靠两道机械约束：`maxCalls` 上限（撞上即 `budget_exhausted`）与全量审计
（重复调用进 `duplicate_calls`、非法调用进 `rejected_calls`）—— **试探行为本身可见**，而不指望它不发生。

**产物装配只有一份**（`assembleArtifact`）：假模型、stub、真实模型走同一条装配路径，
否则三条路会各自漂移。

### 4.6 比赛版范围：只支持**已经可靠解析**的表格

复杂 PDF 表格继续降级，**不以"通用表格解析完成"为 tool calling 的前提**。
门槛由 `key_query_safe` 承担（`header_detected && !truncated`），不满足就 `unverified`，不猜。


复杂 PDF 表格继续降级，**不以"通用表格解析完成"为 tool calling 的前提**。
门槛由 `key_query_safe` 承担（`header_detected && !truncated`），不满足就 `unverified`，不猜。


---

## 5. 输出契约
产物：`<name>.checks.json`（契约见 `verification-checks.schema.json`）。
结构：`authority` / `doc` / `rubric`(引用) / `evidence`(引用) / **`index`(引用)** / `checks[]` / `diagnostics`。
`index` 是**表格键值查询的解析依据** —— 只引用不复制：表格结构在 L1 索引里只有一份权威副本。
`diagnostics` 里除计数与原因归类外，还有 **`tool_calling`（调用账目）** 与 **`rejected_calls`（拒收表）**。
校验：五份契约示例 + tool calling 通路的产物都在回归测试里过**真正的** schema 校验（`src/validator.mjs`）。

---

## 6. 「不评分」的机械保证
| 机制 | 说明 |
|---|---|
| schema 封闭 + 无分数字段 | 字段表里没有 `score` / `point` / `grade`（已加递归扫 key 断言） |
| `authority.layer_produces_score: false` | `const` |
| 计数不等于分数 | `diagnostics.counts` 与 rubric 分值之间无映射路径 |
| `not_scoring` 声明 | 明写「pass 多不代表得分高」 |

**措辞边界**：`fail` 只能表述为「机械检查不成立」，不能写成「学生算错了」。
这是**结构性保证**：产物里没有自由措辞字段（`reason_codes` 是枚举码，展示句由程序生成）。

---

## 7. 回归覆盖的关键边界

以下是当前规则的代表性反例与预期行为；完整字段和原因码以 [verification-checks.schema.json](verification-checks.schema.json) 为准。

| 边界 | 预期行为 |
| --- | --- |
| 操作数数量不符、除零或非有限结果 | `unverified`，分别保留 `arity_mismatch`、`division_by_zero`、`non_finite_result` 原因 |
| 数字只是更长数值的子串，或候选值离标签过远 | 只按完整原文中的完整数值 token 与标签位置绑定，不盲取首次出现 |
| 多行数值块没有可靠行列结构 | `unverified(multiline_span_not_structured)`，不猜单元格归属 |
| 数值量纲没有来源 | 明确区分 `inline / cited / undeclared`；未知单位或来源冲突不猜测 |
| 两张表出现相同行/列名 | 键值查询必须带 `table_id`；查询安全性取决于 L1 的结构标记 |
| 编号在文档中乱序 | 按文档顺序检查，不先排序再判连续 |
| 模型调用结构不合法或重复 | 两道闸拒收并留痕；`accepted + rejected = attempted`，且调用次数受上限约束 |
| 来源、容差或计算前提不足以支持 `fail` | 降级为 `unverified`，不能写成对学生的扣分判断 |

多文件提交及受控程序生成列于[项目技术总览的未来方向](PROJECT-OVERVIEW.md#5-未来优化方向)，不改变本版有限工具目录。


