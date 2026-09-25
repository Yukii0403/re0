// _freezecheck.mjs —— 小规模新案例检查（冻结前）
//
// 三件事（Yukii 9/25 定）：
//   ① **第一屏是否说对** —— 逐条回原文核对（人判）
//   ② **是否重复** —— 机械可判：第一屏内引文（归一化）必须唯一
//   ③ **折叠区是否埋了关键问题** —— 从折叠里按"若被埋最可惜"排序抽一批（人判）
//
// ★ 样本纪律：只用**未参与改规则**的报告；0503 / 0516 只做回归（不在此列）。
//
// 用法：node _freezecheck.mjs

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeacherView, qualifiesForTop } from './teacherview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const VDIR = path.join(root, 'fixtures/veras');
const OUT = path.join(VDIR, 'out-holdout');

const CASES = [
  { id: '2019-calculus-RR03-0655', band: '高' },
  { id: '2019-calculus-RR03-0982', band: '高' },
  { id: '2019-calculus-RR03-0820', band: '中' },
  { id: '2019-calculus-RR03-0552', band: '中' },
  { id: '2019-calculus-RR03-1005', band: '中低' },
  { id: '2019-calculus-RR03-0531', band: '低' },
];
const DEV = ['2019-calculus-RR03-0516', '2018-algebra-RR03-0223', '2018-algebra-RR03-0063',
  '2019-calculus-RR03-0503', '2019-calculus-RR03-0618', '2019-calculus-RR03-0517'];

const readJson = async p => JSON.parse(await fsp.readFile(p, 'utf8'));
const readIf = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } };
const gold = await readJson(path.join(VDIR, 'holdout/holdout.pendulum.json'));
const profile = await readJson(path.join(root, 'design/rubric-assessment-profile.veras-pendulum.json'));
const rubric = await readJson(path.join(root, 'design/canonical-rubric.veras-pendulum.json'));
const pById = new Map(profile.items.map(i => [i.rubric_item_id, i]));

const norm = s => String(s ?? '').replace(/[\s\p{P}]+/gu, '').toLowerCase();
const L = [];
const J = { rule: '冻结前检查：① 第一屏是否说对（人判）② 是否重复（机械）③ 折叠区是否埋关键问题（人判抽查）', cases: [], machine: {} };

let mRepeat = 0, mFailGate = 0, mOverN = 0, mNoPage = 0, shownTotal = 0;
let foldCandidates = 0;

L.push('# 冻结前检查 · 小规模新案例（未参与改规则）');
L.push('');
L.push('> 样本纪律：**0503 / 0516 只做回归**，不在此列；本表只用未参与规则制定的 6 份（高/中/低覆盖）。');
L.push('> 三件事：① 第一屏是否说对（人判）② 是否重复（机械）③ 折叠区是否埋了关键问题（抽查人判）。');
L.push('');

for (const c of CASES) {
  const artRaw = await readIf(path.join(OUT, c.id + '.txt.assessment.json'));
  if (!artRaw) { L.push(`## ${c.id}（${c.band}）\n\n（没有产物，跳过）\n`); continue; }
  const art = JSON.parse(artRaw);
  const full = (await readIf(path.join(VDIR, 'holdout', c.id + '.txt'))) ?? '';
  const g = (gold.reports ?? []).find(x => x.id === c.id);
  const goldTotal = g ? g.dims.reduce((a, b) => a + b, 0) : null;

  const view = buildTeacherView({ assessmentArtifact: art, rubric, profile, topN: 3 });
  const top = view.whole_report.top_concerns;

  // ② 机械：第一屏内引文唯一（不重复）
  const quotes = top.map(f => norm(f.warrant?.student_quote ?? f.quote ?? '')).filter(Boolean);
  const dup = quotes.length !== new Set(quotes).size;
  if (dup) mRepeat++;
  // 第一屏每条都过门槛
  const gateOk = top.every(f => qualifiesForTop(f));
  if (!gateOk) mFailGate++;
  if (top.length > 3) mOverN++;
  // 页码可得性
  const withPage = top.filter(f => f.located?.source_ref?.page != null).length;
  if (top.length && withPage < top.length) mNoPage++;
  shownTotal += top.length;

  // ③ 折叠区候选：从折叠的 concern 里按"若被埋最可惜"排序（有 L3 反证 > 有核验依据 > 较严重）
  const keyTop = new Set(top.map(f => `${f.rubric_item_id}|${f.note}`));
  const folded = (art.assessments ?? []).flatMap(a => (a.findings ?? [])
    .map(f => ({ a, f }))
    .filter(({ a, f }) => f.polarity === 'concern' && !keyTop.has(`${a.rubric_item_id}|${f.note}`)))
    .map(({ a, f }) => ({
      rubric_item_id: a.rubric_item_id, kind: f.kind, severity: f.severity ?? null, note: f.note,
      quote: f.quote ?? null, anchored: !!(f.located || f.verification),
      l3fail: f.verification?.stance === 'fail', bound: f.warrant?.bound === true,
      score: (f.verification?.stance === 'fail' ? 0 : f.warrant?.bound ? 1 : f.severity === 'major' ? 2 : f.anchored ? 3 : 4),
    }))
    .sort((x, y) => x.score - y.score);
  const sample = folded.slice(0, 4);
  foldCandidates += folded.length;

  L.push(`## ${c.id}（${c.band}质量档 · gold ${goldTotal}/35）`);
  L.push('');
  L.push(`- 机械检查：第一屏 ${top.length} 条 · 引文唯一 **${dup ? '✗ 有重复' : '✓'}** · 全部过门槛 **${gateOk ? '✓' : '✗'}** · 带页码 ${withPage}/${top.length} · 折叠 concern ${folded.length} 条`);
  L.push('');
  L.push('### ① 第一屏（逐条回原文核对：是否真实存在 / 是否说过头 / 引用与解释是否相符）');
  L.push('');
  if (!top.length) L.push('（**0 条** —— 合格观察不足时不凑满）');
  top.forEach((f, i) => {
    const pg = f.located?.source_ref?.page;
    L.push(`**${i + 1}. [${(f.rubric_item_ids || [f.rubric_item_id]).join('/')}] ${f.kind}${f.severity ? '/' + f.severity : ''}`
      + `${pg != null ? ' · 第 ' + pg + ' 页' : ''}** ${f.warrant?.bound ? '（内容错误候选·依据已绑定）' : f.verification?.stance === 'fail' ? '（L3 反证）' : ''}`);
    L.push('');
    L.push(`- 观察：${f.note}`);
    if (f.warrant?.bound) {
      L.push(`- 学生原话：${f.warrant.student_quote}`);
      L.push(`- 错在哪：${f.warrant.what_is_wrong}`);
      L.push(`- 依据（${f.warrant.basis_kind}）：${f.warrant.basis_detail}`);
    }
    if (f.verification) L.push(`- L3：\`${f.verification.check_id}\` → **${f.verification.stance}**`);
    if (f.quote) L.push(`- 引文：\`${String(f.quote).slice(0, 160)}\``);
    L.push('- 核查：① 真实存在？`____`　② 说过头？`____`　③ 引用/解释相符？`____`');
    L.push('');
  });
  L.push('### ③ 折叠区抽查（按"若被埋最可惜"排序取前 4）');
  L.push('');
  if (!sample.length) L.push('（无折叠 concern）');
  sample.forEach((f, i) => {
    L.push(`- **${i + 1}. [${f.rubric_item_id}] ${f.kind}${f.severity ? '/' + f.severity : ''}**`
      + `${f.l3fail ? ' · **有 L3 反证**' : f.bound ? ' · 有绑定依据' : f.anchored ? ' · 可回原文核对' : ' · ⚠无法核对'}`);
    L.push(`    - ${f.note}`);
    if (f.quote) L.push(`    - 引文：\`${String(f.quote).slice(0, 140)}\``);
    L.push('    - ★ **是否比第一屏更该先看？** `是 / 否`');
  });
  L.push('');
  L.push('---');
  L.push('');

  J.cases.push({
    id: c.id, band: c.band, gold_total: goldTotal,
    top: top.map(f => ({ ids: f.rubric_item_ids || [f.rubric_item_id], kind: f.kind, severity: f.severity, page: f.located?.source_ref?.page ?? null, bound: f.warrant?.bound === true, l3fail: f.verification?.stance === 'fail', note: f.note })),
    machine: { duplicate_quote: dup, all_pass_gate: gateOk, with_page: withPage, folded_concerns: folded.length },
    folded_sample: sample.map(f => ({ rubric_item_id: f.rubric_item_id, kind: f.kind, severity: f.severity, note: f.note, l3fail: f.l3fail, bound: f.bound })),
  });
}

J.machine = { cases: CASES.length, duplicates: mRepeat, gate_violations: mFailGate, over_n: mOverN, cases_with_missing_page: mNoPage, shown_total: shownTotal, folded_concerns_total: foldCandidates };
J.dev_cases_excluded = DEV;
J.note = '★ 本表只用于"已知案例之外"的检查；结论若通过则冻结当前规则版本。0503/0516 仅作回归。';

L.push('## 机械检查汇总');
L.push('');
L.push(`- 样本 ${CASES.length} 份 · 第一屏合计 ${shownTotal} 条`);
L.push(`- **重复**（第一屏内引文重复的样本数）：${mRepeat}`);
L.push(`- **门槛违规**：${mFailGate}`);
L.push(`- **超出上限（>3）**：${mOverN}`);
L.push(`- **有观察缺页码的样本**：${mNoPage}`);
L.push(`- 折叠 concern 合计：${foldCandidates}`);
L.push('');
L.push(`★ 0503 / 0516 只作回归，未列入本表：${DEV.join('、')}`);

await fsp.writeFile(path.join(VDIR, 'freeze-check.md'), L.join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(VDIR, 'freeze-check.json'), JSON.stringify(J, null, 2) + '\n', 'utf8');
console.log('冻结前检查表：fixtures/veras/freeze-check.md');
console.log(`  样本 ${CASES.length} 份 · 第一屏 ${shownTotal} 条 · 重复 ${mRepeat} · 门槛违规 ${mFailGate} · 缺页码样本 ${mNoPage}`);
