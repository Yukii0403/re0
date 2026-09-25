// _mkexample.mjs —— 生成 design/evidence-candidates.example.json
//
// 这版示例对着**真实文件**跑：fixtures/report.pdf（4 页真 PDF，L1 已能解析）
//   · 偏移 / source_ref / 上下文 / 资产存在性 —— 全部真实验证
//   · 重复引用的绑定用真实数据演示（那段套话在原文里出现多次）
//
// 依赖：
//   design/canonical-rubric.example.json  （先跑 _mkrubric.mjs）
//   design/retrieval-plan.example.json    （先跑 _mkplan.mjs）
//   fixtures/out/report.pdf.{txt,index.json} + report.pdf.p003.png
//   —— 后两者若不存在，本脚本会自动调 L1 与 page.mjs 生成
//
// 说明：示例是**契约的自洽样板**，不是一次完整检索的日志。规则/结构通道的归因由真实规则算出；
// 语义通道的命中是手工给定的（模拟模型返回）。真实跑一遍会因高召回设计而产出远多于样本的 span。
// 用法: node _mkexample.mjs

import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RULES, run as runL1 } from './l1.mjs';
import { renderPage } from './page.mjs';
import { bindQuote, allOccurrences, entryCovering } from './quote-binding.mjs';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');
const fx = path.join(root, 'fixtures');
const outDir = path.join(fx, 'out');

const CTX = 14;
const BANNED = ['充分', '不足', '欠缺', '完整', '合理', '准确', '错误', '优秀', '遗漏',
  '没有给出', '缺少', '符合要求', '达标', '未达标', '恰当', '欠佳', '正确地', '不严谨'];

// ---------------------------------------------------------------- 准备真实材料
const PDF = path.join(fx, 'report.pdf');
const TXT = path.join(outDir, 'report.pdf.txt');
const IDX = path.join(outDir, 'report.pdf.index.json');
const PNG = path.join(outDir, 'report.pdf.p003.png');

await fsp.mkdir(outDir, { recursive: true });
if (!(await exists(TXT)) || !(await exists(IDX))) await runL1(PDF, outDir);
if (!(await exists(PNG))) await renderPage(PDF, 3, PNG, 2);

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

const full = await fsp.readFile(TXT, 'utf8');
const idx = JSON.parse(await fsp.readFile(IDX, 'utf8'));
const entries = idx.entries;
const cr = JSON.parse(await fsp.readFile(path.join(design, 'canonical-rubric.example.json'), 'utf8'));
const planBody = await fsp.readFile(path.join(design, 'retrieval-plan.example.json'), 'utf8');
const plan = JSON.parse(planBody);
const planSha = createHash('sha256').update(Buffer.from(planBody, 'utf8')).digest('hex');

// ---------------------------------------------------- 绑定：把 quote 绑到原文
// pred 用于显式挑出「要绑到哪一处」；pred 明明给了却匹配不上，直接抛错而不是静默回退 ——
// 静默回退正是这个 bug 最初没被发现的原因。
function bindAt(quote, pred) {
  const occ = allOccurrences(full, quote);
  if (!occ.length) throw new Error('引用串在原文中不存在: ' + JSON.stringify(quote.slice(0, 30)));
  if (pred) {
    for (const o of occ) {
      const e = entryCovering(entries, o, o + quote.length);
      if (e && pred(e)) return { entryHint: e.id, entry: e, occurrence: o };
    }
    throw new Error(`pred 没匹配到任何覆盖该引用的条目（引用出现 ${occ.length} 次）: ${JSON.stringify(quote.slice(0, 24))}`);
  }
  const e = entryCovering(entries, occ[0], occ[0] + quote.length);
  return { entryHint: e?.id ?? null, entry: e, occurrence: occ[0] };
}

function makeSpan(quote, pred, { needsSemantic = false, matchType = 'verbatim', cursor = 0 } = {}) {
  const { entryHint } = bindAt(quote, pred);
  const b = bindQuote(full, quote, { entryHint, entries, cursor });
  if (!b.ok) throw new Error('引用串在原文中找不到（模型改了字）: ' + JSON.stringify(quote));
  const e = entryCovering(entries, b.start, b.end);
  return {
    span: {
      quote,
      source_ref: { file: idx.doc.name, sha256: idx.doc.sha256, page: e?.page ?? null, entry: e?.id ?? null },
      offset: { start: b.start, end: b.end },
      context: { before: full.slice(Math.max(0, b.start - CTX), b.start), after: full.slice(b.end, b.end + CTX) },
      match_type: matchType,
      found_by: channelsOf(quote, e?.type ?? null, needsSemantic),
      binding: { mode: b.mode, occurrences: b.occurrences, ...(b.ambiguous ? { ambiguous: true } : {}) },
    },
    binding: b,
  };
}

function channelsOf(quote, entryType, needsSemantic) {
  const t = quote.trim();
  const out = [];
  const numbered = /^[图表式]\s*[0-9]/.test(t);
  if (numbered) out.push('rule:numbering');
  if (RULES.code.test(t)) out.push('rule:keyword');
  if (/\d/.test(t) && !numbered) out.push('rule:numeric');
  if (/(相比|相较|对比|优于|高于|低于|更好|更快|提升|下降|增加|减少|差异)/.test(t)) out.push('rule:relation');
  if (entryType && ['table', 'figure', 'formula', 'code'].includes(entryType)) out.push('structure:' + entryType);
  if (needsSemantic) out.push('llm:semantic');
  return out.length ? out : ['llm:semantic'];
}

// ---------------------------------------------------------------- 证据 bundle
const Q = {
  figCap: '图 3 不同学习率下的验证损失曲线',
  tabCap: '表 4 各模块消融对比',
  pointsToFig: '三组学习率下验证损失的下降曲线如图所示。',
  tableBody: 'baseline 0.812 6.4\n+ attention 0.847 7.1\n+ attention + 数据增强 0.861 9.8',
  conclusion: '可以看出注意力模块带来约 3.5 个百分点的提升，而数据增强进一步提升至 86.1%， 但训练时长增加约',
  filler: '此外，学习率预热策略在训练初期带来了更稳定的梯度范数，但对最终精度影响有限。 我们建议在算力',
};

const specs = [
  {
    rubric_item_id: 'R2.1', facet_id: 'F2', note: '指向图的句子 + 图注 + 原始页图，共同构成趋势类证据',
    spans: [
      makeSpan(Q.pointsToFig, e => e.type === 'paragraph' && e.page === 1, { matchType: 'implicit', needsSemantic: true }).span,
      makeSpan(Q.figCap, e => e.type === 'figure', { matchType: 'implicit', needsSemantic: true }).span,
    ],
    asset_refs: [
      { kind: 'page_render', ref: path.relative(root, PNG).split(path.sep).join('/'), page: 3, note: '第 3 页整页渲染 —— 图形内容只能靠它来读' },
    ],
  },
  {
    rubric_item_id: 'R2.1', facet_id: 'F1', note: '表体里的实际数值',
    spans: [makeSpan(Q.tableBody, e => e.type === 'paragraph', { matchType: 'verbatim', needsSemantic: true }).span],
  },
  {
    rubric_item_id: 'R2.2', facet_id: 'F1', note: '图的编号与标题',
    spans: [makeSpan(Q.figCap, e => e.type === 'figure', { matchType: 'verbatim' }).span],
  },
  {
    rubric_item_id: 'R2.2', facet_id: 'F2', note: '表的编号与标题',
    spans: [makeSpan(Q.tabCap, e => e.type === 'table', { matchType: 'verbatim' }).span],
  },
  {
    rubric_item_id: 'R2.1', facet_id: 'F6', note: '由数据得出的结论性表述',
    spans: [makeSpan(Q.conclusion, e => e.type === 'paragraph' && e.page === 2, { matchType: 'verbatim', needsSemantic: true }).span],
  },
  {
    rubric_item_id: 'R3.2', facet_id: 'F2', note: '改进方向：同一句话在原文里出现多次，按 L1 条目提示绑定到第 2 页那一处',
    spans: [makeSpan(Q.filler, e => e.type === 'paragraph' && e.page === 2, { matchType: 'implicit', needsSemantic: true }).span],
  },
  {
    rubric_item_id: 'R3.2', facet_id: 'F2', note: '同样的引用串，绑定到第 4 页那一处 —— 这是修复后的行为',
    spans: [makeSpan(Q.filler, e => e.type === 'paragraph' && e.page === 4, { matchType: 'implicit', needsSemantic: true }).span],
  },
  {
    rubric_item_id: 'R2.1', facet_id: 'F1',
    note: '单行的表体行：值与其行标签在同一行内相邻 —— L3 只有在这种「结构化」的 span 上才允许判定',
    spans: [
      makeSpan('baseline 0.812 6.4', e => e.type === 'paragraph', { matchType: 'verbatim', needsSemantic: true }).span,
      makeSpan('+ attention 0.847 7.1', e => e.type === 'paragraph', { matchType: 'verbatim', needsSemantic: true }).span,
      makeSpan('+ attention + 数据增强 0.861 9.8', e => e.type === 'paragraph', { matchType: 'verbatim', needsSemantic: true }).span,
    ],
  },
  {
    rubric_item_id: 'R2.1', facet_id: 'F1',
    note: '表格列头行：它声明了各列的量纲（验证准确率→ratio；训练时长(min)→duration）。L3 用它作为量纲的额外依据',
    spans: [
      makeSpan('配置 验证准确率 训练时长(min)', e => e.type === 'paragraph' && e.page === 1, { matchType: 'verbatim', needsSemantic: true }).span,
    ],
  },
];

const evidence = specs.map((s, i) => ({
  id: 'ev' + String(i + 1).padStart(4, '0'),
  rubric_item_id: s.rubric_item_id,
  facet_id: s.facet_id,
  spans: s.spans,
  ...(s.asset_refs ? { asset_refs: s.asset_refs } : {}),
  note: s.note,
}));

// ---------------------------------------------------------------- 诊断
const facetCoverage = plan.items.flatMap(item => item.facets.map(f => {
  const own = evidence.filter(e => e.rubric_item_id === item.rubric_item_id && e.facet_id === f.id);
  const spans = own.flatMap(e => e.spans);
  const ran = new Set([...f.channels, ...spans.flatMap(s => s.found_by)]);
  const ch = {};
  for (const name of [...ran].sort()) ch[name] = spans.filter(s => s.found_by.includes(name)).length;
  return {
    rubric_item_id: item.rubric_item_id,
    facet_id: f.id,
    form: f.form,
    modality: f.modality,
    channels: ch,
    hits: spans.length,
    status: 'complete',
    outcome: spans.length ? 'located' : 'no_candidate',
    reason: null,
  };
}));

const scanRange = `${entries[0].id}-${entries[entries.length - 1].id}`;
const rank = { complete: 0, partial: 1, source_unavailable: 2, channel_error: 3 };
const rubricItemSummary = plan.items.map(item => {
  const own = evidence.filter(e => e.rubric_item_id === item.rubric_item_id);
  const fc = facetCoverage.filter(f => f.rubric_item_id === item.rubric_item_id);
  const worst = fc.reduce((w, f) => (rank[f.status] > rank[w] ? f.status : w), 'complete');
  const outcome = fc.some(f => f.outcome === 'undetermined') ? 'undetermined'
    : fc.some(f => f.outcome === 'located') ? 'located' : 'no_candidate';
  return {
    rubric_item_id: item.rubric_item_id,
    candidates: own.length,
    status: worst,
    outcome,
    scanned: [scanRange],
    notes: own.length ? [] : ['未找到候选'],
  };
});

// advisory_lint：只扫模型生成的自由文本字段
const scannedFields = ['evidence[].note', 'evidence[].asset_refs[].note'];
const lintTargets = evidence.flatMap(e => [
  { path: `evidence.${e.id}.note`, text: e.note ?? '' },
  ...(e.asset_refs ?? []).map((a, i) => ({ path: `evidence.${e.id}.asset_refs.${i}.note`, text: a.note ?? '' })),
]);
const violations = [];
for (const { path: p, text } of lintTargets) {
  for (const w of BANNED) if (text.includes(w)) violations.push({ path: p, word: w, text });
}

const out = {
  authority: {
    scoring_authority: 'rubric',
    rubric_immutable: true,
    rubric_sha256: cr.source.sha256,
    plan_participates_in_scoring: false,
    notes: '评分权威只有教师上传的原始 rubric；retrieval plan 与候选证据都不参与评分',
  },
  doc: {
    name: idx.doc.name,
    sha256: idx.doc.sha256,
    text_file: path.basename(TXT),
    index_file: path.basename(IDX),
    chars: idx.doc.chars,
  },
  rubric: {
    rubric_id: cr.rubric_id,
    sha256: cr.source.sha256,
    file: 'canonical-rubric.example.json',
    frozen_at: cr.frozen_at,
  },
  retrieval_plan: {
    plan_id: plan.plan_id,
    version: plan.version,
    batch_id: plan.batch_id,
    sha256: planSha,
    file: 'retrieval-plan.example.json',
    pinned: plan.pinned,
  },
  evidence,
  diagnostics: {
    diagnostic_only: true,
    notice: '这是契约的自洽样板，不是一次完整检索的日志：规则/结构通道的归因由真实规则算出，语义通道的命中为模拟返回。'
      + '真实跑一遍会因高召回设计产出远多于本样本的 span，且 status 可能出现 partial / source_unavailable / channel_error。'
      + 'facet coverage 不等于 evidence recall，绝不参与评分 —— evidence recall 只在评测环节用人工 gold set 计算。'
      + 'channels 是各通道命中数（同一 span 可被多通道命中，故不可相加）；hits 是去重后的 span 数。',
    facet_coverage: facetCoverage,
    rubric_item_summary: rubricItemSummary,
  },
  advisory_lint: {
    advisory: true,
    scanned_fields: scannedFields,
    passed: violations.length === 0,
    notice: '只是提示：passed=false 不阻断产物写出，也不改变任何判定。'
      + '本次它命中的是「验证准确率」里的「准确」—— 一个完全合法的技术术语，'
      + '这正是禁用词表不能当主安全机制的原因（主机制是 schema 封闭 + 无评分字段）。',
    banned_words: BANNED,
    violations,
  },
};

const body = JSON.stringify(out, null, 2);
await fsp.writeFile(path.join(design, 'evidence-candidates.example.json'), body, 'utf8');

// ------------------------------------------------------------------ 自证
const schema = JSON.parse(await fsp.readFile(path.join(design, 'evidence-candidates.schema.json'), 'utf8'));
const vr = validate(schema, out);

const allKeys = (o, acc = []) => {
  if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
  return acc;
};
const allSpans = evidence.flatMap(e => e.spans);
const dupSpans = evidence.filter(e => e.spans.some(s => s.binding.occurrences > 1));
const twoBindings = dupSpans.length >= 2 &&
  new Set(dupSpans.map(e => e.spans[0].offset.start)).size === dupSpans.length;

// 对照：如果还用旧的 indexOf(首次出现)，这两条会绑到同一处
const naive = new Set(dupSpans.map(e => full.indexOf(e.spans[0].quote)).map(x => String(x)));

const checks = [
  ['示例通过真正的 schema 校验', vr.ok, true],
  ['每条 span 的 quote 都能按 source_ref + offset 逐字切回原文',
    allSpans.every(s => full.slice(s.offset.start, s.offset.end) === s.quote), true],
  ['source_ref.sha256 就是这份作业原件',
    allSpans.every(s => s.source_ref.sha256 === idx.doc.sha256 && s.source_ref.file === idx.doc.name), true],
  ['source_ref.entry 确实覆盖该 span 范围',
    allSpans.every(s => {
      const e = entries.find(x => x.id === s.source_ref.entry);
      return !!e && s.offset.start >= e.start && s.offset.end <= e.end;
    }), true],
  ['原始上下文确实切自原文',
    allSpans.every(s => full.slice(Math.max(0, s.offset.start - s.context.before.length), s.offset.start) === s.context.before), true],
  ['★ 重复引用被绑到不同位置（用旧的 indexOf 会全绑到同一处）',
    twoBindings && naive.size === 1, true],
  ['每条多 span bundle 的 span 数量 ≥ 1 且不止一条 bundle 含多个 span',
    evidence.every(e => e.spans.length >= 1) && evidence.some(e => e.spans.length > 1), true],
  ['asset_refs 指向的资产在磁盘上真实存在',
    evidence.flatMap(e => e.asset_refs ?? []).every(a => existsSync(path.join(root, a.ref))), true],
  ['四处哈希一致（authority / rubric 引用 / plan 引用 / canonical 原件）',
    out.authority.rubric_sha256 === cr.source.sha256 && out.rubric.sha256 === cr.source.sha256, true],
  ['plan 只引用不复制（字段集合固定）',
    Object.keys(out.retrieval_plan).sort().join(',') === 'batch_id,file,pinned,plan_id,sha256,version', true],
  ['plan 引用绑定到 plan 文件的真实哈希',
    out.retrieval_plan.sha256 === planSha, true],
  ['plan 覆盖 canonical rubric 的所有条目',
    cr.items.every(it => plan.items.some(p => p.rubric_item_id === it.id)), true],
  ['每个 facet 都有诊断记录（含 0 命中的）',
    facetCoverage.length === plan.items.reduce((n, s) => n + s.facets.length, 0), true],
  ['status 与 outcome 的取值都在枚举内',
    facetCoverage.every(f => ['complete', 'partial', 'source_unavailable', 'channel_error'].includes(f.status) &&
      ['located', 'no_candidate', 'undetermined'].includes(f.outcome)), true],
  ['产物任何层级都不存在 recall 字段',
    allKeys(out).every(k => !/recall/i.test(k)), true],
  ['证据条目字段集合固定（结构上无法产生评分字段）',
    evidence.every(e => Object.keys(e).every(k => ['id', 'rubric_item_id', 'facet_id', 'spans', 'asset_refs', 'note'].includes(k))), true],
  ['advisory_lint 只扫模型生成的字段（不含 quote / context）',
    out.advisory_lint.scanned_fields.every(f => !/quote|context|source_ref/.test(f)), true],
  ['★ advisory_lint 只是提示、不阻断：命中也不影响产物写出（advisory 恒为 true）',
    out.advisory_lint.advisory === true && typeof out.advisory_lint.passed === 'boolean', true],
  ['★ advisory_lint 会误伤合法技术术语（「验证准确率」命中「准确」）—— 活证据，所以它不能当硬闸',
    out.advisory_lint.violations.some(v => v.word === '准确') && out.advisory_lint.passed === false, true],
  ['advisory_lint 能抓到越界表述',
    BANNED.some(w => '这里缺少必要的对比实验，结论不够完整。'.includes(w)), true],
];

const rep = [];
rep.push(`基于真实文件 fixtures/report.pdf  (${idx.doc.chars} 字符, ${entries.length} 条目, ${idx.doc.line_coverage} 行覆盖)`);
rep.push(`rubric ${cr.items.length} 条 · plan rp_lab2 v${plan.version} · 证据 ${evidence.length} 条 bundle / ${allSpans.length} 个 span`);
rep.push(`产出 design/evidence-candidates.example.json  (${body.length} 字节)`);
rep.push('');
rep.push('--- 重复引用的绑定（本次修复的重点）---');
rep.push(`  该引用串在原文里一共出现 ${allSpans.find(s => s.binding.occurrences > 1)?.binding.occurrences ?? 0} 次`);
for (const e of dupSpans) {
  const s = e.spans[0];
  rep.push(`  ${e.id} ${e.rubric_item_id}·${e.facet_id}  offset=${s.offset.start}-${s.offset.end}  mode=${s.binding.mode}  entry=${s.source_ref.entry}  page=${s.source_ref.page}`);
}
rep.push(`  旧实现 indexOf(首次出现) 会得到的偏移：${[...naive].join(', ')}  ← 全一样，即绑错`);
rep.push('');
rep.push('--- 证据 bundle ---');
for (const e of evidence) {
  rep.push(`  ${e.id} ${e.rubric_item_id}·${e.facet_id}  spans=${e.spans.length}${e.asset_refs ? ` assets=${e.asset_refs.length}` : ''}`);
  for (const s of e.spans) {
    rep.push(`      [${String(s.offset.start).padStart(5)}-${String(s.offset.end).padStart(5)}] p${s.source_ref.page ?? '-'} ${String(s.match_type).padEnd(9)} ${JSON.stringify(s.quote.slice(0, 30))}`);
    rep.push(`              通道=${JSON.stringify(s.found_by)}  绑定=${s.binding.mode}/${s.binding.occurrences}次`);
  }
  for (const a of e.asset_refs ?? []) rep.push(`      asset ${a.kind}: ${a.ref}`);
}
rep.push('');
rep.push('--- 诊断（只作诊断，不是 recall）---');
const stat = new Map();
for (const f of facetCoverage) stat.set(f.status, (stat.get(f.status) || 0) + 1);
rep.push(`  status 分布：${[...stat].map(([k, n]) => `${k}:${n}`).join('  ')}`);
for (const f of facetCoverage.filter(f => !f.hits)) {
  rep.push(`  ${f.rubric_item_id}·${f.facet_id} [${String(f.form).padEnd(9)}] hits=0 ${f.outcome}`);
}
rep.push('');
rep.push('--- advisory_lint（只是提示，不阻断产物）---');
rep.push(`  passed=${out.advisory_lint.passed}  命中 ${violations.length} 处：${violations.map(v => `${v.word}@${v.path}`).join(', ') || '无'}`);
rep.push('  ↑ 本次命中「验证准确率」里的「准确」：合法技术术语被误伤 —— 禁用它当硬闸的理由，不是遗憾。');
rep.push('');
rep.push('--- 自证 ---');
let bad = 0;
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok && name.includes('schema')) for (const e of vr.errors.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
}
rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

await fsp.writeFile(path.join(here, '_mkexample.out.txt'), rep.join('\n') + '\n', 'utf8');
if (bad > 0) {
  process.stderr.write(`_mkexample: ${bad} 项自证失败\n`);
  process.exitCode = 1;
}
