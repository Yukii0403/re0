// verify-tools.mjs —— L3 的确定性验证工具与来源校验
//
// 设计基线（L3 = 有限、可复现、有来源绑定，不评分）：
//   · 有限：检查种类 / 算子**全是枚举**，越界抛错（fail-closed）
//   · 可复现：纯函数；**容差由服务端按算子决定**，不由模型给；结果可逐算
//   · 来源绑定：**模型只负责「指哪里」，数值一律由系统从原文解析**
//
// ★ 对象定位的两条通道（都不改变"模型不给数值"这一条）
//   ① span 通道：模型给 quote（+ label），系统在声明的 span 内逐字定位。
//      **数值操作数必须表态量纲来源状态**（`dim_source_status`: inline | cited | undeclared）——
//      状态是模型的表态，系统拿原文证伪它；三个错误表态各有自己的原因码。
//      「没表态」与「原文没单位」是两件事：前者在调用闸就被拒（不产生 check），
//      后者是一条诚实的 `unverified(unknown_dimension)`。
//   ② 表格通道：模型给 {table_id, row_label, column}，系统在 **L1 已解析的表格结构**里
//      做键值查询，解析成唯一 cell。返回原始单元格内容 + 行列标题 + 单位来源 + source_ref。
//      **单位来源完全由规则解析（模型无表态权）**：列头 > 行标签 > 整表唯一 > 表注。
//      零匹配 / 多匹配 / 单位解析不出 → 一律 unverified。
//
// ★★ 表格通道解决的是**定位歧义**，**不能保证模型选对业务对象**。
//   模型仍可能选错表、错指标、错实验配置。而且结构化的确定性是分层的：
//     · 表格结构（列头/行标签/单元格边界）来自 L1 **规则解析** —— 可回溯、可复现
//     · 三个查询字符串来自**模型** —— 只经过"必须在已解析的列头/行标签里逐字命中"这一道校验
//   两者都在产物里分别标注（`provenance`），**不把模型给的结构化字段升级成确定事实**。
//
// ★ `fail` 的四项前置条件（缺一不可，全在 `basis.preconditions` 里留痕）：
//   ① 输入绑定有效 ② 检查规则适用 ③ 容差策略存在 ④ 计算结果完整
//   模板只能约束措辞，不能证明判断正确 —— 所以真正的保证是这四条，不是那句话。

// ------------------------------------------------------------------ 版本

// ★★ L3 **v0.2**（v0.1 于 2026-09-24 冻结；v0.2 同日按 Yukii 的修改意见 bump）。
//   为什么 bump：新增了**显式作用域** `scope`
//     · `scope: rubric_item` → `rubric_item_id` 必填、非空、且必须真的存在于 canonical rubric
//     · `scope: document`    → `rubric_item_id` 必须显式为 null
//   动机：`rubric_item_id=null` **不允许**被下游猜测性地归到某个条目（L4 要消费 L3，
//   不能把"文档级检查"和"模型漏填条目"混成一件事）。选 document 只能用于真正文档级的检查
//   （编号连续性、全局引用完整性这类）。
//   其余冻结内容仍然不动：不扩充算子 / 检查种类 / 容差，原因码表、两闸分工、产物 schema 的
//   其它部分、三条约束（有限 / 可复现 / 有来源绑定）都不变。再要改就继续 bump。
//   兼容：v0.1 产物没有 `scope` 字段 —— L4 读旧产物时按 `rubric_item_id` 是否为空**推导**并
//   标 `scope_inferred`（非空 → rubric_item；null → document，因此永远不自动影响分数）。
export const L3_VERSION = 'v0.2';

// ------------------------------------------------------------------ 单位与量纲

export const UNIT_DEF = {
  // 没有单位标记 → unknown（量纲未声明），不是"无量纲"
  '': { dim: 'unknown', base: 'unknown', factor: 1 },
  '%': { dim: 'ratio', base: 'ratio', factor: 0.01 },
  'percent': { dim: 'ratio', base: 'ratio', factor: 0.01 },
  '百分比': { dim: 'ratio', base: 'ratio', factor: 0.01 },
  'pp': { dim: 'ratio', base: 'ratio', factor: 0.01 },
  '百分点': { dim: 'ratio', base: 'ratio', factor: 0.01 },
  '个百分点': { dim: 'ratio', base: 'ratio', factor: 0.01 },
  'ms': { dim: 'duration', base: 'second', factor: 0.001 },
  's': { dim: 'duration', base: 'second', factor: 1 },
  'min': { dim: 'duration', base: 'second', factor: 60 },
  '分钟': { dim: 'duration', base: 'second', factor: 60 },
  'h': { dim: 'duration', base: 'second', factor: 3600 },
  'KB': { dim: 'bytes', base: 'byte', factor: 1024 },
  'MB': { dim: 'bytes', base: 'byte', factor: 1024 * 1024 },
  'GB': { dim: 'bytes', base: 'byte', factor: 1024 * 1024 * 1024 },
};

export function normalizeUnit(raw) {
  const u = String(raw ?? '').trim();
  return UNIT_DEF[u] ?? null; // 表里没有的单位 → null，调用方按 unknown_unit 处理
}

// 量纲关键词表：依据是一段**来自材料**的文字（列头、图注…），靠这张枚举表判它的量纲。
// 「没写单位」= unknown，要判出量纲必须有依据 —— 表是显式的、可审计的，不是模型说了算。
// ★ `timing` 是实测补上的（2026-09-24，冻结前最后一处）：真实报告的表注常写
//   「Figure 3: Timings for 2-table join query」，而 `timings` 里并没有子串 `time`
//   （词形是 tim-ing，不是 time-ing）→ 不加这一条就认不出 duration。
export const DIM_KEYWORDS = {
  ratio: ['准确率', '精确率', '召回率', '占比', '比率', '比例', '概率', '百分比', 'acc', 'accuracy', 'precision', 'recall', 'f1', 'rate', 'ratio'],
  duration: ['时长', '耗时', '时间', '训练时间', 'time', 'timing', 'duration', 'latency'],
  bytes: ['大小', '体积', '内存', 'size', 'memory'],
};

export function dimFromEvidence(text) {
  const t = String(text);
  const m = t.match(/[(（]\s*([A-Za-z%]{1,5}|[^\s)）]{1,4})\s*[)）]/);
  if (m) {
    const u = normalizeUnit(m[1]);
    if (u && u.dim !== 'unknown') return { dim: u.dim, via: 'unit_marker', marker: m[1] };
  }
  const lower = t.toLowerCase();
  for (const [dim, words] of Object.entries(DIM_KEYWORDS)) {
    for (const w of words) if (lower.includes(w.toLowerCase())) return { dim, via: 'keyword', marker: w };
  }
  return null;
}

// ------------------------------------------------------------------ 算子（枚举，含输入/输出维度）

export const OPERATORS = {
  sum_of: { arity: -1, inDim: 'same', outDim: 'same', outUnit: '', formula: 'a₁ + a₂ + …', note: '操作数之和' },
  mean_of: { arity: -1, inDim: 'same', outDim: 'same', outUnit: '', formula: '(a₁ + a₂ + …) / n', note: '操作数均值' },
  difference: { arity: 2, inDim: 'same', outDim: 'same', outUnit: '', formula: 'a − b', note: 'a − b' },
  ratio_of: { arity: 2, inDim: 'same', outDim: 'dimensionless', outUnit: '', formula: 'a / b', note: 'a / b，输出无量纲比值' },
  percent_of: { arity: 2, inDim: 'same', outDim: 'ratio', outUnit: '%', formula: '(a / b) × 100%', note: 'a 占 b 的百分比' },
  relative_change: { arity: 2, inDim: 'same', outDim: 'ratio', outUnit: '', formula: '(新 − 旧) / 旧', note: '操作数顺序为 [旧, 新]' },
  product: { arity: 2, inDim: 'any', outDim: 'mul', outUnit: '', formula: 'a × b', note: 'a × b，输出维度为两输入之积' },
  unit_consistent: { arity: -1, inDim: 'any', outDim: 'bool', outUnit: '', formula: '量纲集合的势 = 1', expectation: '1', note: '已声明的量纲是否完全一致（至少两个已声明）' },
  range_in: { arity: 1, inDim: 'any', outDim: 'bool', outUnit: '', formula: 'lo ≤ a ≤ hi', expectation: '1', note: '归一后的值是否落在预置范围内' },
  monotonic: { arity: -1, inDim: 'same', outDim: 'bool', outUnit: '', formula: '沿文档顺序单调', expectation: '1', note: '按文档顺序是否单调' },
  numbering_continuity: { arity: -1, inDim: 'text', outDim: 'bool', outUnit: '', formula: '文档顺序编号恰为 1..n', expectation: '1', note: '按文档顺序编号是否恰为 1..n' },
  equals_text: { arity: 2, inDim: 'text', outDim: 'bool', outUnit: '', formula: 'a ≡ b（逐字）', expectation: '1', note: '两个文本操作数是否逐字相等' },
  agree: { arity: 2, inDim: 'same', outDim: 'bool', outUnit: '', formula: '|a − b| ≤ 容差', expectation: '0', note: '两个操作数是否在容差内一致' },
};

export const KIND_OPERATORS = {
  numeric_recompute: ['sum_of', 'mean_of', 'ratio_of', 'percent_of', 'difference', 'relative_change', 'product'],
  unit_check: ['unit_consistent'],
  internal_consistency: ['agree', 'difference', 'relative_change', 'ratio_of', 'percent_of', 'sum_of', 'mean_of'],
  numbering: ['numbering_continuity', 'equals_text'],
  cross_reference: ['equals_text', 'agree', 'difference'],
  magnitude_sanity: ['range_in'],
};
export const CHECK_KINDS = Object.keys(KIND_OPERATORS);

export const SELF_CONTAINED = ['unit_consistent', 'range_in', 'monotonic', 'numbering_continuity', 'equals_text', 'agree'];

export const RANGES = {
  fraction: { lo: 0, hi: 1, requiresDim: 'ratio' },   // 断言"这是比值"需要已声明量纲
  non_negative: { lo: 0, hi: Infinity, requiresDim: null },
  positive: { lo: Number.MIN_VALUE, hi: Infinity, requiresDim: null },
};

// ★ 容差由服务端按算子决定 —— 模型不给，也就没有这个自由度。
export const TOLERANCE_BY_OPERATOR = {
  sum_of: 'rel_5pct', mean_of: 'rel_5pct', difference: 'rel_5pct', product: 'rel_5pct',
  ratio_of: 'rel_5pct', percent_of: 'rel_5pct', relative_change: 'rel_5pct',
  agree: 'abs_1e_3',
  unit_consistent: 'exact', range_in: 'exact', monotonic: 'exact',
  numbering_continuity: 'exact', equals_text: 'exact',
};

export const TOLERANCES = {
  exact: { kind: 'abs', value: 0 },
  abs_1e_3: { kind: 'abs', value: 1e-3 },
  abs_1e_2: { kind: 'abs', value: 1e-2 },
  abs_0_5: { kind: 'abs', value: 0.5 },
  rel_1pct: { kind: 'rel', value: 0.01 },
  rel_5pct: { kind: 'rel', value: 0.05 },
};
export const MONOTONIC_DIRECTIONS = ['non_decreasing', 'non_increasing'];
export const STANCES = ['pass', 'fail', 'unverified'];
export const DIMS = ['unknown', 'ratio', 'dimensionless', 'duration', 'bytes', 'bool'];

// ★★ 量纲来源状态：**模型对"这个数的量纲从哪来"的必须表态**（枚举，不表态就报码）。
//   inline     值自带单位标记（`7.1` 不行，`7.1 ms` 才行）—— 系统拿原文一查就知道它说的是不是真的
//   cited      另给一段可回溯到原文的依据（dim_evidence）
//   undeclared 明确表态：找不到来源（诚实的"不知道"，不是默认值）
//
// 为什么这条约束能"硬"：它是**枚举表态**，系统能拿原文证伪（有没有内联单位是机械可查的）。
// 而"表格/数值 facet 一律必须带 dim_evidence"那种约束要求的是**材料里存在某段文字** ——
// 那是材料的事实，强制只能逼模型抓一段不相干的字来凑（"买一个通过"），并把
// 「模型没给依据」与「材料没依据」混成同一种 unverified。故不采用后者。
export const DIM_SOURCE_STATUSES = ['inline', 'cited', 'undeclared'];

// 给**离线工具与夹具**用的：按一个守规矩的生产者的写法补上状态（不影响 LLM 通路 ——
// 那里状态必须由模型自己给，漏了在调用闸就被拒）。
export function inferDimSourceStatus(quote, spec = {}) {
  if (spec.dim_evidence) return 'cited';
  const u = normalizeUnit(parseNumeric(String(quote)).unit ?? '');
  return u && u.dim !== 'unknown' ? 'inline' : 'undeclared';
}

// 降级（unverified）原因码。**唯一的措辞来源**：schema 里 reason_codes 的 enum 必须等于这份表，
// 展示句由 renderStatement() 从码 + 计算依据生成 —— 全项目只有一份模板定义。
export const REASONS = [
  'claim_missing', 'claim_not_source_bound',
  'operand_bundle_not_found', 'operand_span_index_out_of_range',
  'operand_quote_not_in_declared_span', 'operand_quote_mismatch',
  'operand_not_a_complete_numeric_token',
  'operand_label_not_in_same_span', 'operand_quote_not_near_label', 'ambiguous_operand_selection',
  'multiline_span_not_structured', 'arity_mismatch',
  'no_number_in_operand', 'multiple_numbers_in_operand', 'unparsable_number',
  'unknown_unit', 'unknown_dimension', 'dim_evidence_unusable', 'incompatible_dimensions',
  // 量纲来源状态（模型必须表态；缺失与"原文没单位"是两件事）
  'dim_source_status_missing', 'dim_status_inline_without_unit',
  'dim_status_cited_without_evidence', 'dim_status_undeclared_with_source',
  'division_by_zero', 'non_finite_result',
  'expected_not_source_bound', 'ambiguous_expected_selection',
  'no_source_bound_expected_value', 'all_dims_undeclared', 'unparsable_numbering',
  // 表格键值查询
  'table_not_found', 'table_not_key_query_safe', 'column_not_found', 'column_ambiguous',
  'row_label_not_found', 'row_label_ambiguous', 'cell_missing', 'column_unit_undetermined',
  // fail 的前置条件未满足
  'fail_precondition_missing',
];

// fail 的判定码（不是"降级原因"，但同为措辞的唯一来源）
export const VERDICT_CODES = ['check_not_upheld'];
export const ALL_CODES = [...REASONS, ...VERDICT_CODES];

// ★ 调用级拒绝码：**整条 check 没有被产生**时的原因。
//   与 reason_codes 的区别：那是"检查做了但得不出结论"，这是"这次调用根本不是一条合法检查"。
//   合法检查与非法调用的分界是**结构**，不是语义 —— 结构不合格就拒绝（且必须可见），
//   语义上指错了地方仍然产生一条 unverified 的 check（那才有审计价值）。
export const CALL_REJECT_CODES = [
  'unknown_tool',
  'malformed_arguments_json',
  'arguments_failed_schema',
  'unknown_rubric_item',   // ★ v0.2：scope=rubric_item 但 id 不在 canonical rubric 里
  'internal_tool_error',
  'budget_exhausted',
];

// ------------------------------------------------------------------ 措辞（唯一一份模板）

const NON_EVALUATIVE = '本结论仅说明机械检查成立与否，不表示对学生的评价。';

const REASON_TEXT = {
  claim_missing: '未给出被验证的原话',
  claim_not_source_bound: '被验证的原话无法逐字回到原文',
  operand_bundle_not_found: '操作数指向的证据 bundle 不存在',
  operand_span_index_out_of_range: '操作数指向的片段下标越界',
  operand_quote_not_in_declared_span: '操作数的引用串不在声明的片段里',
  operand_quote_mismatch: '操作数的引用串与原文切片不一致',
  operand_not_a_complete_numeric_token: '操作数不是一个完整的数值（可能被截断或只是子串）',
  operand_label_not_in_same_span: '操作数的标签不在同一片段里',
  operand_quote_not_near_label: '操作数的值没有紧挨着它的标签',
  ambiguous_operand_selection: '标签无法唯一确定对象',
  multiline_span_not_structured: '来源片段是未结构化的多行数值块（表格行列未还原）',
  arity_mismatch: '操作数个数与该算子要求不符',
  no_number_in_operand: '操作数里没有数值',
  multiple_numbers_in_operand: '操作数里有多个数值，无法确定用哪一个',
  unparsable_number: '操作数里的数值无法解析',
  unknown_unit: '单位不在已知表里，不做猜测',
  unknown_dimension: '量纲未声明，且没有可回溯的额外依据',
  dim_evidence_unusable: '给出的量纲依据无法使用',
  dim_source_status_missing: '数值操作数没有声明量纲来源状态（必须表态，不是默认值）',
  dim_status_inline_without_unit: '声明量纲来自值自带的单位标记，但该值里没有可识别的单位标记',
  dim_status_cited_without_evidence: '声明量纲来自另给的原文依据，但没有给出这段依据',
  dim_status_undeclared_with_source: '声明量纲没有来源，但值自带了单位标记或另给了依据',
  incompatible_dimensions: '参与运算的量纲不一致',
  division_by_zero: '除数为 0，结果不确定',
  non_finite_result: '推算结果不是有限数',
  expected_not_source_bound: '期望值无法逐字回到原文',
  ambiguous_expected_selection: '期望值的标签无法唯一确定对象',
  no_source_bound_expected_value: '缺少来自原文的期望值',
  all_dims_undeclared: '所有操作数都没有声明量纲，单位检查无从判定',
  unparsable_numbering: '编号里提取不出数值',
  table_not_found: '指定的表格不在 L1 已解析的表格里',
  table_not_key_query_safe: '该表格没有可靠解析到可用于键值查询的程度',
  column_not_found: '列头里没有这一列',
  column_ambiguous: '列头里这一列名出现多次，无法确定是哪一列',
  row_label_not_found: '行标签里没有这一行',
  row_label_ambiguous: '行标签里这一行出现多次，无法确定是哪一行',
  cell_missing: '该行列位置没有单元格',
  column_unit_undetermined: '列的单位无法从列头确定',
  fail_precondition_missing: 'fail 的四项前置条件未全部满足',
};

// 展示句由程序从这里生成；产物里**不存任何自由措辞**（schema 里没有那样的字段）。
export function renderStatement(result) {
  if (!result || result.stance === 'pass') return null;
  const codes = result.reason_codes ?? [];
  if (result.stance === 'fail') {
    return `机械检查不成立：${result.basis?.formula ?? result.operator} 在原值上不成立`
      + `（推算 ${result.computed?.value}，期望 ${result.expected?.value}，容差 ${result.tolerance}）。${NON_EVALUATIVE}`;
  }
  return `该项无法验证：${codes.map(c => REASON_TEXT[c] ?? c).join('；')}。${NON_EVALUATIVE}`;
}

export function reasonText(code) { return REASON_TEXT[code] ?? code; }

// ------------------------------------------------------------------ 文本工具

const NUM_RE = /[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
const UNIT_AFTER_RE = /^\s*(%|个百分点|百分点|百分比|分钟|秒|[A-Za-z]{1,5})/;

export function parseNumeric(text) {
  const nums = String(text).match(NUM_RE) || [];
  if (nums.length !== 1) {
    return { ok: false, reason: nums.length === 0 ? 'no_number_in_operand' : 'multiple_numbers_in_operand' };
  }
  const value = Number(nums[0]);
  if (!Number.isFinite(value)) return { ok: false, reason: 'unparsable_number' };
  const idx = text.indexOf(nums[0]);
  const m = text.slice(idx + nums[0].length).match(UNIT_AFTER_RE);
  return { ok: true, value, raw: nums[0], unit: m ? m[1] : '' };
}

// ★ 完整 numeric token：前后都不能再是数字/小数点，也不能被 e/E 指数续上，
//   **也不能漏掉前置负号**。同样必须在**完整原文**上判定 ——
//   一旦在切片（如标签区间、声明区间）内部判定，切片的边界会伪造出一个"数值到此结束"。
export function isCompleteNumericToken(text, start, len) {
  const at = i => (i >= 0 && i < text.length ? text[i] : '');
  const digitish = c => /[0-9.]/.test(c);
  const before = at(start - 1);
  if (digitish(before)) return false;
  if (/[eE]/.test(before) && digitish(at(start - 2))) return false;
  if (signBeforeIsSignificant(text, start - 1)) return false;   // ★ 漏了前置负号 → 不完整
  const after = at(start + len);
  if (digitish(after)) return false;
  if (/[eE]/.test(after) && /[0-9+\-]/.test(at(start + len + 1))) return false;
  return true;
}

// ★ 负号：引 `0.25` 而原文是 `-0.25` 时，丢掉的不只是格式，**值本身变了**（0.25 vs −0.25）。
//   但也不能把区间当负号：`3-1`、`v-1`、`图-1`、`(a)-1` 里的都不是负号。
//   判据：负号前的字符不是数字/字母/右括号/CJK（或负号在行首）→ 它才是真的负号。
const SIGN_CHARS = /[-−–]/;
function signBeforeIsSignificant(text, i) {
  if (i < 0 || i >= text.length) return false;
  if (!SIGN_CHARS.test(text[i])) return false;
  const prev = i - 1 >= 0 ? text[i - 1] : '';
  if (prev === '') return true;                      // 行首：`−0.25`
  if (/[0-9]/.test(prev)) return false;              // `3-1` 是区间
  if (/[A-Za-z]/.test(prev)) return false;           // `v-1` 是编号
  if (/[)\]}）】]/.test(prev)) return false;          // `(a)-1` 是区间
  if (/[\u3400-\u9fff]/.test(prev)) return false;    // `图-1` 是编号
  return true;                                       // 空格 / = / ( / , → 真负号
}

// 在**完整原文**上枚举 quote 的全部出现位置，只留下是完整 token 的那些（返回绝对偏移）。
export function allCompleteTokens(full, quote) {
  const out = [];
  let i = full.indexOf(quote);
  while (i >= 0) {
    if (isCompleteNumericToken(full, i, quote.length)) out.push(i);
    i = full.indexOf(quote, i + 1);
  }
  return out;
}

export function spanIsUnstructured(text) {
  const lines = String(text).split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;
  return lines.filter(l => (l.match(/\d/g) || []).length >= 2).length >= 2;
}

export function uniqueSpans(allSpans) {
  const seen = new Set();
  const out = [];
  for (const s of allSpans) {
    const k = `${s.source_ref?.file ?? ''}|${s.offset?.start}|${s.offset?.end}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function buildBundleIndex(evidenceFile) {
  const m = new Map();
  for (const e of evidenceFile.evidence ?? []) m.set(e.id, e);
  return m;
}

// ------------------------------------------------------------------ 表格键值查询（对象定位的第二条通道）

export function buildTableIndex(l1Index) {
  const tables = new Map();
  for (const t of l1Index?.tables ?? []) tables.set(t.id, t);
  return { tables, entries: l1Index?.entries ?? [], doc: l1Index?.doc ?? null };
}

function entryCovering(entries, start, end) {
  return entries.find(e => start >= e.start && end <= e.end) ?? null;
}

// 零匹配 / 多匹配 / 列单位不明确 → ok:false（调用方一律降为 unverified）
export function resolveTableQuery(full, tableIdx, spec) {
  const query = { table_id: spec.table_id, row_label: spec.row_label, column: spec.column };
  const out = {
    ok: false, selection: 'not_found', reasons: [],
    // ★ 派生来源：这三段文本是**模型给的**，只有"必须在已解析的列头/行标签里逐字命中"这一道校验
    query, query_source: 'model_supplied',
    // 查询里声明的表格身份要**原样回带**（即使表不存在）—— 审计行必须能看到"模型想去哪张表"
    table_id: spec.table_id ?? null,
    value_anchor: 'table_cell',
  };
  const fail = r => ({ ...out, reasons: [r] });

  if (!tableIdx) return fail('table_not_found');
  const t = tableIdx.tables.get(spec.table_id);
  if (!t) return fail('table_not_found');
  if (t.key_query_safe !== true || !t.columns) return { ...fail('table_not_key_query_safe'), table_id: t.id };

  // 结构本身的来源：L1 规则解析（可回溯、可复现）
  const structure_source = {
    origin: 'l1_rule_parse',
    cell_split: t.cell_split_source ?? null,
    caption_entry: t.caption_entry ?? null,
    entry_range: t.entry_range ?? null,
  };

  const colHits = t.columns.filter(c => c.text === spec.column);
  if (!colHits.length) return { ...fail('column_not_found'), table_id: t.id, structure_source, columns: t.columns.map(c => c.text) };
  if (colHits.length > 1) return { ...fail('column_ambiguous'), table_id: t.id, structure_source };
  const ci = t.columns.indexOf(colHits[0]);

  const rowHits = t.rows.filter(r => r.label === spec.row_label);
  if (!rowHits.length) return { ...fail('row_label_not_found'), table_id: t.id, structure_source, row_labels: t.rows.map(r => r.label) };
  if (rowHits.length > 1) return { ...fail('row_label_ambiguous'), table_id: t.id, structure_source };
  const ri = t.rows.indexOf(rowHits[0]);

  const cell = rowHits[0].cells[ci];
  if (!cell) return { ...fail('cell_missing'), table_id: t.id, structure_source };
  const hdr = colHits[0];
  const cellRef = {
    cell_id: `${t.id}:r${ri + 1}:c${ci + 1}`,
    text: cell.text,
    offset: { start: cell.start, end: cell.end },
  };

  // ★★ 表格的单位语义（确定性，作用域由声明位置决定）。**全部由规则解析，模型没有表态权** ——
  //   所以表格通道的操作数里 `dim_source_status` 恒为 null：模型的"表态"在这一通道不存在。
  //   优先级（从最贴近这一格到最远）：
  //   ① **列头**声明单位 → 作用于**整列**（列头最贴近"这一列量的是什么"）
  //   ② **行标签**声明单位 → 作用于**整行**（真实实验表就是这样：列头是 Join 方案名，
  //      单位写在行标签「Average Time (ms)」里）
  //   ③ **整表只声明了一种量纲** → 它作为**整表**的量纲（单位只在 Average 那一行写了一次
  //      ＝ 整表都是 ms）；声明了 ≥2 种就**不兜底** —— 那说明各行列量纲本来就不同，不能混。
  //   ④ **表注 caption** —— 表外，靠位置邻接判定，所以是**最后一级**：只在"表内一处都没声明"时
  //      使用。表外的注解不该覆盖表内的声明，也就不与表内做冲突判定（否则会把邻表的注解算到
  //      这张表头上）。表注自己声明了 ≥2 种量纲，才算冲突。
  //   冲突判定只发生在**同级**（列头 vs 行标签）之间 → 两种不同量纲 ⇒ 这一格量什么无法判定 ⇒ 不猜。
  //   ★ 量纲来自 ③/④ 时，**刻度仍取同表、同量纲、带单位标记**的那一处（记进 `scale_from`）：
  //     否则同一张表会混出两种基准值（表注判 duration ⇒ factor 1，行标签 (ms) ⇒ factor 0.001）。
  const rowLabelCell = rowHits[0].cells[0] ?? null;
  const hdrDim = hdr.text ? dimFromEvidence(hdr.text) : null;
  const rowDim = rowLabelCell ? dimFromEvidence(rowLabelCell.text) : null;
  const mk = (d, src, from, appliesTo) => ({
    quote: src.text, offset: { start: src.start, end: src.end },
    dim: d.dim, via: d.via, marker: d.marker, from, applies_to: appliesTo,
  });
  const inTable = tableDeclaredDims(t);          // 表内：列头 + 行标签
  const captions = tableCaptionDims(t, tableIdx); // 表外：表注（最后兜底）
  let unitSource = null;
  let unitConflict = false;
  if (hdrDim && rowDim && hdrDim.dim !== rowDim.dim) {
    unitConflict = true;
  } else if (hdrDim) {
    unitSource = mk(hdrDim, hdr, 'column_header', 'column');
  } else if (rowDim) {
    unitSource = mk(rowDim, rowLabelCell, 'row_label', 'row');
  } else {
    const dims = [...new Set(inTable.map(x => x.dim))];
    if (dims.length === 1) {
      const s = inTable[0];
      unitSource = mk(s, { text: s.quote, start: s.offset.start, end: s.offset.end }, s.site, 'table');
    } else if (dims.length === 0) {
      const capDims = [...new Set(captions.map(x => x.dim))];
      if (capDims.length === 1) {
        const s = captions[0];
        unitSource = mk(s, { text: s.quote, start: s.offset.start, end: s.offset.end }, 'caption', 'table');
      } else if (capDims.length > 1) {
        unitConflict = true;   // 表注自己就声明了两种量纲
      }
    }
  }
  if (unitSource && unitSource.via !== 'unit_marker') {
    // 只有"声明量纲的那一处自己没说刻度"时，才去同表里找带单位标记的那一处 ——
    // 否则会覆盖掉它自己的刻度（实测：查「平均耗时(ms)」那一行时，会被列头「时长(min)」抢走刻度）。
    const scaleSite = [...inTable, ...captions]
      .find(x => x.dim === unitSource.dim && x.via === 'unit_marker' && x.offset.start !== unitSource.offset.start);
    if (scaleSite) {
      unitSource.scale_from = { quote: scaleSite.quote, offset: scaleSite.offset, from: scaleSite.site, marker: scaleSite.marker };
    }
  }
  const unitFrom = unitSource ? unitSource.from : null;
  const struct = {
    ...out, table_id: t.id, structure_source, column_count: t.column_count,
    row: { label: rowHits[0].label, row_index: ri, cells: rowHits[0].cells.length },
    column: { header: hdr.text, column_index: ci, offset: { start: hdr.start, end: hdr.end } },
    cell: cellRef,
  };
  if (unitConflict) return { ...struct, ok: false, selection: 'not_found', reasons: ['dim_evidence_unusable'] };
  if (!unitSource) return { ...struct, ok: false, selection: 'not_found', reasons: ['column_unit_undetermined'] };

  const entry = entryCovering(tableIdx.entries, cell.start, cell.end);
  const source_ref = {
    file: tableIdx.doc?.name ?? null,
    sha256: tableIdx.doc?.sha256 ?? null,
    page: entry?.page ?? null,
    entry: entry?.id ?? null,
  };

  return {
    ...struct,
    ok: true, selection: 'unambiguous', reasons: [],
    // ★ 与 span 通道保持同一形状：操作数自己的 offset 指向**值的原文位置**（= 该单元格）。
    //   这样 `full.slice(offset) === quote` 这条不变量在两条通道上都成立，期望值也才有出处可比。
    offset: { start: cell.start, end: cell.end },
    quote: cell.text,
    unit_source: unitSource,
    source_ref,
    // 每个结构化字段的确定性分别标注 —— 不把模型给的字符串升级成确定事实
    provenance: {
      query: 'model_supplied',
      table_structure: structure_source.origin,
      cell_split: structure_source.cell_split,
      unit: unitFrom,
    },
  };
}

// 量纲依据 → 换算系数。**只有依据是单位标记时它才说明刻度**（列头「训练时长(min)」里的 min）；
// 只是关键词时（「验证准确率」）它只声明量纲，不声明刻度。
// 两条通道共用同一个函数 —— 否则会出现"表头单位被识别了、span 通道却没换算"的不一致。
// 量纲依据 → 换算系数。**只有依据是单位标记时它才说明刻度**（列头「训练时长(min)」里的 min）；
// 只是关键词时（「验证准确率」）它只声明量纲，不声明刻度。
// 两条通道共用同一个函数 —— 否则会出现"表头单位被识别了、span 通道却没换算"的不一致。
// ★ 声明**量纲**的那一处与声明**刻度**的那一处可以不是同一处：表注写「Timings …」（duration，
//   只是关键词），而 `(ms)` 写在某一行标签里 → 后者记在 `scale_from` 上。
//   不记就等于把刻度丢了 —— 同一张表会算出两种基准值（差 1000 倍），那是会误判的。
function scaleFromDimSource(us) {
  const marker = us?.scale_from?.marker ?? us?.marker;
  const via = us?.scale_from ? 'unit_marker' : us?.via;
  if (via === 'unit_marker') {
    const u = normalizeUnit(marker);
    if (u && u.dim !== 'unknown') return { factor: u.factor, base: u.base, marker };
  }
  return { factor: 1, base: us?.dim ?? 'unknown' };
}

// **表内**所有声明了量纲的位置（列头 / 行标签）。单位的**作用域由声明位置决定**，
// 所以要把两处都收集起来（而不是只看被查询的那一格）—— 这是 ③「整表唯一量纲」和换算刻度的依据。
function tableDeclaredDims(t) {
  const out = [];
  for (const c of t.columns ?? []) {
    const d = dimFromEvidence(c.text);
    if (d) out.push({ ...d, quote: c.text, offset: { start: c.start, end: c.end }, site: 'column_header' });
  }
  for (const r of t.rows ?? []) {
    const lab = r.cells?.[0];
    if (!lab) continue;
    const d = dimFromEvidence(lab.text);
    if (d) out.push({ ...d, quote: lab.text, offset: { start: lab.start, end: lab.end }, site: 'row_label' });
  }
  return out;
}

// **表注**候选（量纲可能只写在表注里，如「Table 3: Average runtime (ms)」）。表注在表**外**，
// 只能靠位置邻接判定，所以它是最后一级依据，且只在表内一处都没声明时才启用。
// 三个候选：① L1 已认出的图注条目（`caption_entry`）② 表区紧邻的下一条 ③ 表区紧邻的上一条
// （中文报告把表注放上方或下方都常见）。候选仍要过 `dimFromEvidence`，且来源（quote + offset +
// side + entry）照样进产物 —— 邻接是启发式，所以必须能被审计。
function tableCaptionDims(t, tableIdx) {
  const entries = tableIdx?.entries ?? [];
  const out = [];
  const push = (e, side) => {
    if (!e || typeof e.text !== 'string') return;
    const d = dimFromEvidence(e.text);
    if (!d) return;
    out.push({ ...d, quote: e.text, offset: { start: e.start, end: e.end }, site: 'caption', side, entry: e.id });
  };
  const [a, b] = String(t.entry_range ?? '').split('-');
  const ia = entries.findIndex(e => e.id === a);
  const ib = entries.findIndex(e => e.id === (b ?? a));
  if (t.caption_entry) push(entries.find(e => e.id === t.caption_entry), 'l1_caption_entry');
  if (ib >= 0) push(entries[ib + 1], 'after');
  if (ia >= 0) push(entries[ia - 1], 'before');
  return out;
}

function resolveTableOperand(full, tableIdx, spec) {
  const q = resolveTableQuery(full, tableIdx, spec);
  // 表格通道里单位由规则解析 → 不存在"模型表态"，状态显式记为 null（不是"漏了"）
  const w = { ...q, dim_source_status: null };
  if (!q.ok) return w;
  if (spec.kind === 'text') return { ...w, raw: q.cell.text };

  const p = parseNumeric(q.cell.text);
  if (!p.ok) return { ...w, ok: false, selection: 'not_found', reasons: [p.reason], raw: q.cell.text };
  const u = normalizeUnit(p.unit);
  if (!u) return { ...w, ok: false, selection: 'not_found', reasons: ['unknown_unit'], raw: p.raw };

  // 单元格是裸数字 → 量纲与刻度都取自 unit_source。若单元格自己带了单位且与依据冲突，判依据不可用。
  const us = q.unit_source;
  if (u.dim !== 'unknown' && u.dim !== us.dim) {
    return { ...w, ok: false, selection: 'not_found', reasons: ['dim_evidence_unusable'] };
  }
  const sc = u.dim !== 'unknown' ? { factor: u.factor, base: u.base, marker: p.unit } : scaleFromDimSource(us);
  return {
    ...w,
    raw: p.raw, value: p.value, unit: p.unit || sc.marker || '',
    dim: u.dim !== 'unknown' ? u.dim : us.dim, base: sc.base, base_value: p.value * sc.factor,
    span_structured: true,
    dim_source: us,
  };
}

// ------------------------------------------------------------------ span 通道：定位

const GAP_BEFORE = 6;
const GAP_AFTER = 5;

function locate(full, bundleIndex, spec, unique, needLabel) {
  const fail = r => ({
    ok: false, selection: 'not_found',
    quote: spec?.quote ?? null, raw: spec?.quote ?? null, label: spec?.label ?? null,
    label_occurrences: null, reasons: [r],
  });

  if (!spec || typeof spec !== 'object') return fail('operand_bundle_not_found');
  const bundle = bundleIndex.get(spec.bundle_id);
  if (!bundle) return fail('operand_bundle_not_found');
  const span = bundle.spans?.[spec.span_index];
  if (!span) return fail('operand_span_index_out_of_range');

  const win = { start: span.offset.start, end: span.offset.end };
  const winText = full.slice(win.start, win.end);
  const unstructured = spanIsUnstructured(winText);
  const common = { ref: { bundle_id: spec.bundle_id, span_index: spec.span_index }, span_offset: win, span_structured: !unstructured, source_ref: span.source_ref };

  if (!needLabel) {
    const rel = winText.indexOf(spec.quote);
    if (rel < 0) return fail('operand_quote_not_in_declared_span');
    const offset = { start: win.start + rel, end: win.start + rel + spec.quote.length };
    if (full.slice(offset.start, offset.end) !== spec.quote) return fail('operand_quote_mismatch');
    return { ...common, ok: true, selection: 'unambiguous', quote: spec.quote, offset, reasons: [] };
  }

  const labelRel = winText.indexOf(spec.label);
  if (labelRel < 0) return { ...fail('operand_label_not_in_same_span'), ...common };
  const labelOffset = { start: win.start + labelRel, end: win.start + labelRel + spec.label.length };
  if (!winText.includes(spec.quote)) return { ...fail('operand_quote_not_in_declared_span'), ...common, label: spec.label, label_offset: labelOffset };

  // ③b 值必须**贴着标签**，且必须是**完整 numeric token**。
  //     ★ 两步都只在**完整原文**上做：
  //       ① 候选 = 完整原文里所有满足 isCompleteNumericToken 的出现位置（绝不在切片内部判定，
  //          否则切片边界会伪造出"数值到此结束"，把 '0.861' 从原文的 '0.8612' 里切出来当真值）
  //       ② 再判断候选与标签的位置关系（标签内 / 紧随其后 / 紧贴其前），距离用 GAP 判，不截断窗口
  const cands = allCompleteTokens(full, spec.quote);
  let start = cands.find(s => s >= labelOffset.start && s + spec.quote.length <= labelOffset.end);
  let anchor = 'inside_label';
  if (start === undefined) {
    start = cands.find(s => s >= labelOffset.end && s - labelOffset.end <= GAP_AFTER);
    anchor = 'after_label';
  }
  if (start === undefined) {
    const rev = [...cands].reverse()
      .find(s => s + spec.quote.length <= labelOffset.start && labelOffset.start - (s + spec.quote.length) <= GAP_BEFORE);
    if (rev !== undefined) { start = rev; anchor = 'before_label'; }
  }
  if (start === undefined) {
    // 区分两类失败：完整原文里存在完整 token（只是离标签不合规） vs 它只是更长数值的子串
    const r = cands.length ? 'operand_quote_not_near_label' : 'operand_not_a_complete_numeric_token';
    return { ...fail(r), ...common, label: spec.label, label_offset: labelOffset };
  }
  const offset = { start, end: start + spec.quote.length };
  if (full.slice(offset.start, offset.end) !== spec.quote) return { ...fail('operand_quote_mismatch'), ...common };

  const labelAt = new Set();
  for (const s of unique) {
    const t = full.slice(s.offset.start, s.offset.end);
    let i = t.indexOf(spec.label);
    while (i >= 0) { labelAt.add(s.offset.start + i); i = t.indexOf(spec.label, i + 1); }
  }
  return {
    ...common, ok: true,
    selection: labelAt.size > 1 ? 'ambiguous' : 'unambiguous',
    quote: spec.quote, offset, label: spec.label, label_offset: labelOffset,
    label_occurrences: labelAt.size, value_anchor: anchor, reasons: [],
  };
}

// spec 可以走两条通道：有 table_id → 表格键值查询；否则 → span 定位
export function resolveOperand(full, bundleIndex, spec, unique, tableIdx = null) {
  if (spec?.table_id != null) return resolveTableOperand(full, tableIdx, spec);
  const r = locate(full, bundleIndex, spec, unique, true);
  if (spec?.kind === 'text') return r.ok ? { ...r, raw: spec.quote, dim_source_status: null } : r;

  // ★★ 数值操作数**必须表态**量纲来源状态（枚举）。漏了就报自己的码 ——
  //   「模型没表态」与「原文没单位」是两件事，绝不能合并成同一个 unverified。
  //   （LLM 通路上这条在**调用闸**就被拦下、根本不产生 check；这里是给非工具通路兜底。）
  const status = spec?.dim_source_status;
  if (!DIM_SOURCE_STATUSES.includes(status)) {
    return {
      ...r, ok: false, selection: 'not_found',
      reasons: ['dim_source_status_missing', ...(r.reasons ?? [])],
      dim_source_status: status ?? null, quote: spec?.quote ?? null,
    };
  }
  const S = o => ({ ...o, dim_source_status: status });
  const evRef = ds => ({ dim_evidence: { quote: ds.quote, offset: ds.offset } });

  const dimEvidence = spec?.dim_evidence
    ? locate(full, bundleIndex, { ...spec.dim_evidence }, unique, false)
    : null;
  let dimSource = null;
  if (dimEvidence) {
    if (!dimEvidence.ok) return S({ ...r, ok: false, selection: 'not_found', reasons: ['dim_evidence_unusable'] });
    const evText = full.slice(dimEvidence.offset.start, dimEvidence.offset.end);
    const d = dimFromEvidence(evText);
    if (!d) return S({ ...r, ok: false, selection: 'not_found', reasons: ['dim_evidence_unusable'], dim_evidence: { quote: dimEvidence.quote, offset: dimEvidence.offset } });
    dimSource = { quote: dimEvidence.quote, offset: dimEvidence.offset, dim: d.dim, via: d.via, marker: d.marker };
  }
  // ★ 表态 cited 却指不出依据 → 表态本身是假的（与"依据不可用"分开报）
  if (status === 'cited' && !dimSource) {
    return S({ ...r, ok: false, selection: 'not_found', reasons: ['dim_status_cited_without_evidence', ...(r.ok ? [] : r.reasons ?? [])] });
  }
  if (!r.ok) return S(r);

  const p = parseNumeric(spec.quote);
  if (!p.ok) return S({ ...r, ok: false, selection: 'not_found', reasons: [p.reason], raw: spec.quote });
  const u = normalizeUnit(p.unit);
  if (!u) return S({ ...r, ok: false, selection: 'not_found', reasons: ['unknown_unit'], raw: p.raw });

  // ★★ 表态 vs 原文：系统拿原文**证伪**表态 —— 值里有没有单位标记是机械可查的，
  //    所以这条约束才是"硬"的（它约束的是模型的表态，不是材料里必须存在什么）。
  const inlineUnit = u.dim !== 'unknown';
  if (status === 'inline' && !inlineUnit) {
    return S({ ...r, ok: false, selection: 'not_found', reasons: ['dim_status_inline_without_unit'], raw: p.raw, unit: p.unit });
  }
  if (status === 'undeclared' && (inlineUnit || dimSource)) {
    return S({
      ...r, ok: false, selection: 'not_found', reasons: ['dim_status_undeclared_with_source'],
      raw: p.raw, unit: p.unit, ...(dimSource ? evRef(dimSource) : {}),
    });
  }

  // 量的单位与刻度：**内联单位标记优先**（它最具体），dim_evidence 只在值本身没声明时才补。
  // 两者都声明却互相矛盾 → 依据对这个操作数不可用（不猜哪个对）。
  let dim = 'unknown';
  let base = 'unknown';
  let factor = 1;
  let unit = p.unit;
  if (inlineUnit) {
    if (dimSource && dimSource.dim !== u.dim) {
      return S({
        ...r, ok: false, selection: 'not_found', reasons: ['dim_evidence_unusable'],
        ...evRef(dimSource),
      });
    }
    dim = u.dim; base = u.base; factor = u.factor;
  } else if (dimSource) {
    dim = dimSource.dim;
    const sc = scaleFromDimSource(dimSource);   // ★ 与表格通道同一套换算：列头写 (min) 就是分钟
    base = sc.base;
    factor = sc.factor;
    if (dimSource.via === 'unit_marker') unit = dimSource.marker;
  }
  return S({
    ...r, raw: p.raw, value: p.value, unit,
    dim, base, base_value: p.value * factor,
    ...(dimSource ? { dim_source: dimSource } : {}),
  });
}

export function resolveClaim(full, bundleIndex, spec, unique) {
  const r = locate(full, bundleIndex, spec, unique, false);
  return r.ok ? { ...r, ok: true, reasons: [] } : r;
}

// ------------------------------------------------------------------ 维度

function unifyDims(ops) {
  const unknown = ops.filter(o => !o.dim || o.dim === 'unknown');
  if (unknown.length) return { ok: false, reason: 'unknown_dimension' };
  const chars = new Set(ops.map(o => o.dim));
  if (chars.size > 1) return { ok: false, reason: 'incompatible_dimensions' };
  return { ok: true, dim: [...chars][0], warnings: [] };
}

function mulDim(a, b) {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === b) return `${a}·${a}`;
  return `${a}·${b}`;
}

function within(computed, expected, tol) {
  if (tol.kind === 'abs') return Math.abs(computed - expected) <= tol.value;
  const base = Math.abs(expected) > 0 ? Math.abs(expected) : 1;
  return Math.abs(computed - expected) / base <= tol.value;
}

// ------------------------------------------------------------------ fail 的四项前置条件

// ① 输入绑定有效 ② 检查规则适用 ③ 容差策略存在 ④ 计算结果完整
// 四项全 true 才允许产出 fail。缺哪项就报哪项（`fail_precondition_missing`）。
export function preconditionsOf(ctx) {
  const { def, allowedOps, toleranceName, tol, ops, claim, computation } = ctx;
  return {
    input_binding: !!(claim && claim.ok === true) &&
      ops.length > 0 && ops.every(o => o.ok === true &&
        o.selection === 'unambiguous' && o.span_structured !== false),
    rule_applicable: !!(def && Array.isArray(allowedOps) && allowedOps.includes(def.operator ?? ctx.operator)),
    tolerance_policy: !!(toleranceName && tol),
    computation_complete: !!(computation && computation.computed !== null && Number.isFinite(computation.computed) &&
      computation.expected !== null && Number.isFinite(computation.expected) && computation.delta !== null),
  };
}

const allTrue = o => Object.values(o).every(Boolean);
const missingKeys = o => Object.entries(o).filter(([, v]) => !v).map(([k]) => k);

// ------------------------------------------------------------------ 执行一个 check

export function runCheck(full, bundleIndex, allSpans, check, l1Index = null) {
  const def = OPERATORS[check.operator];
  if (!def) throw new Error(`算子不在枚举内: ${check.operator}`);
  const allowed = KIND_OPERATORS[check.kind];
  if (!allowed) throw new Error(`检查种类不在枚举内: ${check.kind}`);
  if (!allowed.includes(check.operator)) throw new Error(`检查种类 ${check.kind} 不允许使用算子 ${check.operator}`);

  const toleranceName = TOLERANCE_BY_OPERATOR[check.operator];   // ★ 服务端决定，忽略传入值
  const tol = toleranceName ? TOLERANCES[toleranceName] : null;
  const unique = uniqueSpans(allSpans);
  const tableIdx = l1Index ? buildTableIndex(l1Index) : null;

  // ★ 顺序有含义：**先解析操作数、再解析 claim**。
  //   即使 claim 不合格，审计行里也必须留下「模型到底指了哪里」—— 否则出问题时无从复盘。
  const ops = (check.operands ?? []).map(s => resolveOperand(full, bundleIndex, s, unique, tableIdx));
  const claim = check.claim ? resolveClaim(full, bundleIndex, check.claim, unique) : null;

  const base = {
    id: check.id, kind: check.kind, operator: check.operator,
    // ★ v0.2：作用域随产物落盘 —— 下游（L4）据此判断这条检查该归到哪个条目
    scope: check.scope === 'document' ? 'document' : 'rubric_item',
    rubric_item_id: check.scope === 'document' ? null : (check.rubric_item_id ?? null),
    claim, operands: ops, warnings: [],
  };

  const stop = (codes, extra = {}) => {
    const rs = [...new Set(codes)];
    return {
      ...base, stance: 'unverified', reason_codes: rs,
      computed: null, expected: null, delta: null, tolerance: toleranceName ?? null,
      basis: {
        // ★ 必须补上 operator —— `OPERATORS[x]` 本身不带这个字段，
        //   直接传会让降级路径的 rule_applicable 恒为 false（真模型跑出来的 bug）
        preconditions: preconditionsOf({ def: { ...def, operator: check.operator }, allowedOps: allowed, toleranceName, tol, ops, claim, computation: null }),
        formula: def.formula ?? null,
        values: null,
        ...(extra.basis ?? {}),
      },
      ...extra,
    };
  };

  if (!claim) return stop(['claim_missing']);
  if (!claim.ok) return stop(['claim_not_source_bound', ...claim.reasons]);

  if (def.arity >= 0 && ops.length !== def.arity) return stop(['arity_mismatch']);
  if (ops.length === 0) return stop(['arity_mismatch']);

  const bad = ops.filter(o => !o.ok);
  if (bad.length) return stop(bad.flatMap(o => o.reasons));

  const structIssues = ops.some(o => !o.span_structured);
  const ambIssues = ops.some(o => o.selection !== 'unambiguous');
  if (structIssues || ambIssues) {
    const rs = [];
    if (structIssues) rs.push('multiline_span_not_structured');
    if (ambIssues) rs.push('ambiguous_operand_selection');
    return stop(rs, ambIssues ? {
      warnings: ops.filter(o => o.selection === 'ambiguous')
        .map(o => `「${o.label ?? o.query?.row_label ?? '?'}」在去重后的候选空间里出现 ${o.label_occurrences ?? '-'} 次，无法唯一确定对象`),
    } : {});
  }

  const numeric = def.inDim === 'text' ? [] : ops.filter(o => o.value !== undefined);
  let dimInfo = { ok: true, dim: 'unknown', warnings: [] };
  if (def.inDim === 'same' && numeric.length) {
    dimInfo = unifyDims(numeric);
    if (!dimInfo.ok) return stop([dimInfo.reason]);
  }
  const v = numeric.map(o => o.base_value);

  if (['ratio_of', 'percent_of'].includes(check.operator) && numeric[1]?.base_value === 0) return stop(['division_by_zero']);
  if (check.operator === 'relative_change' && numeric[0]?.base_value === 0) return stop(['division_by_zero']);

  let computed = null;
  let outDim = 'bool';
  switch (check.operator) {
    case 'sum_of': computed = v.reduce((a, b) => a + b, 0); outDim = dimInfo.dim; break;
    case 'mean_of': computed = v.reduce((a, b) => a + b, 0) / v.length; outDim = dimInfo.dim; break;
    case 'difference': computed = v[0] - v[1]; outDim = dimInfo.dim; break;
    case 'ratio_of': computed = v[0] / v[1]; outDim = 'dimensionless'; break;
    case 'percent_of': computed = (v[0] / v[1]) * 100; outDim = 'ratio'; break;
    case 'relative_change': computed = (v[1] - v[0]) / v[0]; outDim = 'ratio'; break;
    case 'product': computed = v[0] * v[1]; outDim = mulDim(numeric[0].dim, numeric[1].dim); break;
    case 'unit_consistent': {
      const declared = numeric.filter(o => o.dim && o.dim !== 'unknown').map(o => o.dim);
      if (declared.length < 2) return stop(['all_dims_undeclared']);
      computed = new Set(declared).size === 1 ? 1 : 0;
      break;
    }
    case 'range_in': {
      const r = RANGES[check.params?.range];
      if (!r) throw new Error(`范围不在枚举内: ${check.params?.range}`);
      if (r.requiresDim && numeric[0].dim !== r.requiresDim) return stop(['unknown_dimension']);
      computed = v[0] >= r.lo && v[0] <= r.hi ? 1 : 0;
      break;
    }
    case 'monotonic': {
      const d = check.params?.direction;
      if (!MONOTONIC_DIRECTIONS.includes(d)) throw new Error(`单调方向不在枚举内: ${d}`);
      const seq = [...ops].sort((a, b) => a.offset.start - b.offset.start).map(o => o.base_value);
      const inc = seq.every((x, i) => i === 0 || x >= seq[i - 1]);
      const dec = seq.every((x, i) => i === 0 || x <= seq[i - 1]);
      computed = (d === 'non_decreasing' ? inc : dec) ? 1 : 0;
      break;
    }
    case 'numbering_continuity': {
      const seq = [...ops].sort((a, b) => a.offset.start - b.offset.start)
        .map(o => Number((String(o.raw).match(/\d+/) || [NaN])[0]));
      if (seq.some(n => !Number.isFinite(n))) return stop(['unparsable_numbering']);
      const noDup = new Set(seq).size === seq.length;
      computed = noDup && seq.every((n, i) => n === i + 1) ? 1 : 0;
      base.warnings.push(`按文档顺序的编号序列 = ${seq.join(', ')}`);
      break;
    }
    case 'equals_text': computed = String(ops[0].raw).trim() === String(ops[1].raw).trim() ? 1 : 0; break;
    // agree 的产物是「两个操作数之差」，量纲随输入 —— 不能记成 bool
    case 'agree': computed = Math.abs(v[0] - v[1]); outDim = dimInfo.dim; break;
    default: throw new Error(`算子未实现: ${check.operator}`);
  }

  if (!Number.isFinite(computed)) return stop(['non_finite_result']);
  const scale = def.outUnit || null;
  const computedBase = scale === '%' ? computed * UNIT_DEF['%'].factor : computed;

  const exp = check.expected ? resolveOperand(full, bundleIndex, { ...check.expected, kind: check.expected.kind ?? 'number' }, unique, tableIdx) : null;
  if (check.expected && !exp.ok) return stop(['expected_not_source_bound', ...exp.reasons]);
  if (exp && !exp.span_structured) return stop(['multiline_span_not_structured']);
  if (exp && exp.selection !== 'unambiguous') return stop(['ambiguous_expected_selection']);

  // 期望值：来自材料，或由算子自身定义（自洽型检查）
  let expectedValue = null;
  let expectedDim = 'unknown';
  let expectedOrigin = null;
  const expectedExtra = {};
  if (exp) {
    expectedValue = exp.base_value;
    expectedDim = exp.dim ?? 'unknown';
    expectedOrigin = 'source_bound';
    // ★ 期望值的**来源信息不能丢** —— 它是"这个期望从材料哪一处来"的唯一凭据。
    //   上一版只存了 value/dim/unit/raw，等于把 patch 里最要紧的那一半扔了。
    if (exp.offset) expectedExtra.offset = exp.offset;
    if (exp.source_ref) expectedExtra.source_ref = exp.source_ref;
    if (exp.selection) expectedExtra.selection = exp.selection;
    if (exp.value_anchor) expectedExtra.value_anchor = exp.value_anchor;
    if (exp.cell) expectedExtra.cell = exp.cell;
    if (exp.dim_source) expectedExtra.dim_source = exp.dim_source;
    // 期望值的量纲来源状态同样要显式留下（它也是模型表态的一部分）
    if (exp.dim_source_status !== undefined) expectedExtra.dim_source_status = exp.dim_source_status;
    // 注意 quote 与 raw 是两件事：offset 覆盖的是 quote（引用串），raw 是解析出来的数字。
    // 两个都留，才能满足全项目唯一那条不变量：full.slice(offset) === quote
    if (exp.quote !== undefined) expectedExtra.quote = exp.quote;
    if (exp.raw !== undefined) expectedExtra.raw = exp.raw;
    if (exp.unit !== undefined) expectedExtra.unit = exp.unit;
  } else if (SELF_CONTAINED.includes(check.operator) && def.expectation != null) {
    expectedValue = Number(def.expectation);
    expectedDim = 'bool';
    expectedOrigin = 'rule_constant';
    expectedExtra.rule = `${check.operator} 的期望由算子自身定义（恒为 ${def.expectation}），不来自材料`;
  } else {
    return stop(['no_source_bound_expected_value']);
  }

  const delta = { abs: Math.abs(computedBase - expectedValue), tolerance: tol ?? null };
  const computation = { computed: computedBase, expected: expectedValue, delta };
  const pre = preconditionsOf({
    def: { ...def, operator: check.operator },
    allowedOps: allowed, toleranceName, tol, ops, claim, computation,
  });
  const basis = {
    preconditions: pre,
    formula: def.formula ?? null,
    values: numeric.map(o => o.base_value),
    expected_origin: expectedOrigin,
  };

  // ★ fail 的四项前置条件必须全部成立；缺项一律降级（不是 fail）
  const ok = within(computedBase, expectedValue, tol ?? TOLERANCES.exact);
  const wantsFail = !ok;
  if (wantsFail && !allTrue(pre)) {
    return {
      ...stop(['fail_precondition_missing'], { basis }),
      basis: { ...basis, preconditions_missing: missingKeys(pre) },
    };
  }

  // 维度兼容（有原文期望值时）
  if (expectedOrigin === 'source_bound' && !dimsCompatible(outDim, expectedDim)) {
    if (outDim === 'unknown' || expectedDim === 'unknown') return stop(['unknown_dimension'], { basis });
    return stop(['incompatible_dimensions'], { basis });
  }

  return {
    ...base,
    stance: ok ? 'pass' : 'fail',
    reason_codes: ok ? [] : [...VERDICT_CODES],
    computed: { value: computedBase, dim: outDim, ...(scale ? { scale } : {}) },
    expected: {
      value: expectedValue, dim: expectedDim, origin: expectedOrigin,
      ...expectedExtra,
    },
    delta, tolerance: toleranceName ?? null,
    basis,
  };
}

function dimsCompatible(a, b) { return a === b; }

// ------------------------------------------------------------------ LLM tool calling 的接口面
// 按 kind 分组的 6 个 tool。每个 tool 参数里 operator 的 enum 就是该 kind 允许的算子，
// 于是 schema 成为第一道闸。操作数支持两条通道：span（bundle_id+span_index+quote）
// 或表格键值查询（table_id + row_label + column）——**由 if/then 强制补齐该通道的必填字段**，
// 于是"少给字段"在调用阶段就被拒，不会变成一条语义奇怪的 check。

const OPERAND_PROPS = {
  // 通道 A：span 内定位
  bundle_id: { type: 'string' }, span_index: { type: 'integer' },
  quote: { type: 'string', description: '数值本身，逐字；不要给偏移' },
  label: { type: 'string', description: '能唯一确定该对象的标签，必须与值同处一个片段' },
  kind: { type: 'string', enum: ['number', 'text'] },
  // ★ 数值操作数必须**表态**量纲从哪来。这是枚举表态，系统能拿原文证伪，
  //   所以可以做成硬约束；而"必须给出一段原文依据"不能（那是材料的事实，强制只会逼出伪造）。
  dim_source_status: {
    type: 'string', enum: DIM_SOURCE_STATUSES,
    description: '数值操作数必须表态量纲从哪来：inline=值本身带单位标记（如 "7.1 ms"）；'
      + 'cited=另给 dim_evidence 指向原文；undeclared=找不到来源（如实表态，允许）。'
      + '系统会拿原文核对该表态，填错则该操作数作废（绝不会因此变成 fail）。',
  },
  dim_evidence: {
    type: 'object', additionalProperties: false,
    description: '量纲的另一处依据：一段来自原文、可逐字定位的文字（如列头「验证准确率」、'
      + '行标签「Average Time (ms)」）。只在 dim_source_status=cited 时给；'
      + '值自带单位标记时不必给（内联单位优先）。',
    required: ['bundle_id', 'span_index', 'quote'],
    properties: { bundle_id: { type: 'string' }, span_index: { type: 'integer' }, quote: { type: 'string' } },
  },
  // 通道 B：表格键值查询（必须带 table_id —— 报告里两张表都可能有 baseline）
  table_id: { type: 'string', description: 'L1 索引里的表格 id' },
  row_label: { type: 'string', description: '行标签，必须逐字等于已解析的行标签' },
  column: { type: 'string', description: '列头，必须逐字等于已解析的列头' },
};

const CHANNEL_GATE = {
  if: { type: 'object', required: ['table_id'] },
  then: { type: 'object', required: ['table_id', 'row_label', 'column'] },
  else: { type: 'object', required: ['bundle_id', 'span_index', 'quote', 'label'] },
};

// 数值 span 必须表态量纲来源状态 —— 由 if/then 在**调用阶段**强制（漏了直接被拒，不产生 check）。
// 为什么必须在这里而不是事后：这样「模型漏参数」与「原文没单位」在数据上就不可能混成同一种
// unverified —— 前者根本产生不了 check。嵌套 if/then/else 是受支持的（validator 支持
// if/then/else + allOf，不支持 anyOf/oneOf/not），所以用"外层判通道、内层判 kind"来表达。
const DIM_STATUS_GATE = {
  if: { type: 'object', required: ['bundle_id'] },
  then: {
    if: { type: 'object', required: ['kind'], properties: { kind: { const: 'text' } } },
    then: { type: 'object' },
    else: { type: 'object', required: ['dim_source_status'] },
  },
  else: { type: 'object' },
};

// ★ v0.2：显式作用域。`rubric_item` 的检查必须带真实存在的条目 id；`document` 的检查
//   必须把 id 显式置 null —— 于是"文档级"与"忘了填条目"在数据上就是两件事，下游不许猜。
const SCOPE_GATE = {
  if: { type: 'object', required: ['scope'], properties: { scope: { const: 'rubric_item' } } },
  then: { type: 'object', required: ['rubric_item_id'], properties: { rubric_item_id: { type: 'string', minLength: 1 } } },
  else: { type: 'object', required: ['rubric_item_id'], properties: { rubric_item_id: { type: 'null' } } },
};

export function toolSpecs() {
  return CHECK_KINDS.map(kind => ({
    name: `verify_${kind}`,
    description: `L3 机械验证：${kind}。只做机械检查，不评分；数值一律由系统从材料解析，不要自己给数字。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'rubric_item_id', 'claim', 'operator', 'operands'],
      properties: {
        scope: {
          type: 'string', enum: ['rubric_item', 'document'],
          description: '这条检查的作用域：rubric_item=为某个 rubric 条目做的（此时 rubric_item_id 必填）；'
            + 'document=真正的文档级检查（编号连续性、全局引用完整性这类），此时 rubric_item_id 必须显式为 null。',
        },
        rubric_item_id: { type: ['string', 'null'] },
        claim: {
          type: 'object', additionalProperties: false,
          required: ['bundle_id', 'span_index', 'quote'],
          properties: {
            bundle_id: { type: 'string' }, span_index: { type: 'integer' },
            quote: { type: 'string', description: '被验证的原话，逐字来自原文' },
          },
        },
        operator: { type: 'string', enum: KIND_OPERATORS[kind] },
        operands: {
          type: 'array', minItems: 1,
          items: { allOf: [{ type: 'object', additionalProperties: false, properties: OPERAND_PROPS }, CHANNEL_GATE, DIM_STATUS_GATE] },
        },
        expected: {
          type: 'object', additionalProperties: false,
          description: '期望值，也必须来自材料。自洽型算子不需要',
          properties: OPERAND_PROPS,
          allOf: [CHANNEL_GATE, DIM_STATUS_GATE],
        },
        params: {
          type: 'object', additionalProperties: false,
          properties: {
            range: { type: 'string', enum: Object.keys(RANGES) },
            direction: { type: 'string', enum: MONOTONIC_DIRECTIONS },
          },
        },
      },
      // 作用域与条目 id 的一致性由调用闸强制（scope=rubric_item 必填 id、document 必须 null）
      allOf: [SCOPE_GATE],
    },
  }));
}

// LLM API（OpenAI / DeepSeek 风格）要的形态
export function llmTools() {
  return toolSpecs().map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
