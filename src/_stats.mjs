// _stats.mjs —— VerAs 评测的**唯一**统计口径（三个脚本共用这一份）
//
// ★ 为什么必须只有一份（Yukii 2026-09-24）：
//   之前 _evalsum / _evaldiag / _evalveras 各写一套指标，同一批数据算出不同的数
//   （例如 ρ 一个用并列平均秩、一个用序号秩），"三份报告互相打架"本身就是缺陷。
//   报告数字必须与实现一一对应 —— 因此统计只有这一处出口。
//
// ★ 三条硬规则（来自 Yukii 对前一版的三处纠正）：
//   ① **分组**：`common` / `discussion`（多评分者 / 小组共识）与 `single`（单评分者）
//      可信贷不同，**绝不混算**。混算出的平均数没有意义。
//   ② **并列取平均秩**：VerAs 分数是 0–5 整数，并列极多。按排序下标取秩 = 假设无并列 = 错。
//   ③ **缺分不是 0 分**：`complete=false` / `awarded=null` / 缺条目 → 单列并从指标里**排除**。

// ------------------------------------------------------------------ 秩与相关

// 并列取平均秩（tie-corrected average ranks，秩从 1 起）
export function avgRanks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

// Spearman ρ（分子分母用同一套并列平均秩）。n<3 → null（两个点必共线，算出来没有信息）
export function spearman(xs, ys) {
  if (!xs || xs.length < 3) return null;
  if (xs.length !== ys.length) throw new Error('spearman: 长度不一致');
  if (xs.some(v => typeof v !== 'number') || ys.some(v => typeof v !== 'number'))
    throw new Error('spearman: 含非数值（调用方应先剔除不完整样本）');
  const rx = avgRanks(xs), ry = avgRanks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

// 并列修正因子 Σ(t³-t)/12。越大并列越多 → ρ 的可分辨力越低，**必须报出来**。
export const tieFactor = arr => {
  const cnt = {};
  for (const v of arr) cnt[v] = (cnt[v] ?? 0) + 1;
  return Object.values(cnt).reduce((s, t) => s + (t ** 3 - t), 0) / 12;
};

// 秩的**有效分辨力**：ρ 至多只能在这个粒度上排序。并列越多 → 有效档位越少。
// = 不同取值的个数。报出来才不会被一个"看着还行"的 ρ 骗过去（R1 全是 4 → =1 → ρ 无意义）。
export const distinctCount = arr => new Set(arr).size;

// ------------------------------------------------------------------ 完整性判定

// 判定一份 L4 产物是否**可用于总分指标**。返回原因列表；空数组 = 可用。
// ★★ 2026-09-24（v0.3）：实现搬到 `veras-map.mjs`（唯一的映射口径），这里只 re-export，
//   保持"统计口径只从 `_stats` 出"的既有约定不变。
//   为什么必须换：v0.3 起产物里**没有 `score.awarded` / `aggregation.total.awarded`** 了，
//   旧判据会把这批产物全判成"不完整"。新判据 = "每个维度都能映射出分数"
//   （弃权 → 不可用但不当 0；`outside_defined_levels` → 映射为 0，属有效判定）。
//   ★ 签名多一个 `profile`：levels 的档位分要从 profile 的等级表里取。
export { completenessReasonsV03 as completenessReasons } from './veras-map.mjs';

// ------------------------------------------------------------------ 分组

// ★ 分组是**强制**的：可信度不同就不能平均。
export const GROUP_OF = { single: 'single', common: 'common', discussion: 'discussion' };
export const GROUP_LABEL = {
  single: 'single（单评分者，噪声更大）',
  common: 'common（多评分者多数票）',
  discussion: 'discussion（小组共识）',
};
export const groupRows = rows => {
  const g = { single: [], common: [], discussion: [] };
  for (const r of rows) (g[r.status] ?? (g[r.status] = [])).push(r);
  return g;
};

// ------------------------------------------------------------------ 指标

// 组内指标。**只接受已通过 completenessReasons 的样本**（predicted_total 必为数值）。
// maxTotal 仅用于把 ta/rater 的 0–1 折算回原始刻度以便与 gold 同尺度比较。
export function groupMetrics(rs, maxTotal) {
  if (!rs.length) return null;
  const bad = rs.filter(r => typeof r.predicted_total !== 'number');
  if (bad.length) throw new Error(`groupMetrics: 传入不完整样本 ${bad.map(r => r.id).join(',')}`);

  const pairs = rs.flatMap(r => r.gold.map((g, i) => [g, r.pred[i]]).filter(([, p]) => typeof p === 'number'));
  const dimMae = pairs.reduce((s, [g, p]) => s + Math.abs(g - p), 0) / (pairs.length || 1);
  const totalMse = rs.reduce((s, r) => s + (r.predicted_total - r.gold_total) ** 2, 0) / rs.length;
  const bias = rs.reduce((s, r) => s + (r.predicted_total - r.gold_total), 0) / rs.length;
  const rv = rs.flatMap(r => r.review);
  const golds = rs.map(r => r.gold_total), preds = rs.map(r => r.predicted_total);

  return {
    n: rs.length,
    dim_mae: pairs.length ? dimMae : null,
    dim_n: pairs.length,
    total_mse: totalMse,
    bias,
    review_rate: rv.length ? rv.filter(Boolean).length / rv.length : 0,
    // ★ 我们 vs gold：这是**唯一**可以称为"准确性"的数
    rho_total: spearman(golds, preds),
    // ★ 参照线（不是分数）：TA 用另一套更粗的 rubric，与研究者量规不是同一评分工具
    rho_ta: spearman(golds, rs.map(r => r.ta * maxTotal)),
    rho_rater: spearman(golds, rs.map(r => r.rater * maxTotal)),
    // ★ 参照线本身也要报分辨率：ρ 在并列上退化成"分档"，不看这个会误读
    rho_total_note: { gold_distinct: distinctCount(golds), pred_distinct: distinctCount(preds) },
    gold_ties: tieFactor(golds),
    pred_ties: tieFactor(preds),
  };
}

// 逐维指标（**在组内**，且只统计有分的那几对）
export function perDimMetrics(rs, dims) {
  return dims.map((id, i) => {
    const pairs = rs.map(r => [r.gold[i], r.pred[i]]).filter(([, p]) => typeof p === 'number');
    const gs = pairs.map(([g]) => g), ps = pairs.map(([, p]) => p);
    const mae = pairs.length ? pairs.reduce((s, [g, p]) => s + Math.abs(g - p), 0) / pairs.length : null;
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      id,
      n: pairs.length,
      mae,
      rho: spearman(gs, ps),
      gold_mean: mean(gs),
      pred_mean: mean(ps),
      // 逐维的并列也多 —— 同样报出来
      gold_distinct: distinctCount(gs),
      pred_distinct: distinctCount(ps),
    };
  });
}

// 精确命中率（子集/完全一致）——比 ρ 更能反映"少数极端错"的影响
export function exactMatch(rs, dims) {
  let hit = 0, tot = 0;
  for (const r of rs) for (let i = 0; i < dims.length; i++) {
    if (typeof r.pred[i] !== 'number') continue;
    tot++; if (r.pred[i] === r.gold[i]) hit++;
  }
  return { hit, tot, rate: tot ? hit / tot : null };
}

export const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
export const fmtSigned = (v, d = 2) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d));
