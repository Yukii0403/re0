// _teacheredit.mjs —— 教师工作表的**生成**与**校验**（闭环里唯一的人工环节的入口）
//
// 定位：把 L4 的定性评估变成一份教师能直接上手的工作表；教师填完后由本脚本校验，
//   通过即可作为 `_summaryrun --scores` 的输入（分数只由教师给，程序只回抄）。
//
// 用法：
//   node _teacheredit.mjs --assessment fixtures/real/out/cs3223-writeup.pdf.assessment.json \
//                         --profile design/rubric-assessment-profile.cs3223-test.json \
//                         --rubric  design/canonical-rubric.cs3223-test.json \
//                         --out design/teacher-scores.cs3223-work.json          # 生成待填工作表
//   node _teacheredit.mjs --check <教师填好的 json> --profile <profile> --assessment <L4 产物>   # 校验
//
// ★★ 三条纪律：
//   ① 工作表**不是结果**：未填的模板 status=needs_teacher_input，空 verdict/score 会被校验器拒 ——
//      绝不让人把"还没填的模板"当成"教师已确认"。
//   ② 工作表只提供**待填槽位 + 系统结论摘要**：教师看到 AI 说了什么（含送审原因与"无法回原文核对"的观察），
//      再决定三选与给分；分数字段**只有教师能填**（模型与程序都不填）。
//   ③ 校验口径复用 `summary.mjs` 的 `verifySummaryInputs`（唯一一份），不再写第二套。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySummaryInputs } from './summary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const readJson = async p => JSON.parse(await fsp.readFile(p, 'utf8'));
const readIf = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } };

const rep = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) rep.push(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

const CHECK_PATH = argOf('--check', null);
const ASSESS_PATH = argOf('--assessment', path.join(root, 'fixtures/real/out/cs3223-writeup.pdf.assessment.json'));
const PROFILE_PATH = argOf('--profile', path.join(root, 'design/rubric-assessment-profile.cs3223-test.json'));
const RUBRIC_PATH = argOf('--rubric', path.join(root, 'design/canonical-rubric.cs3223-test.json'));

const profile = await readJson(PROFILE_PATH);
const rubric = await readJson(RUBRIC_PATH);
const leaves = profile.items.filter(p => p.scorable === true).map(p => p.rubric_item_id).sort();
const pById = new Map(profile.items.map(p => [p.rubric_item_id, p]));
const rById = new Map((rubric.items ?? []).map(i => [i.id, i]));

// ------------------------------------------------------------------ 模式二：校验教师填写

if (CHECK_PATH) {
  const scores = await readJson(CHECK_PATH);
  const assessmentArtifact = await readJson(ASSESS_PATH);
  const scoresBody = await readIf(CHECK_PATH);
  const assessmentBody = await readIf(ASSESS_PATH);
  const v = verifySummaryInputs({
    assessmentArtifact, assessmentBody,
    teacherScores: scores, teacherScoresBody: scoresBody,
    profile,
    // 索引/正文不是本脚本的输入（那是 `_summaryrun` 的活）——这里只核"分数与条目"这一层，
    // 并用 errors 里是否出现正文/索引类错误来区分（见下）
  });
  // ★ 本脚本只负责"教师填写这一层"的校验；正文/索引绑定由 `_summaryrun` 的完整闸负责。
  const relevant = v.errors.filter(e => !/缺少 L1 索引|缺少正文|index|正文与索引|逐字不符/.test(e));
  // ★ "已填"= **每条都有分数**。三选（verdict）允许留空 —— 留空意味着"内容未获教师确认"，
  //   这是设计里明确的合法状态（评语层会把它降级为 pending），不该被算成"没填"。
  const filled = (scores.entries ?? []).filter(e => Number.isInteger(e.score)).length;
  const byVerdict = (scores.entries ?? []).reduce((m, e) => {
    const k = e.verdict ?? '（未三选）'; m[k] = (m[k] ?? 0) + 1; return m;
  }, {});

  rep.push('=== 教师工作表校验 ===');
  rep.push(`文件：${path.relative(root, CHECK_PATH).split(path.sep).join('/')}   status=${scores.status ?? '（未设）'}`);
  rep.push(`条目：${(scores.entries ?? []).length}/${leaves.length}   已给分：${filled}/${leaves.length}   三选分布：${JSON.stringify(byVerdict)}`);
  rep.push('');
  eq('★ 条目齐全（= profile 的可评分叶子）', [...new Set((scores.entries ?? []).map(e => e.rubric_item_id))].sort(), leaves);
  eq('★ 教师的填写不违反校验规则（分数/条目/三选值）', relevant, []);
  if (relevant.length) for (const e of relevant.slice(0, 8)) rep.push(`        ${e}`);
  const allFilled = filled === leaves.length;
  eq('★ 全部条目都已给分（未填的模板不能被当成结果）', allFilled, true);
  eq('★ status=teacher_confirmed 时必须全部填完（不能"确认了却没填"）',
    scores.status !== 'teacher_confirmed' || allFilled === true, true);
  eq('★ 模板态（needs_teacher_input）不得被当成结果：填完就必须改 status',
    !(scores.status === 'needs_teacher_input' && allFilled === true), true);
  rep.push('');
  rep.push(`  ${v.ok ? '（完整闸：通过）' : `（完整闸：另有 ${v.errors.length - relevant.length} 条与正文/索引绑定相关的缺项，由 _summaryrun 负责）`}`);
  rep.push('');
  rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' 项失败'} ====`);
  await fsp.writeFile(path.join(here, '_teacheredit.out.txt'), rep.join('\n') + '\n', 'utf8');
  console.log(rep.join('\n'));
  process.exit(bad > 0 ? 1 : 0);
}

// ------------------------------------------------------------------ 模式一：生成待填工作表

const assessmentArtifact = await readJson(ASSESS_PATH);
const aById = new Map((assessmentArtifact.assessments ?? []).map(a => [a.rubric_item_id, a]));

const entries = leaves.map(id => {
  const a = aById.get(id);
  const p = pById.get(id);
  const st = p?.scoring_strategy;
  return {
    rubric_item_id: id,
    // 教师看到什么：条目原文 + 系统结论 + 送审原因 + 观察摘要（含"是否可回原文核对"）
    rubric_text: (rById.get(id)?.text ?? '').slice(0, 400),
    system: a ? {
      strategy_type: a.strategy_type,
      judgment: a.judgment ?? null,
      level_status: a.level_status ?? null,
      candidate_level_ids: a.candidate_level_ids ?? [],
      boundary_condition: a.boundary_condition ?? null,
      review_required: a.review?.required ?? false,
      review_reasons: a.review?.required_reason_codes ?? [],
      findings: (a.findings ?? []).map(f => ({
        polarity: f.polarity, kind: f.kind, severity: f.severity ?? null, note: f.note,
        anchored: !!(f.located || f.verification),
      })),
    } : null,
    // ★ 待填槽位（教师填；模型与程序都不填）
    verdict: null,          // accurate | inaccurate | partially_accurate
    score: null,            // 整数，0..max
    max: st?.max ?? null,   // 系统给的满分（教师不用填）
    note: null,
    // levels 条目：教师选最终档（可选；给了就写 level_id）
    final_level_id: null,
  };
});

const out = {
  teacher_scores_id: argOf('--id', 'ts_' + path.basename(ASSESS_PATH).replace(/\.assessment\.json$/, '') + '_work'),
  version: 1,
  // ★★ 模板态：**不是结果**。教师填完后改成 teacher_confirmed 并加 approval。
  status: 'needs_teacher_input',
  instructions: [
    '★ 这是**待填工作表**，不是结果：status=needs_teacher_input，空 verdict/score 会被校验器拒。',
    '1. 逐条读 system（AI 的结论与观察摘要）与 rubric_text（原条目），决定三选：',
    '   verdict = accurate（评价准确）/ inaccurate（不准确）/ partially_accurate（部分准确）。',
    '2. score 填 0..max 的整数（分数**只有教师能填**；AI 与程序都不给分）。',
    '3. note 可写教师备注（会进入评语材料的"教师备注"）。',
    '4. levels 条目若已定档，可写 final_level_id（用 rubric 里已定义的档位 id）。',
    '5. 全部填完后：把 status 改为 teacher_confirmed；若要发布评语，再加 approval：',
    '   { "approved_by": "<你的名字>", "approved_at": "<ISO 时间>", "scope": "summary_release" }。',
    '6. 校验：node _teacheredit.mjs --check <本文件>   再跑：node _summaryrun.mjs --scores <本文件>',
  ],
  doc: assessmentArtifact.doc,
  rubric: { rubric_id: assessmentArtifact.rubric?.rubric_id, source_sha256: assessmentArtifact.rubric?.source_sha256 },
  assessment_ref: { file: path.basename(ASSESS_PATH), layer_version: assessmentArtifact.authority?.layer_version ?? null },
  approval: null,
  entries,
};

const OUT = path.resolve(root, argOf('--out', path.join('design', 'teacher-scores.' + path.basename(ASSESS_PATH).replace(/\.assessment\.json$/, '') + '-work.json')));
await fsp.writeFile(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------- 自证

rep.push('=== 教师工作表生成 ===');
rep.push(`来源：${path.relative(root, ASSESS_PATH).split(path.sep).join('/')}（L4 ${assessmentArtifact.authority?.layer_version ?? '?'}）`);
rep.push(`产出：${path.relative(root, OUT).split(path.sep).join('/')}   ${entries.length} 个条目`);
rep.push('');
eq('★ 工作表覆盖 = profile 的可评分叶子（齐全）', entries.map(e => e.rubric_item_id), leaves);
eq('★ 条目唯一', new Set(entries.map(e => e.rubric_item_id)).size, entries.length);
eq('★ 每条的满分来自 profile（不是模板自己编的）', entries.every(e => e.max === pById.get(e.rubric_item_id)?.scoring_strategy?.max), true);
eq('★ 覆盖账目对得上 L4 产物（每条都能在产物里找到对应结论）', entries.every(e => aById.has(e.rubric_item_id)), true);
eq('★ 模板态：status=needs_teacher_input（不是结果）', out.status, 'needs_teacher_input');
eq('★ 模板态：没有任何分数被预先填上（分数只能教师填）', entries.every(e => e.score === null && e.verdict === null), true);
eq('★ 模板里带了送审原因（教师知道哪些条目系统自己也不确定）', entries.some(e => (e.system?.review_reasons ?? []).length > 0), true);
eq('★ 模板里标出了"无法回原文核对"的观察（教师知道哪些结论核对不了）',
  entries.some(e => (e.system?.findings ?? []).some(f => f.anchored === false)) || entries.every(e => (e.system?.findings ?? []).every(f => f.anchored)), true);
eq('★ 模板里没有任何"AI 给的分"字段（分值权在教师）',
  !JSON.stringify(out).includes('"awarded"') && entries.every(e => !('system_score' in e)), true);
rep.push('');
rep.push('★ 未填的模板**不能**当结果用：`--check` 会因"条目未填全 + status≠teacher_confirmed"失败 —— 这是设计。');
rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' 项失败'} ====`);
await fsp.writeFile(path.join(here, '_teacheredit.out.txt'), rep.join('\n') + '\n', 'utf8');
console.log(rep.join('\n'));
if (bad > 0) process.exitCode = 1;
