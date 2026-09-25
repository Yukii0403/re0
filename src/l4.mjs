// l4.mjs —— L4：Rubric-native Assessment（按**原 rubric 条目**做定性评估，不评分）
//
// 分层定位（v0.3，2026-09-24 定向）：
//     原始 rubric（评分权威，冻结）
//   + 完整原文/原始资产
//   + L2 evidence focus（注意力信号，**不是**信息边界）
//   + L3 mechanical verification（辅助事实，可挂钩的机械反证）
//   → L4 assessment（结构化定性发现 + 候选档位/判断 + 依据 + 审查路由）
//   → 教师给分（三选：准确/不准确/部分准确 + 定档/给分）
//   → 总结评语（另一层，吸收教师给分）
//
// ★★ v0.3 的方向转向（Yukii 定）：模型不再提交分数。定性判断比定量分数更可靠 ——
//   实测（VerAs R1 无分辨力 / R6 单向高估 / 0 分漏判 6/6）失败全集中在「分数校准」，
//   而 rationale 里的定性观察常常是对的。分数权完全归教师。
//
// 七条不可动的原则：
//   ① 按 rubric 条目评估，不按 facet 评估；facet 是检索中间物，不能成为评分原子
//   ② L4 必须能访问完整原文（拿不到的东西不许"因为 L2 没给"就当没有）
//   ③ L3 只作辅助事实：pass 只说明对应机械关系成立；fail 是可引用的反证；unverified 既不支持也不反对；
//      被拒的调用只进诊断。★ 可机械验证的断言（如"计算错误"）应挂钩 L3 check，不凭眼睛断言
//   ④ 不修改 rubric、不重新拆评分标准；分值范围一律来自 assessment profile（而 profile 的分值又逐字来自 rubric 原件）
//   ⑤ 只评 `scorable=true` 的叶子；父项与总分**不聚合出分值**（教师给分），模型与程序都不产生分数
//   ⑥ 没有找到证据 ≠ 学生没写；「检索没找到」≠「通读后确认没写」：
//      points 的 not_satisfied 与 insufficient_evidence 必须分开；
//      levels 的 outside_defined_levels 必须以「已通读可靠完整原文」为前提，且绝不自造 rubric 没定义的档
//   ⑦ 契约按 scoring_strategy 分支：points/binary → judgment 五值；levels → level_status 四态 + 候选档。
//      两个分支物理隔离（工具 schema 按条目动态生成，模型无处写错分支的字段）
//
// ★ 哈希链：rubric(source_sha256) → assessment_profile(自身 sha256) → assessment。
//   原始 rubric 字节变 → L2/L3/L4 全失效；profile 变 → 只失效 L4 及以后。

import { createHash } from 'node:crypto';
import { bindQuote, entryCovering } from './quote-binding.mjs';
import { validate } from './validator.mjs';

// ★ sha 一律对**字节**算（与 L1/L2/L3 驱动同一算法），不做任何规范化。
const sha256Hex = s => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// v0.3（2026-09-24）：① 删除模型侧 score 字段（分数权归教师；levels 唯一候选只是「AI 建议档位」）；
//   ② 契约按 strategy 分支：points/binary 保留五值 judgment；levels 改用四态 level_status
//   （candidate / insufficient_evidence / not_applicable / outside_defined_levels）+ candidate_level_ids
//   （1–2 个 rubric 已定义的相邻档；非 candidate 状态一律空数组）；工具 schema 按条目动态生成；
//   ③ 新增 findings：封闭极性（strength/concern/neutral）+ 半开放宽类别 + 具体说明 + 可选原文定位
//   （逐字绑定）与 L3 挂钩；kind 标签不参与任何送审路由；
//   ④ 送审看证据断链、check 冲突与未解决的不确定性：outside_defined_levels / not_applicable 强制送审；
//   ⑤ 聚合改为覆盖账目（无分值），rule = no_machine_scores_teacher_decides。
export const L4_VERSION = 'v0.3';

export const JUDGMENTS = ['satisfied', 'partially_satisfied', 'not_satisfied', 'insufficient_evidence', 'not_applicable'];
export const LEVEL_STATUSES = ['candidate', 'insufficient_evidence', 'not_applicable', 'outside_defined_levels'];
export const NON_CANDIDATE_STATUSES = ['insufficient_evidence', 'not_applicable', 'outside_defined_levels'];
export const FINDING_POLARITIES = ['strength', 'concern', 'neutral'];
export const FINDING_KINDS = ['calculation', 'reasoning', 'completeness', 'presentation', 'other'];
export const FINDING_SEVERITIES = ['major', 'minor'];

// ★ warrant 的依据类型（封闭枚举；'rubric_requirement'=rubric 条文/档位要求；'self_contradiction'=报告自相矛盾；'l3_check'=L3 机械验证）
const WARRANT_BASIS_KINDS = ['rubric_requirement', 'self_contradiction', 'l3_check'];
export const REF_ROLES = ['support', 'counterevidence', 'context'];
export const IMPACTS = ['support', 'contradict', 'neutral'];
export const STRATEGY_TYPES = ['points', 'levels', 'binary'];

// ★ rationale 的长度是**软上限**（2026-09-24 Yukii 定）：
//   · TARGET 是建议长度（设计稿里的"例如 300 字符"）—— 超了**不拒收**，只记诊断 + 强制送审；
//   · HARD_MAX 只是防爆量的工程上限（2000），撞到它说明模型跑偏了，才会被调用闸拒收。
//   为什么不把 TARGET 做成硬闸：实测真实模型爱写 300+ 字，硬闸让 L4 调用数翻倍，
//   而且会因为"理由长了一点"直接丢掉一个维度的分数 —— 代价与收益完全不成比例。
export const RATIONALE_TARGET = 300;
export const RATIONALE_HARD_MAX = 2000;

// ★ 系统强制的送审原因（最终 review.required **只**由系统规则决定）。
//   没有"模型建议送审"这条通道 —— 主观不确定性请通过 `judgment = insufficient_evidence` 表达。
//   （原先的 `review.suggested` / `suggested_reason_codes` 已删除：实测真实模型 8 项全报 false、
//    也从不影响系统路由；留一个没人用的字段不如把不确定性导向它该去的地方。）
export const SYSTEM_REVIEW_CODES = [
  'insufficient_evidence',       // 判断/状态本身就说材料不够
  'not_applicable',              // ★ v0.3：标准不适用 ≠ 学生没写 —— 必须交教师确认
  'outside_defined_levels',      // ★ v0.3 levels：通读后仍无相关内容、但所有档位都预设"学生写了" → 留空候选，教师裁决
  'l3_fail_for_item',            // 该条目存在 L3 fail（可引用的反证）
  'referenced_l3_fail',          // 显式引用了 fail
  'referenced_l3_unverified',    // 显式引用了 unverified（= 模型认为它对判断是必要的）
  'source_conflict',             // 同时引用了支持与反证
  'supplemental_evidence_used',  // 用了 L2 之外的补充引用
  'visual_asset_unreadable',     // 视觉资产读不到
  'missing_support_evidence',    // 给了判断/候选档，却没有任何起作用的依据
  'dropped_assessment_ref',      // ★ 该条目提交的引用（含 finding 的 quote/check 定位）里只要有一条最终被丢弃
  'rationale_over_limit',        // ★ rationale 超过建议长度（软上限：不拒收，但让人看见）
  'model_output_rejected',       // 该条目的提交被拒过（诊断可见，但它不影响结论）
  'incomplete_assessment',       // 该条目最终没有产出 assessment
];

// 调用级拒收码：**结构或契约不合格，不产生 assessment**（与"产出了但降级"分开）
export const L4_REJECT_CODES = [
  'unknown_tool',
  'malformed_arguments_json',
  'arguments_failed_schema',
  'rubric_item_mismatch',     // 提交的条目不是本次被问的那个
  'not_scorable_item',        // 提交的是父项 / 非 scorable 条目
  'duplicate_rubric_item',    // 该条目已经有一条被接受的 assessment
  // ---- levels 分支的候选档校验 ----
  'level_not_in_rubric',              // ★ 候选档不在 profile 定义的等级里 —— 不许自造 rubric 没有的档（R1 的 L0 教训）
  'levels_not_adjacent',              // 两个候选档不相邻
  'too_many_candidates',              // 候选档超过 2 个
  'candidates_with_non_candidate_status',  // level_status ≠ candidate 却给了候选档（非 candidate 一律空数组）
  'boundary_condition_required',      // 双候选档必须写明卡在哪个条件
  // ---- 分支互斥的防御性校验（正常会被动态工具 schema 先拦下）----
  'judgment_forbidden_for_levels',    // levels 条目不许交 judgment（与候选档重复且易冲突）
  'level_status_forbidden_for_points', // points/binary 条目不许交 level_status
  'internal_tool_error',
  'budget_exhausted',
];

// 引用级丢弃码：**产出 assessment，但该引用无效**（进诊断，不作为评分依据）
export const DROP_CODES = [
  'unknown_bundle', 'no_span_index', 'unknown_span_index', 'quote_offset_mismatch', 'source_ref_other_doc', 'bad_role',
  'unknown_check', 'bad_impact', 'impact_conflicts_pass', 'impact_conflicts_fail', 'impact_conflicts_unverified',
  'unknown_asset',
  'empty_quote', 'quote_not_found', 'ambiguous_quote', 'entry_not_covering',
];

// ------------------------------------------------------------------ profile 校验

// ★ 只为 scorable 叶子生成 assessment；profile 与 rubric 必须自洽（不然宁可整层不跑）
export function validateProfile(profile, rubric) {
  const errors = [];
  const items = rubric.items ?? [];
  const byId = new Map(items.map(i => [i.id, i]));
  const pItems = profile.items ?? [];
  const seen = new Set();

  if (profile.rubric?.rubric_id !== rubric.rubric_id) errors.push('profile.rubric.rubric_id 与 rubric 不一致');
  if (profile.rubric?.source_sha256 !== rubric.source?.sha256) {
    // ★ 不等即失效：profile 是对着某个 rubric 原件做的，原件换了就必须重做
    errors.push('profile.rubric.source_sha256 与 rubric.source.sha256 不一致 → profile 失效');
  }

  for (const p of pItems) {
    if (seen.has(p.rubric_item_id)) errors.push(`profile 里 ${p.rubric_item_id} 重复`);
    seen.add(p.rubric_item_id);
    const rb = byId.get(p.rubric_item_id);
    if (!rb) { errors.push(`profile 里的 ${p.rubric_item_id} 不在 rubric 里`); continue; }
    const isLeaf = (rb.children ?? []).length === 0;
    if (p.scorable === true) {
      if (!isLeaf) errors.push(`${p.rubric_item_id} 声明 scorable，但它在 rubric 里是父项`);
      const st = p.scoring_strategy;
      if (!st || !STRATEGY_TYPES.includes(st.type)) errors.push(`${p.rubric_item_id} 缺合法 scoring_strategy`);
      else if (st.type === 'points') {
        if (!Number.isInteger(st.min) || !Number.isInteger(st.max) || st.max <= st.min) errors.push(`${p.rubric_item_id} 的 min/max 不合法`);
        else if (!Number.isInteger(st.step) || st.step < 1 || (st.max - st.min) % st.step !== 0) errors.push(`${p.rubric_item_id} 的 step 不能整除范围`);
        // ★ 条项计分：max 必须等于各项之和（不然模型"按条项加"和"按 max"会对不上）
        if (st.criteria) {
          const sum = st.criteria.reduce((s, c) => s + (Number.isInteger(c.points) ? c.points : -1e9), 0);
          if (sum !== st.max) errors.push(`${p.rubric_item_id} 的 criteria 点数之和(${sum}) ≠ max(${st.max})`);
          if (st.criteria.some(c => typeof c.text !== 'string' || !c.text.trim())) errors.push(`${p.rubric_item_id} 的 criteria 有条项缺原文`);
        }
      } else if (st.type === 'levels') {
        if (!Array.isArray(st.levels) || !st.levels.length) errors.push(`${p.rubric_item_id} 的 levels 为空`);
        else {
          const idset = new Set(st.levels.map(l => l.level_id));
          if (idset.size !== st.levels.length) errors.push(`${p.rubric_item_id} 的 level_id 重复`);
          if (st.levels.some(l => !Number.isInteger(l.score))) errors.push(`${p.rubric_item_id} 的 level 缺分数`);
          if (st.levels.some(l => l.text !== undefined && !String(l.text).trim())) errors.push(`${p.rubric_item_id} 的某个等级给了空的原文描述`);
          // 等级分必须覆盖 [min,max]（不然 min/max 与等级表不一致）
          const scores = st.levels.map(l => l.score);
          if (Math.min(...scores) !== st.min || Math.max(...scores) !== st.max) errors.push(`${p.rubric_item_id} 的等级分数范围(${Math.min(...scores)}–${Math.max(...scores)}) ≠ min/max(${st.min}–${st.max})`);
        }
      } else if (st.type === 'binary') {
        if (!Number.isInteger(st.satisfied) || !Number.isInteger(st.not_satisfied)) errors.push(`${p.rubric_item_id} 的 binary 缺 satisfied/not_satisfied 分值`);
      }
      if (!p.strategy_source_ref) errors.push(`${p.rubric_item_id} 的 scoring_strategy 没有出处（strategy_source_ref）`);
    } else {
      if (isLeaf) errors.push(`${p.rubric_item_id} 声明不可评分，但它在 rubric 里是叶子`);
      const kids = p.aggregation?.children ?? [];
      if (p.aggregation?.type !== 'sum_children') errors.push(`${p.rubric_item_id} 的 aggregation.type 不在枚举内`);
      if (JSON.stringify(kids) !== JSON.stringify(rb.children ?? [])) {
        errors.push(`${p.rubric_item_id} 的聚合子项与 rubric 不一致`);
      }
    }
  }
  for (const i of items) if (!seen.has(i.id)) errors.push(`rubric 里的 ${i.id} 在 profile 里没有配置`);
  return { ok: errors.length === 0, errors, byId: new Map(pItems.map(p => [p.rubric_item_id, p])) };
}

export function scorableLeaves(profile) {
  return (profile.items ?? []).filter(p => p.scorable === true).map(p => p.rubric_item_id);
}

// ------------------------------------------------------------------ L3 check 的作用域

// ★ v0.2 的 check 自带 scope。v0.1 产物没有这个字段 → 按 id 是否为空**推导**，并标记是推导来的：
//   'document' 与"模型忘了填条目"在旧产物里分不开，所以推导结果不许被当成确定事实。
export function checkScope(c) {
  if (c?.scope === 'rubric_item' || c?.scope === 'document') return { scope: c.scope, inferred: false };
  return { scope: c?.rubric_item_id ? 'rubric_item' : 'document', inferred: true };
}

export function partitionChecks(checks) {
  const out = { rubric_item: new Map(), document: [], any_inferred_scope: false };
  for (const c of checks ?? []) {
    const { scope, inferred } = checkScope(c);
    if (inferred) out.any_inferred_scope = true;
    if (scope === 'document') out.document.push(c);
    else {
      const k = c.rubric_item_id;
      if (!out.rubric_item.has(k)) out.rubric_item.set(k, []);
      out.rubric_item.get(k).push(c);
    }
  }
  return out;
}

// ------------------------------------------------------------------ 每次调用的材料（一个叶子条目一份）

export function buildItemContext({ rubric, profile, evidenceFile, checks, idx, full, itemId, assetExists = null }) {
  const item = (rubric.items ?? []).find(i => i.id === itemId) ?? null;
  const pItem = (profile.items ?? []).find(p => p.rubric_item_id === itemId) ?? null;
  const bundles = (evidenceFile.evidence ?? []).filter(b => b.rubric_item_id === itemId);
  const parts = partitionChecks(checks);
  const itemChecks = parts.rubric_item.get(itemId) ?? [];
  const assets = [];
  const seen = new Set();
  for (const b of bundles) {
    for (const a of b.asset_refs ?? []) {
      if (a.kind !== 'page_render' || !Number.isInteger(a.page)) continue;
      const id = `page-${a.page}`;
      if (seen.has(id)) continue;
      seen.add(id);
      assets.push({ asset_id: id, page: a.page, file: a.ref, note: a.note ?? null, readable: assetExists ? !!assetExists(a.ref) : null });
    }
  }
  return {
    item, pItem, itemId, bundles, checks: itemChecks, assets,
    documentChecks: parts.document,
    checksById: new Map([...(checks ?? [])].map(c => [c.id, c])),
    allBundleIds: new Set((evidenceFile.evidence ?? []).map(b => b.id)),
    entries: idx.entries ?? [],
    docName: idx.doc?.name ?? null,
    full,
  };
}

// ------------------------------------------------------------------ 一条提交的机械校验

// ★ levels 分支的候选档校验（v0.3 取代了旧的分数校验）。
//   契约：level_status=candidate → 1–2 个 profile 已定义的**相邻**档（按 score 升序后紧邻）；
//         非 candidate（insufficient_evidence / not_applicable / outside_defined_levels）→ 一律空数组；
//         双候选必须写 boundary_condition（卡在哪个条件）。
//   ★ 不许自造 rubric 没定义的档（VerAs R1 的教训：L0 是无出处的发明，污染了 5 个维度）。
export function levelsError(args, st) {
  if (!LEVEL_STATUSES.includes(args.level_status)) return 'arguments_failed_schema';
  const ids = Array.isArray(args.candidate_level_ids) ? args.candidate_level_ids : null;
  if (args.level_status !== 'candidate') {
    // 非 candidate 状态：不许带候选档（给了等于暗中给分/给档）
    if (ids && ids.length) return 'candidates_with_non_candidate_status';
    return null;
  }
  if (!ids || !ids.length) return 'arguments_failed_schema';   // candidate 必须至少一个候选档
  if (ids.length > 2) return 'too_many_candidates';
  const byId = new Map((st.levels ?? []).map(l => [l.level_id, l]));
  if (ids.some(id => !byId.has(id))) return 'level_not_in_rubric';
  if (new Set(ids).size !== ids.length) return 'too_many_candidates';   // 重复档视同超量
  if (ids.length === 2) {
    // ★ 相邻 = profile 的等级按 score 升序排列后紧邻（中间没有别的档）
    const ordered = [...(st.levels ?? [])].sort((a, b) => a.score - b.score);
    const i = ordered.findIndex(l => l.level_id === ids[0]);
    const j = ordered.findIndex(l => l.level_id === ids[1]);
    if (Math.abs(i - j) !== 1) return 'levels_not_adjacent';
    const bc = String(args.boundary_condition ?? '').trim();
    if (!bc) return 'boundary_condition_required';   // ★ 双档必须写明卡在哪个条件
  }
  return null;
}

// finding 的定位解析：quote 逐字绑定 + check 挂钩。
//   ★ finding 是定性观察 —— 定位失败**不丢弃 finding 本身**（丢观察比丢引用代价大），
//     只是 located/verification 置 null、原始请求进 diagnostics.dropped_findings、触发送审。
function resolveFinding(f, ctx) {
  const out = { finding: null, drop: null };
  if (!f || !FINDING_POLARITIES.includes(f.polarity) || !FINDING_KINDS.includes(f.kind)
    || typeof f.note !== 'string' || !f.note.trim()) return { drop: { polarity: f?.polarity ?? null, kind: f?.kind ?? null, reason: 'invalid_finding' } };
  if (f.severity != null && !FINDING_SEVERITIES.includes(f.severity)) return { drop: { polarity: f.polarity, kind: f.kind, reason: 'invalid_severity' } };
  const finding = {
    polarity: f.polarity,
    kind: f.kind,
    note: String(f.note).slice(0, 500),
    severity: f.severity ?? null,
    quote: null, entry_hint: f.entry_hint ?? null, check_id: null,
    located: null, verification: null,
  };
  let dropped = false;
  if (typeof f.quote === 'string' && f.quote.trim()) {
    const b = bindQuote(ctx.full, f.quote, { entryHint: f.entry_hint ?? null, entries: ctx.entries });
    if (!b.ok) { dropped = true; out.drop = { polarity: f.polarity, kind: f.kind, reason: 'quote_not_found' }; }
    else if (b.ambiguous) { dropped = true; out.drop = { polarity: f.polarity, kind: f.kind, reason: 'ambiguous_quote', occurrences: b.occurrences }; }
    else {
      const entry = entryCovering(ctx.entries, b.start, b.end);
      if (!entry) { dropped = true; out.drop = { polarity: f.polarity, kind: f.kind, reason: 'entry_not_covering' }; }
      else {
        finding.quote = f.quote;
        finding.located = {
          offset: { start: b.start, end: b.end },
          source_ref: { file: ctx.docName, page: entry.page ?? null, entry: entry.id },
          binding: { mode: b.mode, selection: 'unambiguous', occurrences: b.occurrences },
        };
      }
    }
  }
  if (typeof f.check_id === 'string' && f.check_id) {
    const c = ctx.checksById.get(f.check_id);
    if (!c) { dropped = true; out.drop = { ...(out.drop ?? {}), polarity: f.polarity, kind: f.kind, check_id: f.check_id, reason: (out.drop ? out.drop.reason + '+unknown_check' : 'unknown_check') }; }
    else {
      finding.check_id = f.check_id;
      finding.verification = { check_id: c.id, stance: c.stance, scope: checkScope(c).scope };
    }
  }
  // ★★ warrant（"有依据的内容错误候选"）的**程序核验**：
  //   三要素逐项核验 —— ① 学生原话能在原文**定位** ② "错在哪"要成文（≥10 字）③ 依据要成文，
  //   且 basis_kind=l3_check 时该 check 必须**真实存在**。全部通过才 `bound = true`。
  //   ★★ `bound` 由**程序**回填 —— 模型只能给三要素，给不了一个"我说我对"的开关。
  //   ★★★ 但 `bound` 的**语义必须说准**：它只表示"三要素都绑上了（原话可定位、解释与依据成文、
  //     引用的 check 真实存在）"，**不表示解释在语义上正确**。面向教师一律表述为
  //     「**依据已绑定，内容待核对**」，不得写成"经程序核验/已验证"（那会让教师误以为内容已被证实）。
  //   ★ 核验不通过**不丢观察**（保留 finding、照常送审），只是它不够格进"整篇第一屏"。
  if (f.warrant != null && typeof f.warrant === 'object') {
    const w = f.warrant;
    const reasons = [];
    let qLocated = null;
    if (typeof w.student_quote !== 'string' || w.student_quote.trim().length < 4) reasons.push('missing_student_quote');
    else {
      const b2 = bindQuote(ctx.full, w.student_quote, { entryHint: f.entry_hint ?? null, entries: ctx.entries });
      if (!b2.ok) reasons.push('student_quote_not_found');
      else if (b2.ambiguous) reasons.push('student_quote_ambiguous');
      else qLocated = { offset: { start: b2.start, end: b2.end } };
    }
    if (typeof w.what_is_wrong !== 'string' || w.what_is_wrong.trim().length < 10) reasons.push('what_is_wrong_too_vague');
    if (!WARRANT_BASIS_KINDS.includes(w.basis_kind)) reasons.push('invalid_basis_kind');
    if (typeof w.basis_detail !== 'string' || w.basis_detail.trim().length < 10) reasons.push('basis_detail_too_vague');
    let bCheck = null;
    if (w.basis_kind === 'l3_check') {
      const c2 = (typeof w.basis_check_id === 'string' && w.basis_check_id) ? ctx.checksById.get(w.basis_check_id) : null;
      if (!c2) reasons.push('basis_check_not_found');
      else bCheck = { check_id: c2.id, stance: c2.stance };
    }
    finding.warrant = {
      student_quote: typeof w.student_quote === 'string' ? w.student_quote : null,
      student_quote_located: qLocated,
      what_is_wrong: typeof w.what_is_wrong === 'string' ? w.what_is_wrong.slice(0, 400) : null,
      basis_kind: typeof w.basis_kind === 'string' ? w.basis_kind : null,
      basis_detail: typeof w.basis_detail === 'string' ? w.basis_detail.slice(0, 400) : null,
      basis_check: bCheck,
      bound: reasons.length === 0,             // ★ 程序判定：三要素**已绑定**（≠ 内容正确）
      unbound_reasons: reasons,                // 未绑上的原因码（缺原话/定位不到/依据未成文/check 不存在）
      binding_scope: 'structural_only',        // ★ 约定：只做了结构性绑定，**没有做语义核验**
    };
  }

  if (dropped) return { finding, drop: out.drop, partial: true };   // finding 保留，但定位断链要让人看见
  out.finding = finding;
  return out;
}

function resolveEvidenceRef(ref, ctx) {
  if (!ref || typeof ref.bundle_id !== 'string') return { reason: 'unknown_bundle' };
  const b = ctx.bundles.find(x => x.id === ref.bundle_id);
  if (!b && !ctx.allBundleIds.has(ref.bundle_id)) return { reason: 'unknown_bundle' };
  // ★ 引用别的条目的 bundle 是**允许**的（证据是注意力信号，不是信息边界），但要在产物里标出来源，
  //   不假装它是本条目检索到的。
  const own = !!b;
  const bundle = b ?? null;
  const idxs = Array.isArray(ref.span_indices) ? ref.span_indices : [];
  if (!idxs.length) return { reason: 'no_span_index' };
  if (!REF_ROLES.includes(ref.role)) return { reason: 'bad_role' };
  const resolved = [];
  for (const i of idxs) {
    const s = bundle?.spans?.[i];
    if (!s) return { reason: 'unknown_span_index' };
    if (ctx.full.slice(s.offset.start, s.offset.end) !== s.quote) return { reason: 'quote_offset_mismatch' };
    if (s.source_ref?.file && s.source_ref.file !== ctx.docName) return { reason: 'source_ref_other_doc' };
    resolved.push({ span_index: i, quote: s.quote, offset: s.offset, source_ref: s.source_ref });
  }
  return { ok: true, ref: { bundle_id: ref.bundle_id, span_indices: idxs, role: ref.role, from_other_item: !own, resolved } };
}

function resolveVerificationRef(ref, ctx) {
  if (!ref || typeof ref.check_id !== 'string') return { reason: 'unknown_check' };
  const c = ctx.checksById.get(ref.check_id);
  if (!c) return { reason: 'unknown_check' };
  if (!IMPACTS.includes(ref.impact)) return { reason: 'bad_impact' };
  // ★ 明显错误的映射一律拦住 —— pass 不能当反证，fail 不能当支持，unverified 只能中立
  if (c.stance === 'pass' && ref.impact === 'contradict') return { reason: 'impact_conflicts_pass' };
  if (c.stance === 'fail' && ref.impact === 'support') return { reason: 'impact_conflicts_fail' };
  if (c.stance === 'unverified' && ref.impact !== 'neutral') return { reason: 'impact_conflicts_unverified' };
  return { ok: true, ref: { check_id: c.id, impact: ref.impact, stance: c.stance, scope: checkScope(c).scope, scope_inferred: checkScope(c).inferred } };
}

function resolveSupplemental(q, ctx) {
  if (!q || typeof q.quote !== 'string' || !q.quote.trim()) return { reason: 'empty_quote' };
  if (!REF_ROLES.includes(q.role)) return { reason: 'bad_role' };
  const b = bindQuote(ctx.full, q.quote, { entryHint: q.entry_hint ?? null, entries: ctx.entries });
  if (!b.ok) return { reason: 'quote_not_found' };
  // ★ 比检索阶段更严：不允许"取首次出现当已确认"。歧义就丢弃 + 送审，不许当有效证据。
  if (b.ambiguous) return { reason: 'ambiguous_quote', occurrences: b.occurrences };
  const entry = entryCovering(ctx.entries, b.start, b.end);
  if (!entry) return { reason: 'entry_not_covering' };
  return {
    ok: true,
    evidence: {
      quote: q.quote,
      offset: { start: b.start, end: b.end },
      source_ref: { file: ctx.docName, page: entry.page ?? null, entry: entry.id },
      binding: { mode: b.mode, selection: 'unambiguous', occurrences: b.occurrences },
      role: q.role,
    },
  };
}

function resolveAssetRef(ref, ctx) {
  if (!ref || typeof ref.asset_id !== 'string') return { reason: 'unknown_asset' };
  const a = (ctx.assets ?? []).find(x => x.asset_id === ref.asset_id);
  if (!a) return { reason: 'unknown_asset' };
  if (!REF_ROLES.includes(ref.role)) return { reason: 'bad_role' };
  return {
    ok: true,
    ref: { asset_id: a.asset_id, page: a.page, file: a.file, role: ref.role, readable: a.readable },
  };
}

// 系统强制的送审路由（模型只能"建议"）
// ★ v0.3 路由哲学：看**证据断链、check 冲突、未解决的不确定性**，不凭 findings 的 kind 标签触发。
function systemReview(a, { itemFailCheckIds }) {
  const reasons = new Set();
  // ★ "有依据"= 有**起支撑作用**的引用（support 或 counterevidence），或带有效定位的 finding。
  //   counterevidence 也算：判断是 not_satisfied 时，反证正是它的依据 ——
  //   只认字面上的 'support' 会把合法的"基于反证的否定判断"误送审。
  const bearing = [...a.evidence_refs, ...a.supplemental_evidence].filter(r => r.role !== 'context');
  const findingBearing = a.findings.filter(f => f.located || f.verification);
  const state = a.judgment ?? a.level_status;   // 两个分支的「状态」语义在此对齐
  if (state === 'insufficient_evidence') reasons.add('insufficient_evidence');
  if (state === 'not_applicable') reasons.add('not_applicable');                      // 交教师确认
  if (a.level_status === 'outside_defined_levels') reasons.add('outside_defined_levels');  // 教师裁决档位缺口
  if (itemFailCheckIds.length) reasons.add('l3_fail_for_item');
  if (a.verification_refs.some(r => r.stance === 'fail')) reasons.add('referenced_l3_fail');
  if (a.verification_refs.some(r => r.stance === 'unverified')) reasons.add('referenced_l3_unverified');
  const impacts = new Set(a.verification_refs.map(r => r.impact));
  if (impacts.has('support') && impacts.has('contradict')) reasons.add('source_conflict');
  if (a.supplemental_evidence.length) reasons.add('supplemental_evidence_used');
  if (a.asset_refs.some(r => r.readable === false)) reasons.add('visual_asset_unreadable');
  // ★ 只要有**一条**提交的引用最终被丢弃（evidence / check / asset / 补充引用 / finding 定位），这个条目就必须送审：
  //   依据链出现了断点，结论不能就这么交给教师。丢弃的原因与原始提交都留在 diagnostics 里，
  //   有效引用照常保留、结论也不因此自动改变。
  //   ★ 不把 L2 检索阶段丢弃的候选算进来 —— 那是上游的检索噪声，不是本次评估的依据链。
  const droppedCount = a.diagnostics.dropped_evidence_refs.length + a.diagnostics.dropped_verification_refs.length
    + a.diagnostics.dropped_supplemental_quotes.length + a.diagnostics.dropped_asset_refs.length
    + a.diagnostics.dropped_findings.length;
  if (droppedCount > 0) reasons.add('dropped_assessment_ref');
  // ★ 软上限：写长了不拒收、不改写，但要让人看见（配合 review 一起看）
  if (a.rationale.over_limit) reasons.add('rationale_over_limit');
  // ★ 缺依据不能静默下结论：给了判断/候选档却一条起作用的依据都没有 → 必须送审
  //   （not_applicable 本身已送审；insufficient_evidence 也已送审 —— 不重复记 missing_support_evidence）
  if (!bearing.length && !findingBearing.length && state !== 'not_applicable' && state !== 'insufficient_evidence') {
    reasons.add('missing_support_evidence');
  }
  return [...reasons];
}

// 一次提交 → 一条 assessment（或结构化拒收）
export function assessSubmission(ctx, args) {
  const st = ctx.pItem?.scoring_strategy;
  if (!ctx.pItem?.scorable) return { reject: 'not_scorable_item' };
  if (args.rubric_item_id !== ctx.itemId) return { reject: 'rubric_item_mismatch' };
  if (!st) return { reject: 'arguments_failed_schema' };

  // ★ 契约按 strategy 分支（v0.3）：
  //   points/binary → judgment 五值（轻量裁决，教师给分的快信号）；
  //   levels → level_status 四态 + 候选档（不强迫单选，边界不清给相邻两档 + 卡点，教师选最终档）。
  //   分支互斥在调用闸（动态工具 schema）已物理隔离，这里做第二道防御 —— 谁配错了都能拦住。
  const isLevels = st.type === 'levels';
  if (isLevels) {
    if (args.judgment !== undefined && args.judgment !== null) return { reject: 'judgment_forbidden_for_levels' };
    const err = levelsError(args, st);
    if (err) return { reject: err };
  } else {
    if (args.level_status !== undefined && args.level_status !== null) return { reject: 'level_status_forbidden_for_points' };
    if (args.candidate_level_ids !== undefined && args.candidate_level_ids !== null) return { reject: 'level_status_forbidden_for_points' };
    if (!JUDGMENTS.includes(args.judgment)) return { reject: 'arguments_failed_schema' };
  }

  const droppedEvidence = [];
  const evidence_refs = [];
  for (const r of args.evidence_refs ?? []) {
    const res = resolveEvidenceRef(r, ctx);
    if (res.ok) evidence_refs.push(res.ref);
    else droppedEvidence.push({ ...r, reason: res.reason });
  }

  const droppedVerification = [];
  const verification_refs = [];
  for (const r of args.verification_refs ?? []) {
    const res = resolveVerificationRef(r, ctx);
    if (res.ok) verification_refs.push(res.ref);
    else droppedVerification.push({ ...r, reason: res.reason });
  }

  const droppedSupplemental = [];
  const supplemental_evidence = [];
  for (const q of args.supplemental_quotes ?? []) {
    const res = resolveSupplemental(q, ctx);
    if (res.ok) supplemental_evidence.push(res.evidence);
    else droppedSupplemental.push({ quote: q?.quote ?? null, entry_hint: q?.entry_hint ?? null, reason: res.reason, occurrences: res.occurrences ?? null });
  }

  const droppedAssets = [];
  const asset_refs = [];
  for (const r of args.asset_refs ?? []) {
    const res = resolveAssetRef(r, ctx);
    if (res.ok) asset_refs.push(res.ref);
    else droppedAssets.push({ ...r, reason: res.reason });
  }

  // ★ findings：定性观察不因定位失败而丢弃（丢观察比丢引用代价大），但断链必须进诊断 + 送审
  const droppedFindings = [];
  const findings = [];
  for (const f of args.findings ?? []) {
    const res = resolveFinding(f, ctx);
    if (res.finding) findings.push(res.finding);
    if (res.drop) droppedFindings.push({ note: (f?.note ?? '').slice(0, 80), ...res.drop });
  }

  const rationaleText = String(args.rationale ?? '');
  const a = {
    rubric_item_id: ctx.itemId,
    strategy_type: st.type,                    // 系统回填：决定下游按哪个分支读这条 assessment
    ...(isLevels
      ? {
        level_status: args.level_status,
        candidate_level_ids: args.level_status === 'candidate' ? [...args.candidate_level_ids] : [],
        boundary_condition: args.level_status === 'candidate' && args.candidate_level_ids.length === 2
          ? String(args.boundary_condition) : null,
      }
      : { judgment: args.judgment }),
    findings,
    evidence_refs,
    supplemental_evidence,
    asset_refs,
    verification_refs,
    rationale: {
      text: rationaleText,
      chars: rationaleText.length,
      derived_by: 'model',   // ★ rationale 是**派生判断**，永远标成模型产出，不当原始证据
      limit: RATIONALE_TARGET,
      over_limit: rationaleText.length > RATIONALE_TARGET,   // 超了不拒收，只记下来 + 送审
    },
    // ★ review 里只有系统算出来的两件事。模型没有"建议送审"的字段（见 SYSTEM_REVIEW_CODES 注释）。
    review: {
      required: false,
      required_reason_codes: [],
    },
    diagnostics: {
      dropped_evidence_refs: droppedEvidence,
      dropped_verification_refs: droppedVerification,
      dropped_supplemental_quotes: droppedSupplemental,
      dropped_asset_refs: droppedAssets,
      dropped_findings: droppedFindings,
    },
  };
  // ★ 审查路由在这一层就算清楚（不放在调用循环里）—— 提交 → assessment 的映射必须是完整的一份，
  //   否则直接调用本函数的地方（回归、批处理）会拿到一条"永远不需要审查"的假结论。
  const reasons = systemReview(a, { itemFailCheckIds: (ctx.checks ?? []).filter(c => c.stance === 'fail').map(c => c.id) });
  a.review.required = reasons.length > 0;
  a.review.required_reason_codes = reasons;
  return { ok: true, assessment: a };
}

// ------------------------------------------------------------------ 单条目调用循环

export function l4ResultFor(res) {
  // ★ 拒收必须把**原因**喂回去（L2/L3 早定的规矩）：只回一个码，模型只能瞎猜着重试。
  //   实测：rationale 327 > 300 连报三次，模型每次都重新写一遍还是超长 —— 带上 detail 它才能改对。
  if (!res.ok) return { ok: false, reason_code: res.reason_code, detail: res.detail ?? null };
  return {
    ok: true,
    assessment_id: res.assessment_id,
    rubric_item_id: res.rubric_item_id,
    strategy_type: res.strategy_type,
    judgment: res.judgment ?? null,
    level_status: res.level_status ?? null,
    candidate_level_ids: res.candidate_level_ids ?? null,
    review_required: res.review_required,
    dropped_refs: res.dropped_refs,
  };
}

export function createAssessmentRunner({ ctx, ids, maxCalls = 12 }) {
  const accepted = [];
  const rejected = [];
  let attempted = 0;
  // ★ 调用闸的第一道：参数必须过工具自己的 schema（枚举 / 必填 / 长度上限 / 封闭字段）。
  //   这条**必须**在这里做 —— 只在回归里 validate 一次是不够的：真实模型完全可能给出
  //   超长 rationale（实测 418 > 300）或改写枚举，那时只有这里能拦下来。
  //   ★ v0.3：工具 schema **按条目的 strategy 动态生成** —— levels 条目根本没有 judgment 字段、
  //     points 条目根本没有 level_status/candidate_level_ids 字段。「走错分支」在 schema 层物理不可能，
  //     这是比 if/then 更强的保证（validator 不支持 not/anyOf，动态生成恰好绕开这个限制）。
  const st = ctx.pItem?.scoring_strategy;
  const params = l4Tools(st?.type)[0].function.parameters;
  const reject = (reasonCode, detail) => {
    const entry = { index: attempted - 1, tool: 'submit_rubric_assessment', reason_code: reasonCode, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
    rejected.push(entry);
    return entry;   // 返给调用方，好把 detail 一起喂回模型
  };

  function call(toolCall) {
    const index = attempted++;
    // 拒收一律把 detail 一起带回去（喂给模型，让它自己修）—— 统一在这里出口
    const fail = reasonEntry => ({ ok: false, reason_code: reasonEntry.reason_code, detail: reasonEntry.detail ?? null, index });
    if (attempted > maxCalls) return fail(reject('budget_exhausted', `超过上限 ${maxCalls}`));
    const name = toolCall?.function?.name;
    if (name !== 'submit_rubric_assessment') return fail(reject('unknown_tool'));
    let args;
    try { args = JSON.parse(toolCall.function.arguments ?? '{}'); }
    catch (e) { return fail(reject('malformed_arguments_json', e.message)); }
    let v;
    try { v = validate(params, args); }
    catch (e) { return fail(reject('internal_tool_error', e.message)); }
    if (!v.ok) return fail(reject('arguments_failed_schema', v.errors.slice(0, 3).map(e => `${e.path} ${e.msg}`).join('; ')));
    if (accepted.length) return fail(reject('duplicate_rubric_item', `${ctx.itemId} 已有一条被接受的 assessment`));
    const r = assessSubmission(ctx, args);
    if (r.reject) return fail(reject(r.reject));

    const a = r.assessment;
    a.assessment_id = 'a' + String(ids.next++).padStart(4, '0');
    a.tool_call_index = index;
    // 这一条会话里出现过被拒的提交 → 系统追加一条送审原因（拒收只进诊断、**不影响分数**，但要让人看见）
    if (rejected.length) {
      a.review.required_reason_codes = [...new Set([...a.review.required_reason_codes, 'model_output_rejected'])];
      a.review.required = true;
    }
    a.diagnostics.rejected_submissions = rejected.length;
    accepted.push(a);
    return {
      ok: true, index, assessment_id: a.assessment_id, rubric_item_id: a.rubric_item_id,
      strategy_type: a.strategy_type,
      judgment: a.judgment ?? null, level_status: a.level_status ?? null, candidate_level_ids: a.candidate_level_ids ?? null,
      review_required: a.review.required,
      dropped_refs: {
        evidence: a.diagnostics.dropped_evidence_refs.length,
        verification: a.diagnostics.dropped_verification_refs.length,
        supplemental: a.diagnostics.dropped_supplemental_quotes.length,
        asset: a.diagnostics.dropped_asset_refs.length,
        findings: a.diagnostics.dropped_findings.length,
      },
    };
  }

  return {
    call,
    get assessments() { return accepted; },
    summary() {
      return {
        attempted,
        accepted: accepted.length,
        rejected: rejected.length,
        budget_exhausted: rejected.some(r => r.reason_code === 'budget_exhausted'),
      };
    },
    rejected() { return rejected; },
  };
}

// ------------------------------------------------------------------ 覆盖账目（v0.3：不聚合分数）

// ★ v0.3 起机器不产生分值 —— 教师给分。这里只算**覆盖账目**：
//   每个可评分叶子是否拿到了有效状态（points/binary 的 judgment / levels 的 level_status）。
//   maximum 保留（教师给分时参考满分）。non_candidate_state 一样算"拿到了状态"（它需要教师裁决，不是缺失）。
export function aggregate({ rubric, profile, assessments }) {
  const rById = new Map((rubric.items ?? []).map(i => [i.id, i]));
  const pById = new Map((profile.items ?? []).map(p => [p.rubric_item_id, p]));
  const aById = new Map(assessments.map(a => [a.rubric_item_id, a]));
  const maxOf = id => pById.get(id)?.scoring_strategy?.max ?? null;

  const node = id => {
    const a = aById.get(id);
    if (!a) return { rubric_item_id: id, status: 'missing', judgment: null, level_status: null, maximum: maxOf(id) };
    if (a.strategy_type === 'levels') {
      const s = a.level_status ?? null;
      return {
        rubric_item_id: id,
        status: s === 'candidate' ? 'candidate' : (s ? 'non_candidate_state' : 'missing'),
        judgment: null,
        level_status: s,
        maximum: maxOf(id),
      };
    }
    return {
      rubric_item_id: id,
      status: a.judgment ? 'judged' : 'missing',
      judgment: a.judgment ?? null,
      level_status: null,
      maximum: maxOf(id),
    };
  };

  const sections = (profile.items ?? [])
    .filter(p => p.scorable !== true && !rById.get(p.rubric_item_id)?.parent)
    .map(p => {
      const kids = (p.aggregation?.children ?? []).map(node);
      const complete = kids.every(k => k.status !== 'missing');
      return {
        rubric_item_id: p.rubric_item_id,
        aggregation: p.aggregation?.type ?? 'sum_children',
        maximum: kids.reduce((s, k) => s + (k.maximum ?? 0), 0),
        complete,
        children: kids,
      };
    });

  const leaves = scorableLeaves(profile);
  const incomplete = leaves.filter(id => node(id).status === 'missing');
  return {
    sections,
    total: {
      maximum: leaves.reduce((s, id) => s + (pById.get(id)?.scoring_strategy?.max ?? 0), 0),
      complete: incomplete.length === 0,
      incomplete_items: incomplete,
      rule: 'no_machine_scores_teacher_decides',   // ★ 机器不产生分值；教师给分
    },
  };
}

// ------------------------------------------------------------------ 跨层身份校验（哈希链）

// ★★ 为什么必须在 L4 内部**机械**校验，而不能只在驱动脚本里"顺便看一眼"：
//   哈希链的承诺是「rubric(source_sha256) → assessment_profile(自身 sha256) → assessment」。
//   但"承诺"与"执行"是两件事 —— 上游文件被换掉/改一个字节，产物里的 sha 字段照样是**旧值**，
//   看起来完全正常。不校验的话，我们拿到的是"一份声明自己绑定了 X 的产物"，而不是
//   "一份**确实**绑定了 X 的产物"。它是本层唯一能证伪"来源被换过"的通道。
//
// ★ 失败必须**拒绝产出**（fail-closed）：宁可不给分，也不给一份来路不明的分。
//   因此这里返回错误列表，由驱动决定 exit≠0（不写产物）。

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * 校验 L4 依赖的上游逐字节身份。
 *
 * ★★ 关于 `doc.sha256` 到底是谁的 sha（实测踩过，2026-09-24）：
 *   L1 把它定为**学生上传原件的字节**（`l1.mjs`：`createHash(...).update(await fs.readFile(file))`，
 *   `file` 是 `cs3223-writeup.pdf`），而**不是**抽取出来的 `.txt`。
 *   这是对的 —— 全项目核心原则是「原文 = 学生上传原件」：文档身份必须绑原件，
 *   因此不能拿它去比对 `.txt` 的 sha。L4 读的 `.txt` 由 `doc.text_file` 指明，
 *   它的完整性由 L4 自己**逐字切片断言**兜底（full.slice(offset) === quote 那批不变量）。
 *   本条校验因此只做两件事：① 所有上游声明的 doc.sha256 **必须一致**（同一份作业）；
 *   ② index 的条目 offset 必须落在 L4 实际读到的文本范围内（结构没被换过）。
 *
 * 全部比对都是**字节级**（重新算 sha），绝不信任产物里自报的字段。
 * @returns {{ok: boolean, errors: string[], shas: object, parsed: object}}
 */
export function verifyUpstreamIdentity({
  rubricSourceBody = null, rubric,
  profileBody, profile,
  evidenceBody, verificationBody, indexBody, docBody,
}) {
  const errors = [];
  const sha = s => sha256Hex(s);
  const parsed = { evidence: null, verification: null, index: null };

  // ① rubric：`source.sha256` 指的是**原始 rubric 文本**（`source.file`）的字节，不是 canonical JSON 的。
  //   传了原文就逐字节核；没传就只能核"它自报的 source 结构是否完整"（并在报告里说明）。
  if (!rubric) errors.push('rubric 未解析');
  else {
    if (!SHA_RE.test(rubric.source?.sha256 ?? '')) errors.push('rubric.source.sha256 缺失或格式不对');
    if (!rubric.source?.file) errors.push('rubric.source.file 缺失（无法确认绑的是哪份原件）');
    if (rubricSourceBody !== null) {
      const actual = sha(rubricSourceBody);
      if (actual !== rubric.source.sha256) {
        errors.push(`rubric.source.sha256 与 rubric 原文(${rubric.source?.file})实际字节不符：${rubric.source?.sha256} ≠ ${actual}`);
      }
    }
  }

  // ② profile 是对着**某个** rubric 原件做的 —— 原件换了，profile 立即失效
  if (profile?.rubric?.source_sha256 !== rubric?.source?.sha256) {
    errors.push(`profile.rubric.source_sha256(${profile?.rubric?.source_sha256 ?? 'null'}) 与 rubric.source.sha256(${rubric?.source?.sha256 ?? 'null'}) 不一致 → 证据链断裂`);
  }

  // ③ L2 证据必须绑定**同一个** rubric
  try { parsed.evidence = JSON.parse(evidenceBody); } catch { errors.push('evidence 文件不是合法 JSON'); }
  // ④ L3 验证同样的绑定
  try { parsed.verification = JSON.parse(verificationBody); } catch { errors.push('verification 文件不是合法 JSON'); }
  // ⑤ L1 索引：它是对**这份原件**建的结构索引，原文换一个字节就必须重做
  try { parsed.index = JSON.parse(indexBody); } catch { errors.push('index 文件不是合法 JSON'); }

  for (const [layer, obj] of [
    ['evidence(L2)', parsed.evidence],
    ['verification(L3)', parsed.verification],
  ]) {
    if (!obj) continue;
    const r = obj.authority?.rubric_sha256 ?? obj.rubric?.source_sha256 ?? null;
    if (r === null || r === undefined) errors.push(`${layer} 未声明 rubric_sha256（无法确认它与本 rubric 同源）`);
    else if (r !== rubric?.source?.sha256) errors.push(`${layer}.rubric_sha256 与 rubric.source.sha256 不一致`);
  }

  // ★ doc 身份：index 是原件身份的**权威**（它由 L1 从原件算出），其余层必须与它一致。
  const docName = parsed.index?.doc?.name ?? null;
  const docSha = parsed.index?.doc?.sha256 ?? null;
  if (!parsed.index) { /* 已记 JSON 错误 */ }
  else {
    if (!docName) errors.push('index.doc.name 缺失');
    if (!SHA_RE.test(docSha ?? '')) errors.push('index.doc.sha256 缺失或格式不对');
    for (const [layer, obj] of [['evidence(L2)', parsed.evidence], ['verification(L3)', parsed.verification]]) {
      if (!obj?.doc) { errors.push(`${layer}.doc 缺失（无法确认它绑的是同一份原件）`); continue; }
      if (obj.doc.sha256 !== docSha) {
        errors.push(`${layer}.doc.sha256 与 index.doc.sha256 不一致（不是同一份原件）`);
      }
      if (obj.doc.name && docName && obj.doc.name !== docName) {
        errors.push(`${layer}.doc.name(${obj.doc.name}) 与 index.doc.name(${docName}) 不一致`);
      }
    }
    // 结构被换过的最小证据：条目 offset 必须单调不重叠，且落在 L4 实际读到的文本范围内
    const entries = parsed.index.entries ?? [];
    if (!entries.length) errors.push('index 没有任何条目');
    else {
      let prev = -1, monotone = true;
      for (const e of entries) {
        if (!(Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= prev && e.end >= e.start)) { monotone = false; break; }
        prev = e.start;
      }
      if (!monotone) errors.push('index.entries 的 offset 不是单调不重叠的');
      const lastEnd = Math.max(...entries.map(e => e.end ?? 0));
      if (docBody !== undefined && docBody !== null && lastEnd > docBody.length) {
        errors.push(`index 末条 offset(${lastEnd}) 超出 L4 读到的正文长度(${docBody.length})`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    shas: {
      rubric_source: rubric?.source?.sha256 ?? null,
      rubric_file: sha(rubricSourceBody ?? ''),
      profile: sha(profileBody),
      evidence: sha(evidenceBody),
      verification: sha(verificationBody),
      index: sha(indexBody),
      doc: docSha,
      doc_text: docBody === undefined || docBody === null ? null : sha(docBody),
    },
    parsed,
  };
}

// ------------------------------------------------------------------ 装配（唯一一份：stub 与真实模型共用）

export function assembleAssessmentArtifact({
  doc, rubric, rubricFile, profile, profileFile, profileSha,
  evidenceRef, verificationRef, indexRef, assessments, itemOutcomes, notices,
}) {
  const agg = aggregate({ rubric, profile, assessments });
  const reviewRequired = assessments.filter(a => a.review.required).length;
  const attempted = itemOutcomes.reduce((s, o) => s + o.attempted, 0);
  const accepted = itemOutcomes.reduce((s, o) => s + o.accepted, 0);
  const rejected = itemOutcomes.reduce((s, o) => s + o.rejected, 0);
  const dropCount = k => assessments.reduce((s, a) => s + a.diagnostics[k].length, 0);

  return {
    authority: {
      scoring_authority: 'rubric',
      rubric_sha256: rubric.source.sha256,
      layer_produces_score: false,         // ★ v0.3：模型不再提交分数 —— 定性评价 + 候选档位，分值权完全归教师
      advisory_only: true,
      final_score_requires_teacher_review: true,
      layer_version: L4_VERSION,
      notes: 'L4 v0.3 按**原 rubric 条目**产出结构化定性评估（findings + judgment/候选档位），不产出分数。'
        + 'points/binary 条目给五值 judgment；levels 条目给 1–2 个相邻候选档（教师选最终档；唯一候选也只是「AI 建议档位」）。'
        + '每个定性发现都锚定可回溯依据（quote 逐字绑定 / L3 check 挂钩）；审查路由由系统规则强制。',
    },
    doc,
    rubric: { rubric_id: rubric.rubric_id, source_sha256: rubric.source.sha256, file: rubricFile },
    assessment_profile: { profile_id: profile.profile_id, version: profile.version, status: profile.status, file: profileFile, sha256: profileSha },
    evidence: evidenceRef,
    verification: verificationRef,
    index: indexRef,
    assessments,
    aggregation: agg,
    diagnostics: {
      diagnostic_only: true,
      l4_version: L4_VERSION,
      attempted, accepted, rejected,
      // ★ 账目必须平：一次调用要么变成一条 assessment，要么出现在 rejected_calls 里
      accounted: attempted === accepted + rejected,
      items_total: itemOutcomes.length,
      items_incomplete: itemOutcomes.filter(o => o.accepted === 0).map(o => o.item_id),
      review_required: reviewRequired,
      rejected_calls: itemOutcomes.flatMap(o => o.rejected_calls),
      dropped_refs: {
        evidence: dropCount('dropped_evidence_refs'),
        verification: dropCount('dropped_verification_refs'),
        supplemental: dropCount('dropped_supplemental_quotes'),
        asset: dropCount('dropped_asset_refs'),
        findings: dropCount('dropped_findings'),
      },
      document_checks_not_used_for_score: verificationRef.document_checks ?? 0,
      turns: itemOutcomes.map(o => ({ rubric_item_id: o.item_id, turns: o.turns, done: o.done, attempted: o.attempted, accepted: o.accepted, rejected: o.rejected })),
      notices: notices ?? null,
      not_final: '定性评估，不含分值；最终分数由教师决定。每条 assessment 的 review.required 由系统规则强制，模型只能建议。',
    },
  };
}

// ------------------------------------------------------------------ 工具面 + 提示词

// ★ 工具 schema **按条目的 scoring_strategy 动态生成**（v0.3）：
//   levels 条目的工具里**没有** judgment 字段；points/binary 条目的工具里**没有** level_status /
//   candidate_level_ids / boundary_condition 字段。「走错分支」在 schema 层物理不可能 ——
//   这比 if/then 更强（validator 不支持 not/anyOf，动态生成恰好绕开这个限制）。
//   两个分支都**没有 score 字段**：模型给分没有落点，分值权归教师。
export function l4Tools(strategyType = null) {
  const isLevels = strategyType === 'levels';
  const findingSchema = {
    type: 'object', additionalProperties: false,
    required: ['polarity', 'kind', 'note'],
    properties: {
      polarity: { type: 'string', enum: FINDING_POLARITIES, description: 'strength=做得好 / concern=有问题 / neutral=中性观察（封闭三值，不合并红黄绿）' },
      kind: { type: 'string', enum: FINDING_KINDS, description: '宽类别：calculation / reasoning / completeness / presentation / other（拿不准就 other；细节写进 note，不做成硬枚举）' },
      note: { type: 'string', minLength: 1, maxLength: 500, description: '具体说明：学生哪里做得好/有问题。这是模型派生判断，不是原始证据' },
      severity: { type: ['string', 'null'], enum: [...FINDING_SEVERITIES, null], description: '影响程度：major / minor（可选）' },
      quote: { type: ['string', 'null'], description: '可选的原文定位：逐字引用（系统绑定后回填 located；绑不上会转人工复核）' },
      entry_hint: { type: ['string', 'null'], description: 'L1 条目 id 提示，用于消歧' },
      check_id: { type: ['string', 'null'], description: '可选的 L3 check 挂钩：可机械验证的断言（如计算错误）应当挂钩，而不是凭眼睛断言' },
      // ★★ warrant：**"有依据的内容错误候选"**（2026-09-24 定）。
      //   只用于"学生这里**写错了**（内容错误）"这类主张 —— 风格/形式问题、单纯的缺项，都不要填。
      //   ★ 它**不是一个自我声明的布尔值**：三要素必须给全，且系统会**逐项核验**
      //     （原话能否在原文定位、"错在哪"是否成文、依据是否成文且可核验），通过才写 `warrant.bound = true`。
      //     ★ 但 bound=true **只说明依据绑上了，不说明解释正确** —— 教师仍需核对内容。
      //   ★ 依据不足但可能重要的观察也应写进来 —— 系统会标 bound=false，让它落到「待核查」而不是第一屏。
      warrant: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['student_quote', 'what_is_wrong', 'basis_kind', 'basis_detail'],
        description: '仅在主张"学生此处写错了（内容错误）"时填写。三要素：学生原话 + 具体错在哪 + 判断依据。',
        properties: {
          student_quote: { type: 'string', minLength: 4, description: '① 学生原话：逐字引用（系统会去原文定位；定位不到即判不成立）' },
          what_is_wrong: { type: 'string', minLength: 10, maxLength: 400, description: '② 具体错在哪里：写清"正确的是什么、学生错在哪一步"，不要只说"不准确/有问题"' },
          basis_kind: { type: 'string', enum: WARRANT_BASIS_KINDS, description: '③ 依据类型：rubric 条文或档位要求 / 报告自身自相矛盾 / L3 机械验证结果' },
          basis_detail: { type: 'string', minLength: 10, maxLength: 400, description: '③ 依据的具体内容：写出 rubric 的哪条要求，或报告里哪两处互相矛盾（给两处原话），或哪个 check 的结论' },
          basis_check_id: { type: ['string', 'null'], description: '当 basis_kind=l3_check 时必填：L3 的 check_id（系统核验其真实存在）' },
        },
      },
    },
  };
  const refSchemas = {
    evidence_refs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['bundle_id', 'span_indices', 'role'],
        properties: {
          bundle_id: { type: 'string', description: 'L2 证据 bundle 的 id（必须真实存在）' },
          span_indices: { type: 'array', items: { type: 'integer', minimum: 0 } },
          role: { type: 'string', enum: REF_ROLES },
        },
      },
    },
    asset_refs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['asset_id', 'role'],
        properties: {
          asset_id: { type: 'string', description: '形如 page-3（只能用材料里给出的那些）' },
          role: { type: 'string', enum: REF_ROLES },
        },
      },
    },
    verification_refs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['check_id', 'impact'],
        properties: {
          check_id: { type: 'string', description: 'L3 check 的 id（必须真实存在）' },
          impact: { type: 'string', enum: IMPACTS, description: 'pass 不能标 contradict；fail 不能标 support；unverified 只能 neutral' },
        },
      },
    },
    supplemental_quotes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['quote', 'role'],
        properties: {
          quote: { type: 'string', description: '逐字来自原文（L2 没找到的重要材料可以这样补上）' },
          entry_hint: { type: ['string', 'null'], description: 'L1 条目 id 提示，用于消歧' },
          role: { type: 'string', enum: REF_ROLES },
        },
      },
    },
    rationale: {
      type: 'string', minLength: 1, maxLength: RATIONALE_HARD_MAX,
      description: `建议 ≤${RATIONALE_TARGET} 字。**超过不会拒收** —— 只会记进诊断并强制转人工复核；`
        + `只写能由依据支持的话。这是模型派生判断，不是原始证据。（${RATIONALE_HARD_MAX} 字是防爆量的工程上限，撞到才会被拒。）`,
    },
  };
  const common = {
    rubric_item_id: { type: 'string', description: '必须是本次被问的那个条目 id' },
    findings: { type: 'array', description: '结构化定性发现（可以给空数组，但字段必须出现）', items: findingSchema },
    ...refSchemas,
  };
  const branch = isLevels
    ? {
      level_status: {
        type: 'string', enum: LEVEL_STATUSES,
        description: 'candidate=有依据提出候选档；insufficient_evidence=原件不可读/关键图表无法核实/原文覆盖不可靠，无法判断；'
          + 'not_applicable=这条标准不适用于该作业（≠ 学生没写）；outside_defined_levels=已通读可靠完整原文仍无相关内容、'
          + '但所有档位都预设"学生写了"（此时 candidate_level_ids 必须为空，系统会转教师裁决——不许硬选低档，也不许自造档）',
      },
      candidate_level_ids: {
        type: 'array', minItems: 0, maxItems: 2, items: { type: 'string' },
        description: 'level_status=candidate 时必填：通常 1 个最符合的档；边界不清时给**相邻** 2 个。只能用评分标准里已列出的 level_id（不许自造）。非 candidate 状态一律空数组或不填',
      },
      boundary_condition: {
        type: ['string', 'null'], maxLength: 500,
        description: '给 2 个候选档时**必填**：写明卡在哪个条件、两档各差什么',
      },
    }
    : {
      judgment: {
        type: 'string', enum: JUDGMENTS,
        description: 'not_satisfied=已有材料支持"不满足"；insufficient_evidence=材料不足以判断（两者必须分清，'
          + 'L2 没找到 ≠ 学生没写——找不到时先查完整原文，仍无法判断就用后者）',
      },
    };
  return [{
    type: 'function',
    function: {
      name: 'submit_rubric_assessment',
      description: isLevels
        ? '提交**当前这一个** rubric 条目的定性评估（候选档位 + 结构化发现 + 可回溯依据）。不评分——教师选最终档。只评这一个条目；依据必须逐字来自原文。'
        : '提交**当前这一个** rubric 条目的定性评估（判断 + 结构化发现 + 可回溯依据）。不评分——教师给分。只评这一个条目；依据必须逐字来自原文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: isLevels
          ? ['rubric_item_id', 'level_status', 'findings', 'evidence_refs', 'rationale']
          : ['rubric_item_id', 'judgment', 'findings', 'evidence_refs', 'rationale'],
        properties: { ...common, ...branch },
      },
    },
  }];
}

export const L4_SYSTEM_PROMPT = [
  '你是评分助手：按**原 rubric 的某一个条目**给出定性评估（结构化发现 + 判断/候选档位），并给出可回溯的依据。',
  '你不改评分标准，也**不给分** —— 分数完全由教师决定；你做的是教师最需要你做的事：把做得好的和有问题的地方找出来、钉到原文上。',

  '',
  '硬约束：',
  '1. 你**只能**通过 submit_rubric_assessment 提交，一次只提交这一个条目。**没有任何分数字段** —— 不要试图给分。',
  '2. 契约按条目的评分策略分支（工具字段就是本次该用的那套）：',
  '   **points / binary** → 给 judgment 五值判断（satisfied / partially_satisfied / not_satisfied / insufficient_evidence / not_applicable）；',
  '   **levels** → 给 level_status：通常 candidate + 1 个最符合的档（level_id 只能用标准里已列出的）；',
  '   边界不清时给**相邻** 2 个档并写明 boundary_condition（卡在哪个条件、两档各差什么）—— 教师选最终档。',
  '   ★ 不许自造标准里没有的档。通读了完整原文仍找不到相关内容、而所有档位都预设"学生写了"时，',
  '   用 outside_defined_levels 并留空候选 —— 绝不硬选低档来"表达没写"（那是对档位语义的改写）。',
  '3. findings 是你的主要交付物：每条 = 做得好(strength) / 有问题(concern) / 中性观察(neutral) + 宽类别 + 具体说明。',
    '3b. ★ 如果你要主张「学生这里**写错了**」（内容错误，而非风格/形式问题、也不只是缺项），请在这条 finding 上填 warrant：'
    + '① 学生原话（逐字）② 具体错在哪里（正确的是什么、错在哪一步）③ 判断依据（rubric 哪条要求 / 报告自身哪两处互相矛盾 / 哪个 L3 check 的结论）。'
    + '系统会逐项核验：原话必须能在原文定位、②③要成文、依据若是 L3 check 必须真实存在 —— 核验通过才算「有依据的内容错误候选」，才有资格进教师的第一屏。'
    + '★ 依据不足但你仍觉得可能重要的，也请填 warrant 并如实写你能给的依据 —— 系统会把它标为"未通过核验"，归入待核查，而不是硬拗成结论。'
    + '★ 缺项（学生没写）与形式问题（语法、表述）**不要**填 warrant。',
  '   尽量给出原文定位（quote 逐字引用）；**可机械验证的断言（如"计算错误"）必须挂 L3 check（check_id），不许凭眼睛断言**。',
  '4. 依据分三类：evidence_refs（L2 候选证据，给 bundle_id + span_indices）、',
  '   verification_refs（L3 机械验证结论，给 check_id + impact）、supplemental_quotes（L2 没找到、但你在完整原文里读到的重要材料，逐字引用）。',
  '   所有引用都必须真实存在、逐字命中；绑不回去的引用会被丢弃，并因此转入人工复核。',
  '5. impact 的语义是固定的：pass 只能 support/neutral，fail 只能 contradict/neutral，unverified 只能 neutral。',
  '6. 分清这两件事：**not_satisfied / outside_defined_levels** = 已有材料支持"不满足/没写"；**insufficient_evidence** = 现有材料不足以可靠判断。',
  '   L2 没召回 ≠ 学生没写 —— 完整原文已经给你了，先查原文；原文覆盖本身不可靠（原件不可读、关键图表无法核实）才用 insufficient_evidence。',
  '   ★ 没有"建议送审"这个字段：该不该人工复核由系统规则判定，你只需要把判断和依据给准。',
  '7. rationale 建议 ≤300 字：超了**不会拒收**，但会记进诊断并转人工复核。只写能由依据支持的话；它是你的派生判断，不是原始证据。',
].join('\n');

export function assessmentMessage({ item, pItem, bundles, checks, documentChecks, assets, idx, full }) {
  const st = pItem?.scoring_strategy;
  // ★ 把**标准原文**交给模型：levels 给每个等级的原文描述，points 给条项与各自分值。
  //   不给就等于让它自己编"L3 是什么意思"—— 这是我们不该替它省的一步。
  //   v0.3：策略段按分支说明提交方式（levels = 候选档，points = judgment），不再出现"分数"字样。
  const standardLines = !st ? ['（该条目不可评分）']
    : st.type === 'levels'
      ? [
        `levels：给 level_status + 候选档。通常 1 个最符合的档；边界不清给**相邻** 2 个 + boundary_condition（教师选最终档）`,
        ...st.levels.map(l => `  ${l.level_id} (${l.score} 分)  ${l.text ?? '（无描述）'}`),
        '★ 只能用上面列出的 level_id；标准里没有的档不许自造。min/max 只是满分参考，你不需要给任何分数。',
      ]
      : st.type === 'points'
        ? [
          `points：给 judgment（五值定性判断，不给分）。条项满足情况写进 findings（哪条做到/没做到、差在哪）`,
          ...(st.criteria ?? []).map((c, i) => `  ${i + 1}) [${c.points} 分]  ${c.text}`),
          `满分 ${st.max} 分只是参考 —— 教师给分。`,
        ]
        : [
          'binary：给 judgment（satisfied / not_satisfied 的定性判断 + 依据，不给分）。',
        ];
  const nav = (idx.entries ?? []).map(e => `${e.id}\t${e.type}\tp${e.page ?? '-'}\t${e.start}-${e.end}\t${e.text.replace(/\n/g, '\\n').slice(0, 60)}`);
  const spans = bundles.map(b => [
    `${b.id}  facet=${b.facet_id}`,
    ...b.spans.map((s, i) => `  span[${i}] ${s.offset.start}-${s.offset.end}  ${JSON.stringify(s.quote)}  match_type=${s.match_type ?? '-'} found_by=${JSON.stringify(s.found_by ?? [])}`),
  ].join('\n'));
  const checkLines = (checks ?? []).map(c => {
    const nums = c.stance === 'fail' || c.stance === 'pass'
      ? `  computed=${c.computed?.value ?? '-'} 期望=${c.expected?.value ?? '-'} 容差=${c.tolerance ?? '-'}`
      : `  原因=${JSON.stringify(c.reason_codes ?? [])}`;
    return `${c.id}  [${c.stance}]  ${c.kind}/${c.operator}${nums}`;
  });
  return [
    '## 任务',
    `按 rubric 条目 **${item.id}** 给出定性评估（结构化发现 + 判断/候选档位），并给出可回溯依据。只评这一个条目；不给分 —— 教师给分。`,
    '',
    '## rubric 条目（唯一评分权威；它的字面范围不可被改写）',
    `- ${item.id}  ${item.text}`,
    `  原文出处：${item.source_ref.file} ${item.source_ref.start}-${item.source_ref.end}（评分策略就是从这一段读出来的）`,
    '',
    '## 评分策略（系统执行配置 —— 不是你定的，也不能改）',
    st ? `type=${st.type}  满分参考 max=${st.max}` : '（该条目不可评分）',
    '',
    '## 该条目的评分标准原文（逐字来自 rubric，这就是标准本身）',
    standardLines.join('\n'),
    '',
    '## 该条目的候选证据（L2 产出 —— 注意力信号，**不是**信息边界）',
    spans.join('\n') || '（无）',
    '',
    '## 该条目的机械验证结论（L3 产出 —— 辅助事实；可机械验证的断言应挂钩它）',
    checkLines.join('\n') || '（无）',
    '',
    ...(documentChecks?.length ? [
      '## 文档级机械验证（不归属任何条目；可以引用，但要自己判断它与本条目的关系）',
      documentChecks.map(c => `${c.id}  [${c.stance}]  ${c.kind}/${c.operator}`).join('\n'),
      '',
    ] : []),
    ...(assets?.length ? [
      '## 可引用的页面图（视觉内容只能看图判断）',
      assets.map(a => `${a.asset_id}  ${a.file}  ${a.note ? `(${a.note})` : ''}`).join('\n'),
      '（这些图片已作为附件给出；引用时用 asset_refs 里的 asset_id）',
      '',
    ] : []),
    '## 索引导航（L1 产出，用于定位）',
    nav.join('\n'),
    '',
    '## 完整原文（逐字，未经任何改写。所有 quote 都必须能在这里找到）',
    '```',
    full,
    '```',
  ].join('\n');
}
