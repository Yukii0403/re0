// _toolrun.mjs —— 走完整的 tool calling 通路，产出一份真实的 L3 产物并自证
//
// 这是一个**假模型**：按脚本回放工具调用（含各种不合法的调用），不依赖任何 API。
// 目的有两个：
//   ① 证明「工具 → 调用 → check」这条链真的能跑通，并且产物仍然过真 schema
//   ② 把**被拒的调用**与**重复调用**都留痕 —— 模型的错误行为不该被静默吞掉
//
// 依赖：_realtest（或 l1）→ _mkrubric → _mkplan → _mkexample → 本脚本
// 用法: node _toolrun.mjs

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run as runL1 } from './l1.mjs';
import { buildBundleIndex, KIND_OPERATORS, CALL_REJECT_CODES, ALL_CODES, inferDimSourceStatus, L3_VERSION } from './verify-tools.mjs';
import { createRunner, llmTools, assembleArtifact } from './toolcalling.mjs';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');
const outDir = path.join(root, 'fixtures', 'out');

const TXT = path.join(outDir, 'report.pdf.txt');
const IDX = path.join(outDir, 'report.pdf.index.json');
const EVP = path.join(design, 'evidence-candidates.example.json');
const OUT = path.join(outDir, 'report.pdf.checks.toolcall.json');

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }
await fsp.mkdir(outDir, { recursive: true });
if (!(await exists(TXT)) || !(await exists(IDX))) await runL1(path.join(root, 'fixtures', 'report.pdf'), outDir);

const full = await fsp.readFile(TXT, 'utf8');
const idxBody = await fsp.readFile(IDX, 'utf8');
const idx = JSON.parse(idxBody);
const evBody = await fsp.readFile(EVP, 'utf8');
const evFile = JSON.parse(evBody);
const cr = JSON.parse(await fsp.readFile(path.join(design, 'canonical-rubric.example.json'), 'utf8'));
const bundleIndex = buildBundleIndex(evFile);
const allSpans = evFile.evidence.flatMap(e => e.spans);

const DIM_ACC = { bundle_id: 'ev0009', span_index: 0, quote: '验证准确率' };
const CLAIM_ATTN = { bundle_id: 'ev0005', span_index: 0, quote: '注意力模块带来约 3.5 个百分点的提升' };
const CLAIM_ENH = { bundle_id: 'ev0005', span_index: 0, quote: '数据增强进一步提升至 86.1%' };
// 数值 span 操作数必须表态量纲来源状态（守规矩的生产者自动补；LLM 通路必须自己给，漏了被拒）
const st = (quote, spec = {}) => ({ dim_source_status: inferDimSourceStatus(quote, spec) });
const row = (i, quote, label) => ({ bundle_id: 'ev0008', span_index: i, quote, label, dim_evidence: DIM_ACC, ...st(quote, { dim_evidence: DIM_ACC }) });
const cons = (quote, label) => ({ bundle_id: 'ev0005', span_index: 0, quote, label, ...st(quote) });
const tq = (row_label, column) => ({ table_id: 't0001', row_label, column });

// ---------------------------------------------------------------- 假模型的脚本
// 前 4 条是合法调用（会变成 check）；后 5 条结构不合格（会被拒）
const SCRIPT = [
  { why: '表格通道：两个数都按 (表 id, 行标签, 列头) 取', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [tq('+ attention', '验证准确率'), tq('baseline', '验证准确率')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: 'span 通道：带列头作为量纲依据（与第 0 条同一个算式，两条通道给同一个答案）', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [row(1, '0.847', '+ attention 0.847 7.1'), row(0, '0.812', 'baseline 0.812 6.4')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '幅度合理性：表格单元格 + 列头自定义的量纲', fn: 'verify_magnitude_sanity', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ENH, operator: 'range_in',
    operands: [tq('+ attention + 数据增强', '验证准确率')], params: { range: 'fraction' },
  } },
  { why: '★ 选错指标：列名写成「准确率」（真实列头是「验证准确率」）', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [tq('+ attention', '准确率'), tq('baseline', '验证准确率')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '工具名不在枚举内', fn: 'verify_do_something_else', args: { operator: 'difference' } },
  { why: 'arguments 不是合法 JSON（工具名合法，参数截断了）', fn: 'verify_numeric_recompute', raw: '{"operator": "difference", ' },
  { why: '算子与 kind 不匹配（schema 的 enum 挡住）', fn: 'verify_unit_check', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference', operands: [tq('+ attention', '验证准确率')],
  } },
  { why: '表格通道缺 column（if/then 要求的必填字段）', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [{ table_id: 't0001', row_label: 'baseline' }],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '多给了一个 schema 未定义的字段', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [tq('+ attention', '验证准确率'), tq('baseline', '验证准确率')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'), 我猜的容差: 'abs_1e_3',
  } },
  { why: '与第 0 条完全重复（只计数，不丢弃）', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [tq('+ attention', '验证准确率'), tq('baseline', '验证准确率')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '★ 数值 span 漏了 dim_source_status（必须表态）→ **调用闸拒收**，根本不产生 check：'
    + '「模型漏参数」与「原文没单位」在数据上就是两种东西', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [{ bundle_id: 'ev0008', span_index: 1, quote: '0.847', label: '+ attention 0.847 7.1' }],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '★ 表态 inline（说"值自带单位"）但值里没有单位标记 → 结构合法、**照样产生一条 check**，'
    + '语义闸拿原文证伪该表态 → unverified(dim_status_inline_without_unit)', fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: CLAIM_ATTN, operator: 'difference',
    operands: [
      { bundle_id: 'ev0008', span_index: 1, quote: '0.847', label: '+ attention 0.847 7.1', dim_source_status: 'inline' },
      row(0, '0.812', 'baseline 0.812 6.4'),
    ],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '★ v0.2 · scope=rubric_item 但 id 不在 canonical rubric 里 → 调用闸拒收（unknown_rubric_item）',
    fn: 'verify_numeric_recompute', args: {
    scope: 'rubric_item', rubric_item_id: 'R9.9', claim: CLAIM_ATTN, operator: 'difference',
    operands: [tq('+ attention', '验证准确率'), tq('baseline', '验证准确率')],
    expected: cons('3.5 个百分点', '约 3.5 个百分点'),
  } },
  { why: '★ v0.2 · scope=document（真正的文档级检查，id 显式为 null）→ 合法：照样产生一条 check，'
    + '但它**不属于任何 rubric 条目**，下游不得据此自动影响分数', fn: 'verify_numbering', args: {
    scope: 'document', rubric_item_id: null, operator: 'equals_text',
    claim: { bundle_id: 'ev0003', span_index: 0, quote: '图 3 不同学习率下的验证损失曲线' },
    operands: [
      { bundle_id: 'ev0003', span_index: 0, quote: '图 3 不同学习率下的验证损失曲线', label: '图 3 不同学习率下的验证损失曲线', kind: 'text' },
      { bundle_id: 'ev0003', span_index: 0, quote: '图 3 不同学习率下的验证损失曲线', label: '图 3 不同学习率下的验证损失曲线', kind: 'text' },
    ],
  } },
];

const RUBRIC_IDS = (cr.items ?? []).map(i => i.id);
const runner = createRunner({ full, bundleIndex, allSpans, l1Index: idx, maxCalls: 100, rubricItems: RUBRIC_IDS });
const playback = SCRIPT.map(s => ({
  why: s.why,
  call: s.raw !== undefined
    ? { function: { name: s.fn, arguments: s.raw } }
    : { function: { name: s.fn, arguments: JSON.stringify(s.args) } },
  res: null,
}));
for (const p of playback) p.res = runner.call(p.call);

// 上限：另起一个小预算的 runner，证明撞上限是**可见**的
const budgetRunner = createRunner({ full, bundleIndex, allSpans, l1Index: idx, maxCalls: 2 });
const budgetPlay = SCRIPT.slice(0, 5).map(s => budgetRunner.call({ function: { name: s.fn, arguments: JSON.stringify(s.args ?? {}) } }));

const checks = runner.checks;
const sum = runner.summary();
const rejected = runner.rejected();

const count = s => checks.filter(c => c.stance === s).length;

const out = assembleArtifact({
  runner,
  doc: { name: idx.doc.name, sha256: idx.doc.sha256, text_file: path.basename(TXT), index_file: path.basename(IDX) },
  rubric: { rubric_id: cr.rubric_id, sha256: cr.source.sha256, file: 'canonical-rubric.example.json' },
  evidence: {
    file: 'evidence-candidates.example.json',
    sha256: createHash('sha256').update(Buffer.from(evBody, 'utf8')).digest('hex'),
    plan_id: evFile.retrieval_plan.plan_id,
    plan_version: evFile.retrieval_plan.version,
  },
  index: { file: path.basename(IDX), sha256: createHash('sha256').update(Buffer.from(idxBody, 'utf8')).digest('hex'), tables: idx.tables.length },
  notice: '★ 这是 tool calling 通路的样板（假模型回放）。accepted + rejected = attempted 是硬约束：'
    + '一次调用不许凭空消失。重复调用只计数不丢弃 —— 模型的重复行为本身是要看的。'
    + '撞到调用上限意味着这一轮有检查没做，budget_exhausted 会置位。',
});

const body = JSON.stringify(out, null, 2);
await fsp.writeFile(OUT, body, 'utf8');

// ------------------------------------------------------------------ 自证
const schema = JSON.parse(await fsp.readFile(path.join(design, 'verification-checks.schema.json'), 'utf8'));
let vr;
try { vr = validate(schema, out); } catch (e) { vr = { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; }

const allKeys = (o, acc = []) => {
  if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
  return acc;
};

// 上限 run：证明撞上限可见
const budgetRejects = budgetRunner.rejected();
const tools = llmTools();

const checks_list = [
  ['产物通过真正的 schema 校验', vr.ok, true],
  ['工具表就是 6 个，且形态符合 LLM 的 function calling（type/function.name/parameters）',
    tools.length === 6 && tools.every(t => t.type === 'function' && t.function.name.startsWith('verify_') &&
      t.function.parameters.type === 'object'), true],
  ['每个 tool 的 operator enum 就是该 kind 允许的算子（schema 是第一道闸）',
    tools.every(t => {
      const kind = t.function.name.replace('verify_', '');
      const en = t.function.parameters.properties.operator.enum;
      return en.length === KIND_OPERATORS[kind].length && en.every(o => KIND_OPERATORS[kind].includes(o));
    }), true],

  ['★ accepted + rejected = attempted（一次调用不许凭空消失）',
    out.diagnostics.tool_calling.accepted + out.diagnostics.tool_calling.rejected === out.diagnostics.tool_calling.attempted &&
    out.diagnostics.tool_calling.attempted === SCRIPT.length, true],
  ['★ id 由系统分配且连续（模型不能自报 id）',
    checks.every((c, i) => c.id === 'ck' + String(i + 1).padStart(4, '0')), true],
  ['★ 每条 check 都记了自己来自第几次工具调用',
    checks.every(c => Number.isInteger(c.tool_call_index) && c.tool_call_index >= 0), true],

  ['表格通道调用 → 产出 pass 的 check（不碰 span）',
    checks[0]?.stance === 'pass' && checks[0]?.operands[0]?.cell?.cell_id === 't0001:r2:c2', true],
  ['span 通道调用 → 产出 pass 的 check（带列头量纲依据）',
    checks[1]?.stance === 'pass' && checks[1]?.operands[0].dim_source?.marker === '准确率', true],
  ['幅度检查 → pass', checks[2]?.stance === 'pass' && checks[2]?.operator === 'range_in', true],
  ['★ 语义指错（列名写错）**仍然产出 check**，只是 unverified —— 这才有审计价值',
    checks[3]?.stance === 'unverified' && checks[3]?.reason_codes.includes('column_not_found') &&
    checks[3]?.operands[0].columns.includes('验证准确率'), true],

  ['未知工具名 → 拒收（unknown_tool），不产生 check',
    rejected.some(r => r.reason_code === 'unknown_tool'), true],
  ['arguments 不是合法 JSON → 拒收（malformed_arguments_json）',
    rejected.some(r => r.reason_code === 'malformed_arguments_json'), true],
  ['★ 算子与 kind 不匹配 → 被 schema 的 enum 挡住（arguments_failed_schema）',
    rejected.some(r => r.reason_code === 'arguments_failed_schema' && /operator/i.test(r.detail ?? '')), true],
  ['★ 表格通道缺 column → 被 if/then 挡住（arguments_failed_schema）',
    rejected.some(r => r.reason_code === 'arguments_failed_schema' && /column/i.test(r.detail ?? '')), true],
  ['★★ 数值 span 漏 dim_source_status → 调用闸拒收（漏参数根本不产生 check）',
    rejected.some(r => r.reason_code === 'arguments_failed_schema' && /dim_source_status/.test(r.detail ?? '')), true],
  ['★★ 表态 inline 但值里没单位 → 语义闸拿原文证伪，产出 unverified(dim_status_inline_without_unit)',
    (() => {
      const c = checks.find(x => x.tool_call_index === 11);
      return c?.stance === 'unverified' && c?.reason_codes.includes('dim_status_inline_without_unit') &&
        c?.operands[0].dim_source_status === 'inline';
    })(), true],
  ['★ 量纲来源状态在两条通道上都显式：span 给出表态、表格通道为 null（模型无表态权）',
    checks[1]?.operands[0].dim_source_status === 'cited' &&
    checks[0]?.operands[0].dim_source_status === null, true],
  ['★ v0.2 · scope=rubric_item 的 id 不在 canonical rubric 里 → 拒收（unknown_rubric_item）',
    rejected.some(r => r.reason_code === 'unknown_rubric_item'), true],
  ['★ v0.2 · 每条 check 都带显式作用域；文档级检查的 id 必须是 null 且不归属任何条目',
    checks.every(c => c.scope === 'rubric_item' || c.scope === 'document') &&
    (() => {
      const doc = checks.find(c => c.scope === 'document');
      return !!doc && doc.rubric_item_id === null && doc.id !== checks[0].id;
    })() &&
    checks.filter(c => c.scope === 'rubric_item').every(c => typeof c.rubric_item_id === 'string' && c.rubric_item_id.length > 0), true],
  ['★ v0.2 · 产物声明了 L3 契约版本（下游据此知道消费的是哪一版）',
    out.authority.layer_version === L3_VERSION, true],
  ['多给一个 schema 未定义的字段 → 拒收（additionalProperties:false 生效）',
    rejected.filter(r => r.reason_code === 'arguments_failed_schema').length >= 3, true],
  ['拒收码全部在枚举内', rejected.every(r => CALL_REJECT_CODES.includes(r.reason_code)), true],

  ['★ 重复调用只计数不丢弃（记下与第几次重复）',
    out.diagnostics.tool_calling.duplicate === 1 &&
    out.diagnostics.tool_calling.duplicate_calls[0].index === 9 && out.diagnostics.tool_calling.duplicate_calls[0].of_index === 0, true],
  ['★ 撞到调用上限是可见的（budget_exhausted + 拒收记录）',
    out.diagnostics.tool_calling.budget_exhausted === false &&
    budgetRunner.summary().budget_exhausted === true &&
    budgetRejects.some(r => r.reason_code === 'budget_exhausted'), true],
  ['★ 上限内 accepted + rejected 依然等于 attempted（小预算 run）',
    budgetRunner.summary().accepted + budgetRunner.summary().rejected === budgetRunner.summary().attempted, true],

  ['★ 展示句由程序生成；产物里没有任何自由措辞字段',
    !allKeys(out).some(k => /^(statement|message|comment|explanation|reason_text|wording|prose)$/i.test(k)), true],
  ['★ reason_codes 与拒收码都在枚举内',
    checks.flatMap(c => c.reason_codes).every(c => ALL_CODES.includes(c)), true],
  ['★ 若有 fail，四项前置条件必须全 true',
    out.diagnostics.fail_precondition_status.every(x => x.all_true), true],
  ['counts 与 checks 一致',
    out.diagnostics.counts.pass === count('pass') && out.diagnostics.counts.unverified === count('unverified'), true],
];

const rep = [];
rep.push(`假模型回放 ${SCRIPT.length} 次工具调用（合法 ${SCRIPT.length - rejected.length} 条 → check，拒收 ${rejected.length} 条）`);
rep.push(`基于真实文件 fixtures/report.pdf（${idx.doc.chars} 字符 / ${idx.entries.length} 条目 / ${idx.tables.length} 张表）`);
rep.push(`产出 ${path.relative(root, OUT).split(path.sep).join('/')}（${body.length} 字节）`);
rep.push(`账目：attempted=${sum.attempted}  accepted=${sum.accepted}  rejected=${sum.rejected}  duplicate=${sum.duplicate}  max_calls=${sum.max_calls}`);
rep.push('');
rep.push('--- 工具表（LLM 看到的）---');
for (const t of tools) {
  rep.push(`  ${t.function.name}  operator ∈ ${JSON.stringify(t.function.parameters.properties.operator.enum)}`);
}
rep.push('');
rep.push('--- 回放明细 ---');
for (const p of playback) {
  const head = `  [${String(p.call.function.name).padEnd(28)}] ${p.res.ok ? 'check ' + p.res.id : '拒收'}`;
  rep.push(`${head}  stance=${p.res.stance ?? '-'}  ${p.res.reason_code ?? ''}`);
  rep.push(`      ${p.why}`);
}
rep.push('');
rep.push('--- 产出的 check ---');
for (const c of checks) {
  rep.push(`  ${c.id} (call#${c.tool_call_index}) [${c.stance.padEnd(10)}] ${c.kind.padEnd(18)} ${c.operator.padEnd(15)} why=${JSON.stringify(c.reason_codes)}`);
}
rep.push('');
rep.push('--- 拒收表 ---');
for (const r of rejected) rep.push(`  #${r.index}  ${r.reason_code.padEnd(26)} tool=${JSON.stringify(r.tool)}  ${r.detail ? String(r.detail).slice(0, 90) : ''}`);
rep.push('');
rep.push('--- 自证 ---');
let bad = 0;
for (const [name, got, want] of checks_list) {
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

await fsp.writeFile(path.join(here, '_toolrun.out.txt'), rep.join('\n') + '\n', 'utf8');
if (bad > 0) {
  process.stderr.write(`_toolrun: ${bad} 项自证失败\n`);
  process.exitCode = 1;
}
