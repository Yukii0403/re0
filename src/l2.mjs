// l2.mjs —— L2 Evidence Focus 的实现：R（产出 retrieval plan）+ F（逐条独立定位）
//
// 分工与全项目一致：**模型只提交结构引用与逐字引用串，偏移一律由系统算**。
//   R：模型把 rubric 条目拆成 facet（检索面）与盲点。只输出结构 —— rubric 文本一个字都不由模型产生。
//       facet 的 id 由系统编（F1、F2…），rubric_item_id 必须在 canonical rubric 里存在，
//       且**必须覆盖全部条目**（宁可多不可漏）。
//   F：模型针对**单个 facet** 提交候选引用串（quote）与强弱（match_type）；系统用 quote-binding
//       绑回原文，绑不上即判废并留痕（dropped，可见）。
//
// 硬规则（机械强制，不靠模型自觉）：
//   · status ∈ {source_unavailable, channel_error} ⇒ outcome 必须 undetermined。
//     模型给了别的组合 → 系统**覆写**为 undetermined 并记 overridden:true ——
//     既不放行错误组合，也不丢掉模型原本说的话。
//   · 产物里不存在 recall 字段（诊断不是召回）。evidence recall 只在评测环节用 gold set 算。
//
// 检索面（facet）与盲点的区别（两者都不能说成"学生没写"）：
//   · 检索盲点：R 转不出任何可检索的材料面（措辞本身是判断，如「充分」「合理」）→ 在 R 阶段暴露
//   · 未找到候选：有检索面，但原文里没找到材料 → 记 outcome=no_candidate

import { bindQuote, allOccurrences, entryCovering } from './quote-binding.mjs';

export const FORMS = ['value', 'relation', 'narrative', 'procedure'];
export const MODALITIES = ['text', 'table', 'figure', 'formula', 'code'];
export const MATCH_TYPES = ['verbatim', 'synonym', 'implicit', 'cross_block'];
export const FACET_STATUS = ['complete', 'partial', 'source_unavailable', 'channel_error'];
export const FACET_OUTCOME = ['located', 'no_candidate', 'undetermined'];
// 硬规则：这两个健康度异常时，不许报 located / no_candidate
export const UNHEALTHY_STATUS = ['source_unavailable', 'channel_error'];
export const CHANNELS = [
  'rule:numeric', 'rule:relation', 'rule:numbering', 'rule:keyword',
  'structure:table', 'structure:figure', 'structure:formula', 'structure:code',
  'llm:semantic',
];

export const L2_REJECT_CODES = [
  'unknown_tool', 'malformed_arguments_json', 'arguments_failed_schema',
  'unknown_rubric_item', 'unknown_facet', 'plan_incomplete', 'internal_tool_error', 'budget_exhausted',
  // ★ 一轮里回来多个 tool_call：只处理第一个，其余明确拒绝。
  //   关键不是"拒"本身，而是**每一个 tool_call_id 都必须有回执** —— 少一个下一次请求就是 400（实测踩到）。
  'one_plan_per_call', 'one_facet_per_call',
];

// ------------------------------------------------------------------ 工具定义

const FACET_PROPS = {
  text: { type: 'string', description: '检索面：一个可在原文里查找的材料面（不要写评分措辞）' },
  form: { type: 'string', enum: FORMS, description: '语义形式：要找的是一句什么样的话' },
  modality: { type: 'array', minItems: 1, items: { type: 'string', enum: MODALITIES } },
  channels: { type: 'array', minItems: 1, items: { type: 'string', enum: CHANNELS }, description: '跑哪几条检索网' },
};

export function l2Tools() {
  return [
    {
      type: 'function',
      function: {
        name: 'submit_retrieval_plan',
        description: '提交 retrieval plan：把 rubric 条目拆成检索面（facet）与检索盲点。'
          + '必须覆盖 rubric 的**全部叶子条目**；**汇总型父项（下面标了子项的那些）不要给 facet** —— '
          + '它们由子项覆盖，单独检索只会产生重复证据。父项上仍可以记 blind_spots。'
          + '只输出结构，不要改写 rubric 文本。不要自己编 facet id —— 系统会编。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            items: {
              type: 'array', minItems: 1,
              items: {
                type: 'object', additionalProperties: false,
                required: ['rubric_item_id', 'facets'],
                properties: {
                  rubric_item_id: { type: 'string', description: '必须逐字等于 canonical rubric 里的条目 id' },
                  facets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'form', 'modality', 'channels'], properties: FACET_PROPS } },
                  blind_spots: {
                    type: 'array',
                    items: {
                      type: 'object', additionalProperties: false, required: ['text'],
                      properties: { text: { type: 'string' }, reason: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'submit_facet_candidates',
        description: '针对**某一个 facet** 提交候选证据。只给逐字引用串（quote）—— '
          + '不要给偏移、不要给数字、不要写评价。系统会把 quote 绑回原文；绑不上就判废。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['rubric_item_id', 'facet_id', 'candidates', 'status', 'outcome'],
          properties: {
            rubric_item_id: { type: 'string' },
            facet_id: { type: 'string', pattern: '^F[0-9]{1,3}$' },
            candidates: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['quote', 'match_type'],
                properties: {
                  quote: { type: 'string', description: '逐字来自原文的片段' },
                  match_type: { type: 'string', enum: MATCH_TYPES },
                  note: { type: 'string', maxLength: 120 },
                },
              },
            },
            status: { type: 'string', enum: FACET_STATUS, description: '检索健康度' },
            outcome: { type: 'string', enum: FACET_OUTCOME },
            reason: { type: ['string', 'null'] },
          },
        },
      },
    },
  ];
}

// ------------------------------------------------------------------ R：校验与建 plan

// 结构性错误 → 整次调用被拒（不产生半成品 plan）
// ★ 汇总型父项**允许不被 R 拆解**（它由子项覆盖）；叶子条目必须全在，漏了整次拒收。
export function validatePlanArgs(args, rubricItems) {
  const errors = [];
  const ids = new Set((rubricItems ?? []).map(r => r.id));
  const isSummary = id => {
    const it = (rubricItems ?? []).find(r => r.id === id);
    return !!it && Array.isArray(it.children) && it.children.length > 0;
  };
  const seen = new Set();
  for (const it of args?.items ?? []) {
    if (!ids.has(it.rubric_item_id)) errors.push(`rubric_item_id 不在 canonical rubric 里：${it.rubric_item_id}`);
    if (seen.has(it.rubric_item_id)) errors.push(`rubric_item_id 重复：${it.rubric_item_id}`);
    seen.add(it.rubric_item_id);
  }
  const missing = [...ids].filter(id => !seen.has(id) && !isSummary(id));
  if (missing.length) errors.push(`未覆盖的非汇总条目：${missing.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

export function planFromArgs(args, { rubric, rubricSha256, planId, batchId, version = 1, now, generator = 'l2/0.1.0' }) {
  // 以 canonical rubric 为准逐条铺开：叶子条目用模型给的 facet，汇总父项强制清空 facet
  const byId = new Map((args.items ?? []).map(x => [x.rubric_item_id, x]));
  const items = rubric.items.map(rubricItem => {
    const summary = Array.isArray(rubricItem.children) && rubricItem.children.length > 0;
    const given = byId.get(rubricItem.id);
    const blind = given?.blind_spots?.length ? { blind_spots: given.blind_spots } : {};
    if (summary) {
      // ★ 汇总父项不生成 facet：它由子项覆盖，单独检索只会产生重复证据与多余的模型调用。
      //   仍然留在 plan 里（覆盖率与盲点要看得见它），并带上子项 id 作为跳过的依据。
      return {
        rubric_item_id: rubricItem.id,
        summary: true,
        children: rubricItem.children,
        facets: [],
        ...blind,
      };
    }
    return {
      rubric_item_id: rubricItem.id,
      facets: (given?.facets ?? []).map((f, i) => ({
        id: 'F' + (i + 1),
        text: f.text,
        form: f.form,
        modality: f.modality,
        channels: f.channels,
      })),
      ...blind,
    };
  });
  const skippedParentFacets = (args.items ?? []).reduce((n, x) => {
    const it = rubric.items.find(r => r.id === x.rubric_item_id);
    return n + (it?.children?.length ? (x.facets?.length ?? 0) : 0);
  }, 0);
  return {
    plan_id: planId,
    version,
    batch_id: batchId,
    pinned: true,
    generated_at: now,
    generator,
    revision_note: null,
    rubric_sha256: rubricSha256,
    revision_log: [{
      version, at: now, by: null,
      change: `R 初版（由模型拆解，系统编号与校验）；跳过 ${items.filter(i => i.summary).length} 个汇总父项的 facet`
        + (skippedParentFacets ? `（模型多给的 ${skippedParentFacets} 个父项 facet 已丢弃，避免重复证据）` : ''),
    }],
    items,
  };
}

// ------------------------------------------------------------------ 通道判据（全机械）

function channelsHit(facet, span, entry, full) {
  const t = span.quote;
  const hit = new Set();
  for (const ch of facet.channels) {
    switch (ch) {
      case 'rule:numeric': if (/\d/.test(t)) hit.add(ch); break;
      case 'rule:relation': if (/(相比|相较|对比|优于|高于|低于|提升|下降|增加|减少|差异|因为|导致)/.test(t)) hit.add(ch); break;
      case 'rule:numbering': if (/^[图表式]\s*[0-9]/.test(t.trim()) || /^[图表]\s*[0-9]/.test(entry?.text?.trim() ?? '')) hit.add(ch); break;
      case 'rule:keyword': if (/(def |import |return |for |while |=\s*\w+\()/.test(t)) hit.add(ch); break;
      case 'structure:table': if (entry?.table_id) hit.add(ch); break;
      case 'structure:figure': if (entry?.type === 'figure') hit.add(ch); break;
      case 'structure:formula': if (entry?.type === 'formula') hit.add(ch); break;
      case 'structure:code': if (entry?.type === 'code') hit.add(ch); break;
      // 语义通道：这条引用是模型提交的 —— 若该面声明了语义通道，它就算命中
      case 'llm:semantic': hit.add(ch); break;
      default: break;
    }
  }
  if (!hit.size) hit.add(facet.channels[0]);   // 声明了通道，命中至少要归到一条上，不留空
  return [...hit];
}

// 由 facet 声明的模态/通道推出**系统侧的条目提示**（不是模型给的）——
// 这是三级绑定里 entry_hint 那一级的来源。
function hintsForFacet(facet, entries) {
  const ids = new Set();
  if (facet.modality.includes('table')) for (const e of entries) if (e.table_id) ids.add(e.id);
  if (facet.modality.includes('figure')) for (const e of entries) if (e.type === 'figure') ids.add(e.id);
  if (facet.modality.includes('code')) for (const e of entries) if (e.type === 'code') ids.add(e.id);
  if (facet.modality.includes('formula')) for (const e of entries) if (e.type === 'formula') ids.add(e.id);
  return ids;
}

// ------------------------------------------------------------------ F：把候选引用绑回原文

export function resolveCandidates({ full, entries, facet, args, docRef, ctx = 14, cursorStart = 0 }) {
  const hints = hintsForFacet(facet, entries);
  const spans = [];
  const dropped = [];
  let cursor = cursorStart;
  for (const c of args.candidates ?? []) {
    // 系统算提示：优先绑到"该 facet 的模态所指向的那些条目"里
    let entryHint = null;
    for (const o of allOccurrences(full, c.quote)) {
      const e = entryCovering(entries, o, o + c.quote.length);
      if (e && (hints.size === 0 || hints.has(e.id))) { entryHint = e.id; break; }
    }
    const b = bindQuote(full, c.quote, { entryHint, entries, cursor });
    if (!b.ok) {
      dropped.push({ quote: c.quote, reason: b.reason ?? 'quote_not_found', occurrences: b.occurrences ?? 0 });
      continue;
    }
    cursor = b.end;   // 游标推进：同一批引用不会互相抢同一处
    const e = entryCovering(entries, b.start, b.end);
    if (!e) {
      dropped.push({ quote: c.quote, reason: 'no_covering_entry', occurrences: b.occurrences ?? 0 });
      continue;
    }
    const span = {
      quote: c.quote,
      source_ref: { file: docRef.name, sha256: docRef.sha256, page: e.page ?? null, entry: e.id },
      offset: { start: b.start, end: b.end },
      context: { before: full.slice(Math.max(0, b.start - ctx), b.start), after: full.slice(b.end, b.end + ctx) },
      match_type: c.match_type,
      found_by: [],
    };
    span.found_by = channelsHit(facet, span, e, full);
    span.binding = { mode: b.mode, occurrences: b.occurrences, ...(b.ambiguous ? { ambiguous: true } : {}) };
    spans.push(span);
  }
  // 同一处只留一份（模型可能重复报）
  const uniq = [];
  const seen = new Set();
  for (const s of spans) {
    const k = `${s.offset.start}-${s.offset.end}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
  }
  // ★ 图/表类 facet 需要「读取原始页面的能力」：文本层里没有图的像素。
  //   这不是模型的决定 —— 由 facet 声明的模态机械推出要渲染哪几页。
  const pages = [];
  if (facet.modality.includes('figure') || facet.modality.includes('table')) {
    for (const s of uniq) {
      const e = entries.find(x => x.id === s.source_ref.entry);
      if (e && typeof e.page === 'number' && !pages.includes(e.page)) pages.push(e.page);
    }
  }
  return { spans: uniq, dropped, hintSize: hints.size, pages };
}

// ------------------------------------------------------------------ 硬规则：模型的 outcome 与机械事实不符时覆写
//
// 两条都是"模型的声明不许越过机械事实"：
//   ① status ∈ {source_unavailable, channel_error} ⇒ outcome 必须 undetermined
//   ② 报 located 但**一个候选都没绑上原文** ⇒ 无法判定（提交的候选有问题 ≠ 材料里没有）
// 覆写时保留模型原本的说法（outcome_claimed），既不放行错误组合，也不丢掉它说了什么。

export function applyHardRule({ status, outcome, locatedCount = null }) {
  if (UNHEALTHY_STATUS.includes(status) && outcome !== 'undetermined') {
    return { status, outcome: 'undetermined', overridden: true, claimed_outcome: outcome };
  }
  if (outcome === 'located' && locatedCount === 0) {
    return { status, outcome: 'undetermined', overridden: true, claimed_outcome: outcome };
  }
  return { status, outcome, overridden: false, claimed_outcome: outcome };
}

// ------------------------------------------------------------------ 产物装配（与设计示例同一份契约）

export function assembleEvidence({ doc, rubricRef, plan, planFile, planSha256, evidence, coverage, scannedRange, notice }) {
  const summary = plan.items.map(it => {
    const own = (evidence ?? []).filter(e => e.rubric_item_id === it.rubric_item_id);
    const fc = coverage.filter(c => c.rubric_item_id === it.rubric_item_id);
    // ★ 汇总父项不参与检索 —— 必须**显式**标出来。写成 no_candidate 会被读成「没找到」，那是另一件事。
    if (it.summary) {
      return {
        rubric_item_id: it.rubric_item_id,
        candidates: 0,
        status: 'complete',
        outcome: 'skipped_summary',
        retrieval_skipped: true,
        children: it.children ?? [],
        scanned: [],
        notes: ['汇总型父项，不单独检索：它由子项覆盖，单独检索只会产生重复证据'],
      };
    }
    const rank = { complete: 0, partial: 1, source_unavailable: 2, channel_error: 3 };
    const worst = fc.reduce((w, f) => (rank[f.status] > rank[w] ? f.status : w), 'complete');
    const outcome = fc.some(f => f.outcome === 'undetermined') ? 'undetermined'
      : fc.some(f => f.outcome === 'located') ? 'located' : 'no_candidate';
    return {
      rubric_item_id: it.rubric_item_id,
      candidates: own.length,
      status: worst,
      outcome,
      scanned: [scannedRange],
      notes: own.length ? [] : ['未找到候选'],
    };
  });

  return {
    authority: {
      scoring_authority: 'rubric',
      rubric_immutable: true,
      rubric_sha256: rubricRef.sha256,
      plan_participates_in_scoring: false,
      notes: '评分权威只有教师上传的原始 rubric；retrieval plan 与候选证据都不参与评分',
    },
    doc,
    rubric: rubricRef,
    retrieval_plan: {
      plan_id: plan.plan_id, version: plan.version, batch_id: plan.batch_id,
      sha256: planSha256, file: planFile, pinned: plan.pinned,
    },
    evidence: evidence ?? [],
    diagnostics: {
      diagnostic_only: true,
      notice: notice ?? ('★ facet coverage 不等于 evidence recall，绝不参与评分 —— '
        + '产物刻意不含 recall 字段；evidence recall 只在评测环节用人工 gold set 计算。'
        + 'channels 是各通道命中数（同一 span 可被多通道命中，故不可相加）；hits 是去重后的 span 数。'),
      facet_coverage: coverage,
      rubric_item_summary: summary,
    },
  };
}

// 每个 facet 的诊断记录（**0 命中的也必须出现**，否则只能看到"哪条找到了"）
export function coverageFor({ plan, decisions, evidence }) {
  const out = [];
  for (const it of plan.items) {
    for (const f of it.facets) {
      const own = (evidence ?? []).filter(e => e.rubric_item_id === it.rubric_item_id && e.facet_id === f.id);
      const spans = own.flatMap(e => e.spans);
      const decisionsForFacet = decisions.filter(d => d.facet_id === f.id && d.rubric_item_id === it.rubric_item_id);
      const last = decisionsForFacet[decisionsForFacet.length - 1];
      const h = applyHardRule({
        status: last?.status ?? 'complete',
        outcome: last?.outcome ?? (spans.length ? 'located' : 'no_candidate'),
        locatedCount: spans.length,
      });
      const ch = {};
      for (const name of [...new Set([...f.channels, ...spans.flatMap(s => s.found_by)])].sort()) {
        ch[name] = spans.filter(s => s.found_by.includes(name)).length;
      }
      out.push({
        rubric_item_id: it.rubric_item_id,
        facet_id: f.id,
        form: f.form,
        modality: f.modality,
        channels: ch,
        hits: spans.length,
        status: h.status,
        outcome: h.outcome,
        reason: last?.reason ?? null,
        ...(h.overridden ? { hard_rule_overridden: true, outcome_claimed: h.claimed_outcome } : {}),
        ...(last?.dropped?.length ? { dropped: last.dropped } : {}),
      });
    }
  }
  return out;
}
