// _summaryrun.mjs —— 阶段三（总结评语）的驱动：离线 stub / 真实模型同一套
//
// 用法:
//   node _summaryrun.mjs --stub                       离线：本地 stub 服务把整条链走通（不联网）
//   node _summaryrun.mjs                              真实模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
//   node _summaryrun.mjs --scores design/teacher-scores.cs3223-test.json
//   node _summaryrun.mjs --out ../fixtures/real/out
//
// 输入：L4 产物（含教师确认状态）＋ 完整原文 ＋ 教师给分 JSON
// 输出：<case>.summary.json / <case>.summary.stub.json

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { llmConfigFromEnv, runToolLoop } from './llm.mjs';
import { validate } from './validator.mjs';
import {
  SUMMARY_VERSION, SUMMARY_SOFT_TARGET, SUMMARY_SYSTEM_PROMPT, SUMMARY_PARTS,
  SUMMARY_TEXT_TOOL, SUMMARY_PENDING_TOOL,
  summaryTools, summaryMessage, createSummaryRunner, summaryResultFor,
  buildSummaryContext, verifySummaryInputs, assembleSummaryArtifact,
} from './summary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STUB = process.argv.includes('--stub');
const TURNS = Number(argOf('--turns', 3));
const CASE = argOf('--case', 'cs3223-writeup.pdf');
const OUT_DIR = path.resolve(root, argOf('--out', 'fixtures/real/out'));
const OUT = path.join(OUT_DIR, CASE + (STUB ? '.summary.stub.json' : '.summary.json'));
const REPORT = path.join(here, STUB ? '_summaryrun.out.txt' : '_summaryrun.real.out.txt');
const ASSESS = path.join(OUT_DIR, CASE + '.assessment.json');   // ★ 上游是**给定输入**（真实 L4 产物），stub 只替换"M"
const TXT = path.join(OUT_DIR, CASE + '.txt');
const IDX = path.join(OUT_DIR, CASE + '.index.json');           // ★ 全文与它逐字绑定（防"换掉全文"）
const RUBRIC_PATH = path.resolve(root, argOf('--rubric', 'design/canonical-rubric.cs3223-test.json'));
const PROFILE_PATH = path.resolve(root, argOf('--profile', 'design/rubric-assessment-profile.cs3223-test.json'));
const SCORES_PATH = path.resolve(root, argOf('--scores', 'design/teacher-scores.cs3223-test.json'));

// ------------------------------------------------------------------ stub：脚本化的"模型行为"

// ★ 正文只写教师已确认的内容；未确认/无法核对的观察一律进 pending_notes（不向学生发布）
const STUB_SUMMARY_TEXT = [
  '这份报告把实验数据呈现得相当完整：两张计时表都逐次给出了 Run 1–5 的原始读数与平均值，',
  '并按索引配置（下划线属性）与连接算法分别列出，图表的组织方式清楚。',
  '',
  '需要重点修正的是 Experiment 2（4-table join）那一组数据：Figure 4 中 Unrestricted 列的 Average Time 写作 0.62 ms，',
  '而该列五次运行的实际读数（0.78 / 0.74 / 0.68 / 0.7 / 0.82）算出来是 0.744 ms —— 报告内部数字不自洽。',
  '请回查是抄写还是计算环节出的问题，并在正文里说明该异常。',
  '',
  '另外一处细节值得一并处理：分析文字把计时数据的出处写成 Figure 1，实际对应的是 Figure 3，属于图表交叉引用的笔误。',
  '',
  '关于索引选择的讨论是这份报告的亮点：把 block access 数的差异与实际计时结果对照，并回溯到查询条件本身，',
  '这条论证链是完整的。可以进一步做的是对异常值（如 0.7 ms 那一行）做敏感性说明 ——',
  '目前对离散度的讨论偏薄，补上后结论的稳健性会更有说服力。',
  '',
  '总体建议：优先修正 4-table 那组的不自洽数字（它直接影响结论的可信度），其次补齐缺失的列与图注引用，最后完善异常值讨论。',
].join('\n');

const STUB_SUMMARY_PENDING = [
  '（以下为系统观察，未经教师确认，暂不向学生发布）',
  '· R2.2：实验 2 计时表只有三列、缺 index-join 的运行时间 —— 该条教师认为"部分准确"，需教师核实后再决定是否告知学生。',
  '· R2.3 / R3.3：这两条教师未标注，其相关观察（图表规范、反思的可执行性）暂不发布。',
  '· 另有 5 条观察没有原文定位也没有 L3 挂钩（R2.2/R3.1/R3.3），无法回原文核对，仅列在此处供教师判断。',
].join('\n');

function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      // ★ 两次调用各暴露一个工具：stub 按工具名返回对应的那一半
      const toolName = payload.tools?.[0]?.function?.name ?? null;
      const last = [...(payload.messages ?? [])].reverse().find(m => m.role === 'user');
      const userText = typeof last?.content === 'string' ? last.content
        : (Array.isArray(last?.content) ? (last.content.find(c => c.type === 'text')?.text ?? '') : '');
      seen.push({ toolName, messages: payload.messages, userText });
      const isPending = toolName === 'submit_pending_notes';
      const msg = {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'call_summary_0', type: 'function',
          function: { name: toolName ?? 'submit_student_summary', arguments: JSON.stringify(isPending ? { notes: STUB_SUMMARY_PENDING } : { text: STUB_SUMMARY_TEXT }) },
        }],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'stub', model: 'stub', choices: [{ index: 0, message: msg, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
}

// ------------------------------------------------------------------ 主流程

const rep = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) rep.push(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

await fsp.mkdir(OUT_DIR, { recursive: true });
const read = async p => fsp.readFile(p, 'utf8');
const sha = b => createHash('sha256').update(Buffer.from(b, 'utf8')).digest('hex');

const full = await read(TXT);
const assessBody = await read(ASSESS);
const assessmentArtifact = JSON.parse(assessBody);
const idxBody = await read(IDX);
const idx = JSON.parse(idxBody);
const profileBody = await read(PROFILE_PATH);
const profile = JSON.parse(profileBody);
const scoresBody = await read(SCORES_PATH);
const teacherScores = JSON.parse(scoresBody);
const rubricBody = await read(RUBRIC_PATH);
const rubric = JSON.parse(rubricBody);
const schema = JSON.parse(await read(path.join(design, 'summary.schema.json')));

// ★★ 输入校验（fail-closed）：上游身份必须逐字节对上；教师给分的**上界要回到 profile 核**（不是自报）；
//    全文必须能**逐字切回 L1 索引**（这样"把全文换成无关文字"也会被拦下）。
const gate = (scores, o = {}) => verifySummaryInputs({
  assessmentArtifact, assessmentBody: assessBody, teacherScores: scores, teacherScoresBody: JSON.stringify(scores),
  profile, profileBody, index: idx, indexBody: idxBody, docBody: full, ...o,
});
const v = gate(teacherScores);
if (!v.ok) { process.stderr.write(`_summaryrun 拒绝启动：输入校验失败\n  ${v.errors.join('\n  ')}\n`); process.exitCode = 1; throw new Error('summary inputs invalid'); }

let cfg = null, fetchImpl = fetch, stub = null, usage = { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
if (STUB) {
  stub = await startStub();
  cfg = { baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: 'stub', model: 'stub' };
} else {
  cfg = llmConfigFromEnv();
  const base = fetch;
  fetchImpl = async (url, init) => {
    const res = await base(url, init);
    try {
      const clone = res.clone();
      const b = await clone.json();
      if (b?.usage) {
        usage.prompt_tokens += b.usage.prompt_tokens ?? 0;
        usage.completion_tokens += b.usage.completion_tokens ?? 0;
      }
    } catch { /* usage 拿不到就算了 */ }
    usage.calls++;
    return res;
  };
}

const ctx = buildSummaryContext({ assessmentArtifact, rubric, full, teacherScores });
// ★★ 两次调用，材料物理隔离：A 只见已确认条目 → text；B 只见未确认/有异议条目 → pending_notes
const runs = {};
for (const mode of SUMMARY_PARTS) {
  const runner = createSummaryRunner({ ids: { next: 1 }, part: mode });
  const body = summaryMessage({ ctx, mode, unconfirmedItems: v.unconfirmed_items, criticizedItems: v.disputed_items });
  const loop = await runToolLoop({
    runner, cfg, tools: summaryTools(mode), maxTurns: TURNS, fetchImpl, resultFor: summaryResultFor,
    messages: [{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, { role: 'user', content: body }],
  });
  runs[mode] = { runner, loop, s: runner.summary(), body };
}
const textRun = runs.student_text, pendRun = runs.pending_notes;
const textPart = textRun.runner.summaries[0] ?? null;
const pendPart = pendRun.runner.summaries[0] ?? null;
const summary = textPart ? {
  summary_id: textPart.summary_id,
  text: textPart.text,
  chars: textPart.chars,
  pending_notes: pendPart?.notes ?? '',
  pending_chars: (pendPart?.notes ?? '').length,
} : null;
const s = {
  attempted: textRun.s.attempted + pendRun.s.attempted,
  accepted: textRun.s.accepted + pendRun.s.accepted,
  rejected: textRun.s.rejected + pendRun.s.rejected,
};
const loop = { turns: textRun.loop.turns + pendRun.loop.turns };

const out = assembleSummaryArtifact({
  assessmentArtifact,
  assessmentRef: { file: path.basename(ASSESS), sha256: sha(assessBody), layer_version: assessmentArtifact.authority?.layer_version ?? null },
  teacherScores,
  teacherScoresRef: { file: path.basename(SCORES_PATH), sha256: sha(scoresBody), status: teacherScores.status ?? null },
  rubric, rubricFile: path.basename(RUBRIC_PATH),
  summary,
  unconfirmedItems: v.unconfirmed_items,
  criticizedItems: v.disputed_items,
  contentUnconfirmedItems: v.content_unconfirmed_items,
  unanchoredFindings: v.unanchored_findings,
  releaseBlockers: v.release_blockers,
  approved: v.approved,
  verification: { attempted: s.attempted, accepted: s.accepted, rejected: s.rejected },
  turns: loop.turns,
  usage: STUB ? null : { calls: usage.calls, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens },
  notices: `★ 由${STUB ? '本地 stub 服务（离线）' : '真实模型'}产出（model=${cfg.model}）。`
    + '教师给分是准绳（上界经 profile 核验）；text 只含教师已确认内容；未确认/有异议/无法回原文核对的观察只进 pending_notes；'
    + '产物里的分数由程序从教师给分回抄，模型无权输出分数。',
});

const outBody = JSON.stringify(out, null, 2) + '\n';
await fsp.writeFile(OUT, outBody, 'utf8');

// ------------------------------------------------------------------ 自证

const vr = (() => { try { return validate(schema, out); } catch (e) { return { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; } })();
const keysAll = (o, acc = []) => {
  if (Array.isArray(o)) { for (const x of o) keysAll(x, acc); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); keysAll(o[k], acc); } }
  return acc;
};
const keys = keysAll(out);

rep.push(`模式：${STUB ? '本地 stub（离线）' : '真实 API'}   model=${cfg.model}   summary=${SUMMARY_VERSION}`);
rep.push(`上游：assessment=${path.basename(ASSESS)}   teacher_scores=${path.basename(SCORES_PATH)}（status=${teacherScores.status}）`);
rep.push(`产出 ${path.relative(root, OUT).split(path.sep).join('/')}（${outBody.length} 字节）`);
rep.push(`调用账目：attempted=${s.attempted} accepted=${s.accepted} rejected=${s.rejected}   turns=${loop.turns}`
  + (STUB ? '' : `   tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}  HTTP=${usage.calls}`));
rep.push('');
rep.push('--- 教师给分（准绳；上界经 profile 核验；程序回抄） ---');
for (const e of out.per_item) {
  const c = out.content_unconfirmed_items.includes(e.rubric_item_id) ? '  ★内容未确认' : '';
  rep.push(`  ${e.rubric_item_id.padEnd(6)} ${String(e.score).padStart(3)}/${e.max}  verdict=${e.verdict ?? '（未标注）'}${c}`
    + `  system=${JSON.stringify(e.system_verdict)}  findings: concern=${e.findings_concern} strength=${e.findings_strength}`);
}
rep.push(`  合计 ${out.score_summary.total}/${out.score_summary.maximum}`);
rep.push(`  未三选：${JSON.stringify(out.unconfirmed_items)}   教师认为不准确/部分准确：${JSON.stringify(out.criticized_items)}`);
rep.push(`  内容未确认（非 accurate 的全部，其观察只能进 pending_notes）：${JSON.stringify(out.content_unconfirmed_items)}`);
rep.push(`  定位传递：source_index=${out.anchor_summary.total} 条（有定位/有 L3 挂钩 ${out.anchor_summary.anchored}，无法核对 ${out.anchor_summary.unanchored}）`);
rep.push(`  ★ 发布闸 release=${out.release.status}  blockers=${JSON.stringify(out.release.blockers)}`);
rep.push(`     （scores_are_teacher_final=${out.authority.scores_are_teacher_final}  teacher_scores_status=${out.authority.teacher_scores_status}）`);
rep.push('');
rep.push('--- 总结评语：text（学生可见正文）---');
rep.push(out.summary ? out.summary.text : '（未产出）');
rep.push('');
rep.push('--- 总结评语：pending_notes（**不向学生发布**，待教师确认）---');
rep.push(out.summary?.pending_notes ? out.summary.pending_notes : '（无）');
rep.push('');
rep.push('--- 自证 ---');

const text = out.summary?.text ?? '';

eq('★ artifact 通过正式 JSON Schema', vr.ok, true);
if (!vr.ok) for (const e of vr.errors.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
eq('★ 评语已产出、非空、在工程上限内', !!out.summary && text.trim().length >= 30 && out.summary.chars === text.length && out.summary.chars <= 6000, true);
eq('★ 评语是模型派生，永远标 derived_by=model', out.summary?.derived_by === 'model', true);
eq('★ 本层不产生分值（layer_produces_score=false）', out.authority.layer_produces_score === false, true);
eq('★★ 不把模拟三选说成"教师已确认"：provisional 输入 → scores_are_teacher_final=false，且 status 原样回抄',
  out.authority.scores_are_teacher_final === (teacherScores.status === 'teacher_confirmed') &&
  out.authority.teacher_scores_status === (teacherScores.status ?? null), true);
eq('★★ 发布闸：默认 draft；provisional 输入必须列出全部 blockers（含未三选/有异议/无法核对/超长）', (() => {
  const b = out.release.blockers;
  return out.release.status === 'draft' && !out.release.approved_by &&
    b.includes('provisional_teacher_scores') && b.includes('no_release_approval') &&
    b.includes(`unconfirmed_items:${out.unconfirmed_items.length}`) &&
    b.includes(`disputed_items:${out.criticized_items.length}`) &&
    b.includes(`unanchored_findings:${out.unanchored_findings.length}`) &&
    (out.summary.chars <= out.summary.target || b.includes('over_target_length'));
})(), true);
eq('★ 产物里的分数 = 教师给的最终分（回抄，不是模型输出）',
  JSON.stringify(out.score_summary.total) === JSON.stringify(teacherScores.entries.reduce((a, e) => a + e.score, 0)), true);
eq('★ 逐条分数与输入一字不差（模型没有改写它们的通道）',
  out.per_item.every(e => {
    const src = teacherScores.entries.find(x => x.rubric_item_id === e.rubric_item_id);
    return !!src && e.score === src.score && e.max === src.max && (e.verdict ?? null) === (src.verdict ?? null);
  }), true);
eq('★ 未三选清单由**程序**算：精确等于输入里 verdict 为 null 的条目',
  JSON.stringify(out.unconfirmed_items) === JSON.stringify(teacherScores.entries.filter(e => e.verdict === null || e.verdict === undefined).map(e => e.rubric_item_id)), true);
eq('★ 教师认为不准确/部分准确的条目单独列出（以教师判断为准）',
  JSON.stringify(out.criticized_items) === JSON.stringify(teacherScores.entries.filter(e => e.verdict === 'inaccurate' || e.verdict === 'partially_accurate').map(e => e.rubric_item_id)), true);
eq('★ 内容未确认清单 = 非 accurate 的全部条目（部分准确也意味着内容没被逐条确认）',
  JSON.stringify(out.content_unconfirmed_items) === JSON.stringify(teacherScores.entries.filter(e => e.verdict !== 'accurate').map(e => e.rubric_item_id)), true);
eq('★★ 定位传递：source_index 覆盖 L4 全部 findings，anchored 与 located/L3 一致，且能逐字切回原文', (() => {
  const all = (assessmentArtifact.assessments ?? []).flatMap(a => a.findings ?? []);
  if (out.source_index.length !== all.length) return false;
  if (out.anchor_summary.total !== all.length) return false;
  const un = out.source_index.filter(f => !f.anchored).length;
  if (un !== out.anchor_summary.unanchored || un !== out.unanchored_findings.length) return false;
  // anchored 的每一条都能切回原文或挂钩到真实 check
  return out.source_index.every(f =>
    (!f.located || full.slice(f.located.offset.start, f.located.offset.end) === f.quote) &&
    (f.anchored === !!(f.located || f.l3)));
})(), true);
eq('★ 无法回原文核对、也无 L3 挂钩的观察被单独列出（不得写进 text）',
  out.unanchored_findings.every(u => !u.note) &&   // 只带标识，不带正文内容
  out.unanchored_findings.every(u => out.source_index.some(f => f.rubric_item_id === u.rubric_item_id && f.polarity === u.polarity && f.kind === u.kind)), true);
eq('★★ 两段物理隔离：两个工具、两次调用，各自只见自己的材料（不靠措辞约束）',
  typeof out.summary?.pending_notes === 'string' && out.summary.pending_chars === out.summary.pending_notes.length &&
  SUMMARY_TEXT_TOOL !== SUMMARY_PENDING_TOOL &&
  summaryTools('student_text').length === 1 && summaryTools('student_text')[0].function.name === SUMMARY_TEXT_TOOL &&
  summaryTools('pending_notes').length === 1 && summaryTools('pending_notes')[0].function.name === SUMMARY_PENDING_TOOL &&
  JSON.stringify(summaryTools('student_text')[0].function.parameters.required) === JSON.stringify(['text']) &&
  JSON.stringify(summaryTools('pending_notes')[0].function.parameters.required) === JSON.stringify(['notes']), true);
eq('★ 产物里没有"新分数"字段（awarded / 模型自报分数都不存在）',
  !keys.includes('awarded') && !keys.includes('model_score') && !keys.includes('total_score'), true);
eq('★ 评语内容不做闸（工具面最小），但发布受 release 闸约束',
  summaryTools().length === 2 && !keys.includes('required_reason_codes'), true);
eq('★ 账目平：accepted + rejected = attempted', out.diagnostics.accounted === true, true);
eq('★ 两次调用的材料里都给了完整原文（评语复述事实时可以核对）', STUB ? stub.seen.every(x => x.userText.includes(full)) : true, true);
// ★★ 物理隔离的核心断言：A 的材料里**根本不含**未确认条目的内容；B 的材料里**不含**已确认条目。
eq('★★ 物理隔离（材料级）：正文材料看不到未确认条目、待确认材料看不到已确认条目 —— 泄漏在结构上不可能', STUB ? (() => {
  const a = stub.seen.find(x => x.toolName === 'submit_student_summary');
  const b = stub.seen.find(x => x.toolName === 'submit_pending_notes');
  if (!a || !b) return false;
  const confirmedIds = ctx.items.filter(it => it.content_confirmed).map(it => it.rubric_item_id);
  const unconfirmedIds = ctx.items.filter(it => !it.content_confirmed).map(it => it.rubric_item_id);
  const hasItem = (text, id) => text.includes(`### ${id} `);
  return confirmedIds.every(id => hasItem(a.userText, id)) &&
    unconfirmedIds.every(id => !hasItem(a.userText, id)) &&      // ★ A 里没有未确认条目
    unconfirmedIds.every(id => hasItem(b.userText, id)) &&
    confirmedIds.every(id => !hasItem(b.userText, id));          // ★ B 里没有已确认条目
})() : true, true);
eq('★ 材料里单列"无法回原文核对"的观察（标题级标注）', STUB ? (() => {
  const a = stub.seen.find(x => x.toolName === 'submit_student_summary');
  return a.userText.includes('教师已确认的条目') && a.userText.includes('教师给分：');
})() : true, true);

// ---- ★★ 输入校验的负向回归：真的改一处，必须被拦下（fail-closed）----
//    ★ 这一组直接对应 Yukii 的只读验证：旧版这四条**全部 ok=true**，修完必须全被拦下。
const negs = [];
{
  const mut = f => { const t = JSON.parse(scoresBody); f(t); return t; };
  const run = (scores, o = {}) => gate(scores, o);
  // ① 上界被改写（旧版只查 0≤score≤自报 max → 通过；现在必须对 profile 核）
  const m1 = mut(t => { t.entries[0].max = 100; });
  const r1 = run(m1);
  negs.push(['教师自报的 max 被改写（10→100）', r1.ok === false && r1.errors.some(e => /与 profile 的满分/.test(e))]);
  // ② 重复条目
  const m2 = mut(t => { t.entries.push({ ...t.entries[0] }); });
  const r2 = run(m2);
  negs.push(['同一条目重复出现', r2.ok === false && r2.errors.some(e => /重复出现/.test(e))]);
  // ③ 缺条目
  const m3 = mut(t => { t.entries.splice(2, 1); });
  const r3 = run(m3);
  negs.push(['缺了一条给分（可评分叶子必须齐全）', r3.ok === false && r3.errors.some(e => /缺条目/.test(e))]);
  // ④ 全文被换成无关文字（旧版通过；现在靠"逐字切回索引"拦）
  const r4 = gate(teacherScores, { docBody: '完全无关的文字'.repeat(100) });
  negs.push(['正文被换成无关文字', r4.ok === false && r4.errors.some(e => /逐字不符|超出正文长度/.test(e))]);
  // ⑤ 索引自身被改（entry.text 与正文不符）→ 也必须拦
  const badIdx = JSON.parse(idxBody); badIdx.entries[0].text = badIdx.entries[0].text + '篡改';
  const r5 = gate(teacherScores, { index: badIdx, indexBody: JSON.stringify(badIdx) });
  negs.push(['索引条目与正文不符', r5.ok === false && r5.errors.some(e => /逐字不符/.test(e))]);
  // ⑥ profile 绑到别的 rubric / profile 字节与产物记录不符
  const badP = JSON.parse(profileBody); badP.rubric.source_sha256 = 'd'.repeat(64);
  const r6 = gate(teacherScores, { profile: badP, profileBody: JSON.stringify(badP) });
  negs.push(['profile 绑到别的 rubric', r6.ok === false && r6.errors.some(e => /profile/.test(e))]);
  const r6b = gate(teacherScores, { profileBody: profileBody + ' ' });
  negs.push(['profile 字节与产物记录的 sha 不符', r6b.ok === false && r6b.errors.some(e => /profile 字节/.test(e))]);
  // ⑦ 给了一条不是可评分叶子的条目
  const m7 = mut(t => { t.entries.push({ rubric_item_id: 'R9.9', score: 1, max: 1, verdict: null }); });
  const r7 = run(m7);
  negs.push(['给了一条不是可评分叶子的条目', r7.ok === false && r7.errors.some(e => /不是可评分叶子/.test(e))]);
  // ⑧ 分数越界 / 三选值非法
  const m8 = mut(t => { t.entries[0].score = 999; });
  negs.push(['分数越界', run(m8).ok === false]);
  const m9 = mut(t => { t.entries[0].verdict = '大致准确'; });
  negs.push(['三选值不在枚举内', run(m9).ok === false]);
  const m10 = mut(t => { t.doc.sha256 = 'b'.repeat(64); });
  negs.push(['教师给分绑到别的作业', run(m10).ok === false]);
  const m11 = mut(t => { t.rubric.source_sha256 = 'c'.repeat(64); });
  negs.push(['教师给分绑到别的 rubric', run(m11).ok === false]);
  // 正向对照：原样不动必须通过（否则上面全是假阳性）
  negs.push(['正向对照 · 原样不动必须通过', run(JSON.parse(scoresBody)).ok === true]);
}
for (const [name, ok] of negs) {
  const isCtrl = /正向对照/.test(name);
  eq(isCtrl ? `★ ${name}` : `★ 负向回归 · ${name} → 必须被拦下（fail-closed）`, ok, true);
}

rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);
// ★ 报告是**诊断输出**，不是产物：写失败（沙箱偶发 EPERM 等）**不该让整份样本作废**。
  //   实测踩过：一份 VerAs 样本 L4 全部调用成功、产物已写，却在最后写报告时 EPERM → 整份被判失败。
  try { await fsp.writeFile(REPORT, rep.join('\n') + '\n', 'utf8'); }
  catch (e) { process.stderr.write(`（报告写入失败，不影响产物：${e?.code ?? e?.message}）\n`); }
if (stub) stub.server.close();
if (bad > 0) {
  // ★ 把**具体失败项**也打到 stderr：报告文件可能因沙箱原因写不出来，那样就彻底无从诊断了。
  const failLines = rep.filter(l => /FAIL/.test(l));
  process.stderr.write(`_summaryrun: ${bad} 项自证失败
` + failLines.join('\n') + '\n');
  try { await fsp.writeFile(path.join(here, '_summaryrun.failures.txt'), rep.join('\n') + '\n', 'utf8'); } catch { /* 尽力而为 */ }
  process.exitCode = 1;
}
