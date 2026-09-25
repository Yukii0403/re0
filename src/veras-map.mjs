// veras-map.mjs —— VerAs 评测侧的**保守映射**（全项目唯一一份口径）
//
// ★ 为什么单独一个模块：v0.3 起 L4 **不再产生分数**，但 VerAs 的 gold 是 0–5 的分数。
//   评测必须把"定性结论"映射成"能与 gold 对齐的分值"，而**映射口径只能有一份** ——
//   三份脚本各写一套正是本项目已经踩过的坑（同一批数据算出不同的数）。
//
// ★ 三条纪律：
//   ① 映射**只用于评测**，绝不进任何产物（产物里没有分数；这是 v0.3 的架构事实）；
//   ② 映射必须**保守**：边界不清取低界、宁可弃权也不猜；
//   ③ **弃权（null）不是 0 分**：单列计数、不参与任何分母（沿用 `_stats` 的老规矩）。
//
// ★★ 我的判断（可以推翻）：points 型条目的 `partially_satisfied` **不给映射分（弃权）**。
//   理由：v0.3 的 judgment 是定性判断，不含"做到几成"的定量信息；硬把它映射成某个分数，
//   就是在替模型做**分数校准** —— 而分数校准正是我们论证过不该追、且实测做不稳的那件事
//   （VerAs R1 无分辨力 / R6 单向高估）。宁可弃权，让分数指标只覆盖"明确判断"，并在报告里写明覆盖率。

/** outside_defined_levels ↔ gold 的「未涉及该维度」= 0 分。★ 这不是自造档位（我们不产生档位），而是对齐 gold 的既有语义。 */
export const OUTSIDE_SCORE = 0;

/**
 * 把一条 assessment 映射成可与 gold 对齐的分数。
 * @returns {{score: number|null, kind: 'assessed'|'outside'|'abstain', state: string}}
 *   kind=assessed → 有映射分；outside → 映射为 0（单独计数）；abstain → 弃权（null）
 */
export function mapAssessment(a, profileItem) {
  if (!a) return { score: null, kind: 'abstain', state: 'no_assessment' };
  const st = profileItem?.scoring_strategy;

  if (a.strategy_type === 'levels') {
    const s = a.level_status;
    if (s === 'candidate') {
      const ids = a.candidate_level_ids ?? [];
      const scores = (st?.levels ?? []).filter(l => ids.includes(l.level_id)).map(l => l.score).sort((x, y) => x - y);
      if (!scores.length) return { score: null, kind: 'abstain', state: 'candidate(无有效候选档)' };
      // ★ 边界不清（双候选）→ 取**下界**（保守，不取中点：中点等于替模型猜一个更细的档）
      return { score: scores[0], kind: 'assessed', state: ids.length > 1 ? `candidate${JSON.stringify(ids)}→下界` : `candidate${JSON.stringify(ids)}` };
    }
    if (s === 'outside_defined_levels') return { score: OUTSIDE_SCORE, kind: 'outside', state: s };
    if (s === 'insufficient_evidence') return { score: null, kind: 'abstain', state: s };
    if (s === 'not_applicable') return { score: null, kind: 'abstain', state: s };
    return { score: null, kind: 'abstain', state: String(s) };
  }

  // points / binary：judgment 五值
  const j = a.judgment;
  if (j === 'satisfied') return { score: st?.max ?? null, kind: 'assessed', state: j };
  if (j === 'not_satisfied') return { score: st?.min ?? 0, kind: 'assessed', state: j };
  if (j === 'partially_satisfied') return { score: null, kind: 'abstain', state: 'partially_satisfied(不映射)' };
  return { score: null, kind: 'abstain', state: String(j ?? 'missing') };
}

/**
 * 把一份 L4 产物映射成逐维预测。
 * @returns {{pred: (number|null)[], kinds: string[], states: string[], total: number|null,
 *            counts: {assessed:number, outside:number, abstain:number}, outside_ids: string[],
 *            gold0_ids: string[], outside_hit_gold0: string[]}}
 */
export function mapArtifact(art, dims, profile, goldDims = null) {
  const pById = new Map((profile?.items ?? []).map(p => [p.rubric_item_id, p]));
  const aById = new Map((art?.assessments ?? []).map(a => [a.rubric_item_id, a]));
  const mapped = dims.map(id => mapAssessment(aById.get(id), pById.get(id)));
  const pred = mapped.map(m => m.score);
  const counts = { assessed: 0, outside: 0, abstain: 0 };
  for (const m of mapped) counts[m.kind]++;
  // ★ 只要有弃权 → 不给总分（绝不用 0 补齐一个看起来完整的总分）
  const total = counts.abstain === 0 ? pred.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) : null;
  const outsideIds = dims.filter((id, i) => mapped[i].kind === 'outside');
  // ★★ 2026-09-24 修（实测发现的口径缺口）：只看 levels 的 `outside` 会**低估** 0 分识别率 ——
  //   points 型维度的 `not_satisfied`（映射为 min=0）同样是"认出该维度没做到"。
  //   所以另给一组"宽口径"：**凡映射为 0 的维度**都算命中。
  const zeroIds = dims.filter((id, i) => pred[i] === 0);
  const gold0 = goldDims ? dims.filter((id, i) => goldDims[i] === 0) : [];
  return {
    pred, total, counts,
    kinds: mapped.map(m => m.kind),
    states: mapped.map(m => m.state),
    outside_ids: outsideIds,
    zero_ids: zeroIds,
    gold0_ids: gold0,
    // 窄口径：gold=0 里被报成 outside_defined_levels 的（levels 维度）
    outside_hit_gold0: gold0.filter(id => outsideIds.includes(id)),
    // ★ 宽口径（报告用这个）：gold=0 里被映射为 0 的（含 points 的 not_satisfied）
    zero_hit_gold0: gold0.filter(id => zeroIds.includes(id)),
  };
}

/**
 * v0.3 的完整性判定：返回原因列表；空数组 = 可用于**总分指标**。
 * ★ 与 v0.2 的区别：不再看 `score.awarded` / `aggregation.total.awarded`（那些字段已不存在），
 *   改看"是否每个维度都能映射出分数"。弃权（insufficient_evidence / partially）→ 不可用（但不当 0）。
 */
export function completenessReasonsV03(art, dims, profile) {
  const reasons = [];
  if (!art) { reasons.push('no_artifact'); return reasons; }
  const aById = new Map((art.assessments ?? []).map(a => [a.rubric_item_id, a]));
  const missingLeaves = dims.filter(id => !aById.has(id));
  if (missingLeaves.length) reasons.push(`missing_leaves:${missingLeaves.join('+')}`);
  const m = mapArtifact(art, dims, profile);
  const abstained = dims.filter((id, i) => m.kinds[i] === 'abstain');
  if (abstained.length) reasons.push(`abstained:${abstained.join('+')}`);
  if (m.total === null) reasons.push('total_not_derivable');
  return reasons;
}
