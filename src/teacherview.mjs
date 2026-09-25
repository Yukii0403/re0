// teacherview.mjs —— 教师视图（精简展示）
//
// ★ 定位（Yukii 2026-09-24 定）：交付重心从"AI 精确给分"转到**帮助教师快速形成质量判断**。
//   三层组织：**整篇优先观察 → rubric 条目 → 原文**。
//
// ★★ 三条展示纪律（这个文件存在的理由）：
//   ① **隐藏 AI 的评级**：主视图不展示 AI 候选档位 / AI 判断（judgment / level_status）/
//      任何 AI 分数 —— 教师的第一印象必须建立在**可核查的事实性观察**上，而不是被 AI 的评级锚定。
//      隐藏了什么在产物里**显式声明**（`hidden`），不做静默省略。
//   ② **不确定必须标出来**：无原文定位、也无机械验证挂钩的观察，明确写"请勿当作确定结论"，
//      不许用确定语气包装。
//   ③ **不丢信息**：默认折叠只是"不优先展示"，每条目的观察总数与折叠数都如实记账，
//      教师可展开全部。
//
// ★ 排序**不用分数、不用模型**：只用可解释、可复现的规则（严重程度 + 是否可回原文核对 + 是否有 L3 fail 挂钩），
//   每条排序结果都带 `rank_reason` 说明为什么排在那个位置。

export const TV_VERSION = 'v1';

/** 档位参考：levels 型条目把 rubric 的档位描述给教师当参考标准（**逐字来自 profile，不是 AI 建议**）。 */
export function levelReferenceOf(profileItem) {
  const st = profileItem?.scoring_strategy;
  if (!st || st.type !== 'levels') return [];
  return (st.levels ?? []).map(l => ({
    level_id: l.level_id,
    level_score: l.score,        // ★ 这是 rubric 定义的档位分，不是 AI 给的分
    text: l.text,
  }));
}

/** 把 L4 的 finding 规范化成"教师视图里的一条观察"（带可核查性标注）。 */
export function normalizeFinding(f, rubricItemId) {
  const located = f.located ? { offset: f.located.offset, source_ref: f.located.source_ref ?? null } : null;
  const verification = f.verification ? {
    check_id: f.verification.check_id,
    stance: f.verification.stance,
    scope: f.verification.scope ?? null,
  } : null;
  const anchored = !!(located || verification);
  return {
    rubric_item_id: rubricItemId,
    polarity: f.polarity,                       // strength / concern / neutral
    kind: f.kind,
    severity: f.severity ?? null,               // ★ 模型自报的严重程度：**保留标签**，教师能看到"这是模型判的"
    // ★★ warrant：有依据的内容错误候选 —— `bound` 由程序回填（只表示**依据已绑定**，不表示内容正确）
    warrant: f.warrant ? {
      student_quote: f.warrant.student_quote ?? null,
      student_quote_located: f.warrant.student_quote_located ?? null,
      what_is_wrong: f.warrant.what_is_wrong ?? null,
      basis_kind: f.warrant.basis_kind ?? null,
      basis_detail: f.warrant.basis_detail ?? null,
      basis_check: f.warrant.basis_check ?? null,
      bound: f.warrant.bound === true,
      unbound_reasons: f.warrant.unbound_reasons ?? [],
      binding_scope: f.warrant.binding_scope ?? 'structural_only',
    } : null,
    note: f.note,
    quote: f.quote ?? null,
    located,
    verification,
    anchored,
    // ★ 重要性提示（不改排序，只如实标注）：既非"较严重"、也没有 L3 反证挂钩的，
    //   提醒教师"这是次要问题" —— 实测反例：一份 gold 34/35 的报告里，R1 的语法小瑕疵
    //   被顶进了"整篇三条"（该条目人类给了满分）。排序规则本身留待进一步验证，先把它**标注出来**。
    importance_hint: (f.warrant?.bound === true || f.verification?.stance === 'fail') ? 'primary' : 'secondary',
    // ★★ 不确定就写明 —— 三种情况三种话，不含糊
    anchor_note: located ? '已定位到原文'
      : verification ? '无原文定位，但有机械验证挂钩'
        : '⚠ 无原文定位、也无机械验证挂钩：请勿当作确定结论',
  };
}

/**
 * ★★ 入选「整篇优先展示」的**门槛**（2026-09-24 Yukii 定）。三条必须**同时**满足：
 *   ① 与 rubric 相关 —— 归属到有效的 rubric 条目（构造时已保证）
 *   ② **有可核对依据** —— `anchored`（有原文定位，或有 L3 机械验证挂钩）
 *   ③ **值得教师优先看** —— `severity === 'major'`，或有 L3 反证（`stance === 'fail'`）
 * ★ N 只是**上限**：合格观察不足就少给、甚至 0 条 —— **不凑满**。
 * ★ 门槛只用「机械事实（可核对性）+ 模型自报的**定性**严重程度标签（教师可见）」，
 *   **不引入任何未经校准的模型置信度数字**。
 */
export function qualifiesForTop(f) {
  // ★★ 门槛（2026-09-24 定）：只看**可核验的依据**，不再看模型自报的 severity / kind ——
  //   ① **有依据的内容错误候选**（warrant 三要素经**程序**逐项核验通过：原话可定位 + 错在哪成文 + 依据成文可核验）
  //   ② **L3 机械反证**（`stance === 'fail'`，客观事实）
  //   两条都不成立 → 不上第一屏（可进「可能缺少」/「待核查」/折叠）。N 只是上限，合格不足就少给。
  return f.anchored === true && (f.warrant?.bound === true || f.verification?.stance === 'fail');
}

/**
 * ★ 「重要但证据不足」→ 进**待核查**区（既不入选 top、也不伪装成确定问题）。
 *   判据：`severity === 'major'`（它自称重要）但 `anchored !== true`（核不了）。
 */
export function needsVerificationFirst(f) {
  return f.severity === 'major' && f.anchored !== true;
}

// ★★ 排序（2026-09-24 按 Yukii 要求重做）：**不再把模型自报的 severity 当第一维**。
//   改成三个维度组合，每个维度都**写进产物**（教师能看到"为什么这条排在前面"，而不是被一个隐藏分数决定）：
//     D1「对理解的影响」：计算/推理类问题 > 完整性问题 > 形式（presentation）/其他。
//        ★ 这是**代理**：真正的"影响"无法机械判定，所以用模型给的宽类别 `kind` 做代理，并明确标注是代理。
//     D2「具体可核查」：有精确原文定位 > 只有引文（未定位）> 无引文。
//        ★ **不把"具体"放第一位** —— 泛泛但更要紧的问题仍然可以排前（Yukii 明确要求）。
//     D3「模型自报的严重程度」：只作为**第三维**（降级为参考，而不是决定因素）。
//   ★ 维度顺序 = D1 → D2 → D3 → 条目顺序（稳定）。
const AFFECT_ON_UNDERSTANDING = { calculation: 3, reasoning: 3, completeness: 2, presentation: 1, other: 1 };
const AFFECT_LABEL = { 3: '计算/推理类（影响理解的代理信号）', 2: '完整性/缺项类', 1: '形式/其他' };

function concernRankKey(x) {
  const f = x.finding;
  const l3fail = f.verification?.stance === 'fail';
  // D1 **依据强度**（最重要）：有依据的内容错误候选(3) > L3 机械反证(2) > 其余(1)
  const d1 = f.warrant?.bound === true ? 3 : l3fail ? 2 : 1;
  // D2 影响理解（kind 代理，**辅助**，不再决定能否上屏）
  const d2 = AFFECT_ON_UNDERSTANDING[f.kind] ?? 1;
  // D3 可核查性
  const d3 = f.located ? 3 : f.quote ? 2 : 0;
  // D4 自报严重程度（**辅助**，最低权重）
  const d4 = f.severity === 'major' ? 2 : f.severity === 'minor' ? 1 : 0;
  return { d1, d2, d3, d4 };
}

/** 排序理由（可解释、三条都给出来） */
function rankReasonOf(f) {
  const k = concernRankKey({ finding: f });
  const w = f.warrant?.bound ? '内容错误候选（依据已绑定，内容待核对）' : f.verification?.stance === 'fail' ? 'L3 机械反证' : '普通观察（无绑定依据）';
  return `依据(${w}) · 影响理解(${AFFECT_LABEL[k.d2]})`
    + ` · 可核查性(${k.d3 === 3 ? '有精确原文定位' : k.d3 === 2 ? '有引文未定位' : '无引文'})`
    + ` · 自报严重程度(${f.severity ?? '未标'}，仅辅助)`;
}

/** 对同一批 concern 排序，并给出**可解释的理由**（三维 + 排序依据）。 */
export function rankConcerns(findings, itemOrder = null) {
  const orderOf = id => (itemOrder ? (itemOrder.indexOf(id) < 0 ? 999 : itemOrder.indexOf(id)) : 0);
  return findings
    .map(f => ({ finding: f, k: concernRankKey({ finding: f }) }))
    .sort((a, b) => b.k.d1 - a.k.d1 || b.k.d2 - a.k.d2 || b.k.d3 - a.k.d3 || b.k.d4 - a.k.d4
      || orderOf(a.finding.rubric_item_id) - orderOf(b.finding.rubric_item_id))
    .map(x => ({ ...x.finding, rank_reason: rankReasonOf(x.finding), priority: 100 * x.k.d1 + 10 * x.k.d2 + 3 * x.k.d3 + x.k.d4 }));
}

/**
 * ★★「可能缺少的关键内容」（Yukii 2026-09-24 定的方案②）。
 *   ★ 铁律：**没有单条引文能证明"不存在"**；关键词搜索也排除不了"换一种说法写了"。
 *     → 表述只能是「在**已解析的**报告中未找到…**请教师核对**」，
 *       并且**必须**给出检查范围（解析字数/条目数/解析警告数）与全文查看入口。
 *   ★ 若文本提取不完整（存在解析警告）→ **一律标"无法确认"**，不报缺失。
 *   ★ 有上限（limit），不铺满。
 */
export function buildPossiblyMissing({ assessmentArtifact, rubric, parseInfo, limit = 3 }) {
  const rById = new Map((rubric.items ?? []).map(i => [i.id, i]));
  const warnings = parseInfo?.warnings ?? [];
  const extractUnreliable = warnings.length > 0;
  const scope = {
    parsed_chars: parseInfo?.chars ?? null,
    parsed_entries: parseInfo?.entries ?? null,
    parse_warnings: warnings.length,
    extract_reliable: !extractUnreliable,
    note: '检查范围 = 本次**已解析的**正文（不含以图片/对象形式存在、未被文本捕获的内容）',
  };
  const seeFullText = {
    index: parseInfo?.index_file ?? null,
    text: parseInfo?.text_file ?? null,
    hint: '在完整报告 / 原始正文中查看',
  };
  const cands = [];
  for (const a of assessmentArtifact.assessments ?? []) {
    const id = a.rubric_item_id;
    if (a.level_status === 'outside_defined_levels') {
      cands.push({
        kind: 'levels_item_out_of_scope',
        rubric_item_id: id,
        rubric_text: (rById.get(id)?.text ?? '').slice(0, 200),
        basis: '该条目：通读已解析正文后无相关内容（产物记为 outside_defined_levels）',
        source_finding_keys: [],
      });
    }
  }
  const entries = cands.slice(0, limit).map(c => ({
    ...c,
    statement: extractUnreliable
      ? `**无法确认**该条目相关内容是否存在：本次文本提取不完整（解析警告 ${warnings.length} 条），因此**不下"缺失"判断**，请教师在原文中核对。`
      : `在**已解析的报告**中未找到与该条目相关的内容 —— **请教师核对**（这不等于原文中没有）。`,
    status: extractUnreliable ? 'cannot_confirm' : 'not_found_in_parsed_text',
    check_scope: scope,
    see_full_text: seeFullText,
  }));
  return {
    rule: '★ 只表示"在**已解析的文本**里没找到"，**不表示原文中没有** —— 没有单条引文能证明"不存在"，'
      + '关键词搜索也排除不了"换一种说法写了"。提取不完整时一律标"无法确认"。每条都给出检查范围与全文入口。',
    limit,
    candidates_total: cands.length,
    entries,
    check_scope: scope,
    see_full_text: seeFullText,
  };
}

/**
 * ★★「关键缺项／论述不足 · 待教师核对」——第一屏的**第二个位置**（最多 limit 条，默认 1）。
 *
 *  为什么需要它：门槛（内容错误候选 / L3 反证）天生排除了"缺项、论述不足"这类观察，
 *  于是**高质量报告的第一屏会是空的**（实测 `0655` gold 29 的第一屏 0 条，而折叠里躺着多条带定位的关键论述问题）。
 *
 *  ★★ 三条纪律：
 *   ① **不靠模型自报的 severity 上屏** —— 硬入选条件是「**有原文定位**」：学生确实写了这段，教师能回原文核对。
 *      severity 只在**同分排序的末位**作参考，不单独决定入选。
 *   ② 它不是"已证明全文没写"。所以按两种情形分开表述：
 *      · `argument_gap`（**有定位**）→ 说明「**这段做到了什么、尚未说明什么**」（rubric 要求 + 学生原段 + 说明）；
 *      · `not_found`（无定位）→ 才说明**检索范围**，并要求教师**核对原 PDF**；提取不完整时只报「**无法确认**」。
 *   ③ 与第一屏的问题、与「可能缺少」不重叠（由调用方传 excludeKeys）。
 */
export function buildKeyGaps({ assessmentArtifact, rubric, fullText = null, excludeKeys = new Set(), limit = 1 }) {
  const rById = new Map((rubric.items ?? []).map(i => [i.id, i]));
  const ctx = (quote, pad = 120) => {
    if (!quote || !fullText) return null;
    const i = fullText.indexOf(quote);
    if (i < 0) return null;
    return fullText.slice(Math.max(0, i - pad), i) + '⟨' + quote + '⟩' + fullText.slice(i + quote.length, i + quote.length + pad);
  };
  const cands = [];
  for (const a of assessmentArtifact.assessments ?? []) {
    for (const f of a.findings ?? []) {
      if (f.polarity !== 'concern') continue;
      if (f.kind !== 'completeness' && f.kind !== 'reasoning') continue;   // 缺项 / 论述类
      const k = `${a.rubric_item_id}|${f.note}`;
      if (excludeKeys.has(k)) continue;
      cands.push({
        rubric_item_id: a.rubric_item_id,
        kind: f.kind,
        severity: f.severity ?? null,
        located: !!f.located,
        page: f.located?.source_ref?.page ?? null,
        quote: f.quote ?? null,
        context: ctx(f.quote ?? null),
        note: f.note,
        l3fail: f.verification?.stance === 'fail',
        has_verification: !!f.verification,
        rubric_requirement: (rById.get(a.rubric_item_id)?.text ?? '').slice(0, 600),
      });
    }
  }
  // ★ 排序（**severity 在末位**，不单独决定入选）：
  //   有 L3 反证 > completeness（缺项比"论述不足"更硬）> 引文更长（更有据可查）> severity
  cands.sort((x, y) => (Number(y.l3fail) - Number(x.l3fail))
    || (Number(y.kind === 'completeness') - Number(x.kind === 'completeness'))
    || ((y.quote?.length ?? 0) - (x.quote?.length ?? 0))
    || (Number((y.severity === 'major') ? 1 : 0) - Number((x.severity === 'major') ? 1 : 0)));
  const selected = cands.slice(0, Math.max(0, limit));
  const entries = selected.map(c => ({
    rubric_item_id: c.rubric_item_id,
    kind: c.kind,
    severity: c.severity,
    page: c.page,
    // ★ 两种情形分开表述（有定位 = 论述不足；无定位 = 只在检索范围内说"未找到"）
    status: c.located ? 'argument_gap' : 'not_found',
    rubric_requirement: c.rubric_requirement,
    student_excerpt: c.quote ? { quote: c.quote, context: c.context } : null,
    // 做到什么 / 尚未说明什么（沿用 L4 的说明；这一句是给教师看的"缺口在哪"）
    does_and_misses: c.note,
    l3: c.l3fail ? 'fail' : (c.has_verification ? 'pass_or_other' : null),
    caveat: c.located
      ? '★ 这不是"已证明全文没写"：上引是学生确实写过的一段，请对照原件核对该条要求是否已被说明。'
      : '★ 未能在已解析文本中定位到对应段落 —— 请打开原件核对（也可能是公式/图表未被文本捕获）。',
  }));
  return {
    rule: '★ 入选硬条件是「有原文定位」（可回原文核对），**不靠模型自报的 severity**（severity 仅在末位排序时参考）；'
      + '最多 ' + limit + ' 条。这不是"已证明全文没写"：有定位的按"这段做到了什么、尚未说明什么"表述；'
      + '无定位的才说检索范围并要求核对原 PDF；提取不完整时只报"无法确认"。',
    limit,
    candidates_total: cands.length,
    entries,
  };
}

/**
 * 组装教师视图。
 * @param {{assessmentArtifact, rubric, profile, topN?: number, parseInfo?: object, missingLimit?: number}} args
 */
export function buildTeacherView({ assessmentArtifact, rubric, profile, topN = 3, parseInfo = null, missingLimit = 3, fullText = null, gapLimit = 1 }) {
  const rById = new Map((rubric.items ?? []).map(i => [i.id, i]));
  const pById = new Map((profile.items ?? []).map(i => [i.rubric_item_id, i]));
  const itemOrder = (rubric.items ?? []).map(i => i.id);

  const items = [];
  const allConcerns = [];
  const allFindings = [];      // ★ 全部观察（不只是 concern）—— 用于"无可靠定位"清单，避免漏项
  let totalShown = 0;

  for (const a of assessmentArtifact.assessments ?? []) {
    const id = a.rubric_item_id;
    const findings = (a.findings ?? []).map(f => normalizeFinding(f, id));
    allFindings.push(...findings);

    const concerns = rankConcerns(findings.filter(f => f.polarity === 'concern'), itemOrder);
    const strengths = findings.filter(f => f.polarity === 'strength')
      // 做得好的：优先能回原文核对的（教师一眼能确认），其次保持原顺序
      .sort((x, y) => Number(y.anchored) - Number(x.anchored));
    const neutrals = findings.filter(f => f.polarity === 'neutral');

    const primary_concern = concerns[0] ?? null;
    const primary_strength = strengths[0] ?? null;
    const shown = [primary_concern, primary_strength].filter(Boolean);
    totalShown += shown.length;

    items.push({
      rubric_item_id: id,
      rubric_text: rById.get(id)?.text ?? null,
      strategy_type: a.strategy_type,
      // ★ 档位描述 = teacher 的参考标准（来自 rubric 定义），**不是 AI 候选档**
      level_reference: levelReferenceOf(pById.get(id)),
      primary_concern,
      primary_strength,
      shown_count: shown.length,
      folded: {
        total: findings.length,
        concern: concerns.length,
        strength: strengths.length,
        neutral: neutrals.length,
        folded_count: Math.max(0, findings.length - shown.length),
      },
      // ★★ 显式声明隐藏了什么（不做静默省略）
      hidden: {
        ai_candidate_levels: true,
        ai_judgment: true,
        ai_score: true,
        note: '主视图按交付定位隐藏 AI 候选档位、AI 判断与任何 AI 分数；教师可展开完整报告查看',
      },
    });
    allConcerns.push(...concerns);
  }

  // 整篇：最值得先看的问题（跨条目）。★ 先过**门槛**再取前 N —— N 是上限，不凑满。
  const rankedAll = [...allConcerns].sort((a, b) => b.priority - a.priority
    || itemOrder.indexOf(a.rubric_item_id) - itemOrder.indexOf(b.rubric_item_id));
  const qualified = rankedAll.filter(qualifiesForTop);
  // ★★ (b) 合并"同一处错误被多个条目各报一次"：实测 `0503` 的「直接成正比」错误同时挂在 R3 与 R5，
  //   各占一席 → 把第三个问题挤掉了。判据是**机械的**：两份观察的定位引文（warrant.student_quote，
  //   退化为 finding.quote）归一化后相同，即视为同一处错误 —— 合并成一条，`rubric_item_ids` 挂全部相关条目。
  //   ★ 判据要比"精确相等"宽一点：实测同一处错误在两份产物里只差一个句号就判不成同一处。
  const normQuote = s0 => String(s0 ?? '').replace(/[\s\p{P}]+/gu, '').toLowerCase();
  const sameQuote = (a, c) => {
    if (!a || !c) return false;
    if (a === c) return true;
    // 互为子串才算同一处（加长度门槛，避免"the period"这类短串误合并）
    const [lo, hi] = a.length <= c.length ? [a, c] : [c, a];
    return lo.length >= 30 && hi.includes(lo);
  };
  const mergedConcerns = [];
  for (const f of qualified) {
    const q = normQuote(f.warrant?.student_quote ?? f.quote ?? '');
    const hit = q ? mergedConcerns.find(m => sameQuote(normQuote(m.warrant?.student_quote ?? m.quote ?? ''), q)) : null;
    if (hit) {
      if (!hit.rubric_item_ids.includes(f.rubric_item_id)) hit.rubric_item_ids.push(f.rubric_item_id);
      hit.merged_from += 1;
      hit.rank_reason += `｜与 ${f.rubric_item_id} 指的是同一处（已合并为一条）`;
      continue;
    }
    mergedConcerns.push({ ...f, rubric_item_id: f.rubric_item_id, rubric_item_ids: [f.rubric_item_id], merged_from: 1 });
  }
  const top_concerns = mergedConcerns.slice(0, topN);
  // ★★「可能缺少的关键内容」（方案②）：有上限、措辞不构成"不存在"的断言、带检查范围与全文入口
  const possibly_missing = buildPossiblyMissing({ assessmentArtifact, rubric, parseInfo, limit: missingLimit });
  const key = f => `${f.rubric_item_id}|${f.note}`;
  // ★ 第二条通道：关键缺项／论述不足（与第一屏、待核查都不重叠）
  const usedKeys = new Set([...top_concerns.map(key)]);
  const key_gaps = buildKeyGaps({ assessmentArtifact, rubric, fullText, excludeKeys: usedKeys, limit: gapLimit });
  const shownK = new Set(top_concerns.map(key));
  const missingK = new Set(possibly_missing.entries.flatMap(e => e.source_finding_keys ?? []));
  const foldedConcerns = rankedAll.filter(f => !shownK.has(key(f)) && !missingK.has(key(f)));

  const totalFindings = allFindings.length;
  const totalAnchored = allFindings.filter(f => f.anchored).length;
  // ★ 无可靠定位的观察 = **全部**观察里没有定位也没有验证挂钩的（含 strength / neutral）
  const unanchored = allFindings.filter(f => !f.anchored);

  return {
    authority: {
      layer_produces_score: false,
      view_version: TV_VERSION,
      purpose: '帮助教师快速形成质量判断：整篇优先观察 → rubric 条目 → 原文',
      ai_grading_hidden: true,
      no_ai_score: true,
      notes: '本视图**不含** AI 候选档位、AI 判断与任何 AI 分数（这些在主视图隐藏，教师可在完整报告查看，'
        + '并自行给分）。档位描述来自 rubric 定义，是教师的参考标准，不是 AI 的建议。'
        + '每条观察都标注了可核查性；标注为"无原文定位"的不得当作确定结论。',
    },
    doc: assessmentArtifact.doc,
    rubric: { rubric_id: assessmentArtifact.rubric?.rubric_id ?? null, source_sha256: assessmentArtifact.rubric?.source_sha256 ?? null },
    source_assessment: { file: assessmentArtifact.doc?.name ? `${assessmentArtifact.doc.name}.assessment.json` : null },
    whole_report: {
      rule: `入选需**同时**满足：与 rubric 相关 + **有可核对依据** + 值得优先看（较严重，或有 L3 反证）。`
        + `N=${topN} 只是**上限**，合格不足就少给甚至 0 条（不凑满）。排序：「较严重 → 有 L3 反证 → 可回原文核对」。`
        + `★ 重要但证据不足的进「待核查」区，不伪装成确定问题；门槛**不使用任何模型置信度数字**。`,
      top_concerns,
      /** ★ 关键缺项／论述不足（第一屏第二位置；入选硬条件 = 有原文定位，不靠自报 severity） */
      key_gaps,
      /** ★ 可能缺少的关键内容（**不等于"缺失"**）：措辞与检查范围见 authority.notes */
      possibly_missing,
      /** ★ 排序依据（三维都写出来，教师可自行判断是否同意） */
      rank_dimensions: 'D1 影响理解（kind 代理）→ D2 可核查性 → D3 模型自报的严重程度 → 条目顺序；'
        + '★ 不把自报严重程度当第一维，**也不规定"具体的一律优先"**（泛泛但更要紧的问题仍可排前）',
      merge_rule: '★ 同一处错误被多个 rubric 条目各报一次时，**合并为一条**并挂全部相关条目（rubric_item_ids），'
        + '不重复占用第一屏的名额。判据：定位引文归一化后相同。',
      merged_total: qualified.length - mergedConcerns.length,
      qualified_total: qualified.length,
      ranked_total: rankedAll.length,
      folded_count: foldedConcerns.length,
      /** ★ 排序依据（三维都给出来，教师可自行判断是否同意） */
      rank_dimensions: 'D1 影响理解(kind 代理) > D2 可核查性 > D3 自报严重程度 → 条目顺序；'
        + '★ 不把"模型自报的严重程度"当第一维；**也不规定"具体的一律优先"**',
    },
    items,
    unanchored_findings: unanchored.map(f => ({
      rubric_item_id: f.rubric_item_id,
      polarity: f.polarity,
      kind: f.kind,
      note: f.note,
      anchor_note: f.anchor_note,
    })),
    stats: {
      rubric_items: items.length,
      findings_total: totalFindings,
      findings_shown: totalShown,
      findings_folded: totalFindings - totalShown,
      anchored: totalAnchored,
      unanchored: totalFindings - totalAnchored,
      anchored_rate: totalFindings ? totalAnchored / totalFindings : null,
    },
  };
}

/** 终端渲染：让"教师看到的样子"可直接核验（不是另一套数据，只是同一产物的排版）。 */
export function teacherViewText(view) {
  const L = [];
  const anchorMark = f => (f.located ? '原文定位 ✓' : f.verification ? `有验证挂钩（L3 ${f.verification.stance}）` : '⚠ 无定位/无挂钩');
  L.push(`═══ 教师视图 · ${view.doc?.name ?? '（未知文档）'} ═══`);
  L.push('★ 本视图不含 AI 候选档位、不含 AI 判断、不给分数；档位描述来自 rubric，是参考标准。');
  L.push('');
  L.push(`【整篇：最值得先看的 ${view.whole_report.top_concerns.length} 个问题】`);
  if (!view.whole_report.top_concerns.length) L.push('  （没有需要优先提示的问题）');
  view.whole_report.top_concerns.forEach((f, i) => {
    L.push(`  ${i + 1}. ${f.rubric_item_id} [${f.kind}${f.severity ? '/' + f.severity : ''}] ${anchorMark(f)}`);
    L.push(`     ${f.note}`);
    if (f.quote) L.push(`     原文：${JSON.stringify(f.quote.slice(0, 80))}`);
    if (f.verification) L.push(`     验证：${f.verification.check_id} → ${f.verification.stance}${f.verification.scope ? `（${f.verification.scope}）` : ''}`);
    if (f.warrant?.bound) {
      L.push(`     ★ 内容错误候选（**依据已绑定，内容待核对** —— 系统只核对了"原话能定位、解释与依据成文、引用的 check 存在"，**未做语义核验**）：`);
      L.push(`       学生原话：${JSON.stringify(String(f.warrant.student_quote).slice(0, 90))}`);
      L.push(`       错在哪：${f.warrant.what_is_wrong}`);
      L.push(`       依据（${f.warrant.basis_kind}）：${f.warrant.basis_detail}`);
    }
    if (f.importance_hint === 'secondary') L.push('     ★ 次要问题：既非"较严重"、也无机械验证反证 —— 若无更严重的问题需先看，可略过');
    L.push(`     排序依据：${f.rank_reason}`);
  });
  const kg = view.whole_report.key_gaps;
  if (kg?.entries?.length) {
    L.push('');
    L.push(`  【★ 关键缺项／论述不足 · 待教师核对（${kg.entries.length}/${kg.candidates_total}，上限 ${kg.limit}）】`);
    for (const e of kg.entries) {
      L.push(`   ▸ [${e.rubric_item_id}] ${e.kind}${e.severity ? '/' + e.severity : ''}${e.page != null ? ' · 第 ' + e.page + ' 页' : ''}`
        + `${e.status === 'argument_gap' ? ' · 有原文定位' : ' · 未定位（请核对原件）'}`);
      L.push(`     rubric 要求：${String(e.rubric_requirement).slice(0, 120)}`);
      if (e.student_excerpt?.context) L.push(`     学生实际写的：${String(e.student_excerpt.context).slice(0, 200)}`);
      else if (e.student_excerpt?.quote) L.push(`     学生实际写的：${String(e.student_excerpt.quote).slice(0, 160)}`);
      L.push(`     做到了什么／尚未说明什么：${e.does_and_misses}`);
      L.push(`     ${e.caveat}`);
    }
  }

  const pm = view.whole_report.possibly_missing;
  if (pm?.entries?.length) {
    L.push('');
    L.push(`  【★ 可能缺少的关键内容（${pm.entries.length}/${pm.candidates_total}，上限 ${pm.limit}）】`
      + `—— ★ 只表示"在**已解析的文本**里没找到"，**不等于原文中没有**`);
    for (const e of pm.entries) {
      L.push(`   ? [${e.rubric_item_id}] ${e.statement}`);
      L.push(`     依据：${e.basis}`);
      L.push(`     检查范围：已解析 ${e.check_scope.parsed_chars} 字 / ${e.check_scope.parsed_entries} 条结构条目 / 解析警告 ${e.check_scope.parse_warnings} 条`);
      L.push(`     查看全文：${e.see_full_text.hint}（${e.see_full_text.text ?? '—'}）`);
    }
  }
  L.push(`  （其余 ${view.whole_report.folded_count} 条问题已折叠，展开可见全部）`);
  L.push('');
  L.push('【逐条 rubric】');
  for (const it of view.items) {
    L.push(`▌${it.rubric_item_id}  ${String(it.rubric_text ?? '').slice(0, 100)}`);
    if (it.primary_concern) {
      const f = it.primary_concern;
      L.push(`  ✗ 关键问题 [${f.kind}${f.severity ? '/' + f.severity : ''}] ${anchorMark(f)}`);
      L.push(`     ${f.note}`);
      if (f.quote) L.push(`     原文：${JSON.stringify(f.quote.slice(0, 80))}`);
      if (f.verification) L.push(`     验证：${f.verification.check_id} → ${f.verification.stance}`);
    } else L.push('  ✗ 关键问题：（无）');
    if (it.primary_strength) {
      const f = it.primary_strength;
      L.push(`  ✓ 做得好的 [${f.kind}] ${anchorMark(f)}`);
      L.push(`     ${f.note}`);
      if (f.quote) L.push(`     原文：${JSON.stringify(f.quote.slice(0, 80))}`);
    } else L.push('  ✓ 做得好的：（无）');
    L.push(`  ⋯ 折叠：另有 ${it.folded.folded_count} 条（问题 ${it.folded.concern} / 优点 ${it.folded.strength} / 中性 ${it.folded.neutral}，共 ${it.folded.total}）`);
    if (it.level_reference.length) {
      L.push(`  档位参考（rubric 定义，非 AI 建议）：${it.level_reference.map(l => `${l.level_id}(${l.level_score})`).join(' ')}`);
    }
  }
  if (view.unanchored_findings.length) {
    L.push('');
    L.push(`【★ 无可靠定位的观察（${view.unanchored_findings.length} 条）—— 请勿当作确定结论】`);
    for (const f of view.unanchored_findings) L.push(`  - ${f.rubric_item_id} [${f.polarity}/${f.kind}] ${String(f.note).slice(0, 100)}`);
  }
  L.push('');
  L.push(`【账目】条目 ${view.stats.rubric_items} · 观察 ${view.stats.findings_total}（展示 ${view.stats.findings_shown} / 折叠 ${view.stats.findings_folded}）· 可回原文 ${view.stats.anchored}（${(view.stats.anchored_rate * 100).toFixed(1)}%）· 无法核对 ${view.stats.unanchored}`);
  return L.join('\n');
}
