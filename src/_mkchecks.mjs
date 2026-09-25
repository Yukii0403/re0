// _mkchecks.mjs —— 生成 design/verification-checks.example.json
//
// 对着真实文件跑：fixtures/report.pdf 的 L1 产物 + design/evidence-candidates.example.json 的 L2 证据。
// 依赖顺序：_realtest（或 l1）→ _mkrubric → _mkplan → _mkexample → 本脚本 → _selftest
//
// 本轮改动的直接体现：
//   · **「没有单位」叫 unknown，不叫 scalar** —— 要判定量纲必须有可回溯的额外依据（dim_evidence），
//     于是 ck0001 / ck0002 成为一对对照：同一个算式，给了列头依据 → pass；不给 → unverified
//   · **值的定位由标签锚定，且必须是完整 numeric token** —— 不能靠子串（'0' 在 '1e308' 里不算）
//   · claim 与操作数走同一套来源验证；**操作数先解析**，这样 claim 不合格时审计行仍留有「模型指了哪里」
//   · 容差由服务端按算子决定（传入值被忽略）；fail / unverified 走固定陈述模板
// 用法: node _mkchecks.mjs

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run as runL1 } from './l1.mjs';
import { buildBundleIndex, runCheck, uniqueSpans, KIND_OPERATORS, normalizeUnit, TOLERANCE_BY_OPERATOR, renderStatement, ALL_CODES, inferDimSourceStatus, L3_VERSION } from './verify-tools.mjs';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');
const outDir = path.join(root, 'fixtures', 'out');

const TXT = path.join(outDir, 'report.pdf.txt');
const IDX = path.join(outDir, 'report.pdf.index.json');
const EVP = path.join(design, 'evidence-candidates.example.json');
const OUT = path.join(design, 'verification-checks.example.json');

await fsp.mkdir(outDir, { recursive: true });
async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
if (!(await exists(TXT)) || !(await exists(IDX))) await runL1(path.join(root, 'fixtures', 'report.pdf'), outDir);

const full = await fsp.readFile(TXT, 'utf8');
const idx = JSON.parse(await fsp.readFile(IDX, 'utf8'));
const evBody = await fsp.readFile(EVP, 'utf8');
const evFile = JSON.parse(evBody);
const evSha = createHash('sha256').update(Buffer.from(evBody, 'utf8')).digest('hex');
const cr = JSON.parse(await fsp.readFile(path.join(design, 'canonical-rubric.example.json'), 'utf8'));

const bundleIndex = buildBundleIndex(evFile);
const allSpans = evFile.evidence.flatMap(e => e.spans);
const uniq = uniqueSpans(allSpans);
// ★ L1 索引是表格键值查询的解析依据 —— 只引用不复制
const idxBody = await fsp.readFile(IDX, 'utf8');
const idxSha = createHash('sha256').update(Buffer.from(idxBody, 'utf8')).digest('hex');

// bundle 位置（按 _mkexample 的定义顺序）
const B_CONS = 'ev0005';   // R2.1·F6 结论行（单行）
const B_BLOCK = 'ev0002';  // R2.1·F1 表体整块（多行，未结构化）
const B_ROWS = 'ev0008';   // R2.1·F1 三条单行表体行（结构化）
const B_FIG = 'ev0003';    // R2.2·F1 图注
const B_HEAD = 'ev0009';   // R2.1·F1 表格列头行（量纲的额外依据）

const CLAIM_ATTN = '注意力模块带来约 3.5 个百分点的提升';
const CLAIM_ENH = '数据增强进一步提升至 86.1%';
// 列头行里那两段：用来声明「验证准确率」列的量纲
const DIM_ACC = { bundle_id: B_HEAD, span_index: 0, quote: '验证准确率' };
const claim = q => ({ bundle_id: B_CONS, span_index: 0, quote: q });
// 注意：一律不传 tolerance —— 容差由服务端按算子决定
// ★ 数值 span 操作数必须表态量纲来源状态；这里按"守规矩的生产者"自动补
//   （inline＝值自带单位 / cited＝另给依据 / undeclared＝找不到来源）。
//   LLM 通路上状态必须由模型自己给，漏了在调用闸就被拒。
const st = (quote, spec) => ({ dim_source_status: inferDimSourceStatus(quote, spec) });
const row = (i, quote, label, dim) => ({ bundle_id: B_ROWS, span_index: i, quote, label, ...(dim ? { dim_evidence: dim } : {}), ...st(quote, { dim_evidence: dim }) });
const blk = (quote, label) => ({ bundle_id: B_BLOCK, span_index: 0, quote, label, ...st(quote) });
const cons = (quote, label) => ({ bundle_id: B_CONS, span_index: 0, quote, label, ...st(quote) });

const proposals = [
  {
    // ① 给了量纲依据（列头「验证准确率」）→ 可以判定
    id: 'ck0001', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [row(1, '0.847', '+ attention 0.847 7.1', DIM_ACC), row(0, '0.812', 'baseline 0.812 6.4', DIM_ACC)],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // ② 完全相同的算式，但不给量纲依据 → 只能是 unknown，诚实地说做不了。
    //    「没写单位」不等于「无量纲」—— 那是替原文做断言。
    id: 'ck0002', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [row(1, '0.847', '+ attention 0.847 7.1'), row(0, '0.812', 'baseline 0.812 6.4')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // 跨处引用：结论里的 86.1% 与表体里的 0.861 是否一致
    id: 'ck0003', kind: 'cross_reference', operator: 'agree', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ENH),
    operands: [cons('86.1%', CLAIM_ENH), row(2, '0.861', '+ attention + 数据增强 0.861 9.8', DIM_ACC)],
  },
  {
    // 三个操作数里只有结论行那个带单位 → 已声明量纲不足两个 → 单位检查无从判定
    id: 'ck0004', kind: 'unit_check', operator: 'unit_consistent', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [row(1, '0.847', '+ attention 0.847 7.1'), row(0, '0.812', 'baseline 0.812 6.4'), cons('3.5 个百分点', '约 3.5 个百分点')],
  },
  {
    // 懒标签：'+ attention' 在去重后的候选空间里落在两处（两个表体行），无法唯一确定对象
    id: 'ck0005', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [row(1, '0.847', '+ attention'), row(0, '0.812', 'baseline 0.812 6.4', DIM_ACC)],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // 选错对象：0.847 被声明在结论行的 span 里，而结论行没有这个数
    id: 'ck0006', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [cons('0.847', '注意力模块'), row(0, '0.812', 'baseline 0.812 6.4', DIM_ACC)],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    id: 'ck0007', kind: 'magnitude_sanity', operator: 'range_in', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ENH),
    operands: [cons('86.1%', CLAIM_ENH)],
    params: { range: 'fraction' },
  },
  {
    // 同样的算式，但操作数取自**多行表格整块** —— 行列没还原，值属于哪一列没有机械依据
    id: 'ck0008', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [blk('0.847', '+ attention 0.847 7.1'), blk('0.812', 'baseline 0.812 6.4')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // ★ 表格通道（键值查询）：完全不碰 span，只用 (表 id, 行标签, 列头) 定位两个数
    //   必须带 table_id —— 同一份报告里两张表都可能有 baseline 和「准确率」
    id: 'ck0010', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [
      { table_id: 't0001', row_label: '+ attention', column: '验证准确率' },
      { table_id: 't0001', row_label: 'baseline', column: '验证准确率' },
    ],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // 选错表：这个 id 在 L1 里不存在 → 零匹配
    id: 'ck0011', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [
      { table_id: 't0099', row_label: '+ attention', column: '验证准确率' },
      { table_id: 't0001', row_label: 'baseline', column: '验证准确率' },
    ],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // ★ 选错指标：真实列头是「验证准确率」，写成「准确率」就是零匹配。
    //   定位歧义被消掉了，但**选对业务对象仍由模型负责** —— 这一条就是那个反例。
    id: 'ck0012', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'R2.1',
    claim: claim(CLAIM_ATTN),
    operands: [
      { table_id: 't0001', row_label: '+ attention', column: '准确率' },
      { table_id: 't0001', row_label: 'baseline', column: '验证准确率' },
    ],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  },
  {
    // 同一段图注被两个 bundle 引用（同一物理 span）：label 只应算一次
    id: 'ck0009', kind: 'numbering', operator: 'equals_text', rubric_item_id: 'R2.2',
    claim: { bundle_id: B_FIG, span_index: 0, quote: '图 3 不同学习率下的验证损失曲线' },
    operands: [
      { bundle_id: B_FIG, span_index: 0, quote: '图 3 不同学习率下的验证损失曲线', label: '图 3 不同学习率下的验证损失曲线', kind: 'text' },
      { bundle_id: 'ev0001', span_index: 1, quote: '图 3 不同学习率下的验证损失曲线', label: '图 3 不同学习率下的验证损失曲线', kind: 'text' },
    ],
  },
];

// ★ v0.2：每条 check 都带**显式作用域**。这一批都是为某个 rubric 条目做的 → rubric_item。
//   （scope=document 只用于真正文档级的检查：编号连续性、全局引用完整性这类，且 id 必须为 null。）
const checks = proposals.map(p => runCheck(full, bundleIndex, allSpans, { scope: 'rubric_item', ...p }, idx));
const byId = id => checks.find(c => c.id === id);

const count = s => checks.filter(c => c.stance === s).length;
const reasons = new Map();
for (const c of checks) if (c.stance === 'unverified') for (const r of c.reason_codes) reasons.set(r, (reasons.get(r) || 0) + 1);
const byKind = {};
for (const c of checks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
const kindsMissing = KIND_OPERATORS && Object.keys(KIND_OPERATORS).filter(k => !byKind[k]);
// ★ 每条 fail 的四项前置条件实测值 —— fail 必须四项全 true
const failPre = checks.filter(c => c.stance === 'fail')
  .map(c => ({ check_id: c.id, all_true: Object.values(c.basis.preconditions).every(Boolean) }));

const out = {
  authority: {
    scoring_authority: 'rubric',
    rubric_sha256: cr.source.sha256,
    layer_produces_score: false,
    layer_version: L3_VERSION,
    notes: 'L3 只做机械验证。pass / fail 是验证结论，不是分数；L3 不产生任何评分。'
      + '产物里没有任何自由措辞字段 —— 展示句由程序从 reason_codes + basis 生成，模板只有一份定义。'
      + 'fail 必须同时满足 basis.preconditions 的四项，缺一即降级。',
  },
  doc: { name: idx.doc.name, sha256: idx.doc.sha256, text_file: path.basename(TXT), index_file: path.basename(IDX) },
  rubric: { rubric_id: cr.rubric_id, sha256: cr.source.sha256, file: 'canonical-rubric.example.json' },
  evidence: { file: 'evidence-candidates.example.json', sha256: evSha, plan_id: evFile.retrieval_plan.plan_id, plan_version: evFile.retrieval_plan.version },
  index: { file: path.basename(IDX), sha256: idxSha, tables: idx.tables.length },
  checks,
  diagnostics: {
    diagnostic_only: true,
    notice: '★ pass / fail 的计数不得映射为任何分数：验证只覆盖可机械判定的那一小部分。'
      + 'unverified 的成因已归类 —— unknown_dimension 与 all_dims_undeclared 指向同一件事：'
      + '「没写单位」被判成 unknown 而不是无量纲，所以同维运算与单位检查都做不了；'
      + 'multiline_span_not_structured 指向跨行的**非结构化**片段（L1 已能还原的行不再属于这一类）。'
      + '表格通道消掉的是**定位**歧义：ck0010 完全不碰 span 也能取到数；'
      + '但 ck0012 说明**选对业务对象仍由模型负责** —— 列名写错就是零匹配，程序不会替它猜。'
      + (kindsMissing.length ? ` 注意：本样本未覆盖的检查种类有 ${kindsMissing.join(' / ')} —— 不做假样例凑数。` : ''),
    counts: { pass: count('pass'), fail: count('fail'), unverified: count('unverified') },
    by_kind: byKind,
    unverified_reasons: [...reasons].sort().map(([reason, c]) => ({ reason, count: c })),
    fail_precondition_status: failPre,
    not_scoring: 'L3 不评分。验证结论只描述「机械检查成立与否」，不描述学生表现。',
  },
};

const body = JSON.stringify(out, null, 2);
await fsp.writeFile(OUT, body, 'utf8');

// ------------------------------------------------------------------ 自证
const schema = JSON.parse(await fsp.readFile(path.join(design, 'verification-checks.schema.json'), 'utf8'));
const vr = validate(schema, out);

const allKeys = (o, acc = []) => {
  if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
  return acc;
};

// ★ 键名守卫必须**按整个键名**判定，不能按子串 —— 子串会把 dim_source.marker 当成 mark（分数）。
//   这已经是这个项目里第三次遇到「子串匹配误伤」了。
const SCORE_KEYS = new Set(['recall', 'score', 'scores', 'point', 'points', 'grade', 'grades', 'credit', 'credits', 'mark', 'marks']);
const ALLOWED_SCORE_KEYS = ['layer_produces_score', 'scoring_authority', 'not_scoring', 'plan_participates_in_scoring'];
const looksLikeScoreKey = k => !ALLOWED_SCORE_KEYS.includes(k) && (SCORE_KEYS.has(k.toLowerCase()) || /recall/i.test(k));

const judged = checks.filter(c => c.stance === 'pass' || c.stance === 'fail');
const opsOf = c => c.operands;

// claim 走同一套验证：故意把 claim 声明到一个不含它的 span 里
const claimProbe = runCheck(full, bundleIndex, allSpans, {
  id: 'ck9101', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: null,
  claim: { bundle_id: B_ROWS, span_index: 0, quote: CLAIM_ATTN },
  operands: [row(1, '0.847', '+ attention 0.847 7.1', DIM_ACC), row(0, '0.812', 'baseline 0.812 6.4', DIM_ACC)],
  expected: cons('3.5 个百分点', '约 3.5 个百分点'),
}, idx);
// 缺 claim
const noClaim = runCheck(full, bundleIndex, allSpans, {
  id: 'ck9102', kind: 'numeric_recompute', operator: 'difference',
  operands: [row(1, '0.847', '+ attention 0.847 7.1', DIM_ACC), row(0, '0.812', 'baseline 0.812 6.4', DIM_ACC)],
}, idx);
// 负例：选择无歧义、span 结构化，但算术不成立 → fail。
// 同时故意传一个数值不同的容差 —— 证明容差确实由服务端决定（传了也不生效）。
const failProbe = runCheck(full, bundleIndex, allSpans, {
  id: 'ck9001', kind: 'numeric_recompute', operator: 'difference', claim: claim(CLAIM_ATTN),
  operands: [row(2, '0.861', '+ attention + 数据增强 0.861 9.8', DIM_ACC), row(0, '0.812', 'baseline 0.812 6.4', DIM_ACC)],
  expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  tolerance: 'abs_0_5',
}, idx);

// label 去重的对照：旧逻辑（数 span 个数）会得到 2，新逻辑（绝对偏移）得到 1
const figLabel = '图 3 不同学习率下的验证损失曲线';
const oldCount = allSpans.filter(s => full.slice(s.offset.start, s.offset.end).includes(figLabel)).length;
const newCount = byId('ck0009')?.operands[0]?.label_occurrences;

// ---- 合成夹具：完整 numeric token 与「离标签太远」是两回事
const tokText = '总量 1，部分 0.5，占比 50%，耗时 300 min，放大 1e308';
const tokSpan = { offset: { start: 0, end: tokText.length }, source_ref: { file: 'synth-token.txt', sha256: 'st', page: null, entry: 'eT9' } };
const tokB = buildBundleIndex({ evidence: [{ id: 'evT', spans: [tokSpan] }] });
const tokRun = (quote, label) => runCheck(tokText, tokB, [tokSpan], {
  id: 'ck9003', kind: 'magnitude_sanity', operator: 'range_in',
  claim: { bundle_id: 'evT', span_index: 0, quote: '总量 1' },
  operands: [{ bundle_id: 'evT', span_index: 0, quote, label, ...st(quote) }],
  params: { range: 'non_negative' },
});
// 正向对照：值就在标签内 → 可以判定
const tokInside = tokRun('300', '耗时 300 min');
// '0' 在这个片段里只作为 '1e308' / '50%' / '300' / '0.5' 的子串出现 → 不是完整 token
const tokSubstring = tokRun('0', '放大 1e308');
// '30' 只在 '300' 里出现 → 同上
const tokSubstring2 = tokRun('30', '耗时 300 min');
// '300' 是完整 token，但离标签「总量 1」很远 → 距离问题，与上面区分开
const tokFar = tokRun('300', '总量 1');

const checksList = [
  ['示例通过真正的 schema 校验', vr.ok, true],
  ['★ pass / fail 只在操作数选择无歧义、且片段结构化时产出',
    judged.every(c => opsOf(c).every(o => o.ok && o.selection === 'unambiguous' && o.span_structured === true)), true],
  ['★ 每个 span 通道操作数的 quote 都能按其 offset 逐字切回原文',
    checks.flatMap(opsOf).filter(o => o.ok && o.offset && o.quote)
      .every(o => full.slice(o.offset.start, o.offset.end) === o.quote), true],
  ['★ 每条 check 的 claim 都经过同一套来源验证并逐字切回原文',
    checks.every(c => c.claim && c.claim.ok && full.slice(c.claim.offset.start, c.claim.offset.end) === c.claim.quote), true],
  ['claim 被声明到不含它的 span 里 → unverified（claim_not_source_bound）',
    claimProbe.stance === 'unverified' && claimProbe.reason_codes.includes('claim_not_source_bound'), true],
  ['没有 claim 的 check → unverified（claim_missing）',
    noClaim.stance === 'unverified' && noClaim.reason_codes.includes('claim_missing'), true],
  ['★ 操作数先于 claim 解析 —— claim 不合格时审计行仍留有「模型指了哪里」',
    claimProbe.operands.length > 0 && noClaim.operands.length > 0 &&
    claimProbe.operands.every(o => o.ok), true],

  ['★ 量纲对照：同一个算式，给了列头依据 → pass；不给 → unverified(unknown_dimension)',
    byId('ck0001')?.stance === 'pass' && byId('ck0002')?.stance === 'unverified' &&
    byId('ck0002')?.reason_codes.includes('unknown_dimension'), true],
  ['★ 没有量纲依据时记 unknown（不是 ratio，也不是 scalar）',
    byId('ck0002')?.operands.every(o => o.dim === 'unknown' && !('dim_source' in o)), true],
  ['★ 量纲判定必须留下可回溯的依据（dim_source.quote / via / marker）',
    byId('ck0001')?.operands.every(o => o.dim === 'ratio' && o.dim_source?.via === 'keyword' &&
      o.dim_source?.marker === '准确率' && o.dim_source?.quote === '验证准确率' &&
      full.slice(o.dim_source.offset.start, o.dim_source.offset.end) === '验证准确率'), true],

  // ---- ★ 表格通道（键值查询）
  ['★ 表格键值查询：完全不碰 span 也能取到数、并算出结果（ck0010 → pass）',
    byId('ck0010')?.stance === 'pass' &&
    Math.abs(byId('ck0010')?.computed.value - 0.035) < 1e-12, true],
  ['★ 键值查询必须带表格身份，且 table_id 在 L1 里不存在 → 零匹配 → unverified',
    byId('ck0011')?.stance === 'unverified' && byId('ck0011')?.reason_codes.includes('table_not_found'), true],
  ['★ 选错指标（列名写错）→ 零匹配 → unverified，程序不替模型猜',
    byId('ck0012')?.stance === 'unverified' && byId('ck0012')?.reason_codes.includes('column_not_found') &&
    byId('ck0012')?.operands[0]?.columns?.includes('验证准确率'), true],
  ['★ 返回内容包含：原始单元格内容 + 行列标题 + 单位来源 + source_ref',
    (() => {
      const o = byId('ck0010')?.operands[0];
      return o?.cell?.text === '0.847' && full.slice(o.cell.offset.start, o.cell.offset.end) === '0.847' &&
        o.row?.label === '+ attention' && o.column?.header === '验证准确率' &&
        o.unit_source?.marker === '准确率' && full.slice(o.unit_source.offset.start, o.unit_source.offset.end) === '验证准确率' &&
        o.source_ref?.entry && o.cell.cell_id === 't0001:r2:c2';
    })(), true],
  ['★ 派生来源逐字段标注：查询来自模型、结构来自 L1 规则解析、单位来自列头',
    (() => {
      const o = byId('ck0010')?.operands[0];
      return o?.query_source === 'model_supplied' && o.provenance?.query === 'model_supplied' &&
        o.provenance?.table_structure === 'l1_rule_parse' && o.provenance?.unit === 'column_header' &&
        o.structure_source?.origin === 'l1_rule_parse' && o.structure_source?.cell_split === 'pdf_geometry';
    })(), true],

  ['★ 完整 numeric token：值只是更长数值的子串 → unverified(operand_not_a_complete_numeric_token)',
    tokSubstring.reason_codes.includes('operand_not_a_complete_numeric_token') &&
    tokSubstring2.reason_codes.includes('operand_not_a_complete_numeric_token'), true],
  ['★ 完整 numeric token：完整但离标签太远 → unverified(operand_quote_not_near_label)（与子串问题分开报）',
    tokFar.reason_codes.includes('operand_quote_not_near_label'), true],
  ['完整 numeric token 的正向对照：值就在标签内 → 可以判定，且 anchor 记进产物',
    tokInside.stance === 'pass' && tokInside.operands[0].value_anchor === 'inside_label', true],

  ['多行非结构化 span 不得产出 pass/fail（ck0008 → multiline_span_not_structured）',
    byId('ck0008')?.reason_codes.includes('multiline_span_not_structured'), true],
  ['同一物理 span 被两个 bundle 引用时，label 只算一次（旧逻辑=2，新逻辑=1）',
    oldCount === 2 && newCount === 1, true],
  ['示例里存在「标签无法唯一确定对象」的用例（ck0005）',
    byId('ck0005')?.reason_codes.includes('ambiguous_operand_selection'), true],
  ['示例里存在「值贴着标签也找不到」的用例（ck0006）',
    byId('ck0006')?.reason_codes.some(r => r === 'operand_quote_not_in_declared_span' || r === 'operand_quote_not_near_label'), true],
  ['示例里存在「量纲未声明、单位检查做不了」的用例（ck0004）',
    byId('ck0004')?.reason_codes.includes('all_dims_undeclared'), true],

  // ---- ★ fail 的四项前置条件
  ['负例：选择无歧义 + 片段结构化但算术不成立 → fail', failProbe.stance, 'fail'],
  ['★ fail 的四项前置条件全部为 true（输入绑定 / 规则适用 / 容差策略 / 计算完整）',
    Object.values(failProbe.basis.preconditions).every(Boolean), true],
  ['★ 每条 fail 都在诊断里留了四项前置条件的实测值', 
    out.diagnostics.fail_precondition_status.every(x => x.all_true === true) &&
    out.diagnostics.fail_precondition_status.length === count('fail'), true],
  ['★ 容差由服务端决定：显式传入 abs_0_5 被忽略，实际用 difference 登记的 rel_5pct',
    failProbe.tolerance === TOLERANCE_BY_OPERATOR.difference && failProbe.tolerance !== 'abs_0_5', true],

  // ---- ★ 措辞：产物里没有自由措辞字段，模板只有一份
  //   注意 `text` 不在禁用名单里 —— 那个键出现在 `cell.text`，装的是**原文内容**，不是谁写的措辞
  ['★ 产物里不存在任何自由措辞字段（没有 statement / message / 任何散文）',
    !allKeys(out).some(k => /^(statement|message|comment|explanation|reason_text|wording|verdict_text|prose)$/i.test(k)) &&
    checks.every(c => !('statement' in c)) && !('statement' in (checks[0] ?? {})), true],
  ['★ 展示句由程序从 reason_codes 生成：pass 无句，非 pass 必有句且带免责句',
    checks.filter(c => c.stance === 'pass').every(c => renderStatement(c) === null) &&
    checks.filter(c => c.stance !== 'pass').every(c => typeof renderStatement(c) === 'string' &&
      renderStatement(c).includes('不表示对学生的评价')), true],
  ['★ 生成的展示句里不含任何评价性表述（结构性保证：产物中根本没有措辞字段）',
    checks.map(c => renderStatement(c) ?? '')
      .every(s => !/(学生|同学)[^，。]{0,6}(算错|写错|做错)|不合格|不达标|水平|优秀|较差|态度/.test(s)), true],
  ['★ reason_codes 全部在枚举内（未知码不可能出现）',
    checks.flatMap(c => c.reason_codes).every(c => ALL_CODES.includes(c)), true],

  ['产物任何层级都不存在 recall / 分数类字段',
    allKeys(out).every(k => !looksLikeScoreKey(k)), true],
  ['键名守卫本身不误伤（dim_source.marker 是合法字段，曾被 /mark/ 子串误判）',
    allKeys(out).includes('marker') && !looksLikeScoreKey('marker'), true],
  ['权威声明里写明本层不产生分数', out.authority.layer_produces_score === false, true],
  ['检查种类与算子的映射在工具层封闭', checks.every(c => KIND_OPERATORS[c.kind].includes(c.operator)), true],
  ['证据引用绑定到 L2 产物的真实字节哈希', out.evidence.sha256 === evSha, true],
  ['★ L1 索引引用绑定到真实字节哈希（键值查询的解析依据只有一份权威副本）',
    out.index.sha256 === idxSha && out.index.tables === idx.tables.length, true],
  ['未通过验证的项都带了原因', checks.filter(c => c.stance === 'unverified').every(c => c.reason_codes.length > 0), true],
  ['★ 非 pass 的项都带 basis 与四项前置条件',
    checks.filter(c => c.stance !== 'pass').every(c => c.basis && c.basis.preconditions &&
      typeof c.basis.preconditions.input_binding === 'boolean'), true],
];

const rep = [];
rep.push(`基于真实文件 fixtures/report.pdf（${idx.doc.chars} 字符 / ${idx.entries.length} 条目）`);
rep.push(`证据引用 design/evidence-candidates.example.json  sha256=${evSha.slice(0, 16)}…  span 去重后 ${allSpans.length} → ${uniq.length}`);
rep.push(`产出 design/verification-checks.example.json（${body.length} 字节）`);
rep.push(`stance 分布：pass=${count('pass')}  fail=${count('fail')}  unverified=${count('unverified')}`);
rep.push(`检查种类覆盖：${Object.keys(byKind).join(' / ')}${kindsMissing.length ? `（未覆盖：${kindsMissing.join(' / ')}）` : ''}`);
rep.push('');
rep.push('--- checks（审计行）---');
for (const c of checks) {
  rep.push(`  ${c.id} [${c.stance.padEnd(10)}] ${c.kind.padEnd(18)} ${c.operator.padEnd(15)} ← ${c.rubric_item_id}`);
  rep.push(`      claim ${c.claim?.ok ? 'OK ' : 'BAD'} @${c.claim?.offset?.start ?? '-'}  ${JSON.stringify((c.claim?.quote ?? '').slice(0, 34))}`);
  for (const o of c.operands) {
    if (o.query) {
      rep.push(`      op    [表格键值] ${JSON.stringify(o.query)}`);
      rep.push(`            → ${o.ok ? 'cell ' + o.cell.cell_id : '未解析'}  raw=${JSON.stringify(o.raw ?? null)} dim=${String(o.dim ?? '-')} unit=${JSON.stringify(o.unit ?? '')} unit_src=${JSON.stringify(o.unit_source?.via ?? null)}/${JSON.stringify(o.unit_source?.marker ?? null)}`);
      rep.push(`            结构来源=${o.structure_source?.origin ?? '-'}／列边界=${o.structure_source?.cell_split ?? '-'}／查询来源=${o.query_source ?? '-'}`);
      rep.push(`            行=${JSON.stringify(o.row?.label ?? null)} 列=${JSON.stringify(o.column?.header ?? null)} source_ref=${JSON.stringify(o.source_ref?.entry ?? o.cell?.cell_id ?? '-')}`);
    } else {
      rep.push(`      op    ${String(o.raw).padEnd(14)} unit=${String(o.unit ?? '').padEnd(6)} dim=${String(o.dim ?? '').padEnd(8)} sel=${String(o.selection).padEnd(12)} struct=${o.span_structured === false ? 'NO ' : 'yes'} label_occ=${o.label_occurrences ?? '-'}${o.value_anchor ? ` anchor=${o.value_anchor}` : ''}  ${JSON.stringify((o.label ?? '').slice(0, 24))}`);
    }
  }
  if (c.expected) rep.push(`      exp   ${String(c.expected.raw ?? '').padEnd(14)} → ${c.expected.value}  dim=${c.expected.dim ?? '-'}  origin=${c.expected.origin ?? '-'}`);
  if (c.computed) rep.push(`      comp  ${c.computed.value}  dim=${c.computed.dim ?? '-'}${c.computed.scale ? ` scale=${c.computed.scale}` : ''}   式=${c.basis?.formula ?? '-'}`);
  if (c.delta) rep.push(`      delta ${c.delta.abs}  tol=${JSON.stringify(c.delta.tolerance)}（服务端指定 ${c.tolerance}）`);
  const pre = c.basis?.preconditions;
  if (pre) rep.push(`      前置  ${Object.entries(pre).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`);
  if (c.warnings?.length) for (const w of c.warnings) rep.push(`      warn  ${w}`);
  if (c.reason_codes?.length) rep.push(`      why   ${c.reason_codes.join(', ')}`);
  const say = renderStatement(c);
  if (say) rep.push(`      say   ${say}   ← 程序从 reason_codes 生成，产物里不存这句话`);
}
rep.push('');
rep.push('--- 未通过验证的成因归类 ---');
for (const r of out.diagnostics.unverified_reasons) rep.push(`  ${r.reason}  ×${r.count}`);
rep.push('');
rep.push('--- 不进产物的探针 ---');
rep.push(`  ck9101 claim 声明到不含它的 span       → ${claimProbe.stance}  ${claimProbe.reason_codes.join(',')}  （操作数仍被解析，审计行不空）`);
rep.push(`  ck9102 完全没有 claim                  → ${noClaim.stance}  ${noClaim.reason_codes.join(',')}`);
rep.push(`  ck9001 选择无歧义+结构化但算术不成立   → ${failProbe.stance}  computed=${failProbe.computed?.value ?? '-'} expected=${failProbe.expected?.value ?? '-'}  tol=${failProbe.tolerance}  前置=${JSON.stringify(failProbe.basis.preconditions)}`);
rep.push('');
rep.push('--- 表格键值查询（ck0010 的完整解析链）---');
{
  const o = byId('ck0010').operands[0];
  rep.push(`  模型提交查询：${JSON.stringify(o.query)}   ← 查询来源 ${o.query_source}`);
  rep.push(`  解析成唯一 cell：${o.cell.cell_id}  "${o.cell.text}"  offset=${o.cell.offset.start}-${o.cell.offset.end}`);
  rep.push(`  行标签：${JSON.stringify(o.row.label)}   列头：${JSON.stringify(o.column.header)}`);
  rep.push(`  单位来源：${JSON.stringify(o.unit_source.quote)} → dim=${o.unit_source.dim} via=${o.unit_source.via} marker=${JSON.stringify(o.unit_source.marker)}`);
  rep.push(`  结构来源：${o.structure_source.origin}（列边界 ${o.structure_source.cell_split}）· 表格 ${o.table_id} · 条目 ${o.source_ref.entry} · 第 ${o.source_ref.page} 页`);
  rep.push(`  派生来源：${JSON.stringify(o.provenance)}`);
  rep.push('  ↑ 定位歧义被消掉了；但「选对业务对象」仍由模型负责 —— ck0012 就是列名写错的反例。');
}
rep.push('');
rep.push('--- 完整 numeric token（合成夹具）---');
rep.push(`  片段：${JSON.stringify(tokText)}`);
rep.push(`  值就在标签内   '300' @'耗时 300 min'  → ${tokInside.stance}  anchor=${tokInside.operands[0].value_anchor ?? '-'}`);
rep.push(`  只是子串       '0'   @'放大 1e308'    → ${tokSubstring.stance}  ${tokSubstring.reason_codes.join(',')}`);
rep.push(`  只是子串       '30'  @'耗时 300 min'  → ${tokSubstring2.stance}  ${tokSubstring2.reason_codes.join(',')}`);
rep.push(`  完整但离太远   '300' @'总量 1'         → ${tokFar.stance}  ${tokFar.reason_codes.join(',')}`);
rep.push('');
rep.push(`  单位归一对照：百分点 → base ${normalizeUnit('个百分点').base}（factor ${normalizeUnit('个百分点').factor}）`);
rep.push('');
rep.push('--- 自证 ---');
let bad = 0;
for (const [name, got, want] of checksList) {
  const ok = got === want;
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    if (name.includes('schema')) for (const e of vr.errors.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
    else rep.push(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
}
rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

await fsp.writeFile(path.join(here, '_mkchecks.out.txt'), rep.join('\n') + '\n', 'utf8');
if (bad > 0) {
  process.stderr.write(`_mkchecks: ${bad} 项自证失败\n`);
  process.exitCode = 1;
}
