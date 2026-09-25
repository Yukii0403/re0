// summary.mjs —— 阶段三：总结评语（吸收教师给分后的整篇叙述）
//
// 定位（L4 v0.3 三阶段流程的第③步）：
//     ① L4 逐条定性评估（findings + judgment/候选档 + 原文定位）
//     ② 教师：条目级三选（准确 / 不准确 / 部分准确）+ 给分
//     ③ 本层：重读完整报告 + 教师给分 + 教师确认后的各条评价 → 整篇评语
//
// ★ 为什么③放在教师之后（关键设计）：评语与分数在结构上**不可能矛盾** —— 教师给分是输入，
//   评语围绕已定分数组织。任务性质是「翻译」（把教师的定量决策 + 系统的定性发现翻成学生能读的话），
//   不是「评判」（从原文独立推出质量结论）—— 后者正是我们已证明做不稳的事。
//
// 三条不可动：
//   ① **教师给分是准绳**：模型不得质疑、不得改写、不得给出任何新分数（含总分）——
//      产物里没有分数字段，回抄的分数由程序从输入复制（不是模型输出）。
//   ② **未三选 ≠ 准确**：教师没标注的条目按「AI 初判、未经教师确认」处理，不默认背书。
//      未确认清单由**程序**算（不是模型自报）。
//   ③ 评语是给人看的自由叙述，**不加闸**（上游教师已把关）；但输入里每条评价都自带原文定位，
//      模型复述事实时会带上出处。材料仍是**完整原文**（核心原则 1）。

import { createHash } from 'node:crypto';

export const SUMMARY_VERSION = 'v0.1';

const sha256Hex = s => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

export const VERDICTS = ['accurate', 'inaccurate', 'partially_accurate'];
export const SUMMARY_SOFT_TARGET = 1200;     // 建议长度（字）
export const SUMMARY_HARD_MAX = 6000;        // 防爆量的工程上限（撞到才拒）

// ------------------------------------------------------------------ 输入校验（fail-closed）

/**
 * ★ 评语层的输入校验：上游身份必须**逐字节**对上，教师给分必须与 rubric/profile **机械自洽**。
 *
 * ★★ 2026-09-24 修（Yukii 只读验证发现三处实质漏洞）：
 *   旧版只查了 `0 ≤ score ≤ 教师文件**自报**的 max`，于是「把 max 改成 100 / 重复一条 / 删掉一条 /
 *   把全文换成无关文字」四种篡改全部 ok=true，总分也跟着变。**自报的上界不是上界** ——
 *   必须回到 profile（唯一权威）去核。修法：
 *     ① 条目**唯一**（不得重复）
 *     ② 条目**齐全**（必须与 profile 的可评分叶子集合**完全相等**）
 *     ③ 每条 `max` 必须等于 profile 的 `scoring_strategy.max`（不是教师文件自报的）
 *     ④ **全文必须逐字绑定 L1 索引**：`index.doc.sha256 === A.doc.sha256`、
 *        每条 entry `docBody.slice(start,end) === e.text`（实测 54/54 成立）、offset 单调且落在文内
 *     ⑤ profile 必须绑同一份 rubric，且 profile 字节要能对上产物里记录的 sha
 *
 * @returns {{ok, errors, unconfirmed_items, disputed_items, content_unconfirmed_items,
 *            teacher_total, max_total, release_blockers, shas}}
 */
export function verifySummaryInputs({
  assessmentArtifact, assessmentBody, teacherScores, teacherScoresBody,
  profile = null, profileBody = null, index = null, indexBody = null, docBody = null,
}) {
  const errors = [];
  const A = assessmentArtifact, T = teacherScores;

  if (!A) errors.push('缺少 L4 产物');
  if (!T) errors.push('缺少教师给分');
  if (!A || !T) return { ok: false, errors };

  // ① 同一份作业 / 同一份 rubric
  if (T.doc?.sha256 !== A.doc?.sha256) errors.push('教师给分与 L4 产物不是同一份作业（doc.sha256 不一致）');
  if (T.doc?.name && A.doc?.name && T.doc.name !== A.doc.name) errors.push('教师给分的 doc.name 与 L4 产物不一致');
  if (T.rubric?.source_sha256 !== A.rubric?.source_sha256) errors.push('教师给分与 L4 产物不是同一份 rubric（source_sha256 不一致）');

  // ⑤ profile 是分值的唯一权威 —— 必须绑同一份 rubric，且字节要对得上产物记录的 sha
  const pById = new Map();
  if (!profile) errors.push('缺少 assessment profile（没有它就无法校验教师自报的 max）');
  else {
    if (profile.rubric?.source_sha256 !== A.rubric?.source_sha256) {
      errors.push('profile 绑的不是同一份 rubric（source_sha256 不一致）');
    }
    if (profileBody !== null && A.assessment_profile?.sha256 && sha256Hex(profileBody) !== A.assessment_profile.sha256) {
      errors.push(`profile 字节与 L4 产物记录的 sha 不符（产物 ${String(A.assessment_profile.sha256).slice(0, 12)}… ≠ 实算 ${sha256Hex(profileBody).slice(0, 12)}…）`);
    }
    for (const p of profile.items ?? []) pById.set(p.rubric_item_id, p);
  }

  // ④ 全文必须逐字绑定 L1 索引（★ 这是"全文没被换掉"唯一机械可达的证据）
  if (!index) errors.push('缺少 L1 索引（无法确认评语用的全文就是这份原件的抽取结果）');
  else {
    if (index.doc?.sha256 !== A.doc?.sha256) errors.push('index 绑的不是同一份原件（index.doc.sha256 ≠ L4 产物 doc.sha256）');
    const entries = index.entries ?? [];
    if (!entries.length) errors.push('index 没有任何条目');
    else {
      let prev = -1;
      let monotone = true, mismatch = null, outOfRange = null;
      for (const e of entries) {
        if (!(Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= prev && e.end >= e.start)) { monotone = false; }
        prev = e.start;
        if (docBody !== null) {
          if (e.end > docBody.length) { if (!outOfRange) outOfRange = e.id; }
          else if (docBody.slice(e.start, e.end) !== e.text) { if (!mismatch) mismatch = e.id; }
        }
      }
      if (!monotone) errors.push('index.entries 的 offset 不是单调不重叠的');
      if (docBody === null) errors.push('缺少正文（无法把全文与索引逐字核对）');
      else {
        if (mismatch !== null) errors.push(`正文与索引逐字不符（entry ${mismatch}：full.slice(start,end) ≠ entry.text）→ 全文可能被替换过`);
        if (outOfRange !== null) errors.push(`index 条目 ${outOfRange} 的 offset 超出正文长度 → 全文可能被替换过`);
      }
    }
  }

  // ①②③ 教师给分：唯一、齐全、max 对 profile
  const scorable = new Set((profile?.items ?? []).filter(p => p.scorable === true).map(p => p.rubric_item_id));
  const entries = T.entries ?? [];
  const seen = new Set();
  if (!entries.length) errors.push('教师给分里没有任何条目');
  for (const e of entries) {
    // ① 唯一
    if (seen.has(e.rubric_item_id)) { errors.push(`教师给分里 ${e.rubric_item_id} 重复出现（条目必须唯一）`); continue; }
    seen.add(e.rubric_item_id);
    // 条目必须在可评分叶子里
    if (scorable.size && !scorable.has(e.rubric_item_id)) { errors.push(`教师给分的 ${e.rubric_item_id} 不是可评分叶子`); continue; }
    const a = (A.assessments ?? []).find(x => x.rubric_item_id === e.rubric_item_id);
    if (!a) { errors.push(`教师给分的 ${e.rubric_item_id} 在 L4 产物里没有对应评价`); continue; }
    if (!Number.isInteger(e.score) || !Number.isInteger(e.max)) { errors.push(`${e.rubric_item_id} 的 score/max 不是整数`); continue; }
    // ③ max 必须等于 profile 的权威值（不是自报）
    const pmax = pById.get(e.rubric_item_id)?.scoring_strategy?.max;
    if (!Number.isInteger(pmax)) errors.push(`${e.rubric_item_id} 在 profile 里没有可用的满分`);
    else if (e.max !== pmax) errors.push(`${e.rubric_item_id} 的 max(${e.max}) 与 profile 的满分(${pmax}) 不符 → 上界被改写了`);
    if (e.score < 0 || e.score > e.max) errors.push(`${e.rubric_item_id} 的分数越界（${e.score} / ${e.max}）`);
    if (e.verdict !== null && e.verdict !== undefined && !VERDICTS.includes(e.verdict)) {
      errors.push(`${e.rubric_item_id} 的三选值不在枚举内：${e.verdict}`);
    }
  }
  // ② 齐全：可评分叶子必须逐条有给分
  if (scorable.size) {
    const missing = [...scorable].filter(id => !seen.has(id));
    if (missing.length) errors.push(`教师给分缺条目：${missing.join('、')}（可评分叶子必须逐条给分）`);
  }

  // 三选状态分类（★ 由程序算，不是模型自报）
  const unconfirmed = entries.filter(e => e.verdict === null || e.verdict === undefined).map(e => e.rubric_item_id);
  const disputed = entries.filter(e => e.verdict === 'inaccurate' || e.verdict === 'partially_accurate').map(e => e.rubric_item_id);
  // ★ "内容已确认"只认 verdict === 'accurate'：部分准确/不准确/未三选都意味着**内容本身没被逐条确认**
  const contentUnconfirmed = entries.filter(e => e.verdict !== 'accurate').map(e => e.rubric_item_id);

  // ★★ 发布闸（release）：起草态是默认；只有显式批准记录才能进入 approved
  const approval = T.approval ?? null;
  const blockers = [];
  if (T.status !== 'teacher_confirmed') blockers.push('provisional_teacher_scores');
  if (!approval?.approved_by || !approval?.approved_at || approval?.scope !== 'summary_release') blockers.push('no_release_approval');
  if (unconfirmed.length) blockers.push(`unconfirmed_items:${unconfirmed.length}`);
  if (disputed.length) blockers.push(`disputed_items:${disputed.length}`);
  // 无法回原文的观察（既无 quote 定位、也无 L3 挂钩）—— 教师必须知道哪些结论核对不了
  const unanchored = (A.assessments ?? []).flatMap(a => (a.findings ?? [])
    .filter(f => !f.located && !f.verification)
    .map(f => ({ rubric_item_id: a.rubric_item_id, polarity: f.polarity, kind: f.kind })));
  if (unanchored.length) blockers.push(`unanchored_findings:${unanchored.length}`);

  return {
    ok: errors.length === 0,
    errors,
    unconfirmed_items: unconfirmed,              // 教师未三选
    disputed_items: disputed,                    // 教师认为不准确 / 部分准确
    content_unconfirmed_items: contentUnconfirmed,  // ★ 内容未逐条确认（= 非 accurate 的全部）
    unanchored_findings: unanchored,             // 无法回原文核对、也无 L3 挂钩的观察
    teacher_total: entries.reduce((s, e) => s + (Number.isInteger(e.score) ? e.score : 0), 0),
    max_total: entries.reduce((s, e) => s + (Number.isInteger(e.max) ? e.max : 0), 0),
    release_blockers: blockers,
    approved: blockers.length === 0,
    shas: {
      assessment: sha256Hex(assessmentBody),
      teacher_scores: sha256Hex(teacherScoresBody),
      profile: profileBody === null ? null : sha256Hex(profileBody),
      index: indexBody === null ? null : sha256Hex(indexBody),
      doc_text: docBody === null ? null : sha256Hex(docBody),
    },
  };
}

// ------------------------------------------------------------------ 材料装配

export function buildSummaryContext({ assessmentArtifact, rubric, full, teacherScores }) {
  const aById = new Map((assessmentArtifact.assessments ?? []).map(a => [a.rubric_item_id, a]));
  const rById = new Map((rubric.items ?? []).map(i => [i.id, i]));
  const items = (teacherScores.entries ?? []).map(e => {
    const a = aById.get(e.rubric_item_id);
    const r = rById.get(e.rubric_item_id);
    return {
      rubric_item_id: e.rubric_item_id,
      rubric_text: r?.text ?? '（rubric 里找不到这一条）',
      teacher: { score: e.score, max: e.max, verdict: e.verdict ?? null, note: e.note ?? null },
      // ★ 只有 verdict === 'accurate' 才意味着**内容**被教师逐条确认过；
      //   未三选 / 部分准确 / 不准确 的条目内容都属于"未经确认"，不得进学生可见正文。
      content_confirmed: e.verdict === 'accurate',
      assessment: a ? {
        strategy_type: a.strategy_type,
        judgment: a.judgment ?? null,
        level_status: a.level_status ?? null,
        candidate_level_ids: a.candidate_level_ids ?? [],
        findings: (a.findings ?? []).map(f => ({
          polarity: f.polarity, kind: f.kind, severity: f.severity ?? null,
          note: f.note,
          quote: f.located ? f.quote : null,
          source_ref: f.located?.source_ref ?? null,
          l3: f.verification ? `${f.verification.check_id}:${f.verification.stance}` : null,
          anchored: !!(f.located || f.verification),   // ★ 能否回原文核对
        })),
        evidence_count: (a.evidence_refs ?? []).length + (a.supplemental_evidence ?? []).length,
        review_required: a.review?.required ?? false,
      } : null,
    };
  });
  return { items, full, docName: assessmentArtifact.doc?.name ?? null };
}

// ------------------------------------------------------------------ 工具面（★ 唯一、极简、不加闸）

// ★★ 评语层不做**内容闸**（Yukii 定），但两段之间必须**物理隔离**（2026-09-24 二次修）：
//   我实测到：只做"分段 + 措辞约束"时，模型会把未确认条目的观察同时写进正文（正文与 pending 出现同一观察）。
//   所以改成**两次调用**：
//     调用 A：材料只含「教师已确认」的条目 → 产出 student text
//     调用 B：材料只含「未确认/有异议」的条目 → 产出 pending_notes
//   模型在 A 里**根本看不到**未确认内容 —— 泄漏在结构上不可能发生（不是"提醒它别写"）。
//   每次调用只暴露自己那一个工具（工具名不同），比在同一 schema 里加约束更强。
export const SUMMARY_PARTS = ['student_text', 'pending_notes'];
export const SUMMARY_TEXT_TOOL = 'submit_student_summary';
export const SUMMARY_PENDING_TOOL = 'submit_pending_notes';

export function summaryTools(part = null) {
  const textTool = {
    type: 'function',
    function: {
      name: SUMMARY_TEXT_TOOL,
      description: '提交**学生可见的总结评语正文**。只使用本次材料里给出的条目 —— 它们都是教师已确认的内容。不给出任何分数。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: {
          text: {
            type: 'string', minLength: 30, maxLength: SUMMARY_HARD_MAX,
            description: `学生可见的总结评语正文。建议 ≤${SUMMARY_SOFT_TARGET} 字（超过不拒收，但会记为"需教师过目"）。`
              + '以教师给分为准绳；不出现任何分数、档次或百分比打分；不引入 rubric 之外的评分标准。',
          },
        },
      },
    },
  };
  const pendingTool = {
    type: 'function',
    function: {
      name: SUMMARY_PENDING_TOOL,
      description: '提交**待教师确认的观察**（不向学生发布）：未三选 / 教师认为部分准确或不准确 / 无法回原文核对的观察。',
      parameters: {
        type: 'object', additionalProperties: false, required: ['notes'],
        properties: {
          notes: {
            type: 'string', minLength: 1, maxLength: SUMMARY_HARD_MAX,
            description: '逐条列出待确认的观察：属于哪个条目、教师的三选状态与备注、观察要点、以及是否可回原文核对。'
              + '按条目分组，供教师判断"这条要不要改、要不要发给学生"。不出现任何分数。',
          },
        },
      },
    },
  };
  if (part === 'student_text') return [textTool];
  if (part === 'pending_notes') return [pendingTool];
  return [textTool, pendingTool];
}

export function createSummaryRunner({ ids = { next: 1 }, part = 'student_text' } = {}) {
  const accepted = [];
  const rejected = [];
  let attempted = 0;
  const expectedTool = part === 'pending_notes' ? SUMMARY_PENDING_TOOL : SUMMARY_TEXT_TOOL;
  const valueKey = part === 'pending_notes' ? 'notes' : 'text';
  const minLen = part === 'pending_notes' ? 1 : 30;
  return {
    call(toolCall) {
      const index = attempted++;
      const fail = code => { const e = { index, reason_code: code }; rejected.push(e); return { ok: false, reason_code: code, index }; };
      if (toolCall?.function?.name !== expectedTool) return fail('unknown_tool');
      let args;
      try { args = JSON.parse(toolCall.function.arguments ?? '{}'); } catch { return fail('malformed_arguments_json'); }
      const value = String(args[valueKey] ?? '').trim();
      if (value.length < minLen || value.length > SUMMARY_HARD_MAX) return fail(`${part}_length_out_of_range`);
      if (accepted.length) return fail(`duplicate_${part}`);
      const s = { summary_id: 's' + String(ids.next++).padStart(4, '0'), [valueKey]: value, chars: value.length };
      accepted.push(s);
      return { ok: true, index, summary_id: s.summary_id, chars: s.chars };
    },
    get summaries() { return accepted; },
    summary() { return { attempted, accepted: accepted.length, rejected: rejected.length }; },
    rejected() { return rejected; },
  };
}

export function summaryResultFor(res) {
  if (!res.ok) return { ok: false, reason_code: res.reason_code };
  return { ok: true, summary_id: res.summary_id, chars: res.chars, pending_chars: res.pending_chars };
}

export const SUMMARY_SYSTEM_PROMPT = [
  '你在为学生写实验报告的总结评语。这次只交付**其中一部分**（材料会说明是哪一部分，并只给你对应的提交工具）。',
  '',
  '硬约束：',
  '1. 用材料里给出的那个工具提交，只提交一次。',
  '2. **绝不给分**：不要出现任何分数、总分、百分比打分、档次命名 —— 分数由教师给出。',
  '3. 具体、指向原文、可执行。不要写"建议继续努力"这类空话；可以指向具体位置、数值、图表编号。',
  '4. 不引入 rubric 之外的评分标准；不评价学生的态度、努力程度、智力。',
  '5. 语气：直接、专业、面向学生。',
].join('\n');

function findingLine(f) {
  const tag = f.polarity === 'strength' ? '做得好的' : f.polarity === 'concern' ? '有问题' : '观察';
  return `  · [${tag}/${f.kind}${f.severity ? '/' + f.severity : ''}] ${f.note}`
    + `${f.quote ? `  ⟨原文：${JSON.stringify(f.quote.slice(0, 60))}⟩` : ''}${f.l3 ? `  ⟨L3：${f.l3}⟩` : ''}`
    + `${f.anchored ? '' : '  ★无法回原文核对'}`;
}

function renderItem(it) {
  const t = it.teacher;
  const out = [];
  out.push(`### ${it.rubric_item_id}  ${it.rubric_text.slice(0, 120)}`);
  out.push(`- 教师给分：${t.score} / ${t.max}`
    + `    ${t.verdict === 'accurate' ? '教师：已确认' : t.verdict === null ? '教师：未标注（未三选）' : t.verdict === 'partially_accurate' ? '教师：部分准确' : '教师：不准确'}`
    + `${t.note ? `   教师备注：${t.note}` : ''}`);
  if (!it.assessment) { out.push('- （该条目没有系统评价）'); return out.join('\n'); }
  const a = it.assessment;
  out.push(`- ${a.strategy_type === 'levels' ? `系统状态：${a.level_status}${a.candidate_level_ids.length ? ` 候选档=${JSON.stringify(a.candidate_level_ids)}` : ''}` : `系统判断：${a.judgment}`}；依据引用 ${a.evidence_count} 处${a.review_required ? '（系统标注需人工复核）' : ''}`);
  for (const f of a.findings) out.push(findingLine(f));
  return out.join('\n');
}

// ★ 两套材料，**物理隔离**：student_text 只见已确认条目；pending_notes 只见未确认/有异议条目。
//   调用 A 的材料里根本没有未确认内容 → 泄漏不可能发生（不靠"提醒它别写"）。
export function summaryMessage({ ctx, mode = 'student_text', unconfirmedItems = [], criticizedItems = [] }) {
  const lines = [];
  if (mode === 'student_text') {
    const confirmed = ctx.items.filter(it => it.content_confirmed);
    lines.push('## 任务（这次只写「学生可见的总结评语正文」，用 ' + SUMMARY_TEXT_TOOL + ' 提交）');
    lines.push(`为这份实验报告（${ctx.docName}）写总结评语。下面每一条**都已获教师确认**，可以直接使用其评价内容；教师给分是准绳。`);
    lines.push('先讲做得好的地方，再讲需要改的地方，最后给一两条最有价值的改进建议。不出现任何分数。');
    lines.push('');
    lines.push('## 教师已确认的条目');
    lines.push(confirmed.length ? confirmed.map(renderItem).join('\n\n') : '（无）');
  } else {
    const notConfirmed = ctx.items.filter(it => !it.content_confirmed);
    lines.push('## 任务（这次只写「待教师确认的观察」，用 ' + SUMMARY_PENDING_TOOL + ' 提交；**不向学生发布**）');
    lines.push('下列条目教师**没有确认内容**（未三选 / 认为部分准确或不准确），或观察无法回原文核对。');
    lines.push('请整理成教师可快速判断的清单：教师据此决定"这条要不要改、要不要发给学生"。按条目分组。');
    lines.push('');
    lines.push(`## 未确认 / 有异议的条目（未三选：${unconfirmedItems.length ? unconfirmedItems.join('、') : '无'}；`
      + `教师认为部分准确或不准确：${criticizedItems.length ? criticizedItems.join('、') : '无'}）`);
    lines.push(notConfirmed.length ? notConfirmed.map(renderItem).join('\n\n') : '（无）');
  }
  lines.push('');
  lines.push('## 完整原文（逐字，未经任何改写 —— 复述事实时以它为准）');
  lines.push('```');
  lines.push(ctx.full);
  lines.push('```');
  return lines.join('\n');
}

// ------------------------------------------------------------------ 产物装配

// ★ 分数**不由模型输出**：这里回抄的是教师给分（程序复制），并与输入逐条核对。
export function assembleSummaryArtifact({
  assessmentArtifact, assessmentRef, teacherScores, teacherScoresRef,
  rubric, rubricFile, summary, unconfirmedItems, criticizedItems, verification,
  contentUnconfirmedItems = [], unanchoredFindings = [], releaseBlockers = [], approved = false,
  notices = null, turns = null, usage = null,
}) {
  // ★ 回抄 + 机械核对：产物里的分数必须与输入**逐条一致**（模型没有改写它们的通道）
  const aById = new Map((assessmentArtifact.assessments ?? []).map(a => [a.rubric_item_id, a]));
  const teacher_scores = (teacherScores.entries ?? []).map(e => {
    const a = aById.get(e.rubric_item_id);
    return {
      rubric_item_id: e.rubric_item_id,
      score: e.score,
      max: e.max,
      verdict: e.verdict ?? null,
      verdict_note: e.note ?? null,
      system_verdict: a ? (a.strategy_type === 'levels' ? { level_status: a.level_status, candidate_level_ids: a.candidate_level_ids ?? [] } : { judgment: a.judgment }) : null,
      findings_concern: (a?.findings ?? []).filter(f => f.polarity === 'concern').length,
      findings_strength: (a?.findings ?? []).filter(f => f.polarity === 'strength').length,
    };
  });
  const total = teacher_scores.reduce((s, e) => s + e.score, 0);
  const maxTotal = teacher_scores.reduce((s, e) => s + e.max, 0);

  // ★ 发布闸：起草态是默认；只有输入里带显式批准记录才可能 approved。
  const blockers = [...releaseBlockers];
  if (summary && summary.chars > SUMMARY_SOFT_TARGET) blockers.push('over_target_length');
  const release = {
    status: approved ? 'teacher_approved' : 'draft',
    approved_by: teacherScores.approval?.approved_by ?? null,
    approved_at: teacherScores.approval?.approved_at ?? null,
    blockers,
    rule: '默认 draft：未经教师批准发布的评语不得交给学生；blockers 全空才可能 approved',
  };

  // ★★ 定位传递（Yukii 指出：L4 有定位 ≠ 教师能从评语点回原文）：
  //   把 L4 每条 finding 的定位与挂钩状态**程序回抄**进产物 —— 教师可以据此从评语对应回原文。
  const source_index = (assessmentArtifact.assessments ?? []).flatMap(a => (a.findings ?? []).map(f => ({
    rubric_item_id: a.rubric_item_id,
    polarity: f.polarity,
    kind: f.kind,
    severity: f.severity ?? null,
    note: f.note,
    derived_by: 'model',
    quote: f.quote ?? null,
    located: f.located ? { offset: f.located.offset, source_ref: f.located.source_ref } : null,
    l3: f.verification ? { check_id: f.verification.check_id, stance: f.verification.stance } : null,
    anchored: !!(f.located || f.verification),
  })));
  const anchoredCount = source_index.filter(f => f.anchored).length;

  return {
    authority: {
      scoring_authority: 'rubric',
      rubric_sha256: rubric.source.sha256,
      layer_produces_score: false,                 // ★ 评语层同样不产生分值
      // ★★ 不再无条件声称"教师已确认"：由输入文件的 status 决定（provisional_test ⇒ false）
      scores_are_teacher_final: teacherScores.status === 'teacher_confirmed',
      teacher_scores_status: teacherScores.status ?? null,
      layer_version: SUMMARY_VERSION,
      notes: '总结评语层：以教师给分为准绳，把「分数 + 逐条评价」翻译成学生能读的话。'
        + '★ text 只含教师已确认（verdict=accurate）的内容；未三选/有异议/无法回原文核对的观察一律进 pending_notes，不向学生发布。'
        + '发布状态见 release：默认 draft，未经批准不得交付学生。',
    },
    doc: assessmentArtifact.doc,
    rubric: { rubric_id: rubric.rubric_id, source_sha256: rubric.source.sha256, file: rubricFile },
    assessment: assessmentRef,                     // L4 产物：文件名 + sha256（只引用不复制）
    teacher_scores: teacherScoresRef,              // 教师给分：文件名 + sha256
    score_summary: {                               // ★ 程序回抄的教师最终分（不是模型输出）
      total, maximum: maxTotal,
      by_item: teacher_scores.map(e => ({ rubric_item_id: e.rubric_item_id, score: e.score, max: e.max })),
    },
    per_item: teacher_scores,
    unconfirmed_items: unconfirmedItems,           // ★ 未三选 ≠ 准确（程序算）
    criticized_items: criticizedItems,             // 教师认为不准确/部分准确
    content_unconfirmed_items: contentUnconfirmedItems,   // ★ 内容未逐条确认（非 accurate 的全部）
    unanchored_findings: unanchoredFindings,       // ★ 既无原文定位也无 L3 挂钩 —— 无法核对
    anchor_summary: { total: source_index.length, anchored: anchoredCount, unanchored: source_index.length - anchoredCount },
    source_index,                                  // ★ 每条 finding → 原文定位/挂钩（教师可据此点回原文）
    release,
    summary: summary ? {
      summary_id: summary.summary_id,
      text: summary.text,                          // 学生可见正文（只含教师已确认内容）
      chars: summary.chars,
      pending_notes: summary.pending_notes,        // ★ 不向学生发布：待教师确认的观察
      pending_chars: summary.pending_chars,
      derived_by: 'model',
      target: SUMMARY_SOFT_TARGET,
      over_target: summary.chars > SUMMARY_SOFT_TARGET,
    } : null,
    diagnostics: {
      diagnostic_only: true,
      summary_version: SUMMARY_VERSION,
      attempted: verification?.attempted ?? null,
      accepted: verification?.accepted ?? null,
      rejected: verification?.rejected ?? null,
      accounted: verification ? verification.attempted === verification.accepted + verification.rejected : null,
      turns: turns ?? null,
      usage: usage ?? null,
      notices,
      not_a_score: '本产物不含任何新分数：分数由教师在上一阶段给出并经程序回抄；评语层不加内容闸（上游教师已把关），但发布受 release 闸约束。',
    },
  };
}
