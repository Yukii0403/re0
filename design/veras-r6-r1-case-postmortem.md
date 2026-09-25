# R6 / R1 高分案例逐条复盘

> 日期：2026-09-24　样本：`fixtures/veras/out/` 9 份已产出产物（全部 `status=single`）
> 性质：**案例级交叉核对表**，不是新规则。本文不推导任何通用准入判据 —— 见 §4。
> 统计口径：`src/_stats.mjs`（分组 / 并列平均秩 / 缺分排除）。本文件只做人工逐条对照。

---

## 0. 一句话结论

| 维度 | 类型 | 我们的系统性偏差 | 一句话原因 |
|---|---|---|---|
| **R6** | `points`（5 条 × 1 分） | **单向高估**：9 份里 5 份偏高，2 份把 gold=0 打成 4 | 把"文中出现了某关键词"直接当成"条项满足"，**没有要求该出现必须是"讨论"** |
| **R1** | `levels`（1–5） | **无分辨力**：9 份全给 4（档位=1，ρ 不可算） | 把 L5 当成"必须逐字使用范例原句"，于是**任何**正确陈述都停在 L4 |

两者都不是"模型不聪明"，是**我们交给它的标准原文 + 我们的档位设计**各自有一个可指认的缺陷。

---

## 1. R6 逐条交叉核对（`points`，5 条 × 1 分）

### 1.1 标准原文（逐字，来自 `rubric-pendulum-part2.txt` 第 6 行）

> `1) Discusses at least 1 random error. (1 point) 2) Discusses at least 1 way to reduce 1. (1 point)  3) Discusses at least 1 systematic error. (1 point) 4) Discusses at least 1 way to reduce systematic error. (1 point) 5) Includes one or more additional random or systematic errors. (1 point)`

**注意动词**：5 条全部用 `Discusses`（条项 1、3）或 `Includes`（条项 2、4、5）。
`Discusses` 是**及物动词，要求对该误差有论述**；`Includes` 只要求"包含"。

### 1.2 案例表

| # | 样本 | gold | 我们 | 差 | 我们判"满足"的条项 | 逐条判定是否有原文依据 |
|---|---|---|---|---|---|---|
| 1 | `...193` | **2** | 5 | **+3** | 1,2,3,4,5 | 条3"释放角度一致/秒表停表属系统误差"—— **原文未标为系统误差**，是我们替它归类（见 §1.3-A） |
| 2 | `...363` | 3 | 3 | 0 | 1,2,5 | ✓ 判定自洽，且 rationale 明确写了"全文未提及任何系统误差" |
| 3 | `...1043` | 3 | 4 | +1 | 1,2,3,5 | 条5"又列出一个额外随机误差（string 松紧）"—— 该处原文是在讲误差来源还是讲操作，需回原文核（见 §1.3-B） |
| 4 | `...588` | **2** | 3 | +1 | 1,2,5 | 条5 用**仪器不确定度**（`photogate .001 percent error`）当"额外误差"—— 不确定度 ≠ 误差讨论（见 §1.3-C） |
| 5 | `...789` | **0** | 4 | **+4** | 1,2,3,5 | 条3 系统误差有明确原文（tape measurer over/under-stretch）✓；条5"多个人为随机误差"—— 与条1 是**同一批**（见 §1.3-D） |
| 6 | `...476` | **0** | 4 | **+4** | 1,2,3,4 | 条3 rationale **自己承认**"把停表计时误差归为系统误差的归类不严谨"—— 却仍判满足（见 §1.3-E） |
| 7 | `...189` | 5 | 5 | 0 | 1,2,3,4,5 | ✓ 五项全有独立原文依据，判得对 |
| 8 | `...129` | 4 | 4 | 0 | 1,2,3,4 | ✓ 条5 明确说明"未将其归类为随机或系统误差，故不计分" —— **这是唯一一条正确压住条5 的** |
| 9 | `...072` | 5 | 5 | 0 | 1,2,3,4,5 | ✓ |

**5 份偏高，差值 3/1/1/4/4；2 份把 gold=0 打成 4。**

### 1.3 逐个可指认的缺陷（每条都指向标准原文里的一句话）

**A. `...193` 的条 3 —— 我们替原文做了归类。**
rationale 原话：`指出"释放角度一致""秒表停表"属系统误差`。但原文只说了 `changing the release angle` 和秒表计时，
**没有声称它们是系统误差**。条项 3 的字面要求是 `Discusses at least 1 systematic error` ——
"被我们归类为系统误差的现象"不是"被讨论的系统误差"。

**B. `...1043` 的条 5 —— "又列出"的边界没有依据。**
条项 5 原文：`Includes one or more additional random or systematic errors`。
`additional` 指的是**相对条项 1/3 之外**，这个我们能核；但 rationale 把"string 松紧"同时算进条 5，
需要确认那处原文确实是在**列举误差**而不是在**描述操作步骤**。这一条我无法只凭 rationale 判定 ——
必须回原文。**这正是 rationale 不能当证据的典型**。

**C. `...588` 的条 5 —— 把"仪器不确定度"当成"额外误差"。**
原文引用是 `a photogate that only has a .001 percent error`。这是**仪器规格**，不是对误差的讨论。
条项 5 说的是 `additional random or systematic errors` —— 一个被引用的规格数字不构成"列举了一项误差"。
（对照：条项 1 的 `Discusses` 更严，条项 5 的 `Includes` 稍宽，但都要求**该误差被作为误差提出**。）

**D. `...789` 的条 5 —— 同一批例子被数了两次。**
条 1 用了 `random human error of not stopping the clock in time` / `miscalculated release`；
条 5 又用"多个人为随机误差（走表未及时停止、释放摆角/摆绳不当）"—— **是同一批**。
条项 5 的 `additional` 要求它是条 1 之外的**新增**。重复计数 → 多给 1 分。

**E. `...476` 的条 3/4 —— rationale 自己写了不确定，却仍然给分。**
rationale 逐字：`提到并讨论了系统误差，满足（较弱，把停表计时误差归为系统误差的归类不严谨，但不属"未涉及"）`，
条 4：`同一设计改动也即减少系统误差的方法，满足`。
**这里模型自己说出了"归类不严谨"，却因为"不属未涉及"给了分。**
条项 3 的要求不是"未涉及"，是 `Discusses at least 1 systematic error` ——
"不属未涉及"和"讨论了一个系统误差"之间还差一整个判断。**模型的不确定性已经写出来了，是我们的判定阈值没有承接它。**

### 1.4 R6 的缺陷归类（只有两类，都可指到原文）

| 类别 | 涉及样本 | 标准原文依据 |
|---|---|---|
| **甲：`Discusses`/`Includes` 的宾语没被核**（被归类 / 被引用 / 重复计数） | `193` 条3、`588` 条5、`789` 条5、`476` 条3/4 | 5 条的动词分别是 `Discusses`(1,3) / `Includes`(2,4,5) |
| **乙：`additional` 的新增性没被核** | `789` 条5、`476` 条5 | `additional random or systematic errors`（条5） |

**两类都不是"更严的判据"，是"把标准原文里已经写着的动词与形容词真的用上"。**
这与 §4 的约束一致：不需要新规则，只需要**在提示里把标准原文的动词讲清楚**，并禁止"我们替原文归类"。

---

## 2. R1 逐条交叉核对（`levels`，1–5）

### 2.1 标准原文（逐字，来自 `rubric-pendulum-part1.txt` 第 1 行表头 + 第 3 行）

表头：`Inadequate (1) | Inadequate (2) | Needs improvement (3) | Needs improvement (4) | Complete (5)`

| level_id | 分 | 原文（逐字） |
|---|---|---|
| L1 | 1 | `Research question is included but incorrectly stated. Does not give an explicit statement of the three variables.` |
| L2 | 2 | `Research question is included but incorrectly stated. Gives an explicit statement of the three variables.` |
| L3 | 3 | `Research question is included and correctly stated. Gives an explicit but incomplete statement of the three variables.` |
| L4 | 4 | `Research question is included and correctly stated. Gives an explicit statement of the three variables.` |
| L5 | 5 | `Research question is included and correctly stated: "What affects the period of a pendulum?" Includes an explicit statement of the three variables: mass, angle of release, and string length.` |

**★★ L5 的原文里那个问句是什么？**
两种读法，且**只有一种能在原文里找到依据**：

1. **"逐字引用"读法**（我们目前采用的）：L5 要求研究问题必须**逐字**是 `What affects the period of a pendulum?`
2. **"举例"读法**：那个问句是**该等级的示例**，与 L1–L4 一样，L5 的实质要求是
   "正确陈述 + **完整地**陈述三个变量"（对照 L3 的 `incomplete`）。

第 2 种读法有两条原文依据：
- L5 与 L3 的唯一区别就是三个变量是否 `incomplete`；L5 没有再加别的条件。
- 整个 rubric 里另有一处**明确**给了"可以这样写"的宽容表述（part2 第 4 行条项 3：
  `It could also be things like this: T = 2.0061(s/√m)L(0.5).`）——
  说明这套 rubric 在**要求精确措辞时会明说"也可以写成……"**；L5 这里没有这种豁免。
  但这同时说明：**"逐字"这种要求在本 rubric 里是会显式写出来的**，而 L5 只是摆了一个问句。

**我们的实际做法是第 1 种，且 9/9 份都把这一条写成了不进 L5 的理由。**

### 2.2 量化

| 指标 | 值 |
|---|---|
| 我们给 4 分的份数 | **9 / 9** |
| 我们给的档位数（distinct） | **1** → ρ **不可算**（`_stats.spearman` 在档位=1 时分子分母同为零 → null，报告里显示 `—`） |
| gold 分布 | `0,3,3,5,3,2,5,2,5`（distinct=4） |
| 把"未逐字使用 L5 原句"写进 rationale 的份数 | **9 / 9** |
| gold=5 的 3 份里，我们给 4 | **3 / 3** |
| gold=0 的 1 份里，我们给 4 | **1 / 1** |

### 2.3 两个方向的错，同一个原因

- **向上错**（`...193`，gold=0 → 我们 4）：原文说的是
  `the period of a pendulum can by affected in different ways by changing different independent variables` ——
  这是**主题陈述**，不是"研究问题"；三个变量列了，但**没有说"正确陈述了一个研究问题"**。
  我们为了凑 L4 的两半条件，把"主题陈述"当成了"研究问题正确陈述"。
- **向下错**（`...129`/`...189`/`...072`，gold=5 → 我们 4）：三份的 rationale 都逐字承认
  "问题陈述正确、三变量完整"，然后**仅仅**因为措辞不同而扣 1 分。

**同一条 L4 判据，在两边被用得不一样：**
对 `193` 我们**放宽**了"研究问题"的定义去够 L4；对三份 gold=5 我们**收紧**了 L5 的定义去卡它。
两者都源于同一个未经核实的假设 —— **L5 = 逐字原句**。一旦这个假设不成立，两边的错同时消失。

### 2.4 R1 的缺陷（一个，可指到原文）

| 缺陷 | 依据 |
|---|---|
| **把 L5 的示例问句当成了强制措辞**，于是 L4 变成"正确但没抄原句"的默认落点，档位塌成 1 档 | L5 原文 `…correctly stated: "What affects the period of a pendulum?" Includes an explicit statement of the three variables: mass, angle of release, and string length.` 与 L3 原文 `…correctly stated. Gives an explicit but incomplete statement of the three variables.` 对照 —— 未出现 `verbatim` / `must be worded` / `exactly` 一类措辞 |

---

## 3. 两个维度合起来说明的一件事

R6 的高估与 R1 的无分辨力，方向相反，**成因同类**：

> 模型看到的"标准原文"里，**判定句的谓语与限定词没有被强调**，
> 于是它用**最省力的方式**去满足"标准"：R6 里找关键词（不核 `Discusses` 的宾语、不核 `additional` 的新增性）；
> R1 里够到"最低的那个能自圆其说的档"（4）。

**两者的修法都不是加规则，而是改"我们怎么把标准原文交给模型"**：
- R6：把 5 条的动词（`Discusses`/`Includes`）与 `additional` 的新增性**在提示里逐字呈现并点明**；
- R1：**不能**替模型选"问句是强制还是举例"—— 这需要 Yukii 定（见 §4 问题 1），因为两种读法对应两种不同的评测含义。

---

## 4. 本文**不**做什么（沿用 Yukii 的硬约束）

1. **不从上面任何一条案例反推"准入判据"。** §1.3 的 A–E 每一项都能指回标准原文的一句，是"把已写着的标准用上"，
   不是新造的判据。
2. **不替 L5 的问句定性。** 两种读法我都能写出理由，但选哪一种会改变 R1 的整个含义 ——
   这是**rubric 解读**，必须由 Yukii 定，不能由一次复盘决定。
3. **不动 L0。** `（未涉及该维度：报告里没有任何相关内容）` 是无出处的文本（见 `design/veras-admission-criteria-sourcing.md`），
   它污染了 5 个 `levels` 型维度的最低档。本文只把它记在案，不在复盘里顺手改。
4. **不改已经花过钱的 9 份产物。** 它们是诊断快照。

---

## 5. 待 Yukii 定夺的问题（放在末尾）

1. **R1 的 L5：`What affects the period of a pendulum?` 是"必须逐字"还是"示例措辞"？**
   从原文看，L5 与 L4 的差别**只在三个变量是否完整**（对照 L3 的 `incomplete`）；问句另行给出。
   - 若是样例 → R1 的 L5 判据 = 正确陈述 + **完整**三变量，我们现在 9/9 停 L4 的做法需重做判据；
   - 若是强制 → 现在的做法成立，但 R1 在这批样本上**没有分辨力**（全 4），需要另找能区分的样本。
2. **R6 条 5 的 `additional` 是否允许"条 1 里已出现过的那一类"里再举一个不同例子？**
   原文只说 `additional random or systematic errors`，未说明是否必须**种类**不同。
   （`...789` 的 4 分里，条 5 的 1 分就卡在这里。）
3. **"我们替原文归类"要不要一律不算满足？**（§1.3-A / E）
   这条我有明确立场：**不算**。条项 3 的原文是 `Discusses at least 1 systematic error` ——
   模型可以论证"为什么这算系统误差"，但不能只是把现象列出来由我们贴标签。但这是**我的判断**，
   写在这里作为一个可被推翻的提议，而不是已定的规则。
