# 准入判据的原文出处对照（Pendulum）

> **规则（Yukii 2026-09-24 的硬约束）**：任何"准入判据"必须能追到
> **rubric 原文的某一句** 或 **数据集的标注规则**。**找不到出处的不加。**
> **禁止从一个低分例子反推** —— 那是在为个案编理论。

每条判据三列：**依据原文（逐字 + 出处）** / **它能推出什么（机械）** / **它推不出什么**。

---

## 结论先行

**能拿到原文出处的"准入判据"只有两条，都来自 R6 / R5 的 points 结构（它们本来就按条项定义）。
5 个 levels 型维度（R1/R2/R3/R4/R7）在 rubric 原文里没有"准入"这个概念 —— 因此不能给它们加准入判据。**

也就是说：**先前设想的"给 levels 型补门槛前置"，在原文里找不到依据，不加。**

---

## 一、有出处、可以加的

### 1.1 R6（误差分析，points 型）—— 条项逐个判定

**出处**：`rubric-pendulum-part2.txt` 第 6 行，逐字

```
1) Discusses at least 1 random error. (1 point)
2) Discusses at least 1 way to reduce 1. (1 point)
3) Discusses at least 1 systematic error. (1 point)
4) Discusses at least 1 way to reduce systematic error. (1 point)
5) Includes one or more additional random or systematic errors. (1 point)
```

| | |
|---|---|
| **能推出什么（机械）** | 每条的判据就是它的字面：**"有没有讨论 ≥1 个随机误差"**，是/否 → 1/0 分。五条相加。 |
| **能推出什么（0 分）** | **五条全否 = 0 分**。这是原文的直接含义，无需额外规则。 |
| **推不出什么** | ①"讨论得深不深"（原文只要求 `Discusses at least 1`，**没有质量形容词**）；<br>②"随机误差说得弱就该扣"——原文**没有**这条；<br>③第 5 条 `one or more additional` 不能理解成"质量要高"。 |

**★ 对照我们的实测**：模型在 `2019-algebra-RR03-0476` 的 R6 rationale 里写
「随机误差部分**主要停留在类别与可能性层面、举例较弱**，**但各条项低阈值仍可满足，故建议满分**」
→ 给了 5/5，gold 0。**"低阈值仍可满足"这个表述是对的**（原文确实只要求"至少 1 个"），
但它因此**忽略了第 1 条是否真的成立**。→ **机械化的空间：逐条要求引用证据，而不是笼统说"满足了"。**

### 1.2 R5（数学模型，points 型）—— 条项逐个判定

**出处**：`rubric-pendulum-part2.txt` 第 4 行，逐字

```
1) Use correct reference diagram to fit the mathematical model, give correct formula (t T = 2 √L). (1 point)
2) Provide explanation with respect to size of the constant and the exponent. (1 point)
3) Gives the correct theoretical equation (T = 2 π sqr{L/g}). It could also be things like this: T = 2.0061(s/√m)L(0.5).  (1 point)
4) Results from curve fitting are included in the discussion; for example, the computing the R-value is an attempt of curve fitting. (1 point)
5) Discuss how the mathematical model produced in lab supports the theoretical model is complete and accurate.  (1 point)
```

| | |
|---|---|
| **能推出什么（机械）** | 五条各 1 分。"给出正确公式"= 原文给了两个可接受形式（`T = 2√L` / `T = 2.0061(s/√m)L(0.5)`）—— **判据就是"是否等价于其中之一"**。 |
| **推不出什么** | 原文对第 5 条用了 `complete and accurate` —— 这是**形容词**，不能机械判定，只能靠证据引用。 |

---

## 二、**没有出处、因此不加**的（重要）

### 2.1 R1–R4、R7（levels 型）：原文里**不存在"准入"概念**

**出处**：`rubric-pendulum-part1.txt` 第 1 行（表头）+ 各维度行。

以 R1 为例，原文的五档逐字：

| 档 | 原文 |
|---|---|
| 1 | `Research question is included but incorrectly stated. Does not give an explicit statement of the three variables.` |
| 2 | `Research question is included but incorrectly stated. Gives an explicit statement of the three variables.` |
| 3 | `Research question is included and correctly stated. Gives an explicit but incomplete statement of the three variables.` |
| 4 | `Research question is included and correctly stated. Gives an explicit statement of the three variables.` |
| 5 | `Research question is included and correctly stated: "What affects the period of a pendulum?" Includes an explicit statement of the three variables: mass, angle of release, and string length.` |

| | |
|---|---|
| **能推出什么** | 五档都用 `Research question is included ...` 开头 → **原文的评述单位是"最接近哪一档"，不是"过没过门槛"。** |
| **推不出什么** | ①**没有**"必须原样以问句给出，否则不得分"——**这只在第 5 档的字面里，是第 5 档的充分条件，不是其他档的必要条件**；<br>②**没有**"没写研究问题 → 0 分"的规则（表头只到第 1 档 `Inadequate (1)`）；<br>③**没有**"隐含主旨可以算作研究问题"的任何表述。 |

**→ 所以：给 R1–R4/R7 加"准入判据"= 在原文里没有依据。不加。**

> **我先前错在哪**：我拿 `2019-algebra-RR03-0193`（R1 gold=0）这一个例子，
> 反推出"必须原样问句，否则给 0"。**而数据显示 R1 的 0 分只占全量 7.1%（77/1078）。**
> 用 7.1% 的个案去改写整维的判据，是把**个案当规则**。

### 2.2 "分数不能是 0，除非什么都没写" —— **没有出处**

**出处核查**：
- `README.txt` 第 29 行：`Each dimension was rated on a 6-point scale (0 to 5).`
  → **只说 0 是合法取值，没有说 0 的语义。**
- `rubric` 原文表头：`Inadequate (1) | Inadequate (2) | Needs improvement (3) | Needs improvement (4) | Complete (5)`
  → **只定义 1–5，没有定义 0。**
- 数据集没有任何标注手册 / codebook 文件。

**→ 0 的确切语义（是"未涉及"、"完全不合格"还是别的）在公开材料里查不到。**
**→ 因此我原来合成的 L0 文案「（未涉及该维度：报告里没有任何相关内容）」是无出处的发明，必须去掉或明确标注为我们的执行假设。**

---

## 三、逐维 0 分的经验分布（**事实**，不是规则）

**出处**：`PendulumLab.csv` 全量 1078 行直接统计（可复现）。

| 维度 | 全部 0/N | 占比 | 该维均值 | common 组 0/93 | discussion 组 0/12 |
|---|---|---|---|---|---|
| D1（R1） | 77/1078 | 7.1% | 3.97 | 5 | 2 |
| D2（R2） | 52/1078 | 4.8% | 3.08 | 1 | 0 |
| D3（R3） | 20/1078 | 1.9% | 3.15 | 1 | 0 |
| D4（R4） | 54/1078 | 5.0% | 2.93 | 3 | 1 |
| D5（R5） | 78/1078 | 7.2% | 2.07 | 11 | 0 |
| D6（R6） | 38/1078 | 3.5% | 3.52 | 2 | 0 |
| **D7（R7）** | **279/1078** | **25.9%** | **1.94** | 19 | 2 |

**这些是分布事实，不是判据。** 用途仅限：
- **校验方向性**：如果我们的 0 分率与上表严重偏离（例如 0 分率 0%），说明我们用错了档。
- **不作为规则来源**（"D7 有 25.9% 是 0，所以我们也应该常给 0"——这是错的推理）。

---

## 四、可用原话（可摘进 L4 材料的）与**不可用原话**

**可用**（帮助模型在"最接近哪档"和"确实做到没"之间对齐）：
- tasks 级的动词是 **`Is able to ...`**（`rubric-pendulum-part1.txt` 第 2/4/6 行，part2 第 1/3/5/7 行）
  → 这是一个**能力表述**，可以直接引用给模型：**"判的是'是否展示了这个能力'，不是'有没有提到相关词'"**。
- points 型的条项动词是 **`Discusses at least 1 ...`**（R6）/ **`Provide / Gives / Use ...`**（R5）
  → **"at least 1" 是下限表述，可机械核查"有没有 ≥1 个"。**

**不可用**（我先前自己发明、必须标注或删除）：
- ❌ `（未涉及该维度：报告里没有任何相关内容）` —— L0 文案，无出处
- ❌ "必须原样以问句给出研究问题" —— 只是 R1 第 5 档的字面，被误当门槛
- ❌ "评分者更严，所以我们要往低给" —— 数据集未表达此意

---

## 五、下一步（需先定）

1. **去掉/改造无出处的 L0**：改为**明确标注为"我们的执行假设"**，或按 points 型那样直接让 0 的含义由档位结构推出。
   两种做法都**会在 L4 材料里改变给模型看的东西**，因此属于**规则改动，必须在本文件 §6 的 holdout 上验证**。
2. **5 个 levels 型维度不加准入判据**（无出处）。
3. **R5/R6 可以做的机械化**：**要求逐条()给 1/0 + 引用证据**，而不是给一个总印象分。
   —— 这一条**有原文出处**（五条 `(1 point)` 就是逐条的），是当前证据支持的唯一改动方向。
