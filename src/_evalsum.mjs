// _evalsum.mjs —— 只做汇总：读 fixtures/veras/out/*.assessment.json 算指标，不调用任何模型
//
// 为什么单独拆出来：20 份评测要跑 1 小时，中途会被沙箱/会话打断（实测停在 7/20）。
// 汇总必须能**离线独立重算**，否则每次断线都得把已花掉的钱再烧一遍。
//
// ★ 统计口径全部来自 `_stats.mjs`（唯一出口）。本脚本只负责**读产物 + 排版**。
//   修掉的旧缺陷：① 序号秩 Spearman → 并列平均秩；② 单/共识样本混算 → 分组；③ 缺分当 0 → 排除。
//
// 用法：node _evalsum.mjs --lab pendulum

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  completenessReasons, groupRows, GROUP_LABEL, groupMetrics, perDimMetrics, exactMatch, fmt, fmtSigned,
} from './_stats.mjs';
import { mapArtifact } from './veras-map.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = argOf('--lab', 'pendulum');
const VDIR = path.join(root, 'fixtures/veras');
const OUT = path.join(VDIR, 'out');

const gold = JSON.parse(await fsp.readFile(path.join(VDIR, `gold.${LAB}.json`), 'utf8'));
const profile = JSON.parse(await fsp.readFile(path.join(root, 'design', `rubric-assessment-profile.veras-${LAB}.json`), 'utf8'));
const dims = profile.items.filter(p => p.scorable).map(p => p.rubric_item_id);
const maxTotal = dims.reduce((s, id) => s + profile.items.find(p => p.rubric_item_id === id).scoring_strategy.max, 0);

const rows = [];
const missing = [];
const incomplete = [];
for (const g of gold.reports) {
  let art = null;
  try { art = JSON.parse(await fsp.readFile(path.join(OUT, g.id + '.txt.assessment.json'), 'utf8')); }
  catch { missing.push(g.id); continue; }
  const pick = id => art.assessments?.find(x => x.rubric_item_id === id) ?? null;
  // ★ v0.3：定性结论 → 分数，口径来自唯一的 `veras-map.mjs`（弃权=null；outside_defined_levels↔0）
  const m = mapArtifact(art, dims, profile, g.dims);
  const rec = {
    id: g.id,
    status: g.status,                       // ★ 分组依据
    source: g.source,
    gold: g.dims,
    gold_total: g.dims.reduce((a, b) => a + b, 0),
    ta: g.ta_rescaled,
    rater: g.rater_rescaled,
    pred: m.pred,
    predicted_total: m.total,
    complete: m.counts.abstain === 0,
    judgments: dims.map(id => pick(id)?.judgment ?? null),
    level_statuses: dims.map(id => pick(id)?.level_status ?? null),
    map_states: m.states, map_kinds: m.kinds, map_counts: m.counts,
    outside_ids: m.outside_ids, zero_ids: m.zero_ids, gold0_ids: m.gold0_ids,
    outside_hit_gold0: m.outside_hit_gold0, zero_hit_gold0: m.zero_hit_gold0,
    review: dims.map(id => !!pick(id)?.review?.required),
    review_reasons: dims.flatMap(id => pick(id)?.review?.required_reason_codes ?? []),
    dropped: dims.reduce((s, id) => s + Object.values(pick(id)?.diagnostics ?? {}).filter(Array.isArray).reduce((a, v) => a + v.length, 0), 0),
    leaves: art.assessments?.length ?? 0,
  };
  rec.incomplete_reasons = completenessReasons(art, dims, profile);
  if (rec.incomplete_reasons.length) incomplete.push(rec); else rows.push(rec);
}

const groups = groupRows(rows);
const mAll = rows.length ? groupMetrics(rows, maxTotal) : null;

const lines = [];
lines.push('=== VerAs 评测汇总（离线重算，不调用模型）===');
lines.push(`lab=${LAB}   已产出=${rows.length + incomplete.length}/${gold.reports.length}   可用=${rows.length}   不完整=${incomplete.length}   未产出=${missing.length}   维度=${dims.length}   满分=${maxTotal}`);
if (missing.length) lines.push(`未产出：${missing.join(', ')}`);
lines.push('');
lines.push('★ 缺口三条硬规则：① 分组（single 与 common/discussion 不混算）② 并列取平均秩 ③ 缺分不当 0 分。');
lines.push('');

lines.push('--- 不完整产物（★ 已从全部指标中排除，不是 0 分）---');
if (!incomplete.length) lines.push('  （无）');
for (const r of incomplete) lines.push(`  ${r.id.padEnd(24)} ${r.status.padEnd(10)} ${r.incomplete_reasons.join(', ')}`);
lines.push('');

lines.push('--- 分组（★ 可信贷不同，绝不混算）---');
for (const [k, rs] of Object.entries(groups)) {
  const gl = rs.length ? `gold 均值=${fmt(rs.reduce((s, r) => s + r.gold_total, 0) / rs.length, 1)}/${maxTotal}  我们=${fmt(rs.reduce((s, r) => s + r.predicted_total, 0) / rs.length, 1)}/${maxTotal}` : '';
  lines.push(`  ${k.padEnd(11)} n=${String(rs.length).padStart(2)}  ${gl}`);
}
lines.push('');

lines.push('--- 分组 · 总分指标 ---');
lines.push('  组                 n   总分MSE   偏置     ρ(我们)  ρ(TA)   ρ(评分者)  逐维MAE  送审率');
for (const [k, rs] of Object.entries(groups)) {
  if (!rs.length) { lines.push(`  ${k.padEnd(18)}  —`); continue; }
  const m = groupMetrics(rs, maxTotal);
  lines.push(`  ${k.padEnd(18)} ${String(m.n).padStart(2)}   ${fmt(m.total_mse, 2).padStart(6)}  ${fmtSigned(m.bias).padStart(6)}  ${fmt(m.rho_total).padStart(6)}  ${fmt(m.rho_ta).padStart(6)}  ${fmt(m.rho_rater).padStart(8)}  ${fmt(m.dim_mae, 2).padStart(6)}  ${(m.review_rate * 100).toFixed(0)}%`);
}
if (mAll) {
  lines.push('  ' + '─'.repeat(86));
  lines.push(`  ${'全部（仅供参照，勿引用）'.padEnd(18)} ${String(mAll.n).padStart(2)}   ${fmt(mAll.total_mse, 2).padStart(6)}  ${fmtSigned(mAll.bias).padStart(6)}  ${fmt(mAll.rho_total).padStart(6)}  ${fmt(mAll.rho_ta).padStart(6)}  ${fmt(mAll.rho_rater).padStart(8)}  ${fmt(mAll.dim_mae, 2).padStart(6)}  ${(mAll.review_rate * 100).toFixed(0)}%`);
}
lines.push('');
lines.push('  ★ ρ(TA) / ρ(评分者) 是【参照线】，不是分数：TA 用的是原课程另一套（更粗的）rubric，');
lines.push('    与研究者详细量规不是同一评分工具 →「更接近 TA」**不能**当作「更准确」。');
lines.push('  ★ ρ 必须在"有分辨力的档位数"上读：见下节 gold/pred distinct。distinct=1 时 ρ 无意义。');
lines.push('');

lines.push('--- 并列与分辨力（★ ρ 的可分辨力上限）---');
if (!mAll) lines.push('  （无可用样本）');
else {
  lines.push(`  全部：gold 总分 distinct=${mAll.rho_total_note.gold_distinct}/${mAll.n}  我们 distinct=${mAll.rho_total_note.pred_distinct}/${mAll.n}  gold 并列因子=${mAll.gold_ties.toFixed(1)}  我们并列因子=${mAll.pred_ties.toFixed(1)}`);
  lines.push(`  gold 总分分布：${JSON.stringify(rows.reduce((a, r) => { a[r.gold_total] = (a[r.gold_total] ?? 0) + 1; return a; }, {}))}`);
  lines.push(`  我们总分分布：${JSON.stringify(rows.reduce((a, r) => { const k = r.predicted_total ?? 'null'; a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
  const em = exactMatch(rows, dims);
  lines.push(`  维度级精确命中：${em.hit}/${em.tot}（${(em.rate * 100).toFixed(1)}%）`);
}
lines.push('');

lines.push('--- 逐维（分组）---');
lines.push('  〔组〕 维      n   MAE    ρ     gold均值 我们均值  差     gold档位 我们档位');
for (const [k, rs] of Object.entries(groups)) {
  if (!rs.length) continue;
  lines.push(`  〔${GROUP_LABEL[k]}〕n=${rs.length}`);
  for (const d of perDimMetrics(rs, dims)) {
    const diff = (d.pred_mean !== null && d.gold_mean !== null) ? fmtSigned(d.pred_mean - d.gold_mean) : '—';
    lines.push(`      ${d.id.padEnd(5)} ${String(d.n).padStart(2)}  ${fmt(d.mae, 2).padStart(5)}  ${fmt(d.rho).padStart(5)}  ${fmt(d.gold_mean, 2).padStart(6)}  ${fmt(d.pred_mean, 2).padStart(7)}  ${diff.padStart(5)}   ${String(d.gold_distinct).padStart(4)}   ${String(d.pred_distinct).padStart(5)}`);
  }
}
lines.push('');
lines.push('  ★ 逐维 ρ 的三条读法：① n<3 时 ρ 无意义（显示 —）；② 我们档位=1（全给同一个分）时 ρ 无意义；');
lines.push('    ③ gold 档位少 → ρ 本身就不稳。MAE 在样本少时比 ρ 更可读。');
lines.push('');

lines.push('--- 三方对照（归一化到满分）---');
lines.push('   id                       status      gold    我们     TA     评分者');
for (const r of rows) {
  lines.push(`   ${r.id.padEnd(24)} ${String(r.status).padEnd(10)}  ${fmt(r.gold_total / maxTotal, 2)}   ${fmt(r.predicted_total / maxTotal, 2)}   ${fmt(r.ta, 2)}   ${fmt(r.rater, 2)}`);
}
lines.push('');

lines.push('--- 逐样本明细 ---');
lines.push('  id                       status     gold  我们   差  逐维 gold | 我们');
for (const r of rows) {
  lines.push(`  ${r.id.padEnd(24)} ${String(r.status).padEnd(10)} ${String(r.gold_total).padStart(3)}/${maxTotal} ${String(r.predicted_total).padStart(3)}/${maxTotal} ${String(r.predicted_total - r.gold_total).padStart(3)}  ${r.gold.join('/')} | ${r.pred.join('/')}`);
}
lines.push('');
lines.push('--- 送审原因分布 ---');
const counts = {};
for (const c of rows.flatMap(r => r.review_reasons)) counts[c] = (counts[c] ?? 0) + 1;
if (!Object.keys(counts).length) lines.push('  （无）');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) lines.push(`  ${k.padEnd(30)} ${v}`);

const out = lines.join('\n');
await fsp.mkdir(OUT, { recursive: true });
await fsp.writeFile(path.join(here, `_evalsum.${LAB}.out.txt`), out + '\n', 'utf8');
await fsp.writeFile(path.join(OUT, `evalsum.${LAB}.json`), JSON.stringify({
  lab: LAB, produced: rows.length + incomplete.length, usable: rows.length, total: gold.reports.length, maxTotal, dims,
  rows, excluded_incomplete: incomplete, missing,
  // ★ 指标只在组内：绝不提供"全部混算"作为可直接引用的结果
  metrics: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length ? groupMetrics(v, maxTotal) : null])),
  metrics_all_only_for_reference: mAll,
}, null, 2) + '\n', 'utf8');
console.log(out);
