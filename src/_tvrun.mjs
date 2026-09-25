// _tvrun.mjs —— 教师视图的驱动：L4 产物 → 教师视图（整篇优先观察 → rubric 条目 → 原文）
//
// ★ 只做**展示层**：不改 L1–L4、不调用模型、不新增评分机制、不做排序模型。
//   排序规则写在 `teacherview.mjs` 里（严重程度 + 可核对性 + 是否有 L3 反证），可解释、可复现。
//
// 用法：
//   node _tvrun.mjs --case 2019-calculus-RR03-0516.txt --out fixtures/veras/out-holdout
//   node _tvrun.mjs --case cs3223-writeup.pdf --out fixtures/real/out \
//        --rubric design/canonical-rubric.cs3223-test.json --profile design/rubric-assessment-profile.cs3223-test.json
//
// 产出：<out>/<case>.teacher-view.json + 报告 src/_tvrun.out.txt（含"教师看到的样子"的终端渲染）

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeacherView, teacherViewText, TV_VERSION, qualifiesForTop } from './teacherview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const CASE = argOf('--case', '2019-calculus-RR03-0516.txt');
const OUT = path.resolve(root, argOf('--out', 'fixtures/veras/out-holdout'));
const RUBRIC_PATH = path.resolve(root, argOf('--rubric', 'design/canonical-rubric.veras-pendulum.json'));
const PROFILE_PATH = path.resolve(root, argOf('--profile', 'design/rubric-assessment-profile.veras-pendulum.json'));
const TOPN = Number(argOf('--top', 3));

const readJson = async p => JSON.parse(await fsp.readFile(p, 'utf8'));
const rep = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) rep.push(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};
const note = s => rep.push(`  ${s}`);

const ASSESS = path.join(OUT, CASE + '.assessment.json');
const assessmentArtifact = await readJson(ASSESS);
// ★ 检查范围要用到"本次解析的正文/警告" —— 从 L1 索引读取（不是从产物自报，避免二手信息）
const idxDoc = await readJson(path.join(OUT, CASE + '.index.json')).catch(() => null);
const parseInfo = idxDoc ? {
  chars: idxDoc.doc?.chars ?? null,
  entries: (idxDoc.entries ?? []).length,
  warnings: idxDoc.doc?.warnings ?? [],
  index_file: CASE + '.index.json',
  text_file: CASE + '.txt',
} : null;
const rubric = await readJson(RUBRIC_PATH);
const profile = await readJson(PROFILE_PATH);

// ★ 第二条通道需要原文来切"学生实际写的段落"
const fullText = await fsp.readFile(path.join(OUT, CASE + '.txt'), 'utf8').catch(() => null);   // 第二条通道要切上下文
const view = buildTeacherView({ assessmentArtifact, rubric, profile, topN: TOPN, parseInfo, missingLimit: 3, fullText, gapLimit: 1 });
const body = JSON.stringify(view, null, 2) + '\n';
await fsp.mkdir(OUT, { recursive: true });
await fsp.writeFile(path.join(OUT, CASE + '.teacher-view.json'), body, 'utf8');

// ------------------------------------------------------------------ 自证

rep.push(`=== 教师视图（精简展示 ${TV_VERSION}）===`);
rep.push(`来源：${path.relative(root, ASSESS).split(path.sep).join('/')}（L4 ${assessmentArtifact.authority?.layer_version ?? '?'}）`);
rep.push(`产出：${path.relative(root, path.join(OUT, CASE + '.teacher-view.json')).split(path.sep).join('/')}（${body.length} 字节）`);
rep.push(`rubric：${path.relative(root, RUBRIC_PATH).split(path.sep).join('/')}`);
rep.push(`profile：${path.relative(root, PROFILE_PATH).split(path.sep).join('/')}`);
rep.push(`条目 ${view.stats.rubric_items} · 观察 ${view.stats.findings_total}（展示 ${view.stats.findings_shown} / 折叠 ${view.stats.findings_folded}）`);
rep.push(`整篇优先观察：${view.whole_report.top_concerns.length}/${view.whole_report.ranked_total}（折叠 ${view.whole_report.folded_count}）`);
rep.push('');

// ① 整篇最多 topN 条
eq(`★ 整篇优先观察 ≤ ${TOPN} 条（N 只是上限，不凑满）`, view.whole_report.top_concerns.length <= TOPN, true);
// ★★ 门槛合规：入选的每一条都必须"有可核对依据 + 值得优先看"
eq('★★ 入选整篇展示的每条都过了门槛（有可核对依据 且 值得优先看）',
  view.whole_report.top_concerns.every(f => qualifiesForTop(f)), true);
// ★★ 门槛**不看**模型自报的 severity / kind：构造反例 —— 一个"自称 major 但没有核验依据"的观察不得入选
eq('★★ 门槛不认自报 severity：自称 major 但无绑定依据的观察不得上第一屏',
  view.whole_report.top_concerns.every(f => f.warrant?.bound === true || f.verification?.stance === 'fail'), true);
// ★★ (b) **合成自证**：直接构造"两条 concern 引同一句话、挂在两个条目上"的产物，
//   验证合并逻辑本身（不依赖真实样本碰巧产生重复）。
eq('★★ 同一处错误被多个条目各报一次 → 合并为一条并挂全部条目（合成用例）',
  (() => {
    const Q = 'the length of the string(iv) is directly proportional to the period(dv).';
    const mk = (id, quote) => ({
      rubric_item_id: id, strategy_type: 'levels', rationale: { chars: 10, limit: 2000, over_limit: false },
      level_status: 'candidate', candidate_level_ids: [], boundary_condition: null, review: { required: false, required_reason_codes: [] },
      findings: [{ polarity: 'concern', kind: 'reasoning', note: `关于 ${id} 的同一处错误`, severity: 'minor', quote,
        located: { offset: { start: 0, end: quote.length }, source_ref: { file: 'x', entry: 'e1' }, binding: { mode: 'first', selection: 'unambiguous', occurrences: 1 } },
        warrant: { student_quote: quote, student_quote_located: { offset: { start: 0, end: quote.length } },
          what_is_wrong: '正确应是平方根关系 T∝√L，不是线性正比', basis_kind: 'rubric_requirement',
          basis_detail: 'R3 的 L5 要求 square root of length 或 power law', bound: true, unbound_reasons: [], binding_scope: 'structural_only' } }],
    });
    const art = { doc: { name: 'syn.txt' }, rubric: {}, assessments: [mk('R3', Q), mk('R5', Q + ' ')] };  // 第二份只差一个空格
    const v2 = buildTeacherView({ assessmentArtifact: art, rubric, profile, topN: 3 });
    const t = v2.whole_report.top_concerns;
    return t.length === 1 && t[0].rubric_item_ids.length === 2 && t[0].merged_from === 2;
  })(), true);
// ★★ (b) 合并纪律：同一引文不得在 top 里出现两次
const normQ = x => String(x ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const topQuotes = view.whole_report.top_concerns.map(f => normQ(f.warrant?.student_quote ?? f.quote ?? '')).filter(Boolean);
eq('★★ 同一处错误不得重复占第一屏（同引文只出现一次）', topQuotes.length === new Set(topQuotes).size, true);
eq('★ 入选的内容错误候选都必须带齐三要素（原话定位 + 错在哪 + 依据）',
  view.whole_report.top_concerns.filter(f => f.warrant?.bound === true).every(f =>
    f.warrant.student_quote && f.warrant.student_quote_located && f.warrant.what_is_wrong
    && f.warrant.basis_kind && f.warrant.basis_detail), true);
// ★ 排序依据里必须写出"依据"维度（而不是只写 severity）
eq('★ 排序依据标明"依据"维度（依据强度 > 影响理解 > 可核查性 > 自报严重程度[仅辅助]）',
  view.whole_report.top_concerns.every(f => /依据\(/.test(f.rank_reason) && /仅辅助/.test(f.rank_reason)), true);
// ★★「可能缺少的关键内容」的四条铁律（Yukii 定）
const kg = view.whole_report.key_gaps;
eq('★ 关键缺项/论述不足有上限（第一屏最多 1 条）', kg.entries.length <= kg.limit, true);
// ★★ 硬纪律：入选**不靠模型自报的 severity** —— 每条入选必须有原文定位（或明确标为"未定位"）
eq('★★ 关键缺项的入选不是靠自报 severity：每条都必须有原文定位，或明确标 not_found',
  kg.entries.every(e => e.status === 'argument_gap' || e.status === 'not_found'), true);
eq('★ 有定位的必须给出"做到了什么/尚未说明什么"与 rubric 要求',
  kg.entries.filter(e => e.status === 'argument_gap').every(e => e.does_and_misses && e.rubric_requirement), true);
eq('★ 都不是"已证明全文没写"（必须提示教师核对原件）',
  kg.entries.every(e => /对照原件|核对原件|未能在已解析文本中定位/.test(e.caveat)), true);
eq('★ 关键缺项与第一屏问题不重叠',
  kg.entries.every(e => !view.whole_report.top_concerns.some(t => t.rubric_item_id === e.rubric_item_id && t.note === e.does_and_misses)), true);

const pm = view.whole_report.possibly_missing;
eq('★ 可能缺少的关键内容有上限（不铺满）', pm.entries.length <= pm.limit, true);
const ASSERTIVE = ['没有写', '未写', '不存在', '缺失', '漏写', '没写', '未提及'];
eq('★★ 缺失提示不得构成"不存在"的断言（不许断言 没有写/不存在/缺失）',
  pm.entries.every(e => !ASSERTIVE.some(w => e.statement.includes(w))), true);
eq('★ 每条缺失提示都必须落到"请教师核对"或"无法确认"',
  pm.entries.every(e => /请教师核对|无法确认/.test(e.statement)), true);
eq('★ 每条缺失提示都带：检查范围 + 全文入口 + rubric 条目',
  pm.entries.every(e => e.check_scope && e.see_full_text && e.rubric_item_id && e.rubric_text !== undefined), true);
eq('★★ 文本提取不完整时只能标"无法确认"，不能报缺失',
  pm.check_scope.extract_reliable === true
  || pm.entries.every(e => e.status === 'cannot_confirm' && /无法确认/.test(e.statement)),
  true);
// ★ 排序不把 severity 当第一维（三维依据都要在产物里）
eq('★★ 排序依据写明了三维（影响理解 → 可核查性 → 自报严重程度）',
  typeof view.whole_report.rank_dimensions === 'string' && view.whole_report.rank_dimensions.length > 0, true);
// ★★ 门槛**不使用**模型置信度数字：产物里不得出现这类字段
const CONF_KEYS = ['certainty', 'confidence', 'probability', 'score_threshold'];
const confKeys = (o, acc = []) => {
  if (Array.isArray(o)) { for (const x of o) confKeys(x, acc); return acc; }
  if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) { if (CONF_KEYS.includes(k)) acc.push(k); confKeys(v, acc); } }
  return acc;
};
eq('★★ 门槛不使用未经校准的模型置信度数字（产物里没有这类字段）', confKeys(view), []);
// ② 每条约目默认最多 1 条问题 + 1 条优点
eq('★ 每条 rubric 默认只展示 1 条关键问题 + 至多 1 条做得好的',
  view.items.every(it => (it.primary_concern ? 1 : 0) <= 1 && (it.primary_strength ? 1 : 0) <= 1 && it.shown_count <= 2), true);
// ③ ★★ 主视图不出现 AI 评级（候选档位 / 判断 / 分数）—— 机械检查
// ★ 用**遍历 key** 判定，不用字符串匹配 —— 字符串匹配会把"声明隐藏了什么"的字段名
//   （如 authority.no_ai_score、hidden.ai_candidate_levels）当成泄漏命中（实测踩到）。
//   同时豁免 authority / hidden 两个"声明区"：它们的职责就是说明隐藏了什么。
const FORBIDDEN_KEYS = ['candidate_level_ids', 'judgment', 'level_status', 'awarded', 'boundary_condition'];
const collectKeys = (o, acc = [], inDecl = false) => {
  if (Array.isArray(o)) { for (const x of o) collectKeys(x, acc, inDecl); return acc; }
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      const decl = inDecl || k === 'authority' || k === 'hidden';
      if (!decl && FORBIDDEN_KEYS.includes(k)) acc.push(k);
      collectKeys(v, acc, decl);
    }
  }
  return acc;
};
const leaked = collectKeys(view);
eq('★★ 主视图不含 AI 候选档位 / AI 判断 / 任何 AI 分数（隐藏纪律）', leaked, []);
// ④ 守恒：不丢信息（每条目 folded.total = 产物里该条目的 findings 数）
const aById = new Map((assessmentArtifact.assessments ?? []).map(a => [a.rubric_item_id, a]));
eq('★ 守恒：每条目标注的观察总数 = L4 产物里的条数（折叠不等于丢弃）',
  view.items.every(it => it.folded.total === ((aById.get(it.rubric_item_id)?.findings ?? []).length)), true);
eq('★ 守恒：展示 + 折叠 = 全部观察',
  view.stats.findings_shown + view.stats.findings_folded, view.stats.findings_total);
// ⑤ 展示的观察都来自产物（不新增）
const prodNotes = new Set((assessmentArtifact.assessments ?? []).flatMap(a => (a.findings ?? []).map(f => `${a.rubric_item_id}|${f.note}`)));
const shownNotes = [...view.whole_report.top_concerns, ...view.items.flatMap(it => [it.primary_concern, it.primary_strength].filter(Boolean))]
  .map(f => `${f.rubric_item_id}|${f.note}`);
eq('★ 展示的观察全部来自 L4 产物（展示层不新增内容）', shownNotes.every(k => prodNotes.has(k)), true);
// ⑥ 不确定必须标出来
const shownAll = [...view.whole_report.top_concerns, ...view.items.flatMap(it => [it.primary_concern, it.primary_strength].filter(Boolean))];
eq('★ 每条展示的观察都带可核查性标注（anchor_note）', shownAll.every(f => typeof f.anchor_note === 'string' && f.anchor_note.length > 0), true);
eq('★ 无定位且无验证挂钩的观察 → 标注里必须出现"请勿当作确定结论"',
  shownAll.filter(f => !f.located && !f.verification).every(f => /请勿当作确定结论/.test(f.anchor_note)), true);
eq('★ 无法核对的观察被单独列出（与 stats 一致）',
  view.unanchored_findings.length, view.stats.unanchored);
// ⑦ 档位描述逐字来自 rubric 定义（不是 AI 候选）
const pById = new Map((profile.items ?? []).map(i => [i.rubric_item_id, i]));
eq('★ 档位描述逐字来自 profile（rubric 定义），不是 AI 候选档',
  view.items.every(it => {
    const st = pById.get(it.rubric_item_id)?.scoring_strategy;
    if (st?.type !== 'levels') return it.level_reference.length === 0;
    return it.level_reference.length === st.levels.length &&
      it.level_reference.every((l, i) => l.level_id === st.levels[i].level_id && l.text === st.levels[i].text);
  }), true);
// ⑧ 排序可复现
const view2 = buildTeacherView({ assessmentArtifact, rubric, profile, topN: TOPN });
eq('★ 视图可复现（同输入两次结果完全一致）',
  JSON.stringify(view2.whole_report.top_concerns.map(f => f.note)) === JSON.stringify(view.whole_report.top_concerns.map(f => f.note)), true);
eq('★ 每条排序都带可解释依据（rank_reason）', view.whole_report.top_concerns.every(f => typeof f.rank_reason === 'string' && f.rank_reason.length > 0), true);
eq('★ 每条展示的观察都带重要性提示（次要问题被标出，不冒充满分重要）',
  shownAll.every(f => f.importance_hint === 'primary' || f.importance_hint === 'secondary'), true);
// ⑨ 显示接口：教师可展开全部、可看到完整报告、可自行给分（结构上保证）
eq('★ 结构上保留"展开全部 / 查看完整报告 / 教师自行给分"的通道',
  view.authority.no_ai_score === true && view.authority.ai_grading_hidden === true &&
  view.items.every(it => it.folded.total >= it.shown_count) &&
  typeof view.source_assessment.file === 'string', true);

rep.push('');
rep.push('--- ★ 教师看到的样子（终端渲染，与产物同源）---');
rep.push(teacherViewText(view));
// ★ (a) 措辞纪律（必须在**渲染之后**检查 —— 这里 rep 才含教师可见文本）
const TV_TEXT = rep.join('\n');
eq('★★ 面向教师的文案不得暗示"内容已被证实"（不得写"经程序核验/已验证/已核实"）',
  !/经程序核验|已验证|已核实/.test(TV_TEXT), true);
eq('★ 内容错误候选的措辞必须是"依据已绑定，内容待核对"',
  !view.whole_report.top_concerns.some(f => f.warrant?.bound === true) || /依据已绑定，内容待核对/.test(TV_TEXT), true);

rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' 项失败'} ====`);
await fsp.writeFile(path.join(here, '_tvrun.out.txt'), rep.join('\n') + '\n', 'utf8');
console.log(rep.join('\n'));
if (bad > 0) {
  process.stderr.write(`_tvrun: ${bad} 项自证失败\n` + rep.filter(l => /FAIL/.test(l)).join('\n') + '\n');
  process.exitCode = 1;
}
