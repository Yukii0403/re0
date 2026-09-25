// _evaldiag.mjs —— VerAs 诊断报告（**只读产物，不调用模型**）
//
// ★ 为什么单独一个脚本、不复用 _evalsum：
//   前一版 _evalsum 有三处统计缺陷（Yukii 2026-09-24 指出）：
//     ① 共识样本（status=common/discussion）与单评分者样本（status=single）**混在一起**算 MAE/MSE
//        —— 它们的可信度不同，混算会得到一个没有意义的平均数；
//     ② Spearman 用**序号秩**（按 gold 大小排序取下标）—— 等于假设所有值互不相同。
//        VerAs 的分数是 0–5 的整数，**并列极多**（例如 D5 有 11 个 0），必须用 **并列取平均秩**；
//     ③ **不完整产物**（total.complete=false / awarded=null / 缺条目）被当成 0 计入分母。
//        —— 缺分不是 0 分。必须单列并从指标里排除。
//
// ★ 本脚本产出的是**诊断**，不是评估结论。原因：
//   - 样本是 20 份分层抽样的一小部分，且**已经被用于诊断**（我看过它们的逐维结果），
//     因此它们**不能再用来验证任何由它们推出的规则**（Yukii 的硬约束）。
//   - 任何规则改动都必须在**未参与诊断的样本**上验证。
//
// ★ 统计口径已收敛到 `_stats.mjs`（唯一出口）。本脚本只做"读产物 + 编诊断叙事"。
//
// 用法：node _evaldiag.mjs --lab pendulum

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  completenessReasons, groupRows, groupMetrics, perDimMetrics, tieFactor, fmt, fmtSigned,
} from './_stats.mjs';
import { mapArtifact } from './veras-map.mjs';

// 向后兼容：旧调用点引用 avgRanks/spearman（本文件内已不再自用）
export { avgRanks, spearman, tieFactor } from './_stats.mjs';

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

// ------------------------------------------------------------------ 读产物（含完整性判定）

const rows = [];
const incomplete = [];
for (const g of gold.reports) {
  let art = null;
  try { art = JSON.parse(await fsp.readFile(path.join(OUT, g.id + '.txt.assessment.json'), 'utf8')); } catch { continue; }
  const pick = id => art.assessments?.find(x => x.rubric_item_id === id) ?? null;

  // ★★ 不完整产物的判定统一走 _stats（缺分不是 0 分）；v0.3 起判定需要 profile（档位分来自等级表）
  const reasons = completenessReasons(art, dims, profile);
  // ★ v0.3：定性结论 → 分数（唯一口径在 veras-map；弃权=null、outside_defined_levels↔0）
  const m = mapArtifact(art, dims, profile, g.dims);

  const rec = {
    id: g.id,
    status: g.status,           // ★ 分组依据：single | common | discussion
    source: g.source,
    gold: g.dims,
    gold_total: g.dims.reduce((a, b) => a + b, 0),
    ta: g.ta_rescaled,
    rater: g.rater_rescaled,
    pred: m.pred,
    judgments: dims.map(id => pick(id)?.judgment ?? null),
    level_statuses: dims.map(id => pick(id)?.level_status ?? null),
    map_states: m.states, map_kinds: m.kinds, map_counts: m.counts,
    outside_ids: m.outside_ids, zero_ids: m.zero_ids, gold0_ids: m.gold0_ids,
    outside_hit_gold0: m.outside_hit_gold0, zero_hit_gold0: m.zero_hit_gold0,
    review: dims.map(id => !!pick(id)?.review?.required),
    review_reasons: dims.flatMap(id => pick(id)?.review?.required_reason_codes ?? []),
    predicted_total: m.total,
    complete: m.counts.abstain === 0,
    incomplete_reasons: reasons,
  };
  if (reasons.length) incomplete.push(rec); else rows.push(rec);
}

// ------------------------------------------------------------------ 分组统计（口径来自 _stats）

const groups = groupRows(rows);

const metrics = rs => (rs.length ? groupMetrics(rs, maxTotal) : null);

const perDim = rs => perDimMetrics(rs, dims);

// ------------------------------------------------------------------ 报告

const f = fmt;   // 兼容旧的短名调用；口径与 _evalsum 完全一致
const L = [];
L.push('=== VerAs 诊断报告（只读产物，未调用模型）===');
L.push(`数据集：${gold.dataset.doi}  lab=${LAB}  满分=${maxTotal}  维度=${dims.length}`);
L.push('');
L.push('★ 这是【诊断】，不是评估结论。样本已被用于诊断，不能再用它们验证由它们推出的规则。');
L.push('★ 统计口径来自 src/_stats.mjs（与 _evalsum 同一份实现）。');
L.push('');
L.push(`--- 样本完整性 ---`);
L.push(`  可用（complete 且 7/7 有分）：${rows.length} 份`);
L.push(`  不完整（已排除，不计入任何指标）：${incomplete.length} 份`);
for (const r of incomplete) L.push(`    ${r.id.padEnd(24)} ${r.incomplete_reasons.join(', ')}`);
L.push('');
L.push('--- 分组（★ 可信贷不同，绝不混算）---');
for (const [k, rs] of Object.entries(groups)) {
  L.push(`  ${k.padEnd(12)} n=${rs.length}${rs.length ? `  gold 均值=${(rs.reduce((s, r) => s + r.gold_total, 0) / rs.length).toFixed(1)}/${maxTotal}  我们=${(rs.reduce((s, r) => s + r.predicted_total, 0) / rs.length).toFixed(1)}/${maxTotal}` : ''}`);
}
L.push('');
L.push('--- 分组 · 总分指标 ---');
L.push('  组                        n   总分MSE   偏置     ρ(我们)  ρ(TA)   ρ(评分者)  送审率');
for (const [k, rs] of Object.entries(groups)) {
  const m = metrics(rs); if (!m) { L.push(`  ${k.padEnd(24)}  —`); continue; }
  L.push(`  ${k.padEnd(24)} ${String(m.n).padStart(2)}   ${f(m.total_mse, 2).padStart(6)}  ${(m.bias >= 0 ? '+' : '') + f(m.bias, 2)}  ${f(m.rho_total).padStart(6)}  ${f(m.rho_ta).padStart(6)}  ${f(m.rho_rater).padStart(8)}   ${(m.review_rate * 100).toFixed(0)}%`);
}
const mAll = metrics(rows);
if (mAll) {
  L.push('  ' + '─'.repeat(86));
  L.push(`  ${'全部（仅供参照，勿引用）'.padEnd(24)} ${String(mAll.n).padStart(2)}   ${f(mAll.total_mse, 2).padStart(6)}  ${(mAll.bias >= 0 ? '+' : '') + f(mAll.bias, 2)}  ${f(mAll.rho_total).padStart(6)}  ${f(mAll.rho_ta).padStart(6)}  ${f(mAll.rho_rater).padStart(8)}   ${(mAll.review_rate * 100).toFixed(0)}%`);
} else {
  L.push('  （无可用样本）');
}
L.push('');
L.push('  ★ ρ(TA) / ρ(评分者) 是【参照线】，不是分数：TA 用的是原课程另一套（更粗的）rubric，');
L.push('    与研究者详细量规不是同一评分工具，因此"更接近 TA"不能当作"更准确"。');
L.push('');
L.push('--- 逐维（分组）---');
for (const [k, rs] of Object.entries(groups)) {
  if (!rs.length) continue;
  L.push(`  〔${k}〕n=${rs.length}`);
  for (const d of perDim(rs)) {
    const dft = (d.pred_mean !== null && d.gold_mean !== null) ? (d.pred_mean - d.gold_mean >= 0 ? '+' : '') + f(d.pred_mean - d.gold_mean, 2) : '—';
    L.push(`    ${d.id.padEnd(4)} MAE=${f(d.mae, 2)}  ρ=${f(d.rho)}  gold=${f(d.gold_mean, 2)}  我们=${f(d.pred_mean, 2)}  差=${dft}  档位 gold=${d.gold_distinct}/我们=${d.pred_distinct}`);
  }
}
L.push('');
L.push('  ★ 逐维 ρ 的读法：n<3 或"我们档位=1"时 ρ 无意义；MAE 在样本少时更可读。');
L.push('');
L.push('--- 并列情况（并列多则 ρ 的可分辨力下降，必须报出来）---');
if (!mAll) L.push('  （无可用样本）');
else {
  L.push(`  gold 总分的并列修正因子 = ${mAll.gold_ties.toFixed(1)}（越大并列越多；完全无并列时 = 0）`);
  L.push(`  gold 总分 distinct=${mAll.rho_total_note.gold_distinct}/${mAll.n}  我们 distinct=${mAll.rho_total_note.pred_distinct}/${mAll.n}`);
  L.push(`  gold 总分取值分布：${JSON.stringify(rows.reduce((a, r) => { a[r.gold_total] = (a[r.gold_total] ?? 0) + 1; return a; }, {}))}`);
  L.push(`  我们总分取值分布：${JSON.stringify(rows.reduce((a, r) => { const k = r.predicted_total ?? 'null'; a[k] = (a[k] ?? 0) + 1; return a; }, {}))}`);
}
L.push('');
L.push('--- 送审原因（全部样本）---');
const rc = {};
for (const r of rows.flatMap(r => r.review_reasons)) rc[r] = (rc[r] ?? 0) + 1;
if (!Object.keys(rc).length) L.push('  （无）');
for (const [k, v] of Object.entries(rc).sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(28)} ${v}`);
L.push('');
L.push('--- 逐样本明细 ---');
L.push('  id                       status      gold  我们   差  逐维 gold | 我们');
for (const r of rows) L.push(`  ${r.id.padEnd(24)} ${r.status.padEnd(10)} ${String(r.gold_total).padStart(3)}/${maxTotal}  ${String(r.predicted_total).padStart(3)}/${maxTotal}  ${String(r.predicted_total - r.gold_total).padStart(3)}  ${r.gold.join('/')} | ${r.pred.join('/')}`);

const out = L.join('\n');
await fsp.mkdir(OUT, { recursive: true });
await fsp.writeFile(path.join(OUT, `diag.${LAB}.json`), JSON.stringify({
  kind: 'diagnostic_not_conclusion',
  warning: '本文件是诊断快照。样本已用于诊断，不得用于验证由这些样本推出的规则。',
  dataset: gold.dataset, maxTotal, dims,
  usable: rows, excluded_incomplete: incomplete,
  metrics: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, metrics(v)])),
  metrics_all_only_for_reference: mAll,
}, null, 2) + '\n', 'utf8');
await fsp.writeFile(path.join(here, `_evaldiag.${LAB}.out.txt`), out + '\n', 'utf8');
console.log(out);
