// _auditsheet.mjs —— 人工核查工作表（P0-2）
//
// 目的：把"评价是否说对"变成**可逐条核查的工作表**，而不是依赖印象。
//   ★ 每条观察旁就把**原文上下文**（不是孤零零的引文）、**该条目的 rubric 陈述与档位描述**、
//     **L3 机械验证结论**摆出来 —— 核查者不必再翻原文。
//
// ★★ 核查必须**两路都做**（Yukii 2026-09-24 定）：
//   · A 路（入选项）：整篇优先展示的那些 —— 测"教师第一眼看到的评价准不准"；
//   · B 路（抽查折叠项）：从折叠里按"若被埋掉最可惜"排序抽一批 —— 测"筛选有没有漏掉关键内容"。
//   **只查 A 路证明不了筛选质量**，这是本文件分两路的原因。
//
// ★ 严格分开两类指标：
//   · **原文可定位率**：机械可算 → 本脚本给完整数字；
//   · **评价正确率**：必须人判 → 四类判项**一律留空**，不预填、不暗示。
//
// 用法：node _auditsheet.mjs [--n 2] [--sample 4] [--out fixtures/veras/out-holdout]

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeacherView, normalizeFinding, qualifiesForTop } from './teacherview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(root, argOf('--out', 'fixtures/veras/out-holdout'));
const PER_BAND = Number(argOf('--n', 2));
const SAMPLE_PER_CASE = Number(argOf('--sample', 4));   // 每份从折叠里抽查几条

const VDIR = path.join(root, 'fixtures/veras');
const gold = JSON.parse(await fsp.readFile(path.join(VDIR, 'holdout/holdout.pendulum.json'), 'utf8'));
const profile = JSON.parse(await fsp.readFile(path.join(root, 'design/rubric-assessment-profile.veras-pendulum.json'), 'utf8'));
const rubric = JSON.parse(await fsp.readFile(path.join(root, 'design/canonical-rubric.veras-pendulum.json'), 'utf8'));

// ★ 数据跳过 / 失败的样本不进核查（其产物无效）
const predsDoc = await fsp.readFile(path.join(OUT, 'predictions.pendulum.json'), 'utf8').then(JSON.parse).catch(() => ({ predictions: [] }));
const skipIds = new Set((predsDoc.predictions ?? []).filter(p => p.skipped || p.failed).map(p => p.id));

// ---- 抽样：按 gold 分档（覆盖不同质量；每份天然含 levels 维与 points 维）
const scored = [];
for (const g of gold.reports) {
  const total = g.dims.reduce((a, b) => a + b, 0);
  if (skipIds.has(g.id)) continue;
  const raw = await fsp.readFile(path.join(OUT, `${g.id}.txt.assessment.json`), 'utf8').catch(() => null);
  if (!raw) continue;
  scored.push({ id: g.id, status: g.status, total, dims: g.dims, artifact: JSON.parse(raw) });
}
scored.sort((a, b) => b.total - a.total);
const mid = Math.floor(scored.length / 2) - Math.floor(PER_BAND / 2);
const picks = [
  ...scored.slice(0, PER_BAND).map(x => ({ ...x, band: '高' })),
  ...scored.slice(mid, mid + PER_BAND).map(x => ({ ...x, band: '中' })),
  ...scored.slice(-PER_BAND).map(x => ({ ...x, band: '低' })),
];

const ctxAround = (full, f, pad = 90) => {
  if (f.located?.offset) {
    const { start, end } = f.located.offset;
    return { before: full.slice(Math.max(0, start - pad), start), hit: full.slice(start, end), after: full.slice(end, end + pad) };
  }
  if (f.quote) {
    const i = full.indexOf(f.quote);
    if (i >= 0) return { before: full.slice(Math.max(0, i - pad), i), hit: f.quote, after: full.slice(i + f.quote.length, i + f.quote.length + pad) };
    return { before: '', hit: f.quote, after: '', warn: '★ 引文在原文中找不到（可能是改写）' };
  }
  return null;
};

const L = [];
const jsonOut = {
  purpose: '核查"评价是否说对"（不是分数相关性）',
  rule: '★ 四类判项一律留空 —— 不预填、不暗示；未填 = 未核查。两路都要做：A 入选项测准确性，B 抽查折叠项测筛选是否漏内容。',
  samples: [],
};
let aTotal = 0, aAnchored = 0, pTotal = 0, allTotal = 0, allAnchored = 0;

L.push('# 人工核查工作表 · 两路（A 入选项 / B 折叠抽查）');
L.push('');
L.push('> **A 路**：整篇优先展示的观察（过了门槛的）——回答"教师第一眼看到的评价准不准、值不值得看"。');
L.push('> **B 路**：从**折叠项**里按"若被埋掉最可惜"排序抽查——回答"筛选有没有漏掉关键内容"。');
L.push('> ★ **只查 A 路测不出筛选质量**，两路都要填。');
L.push('> **四类判项**：① 问题真的存在吗 ② 有没有遗漏明显问题 ③ 严重程度说得过头吗 ④ 引用准确但解释错了吗');
L.push('> ★ 未填 ≠ 通过；未填一律视为"未核查"。');
L.push('');

for (const s of picks) {
  const view = buildTeacherView({ assessmentArtifact: s.artifact, rubric, profile, topN: 3 });
  const full = await fsp.readFile(path.join(VDIR, 'holdout', `${s.id}.txt`), 'utf8');
  const aById = new Map((s.artifact.assessments ?? []).map(a => [a.rubric_item_id, a]));
  const allF = (s.artifact.assessments ?? []).flatMap(a => (a.findings ?? []).map(f => normalizeFinding(f, a.rubric_item_id)));
  allTotal += allF.length; allAnchored += allF.filter(f => f.anchored).length;

  const sectionA = [...view.whole_report.top_concerns, ...view.items.flatMap(it => [it.primary_concern, it.primary_strength].filter(Boolean))];
  // ★ A′ 节 = 「可能缺少的关键内容」（新结构；不再是旧的 pending_checks）
  const pm = view.whole_report.possibly_missing;
  const sectionP = pm.entries;
  aTotal += sectionA.length; aAnchored += sectionA.filter(f => f.anchored).length;

  // ★ B 路抽查：折叠项里按"若被埋掉最可惜"排序 —— 有 L3 fail > 较严重 > 有定位
  const keyA = f => `${f.rubric_item_id}|${f.note}`;
  const usedK = new Set(sectionA.map(keyA));
  const folded = allF.filter(f => f.polarity === 'concern' && !usedK.has(keyA(f)))
    .map(f => ({ f, k: (f.verification?.stance === 'fail' ? 0 : f.severity === 'major' ? 1 : f.anchored ? 2 : 3) }))
    .sort((x, y) => x.k - y.k);
  const sampleB = folded.slice(0, SAMPLE_PER_CASE).map(x => x.f);
  pTotal += sampleB.length;

  L.push(`## ${s.id}（${s.band}质量档 · gold ${s.total}/35 · ${s.status} · 正文 ${full.length} 字）`);
  L.push('');
  L.push(`gold 逐维：${s.dims.join('/')}（R1–R4/R7 levels；R5/R6 points）`);
  L.push('');
  L.push(`### A 路 · 教师第一眼看到的（${sectionA.length} 条：整篇 ${view.whole_report.top_concerns.length} + 每条目 1 问题 1 优点）`);
  L.push('');
  let n = 0;
  for (const f of sectionA) {
    n++;
    const cx = ctxAround(full, f);
    L.push(`**A${n}. [${f.rubric_item_id}] ${f.polarity === 'concern' ? '问题' : f.polarity === 'strength' ? '优点' : '中性'} · ${f.kind}${f.severity ? ' · ' + f.severity : ''}**`);
    L.push('');
    L.push(`- 观察：${f.note}`);
    L.push(`- 可核查性：${f.anchor_note}`);
    if (f.verification) L.push(`- L3 机械验证：\`${f.verification.check_id}\` → **${f.verification.stance}**`);
    if (cx) { L.push('- 原文上下文（⟨⟩ 为引文）：'); L.push(''); L.push('  ```text'); L.push(`  ${cx.before}⟨${cx.hit}⟩${cx.after}`); L.push('  ```'); }
    else L.push('- 原文上下文：**（无引文，无法定位）**');
    L.push('');
    L.push('- 核查：① 是否存在：`____`　② 是否遗漏：`____`　③ 严重程度：`____`　④ 引用/解释相符：`____`');
    L.push('');
  }
  if (sectionP.length) {
    L.push(`### A′ · 可能缺少的关键内容（${sectionP.length} 条，上限 ${pm.limit}）`);
    L.push('');
    L.push('> ★ 只表示"在**已解析的文本**里没找到"，**不等于原文中没有**。');
    L.push('');
    for (const e of sectionP) {
      L.push(`- **[${e.rubric_item_id}]** ${e.statement}`);
      L.push(`    - 依据：${e.basis}`);
      L.push(`    - 检查范围：已解析 ${e.check_scope.parsed_chars} 字 / ${e.check_scope.parsed_entries} 条结构条目 / 解析警告 ${e.check_scope.parse_warnings} 条`);
      L.push(`    - 查看全文：${e.see_full_text.hint}`);
      L.push(`    - 核查：① 原文里是否确实没有（或换了说法）「____」　② 是否应影响评价：「____」`);
      L.push('');
    }
  }
  L.push(`### B 路 · 折叠项抽查（${sampleB.length} 条，按"若被埋掉最可惜"排序抽取）`);
  L.push('');
  L.push('> 挑法：有 **L3 反证** 的优先 → 较严重 → 有定位。若这一路发现"比 A 路更该先看"的内容，说明筛选有漏。');
  L.push('');
  let m = 0;
  for (const f of sampleB) {
    m++;
    const cx = ctxAround(full, f);
    const why = f.verification?.stance === 'fail' ? '有 L3 反证' : f.severity === 'major' ? '自称较严重' : f.anchored ? '可回原文核对' : '无法核对';
    L.push(`**B${m}. [${f.rubric_item_id}] ${f.kind}${f.severity ? '/' + f.severity : ''}**（${why}）`);
    L.push('');
    L.push(`- 观察：${f.note}`);
    L.push(`- 可核查性：${f.anchor_note}`);
    if (cx) { L.push('- 原文上下文：'); L.push(''); L.push('  ```text'); L.push(`  ${cx.before}⟨${cx.hit}⟩${cx.after}`); L.push('  ```'); }
    L.push('');
    L.push('- ★ **是否比 A 路更该优先展示？** `是 / 否`　理由：`____`');
    L.push('');
  }
  L.push('---');
  L.push('');

  jsonOut.samples.push({
    id: s.id, band: s.band, gold_total: s.total, status: s.status, text_chars: full.length,
    section_A: sectionA.map(f => ({ rubric_item_id: f.rubric_item_id, polarity: f.polarity, kind: f.kind, severity: f.severity, note: f.note, anchored: f.anchored, anchor_note: f.anchor_note, verification: f.verification })),
    section_A_possibly_missing: sectionP.map(e => ({ rubric_item_id: e.rubric_item_id, statement: e.statement, basis: e.basis, check_scope: e.check_scope })),
    section_B_sample: sampleB.map(f => ({ rubric_item_id: f.rubric_item_id, kind: f.kind, severity: f.severity, note: f.note, anchored: f.anchored, verification: f.verification })),
    to_fill: { A: null, A_pending: null, B_more_important: null },
  });
}

jsonOut.locatable = {
  rule: '★ 只报"能不能回原文核对"，不报"说得对不对"（后者必须人判）',
  section_A: { total: aTotal, anchored: aAnchored, rate: aTotal ? aAnchored / aTotal : null },
  all_findings: { total: allTotal, anchored: allAnchored, rate: allTotal ? allAnchored / allTotal : null },
  section_B_sampled: pTotal,
};

await fsp.writeFile(path.join(OUT, 'audit-sheet.md'), L.join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(OUT, 'audit-sheet.json'), JSON.stringify(jsonOut, null, 2) + '\n', 'utf8');

console.log(`核查工作表：${picks.length} 份（高/中/低各 ${PER_BAND}）`);
console.log(`  抽样：${picks.map(p => `${p.id}(${p.band} ${p.total}/35)`).join('  ')}`);
console.log(`  A 路（入选项）：${aTotal} 条，可回原文 ${aAnchored}（${(aAnchored / aTotal * 100).toFixed(1)}%）`);
console.log(`  B 路（折叠抽查）：${pTotal} 条`);
console.log(`  全部观察：${allTotal} 条，可回原文 ${allAnchored}（${(allAnchored / allTotal * 100).toFixed(1)}%）`);
console.log(`  产出：fixtures/veras/out-holdout/audit-sheet.md · audit-sheet.json`);
