// _l4run.mjs —— L4 的调用链驱动（离线 stub / 真实模型同一套）
//
// ★ 一个可评分叶子条目一次独立调用（设计稿 §3）：CS3223 测试 profile 有 8 个叶子 → 8 次会话。
// ★ 装配只有一份 `assembleAssessmentArtifact` —— stub 与真实模型走同一条路，否则两条路会漂移。
// ★ 上游只引用不复制：L2 证据、L3 验证、L1 索引都按 文件名 + SHA-256 引用（facet 里因此不可能出现分数）。
//
// 用法:
//   node _l4run.mjs --stub                      离线：本地 stub 服务把整条链走通（不联网）
//   node _l4run.mjs                             真实模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
//   node _l4run.mjs --out ../fixtures/real/out   产物目录
//   node _l4run.mjs --turns 3                    每个条目的回合上限

import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { llmConfigFromEnv, runToolLoop } from './llm.mjs';
import { validate } from './validator.mjs';
import {
  L4_VERSION, L4_SYSTEM_PROMPT, l4Tools, l4ResultFor, assessmentMessage, SYSTEM_REVIEW_CODES,
  JUDGMENTS, LEVEL_STATUSES,
  validateProfile, scorableLeaves, buildItemContext, createAssessmentRunner,
  assembleAssessmentArtifact, partitionChecks, verifyUpstreamIdentity,
} from './l4.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const STUB = process.argv.includes('--stub');
const TURNS = Number(argOf('--turns', 3));
const CASE = argOf('--case', 'cs3223-writeup.pdf');
const OUT_DIR = path.resolve(root, argOf('--out', 'fixtures/real/out'));
const OUT = path.join(OUT_DIR, CASE + (STUB ? '.assessment.stub.json' : '.assessment.json'));
const REPORT = path.join(here, STUB ? '_l4run.out.txt' : '_l4run.real.out.txt');

const TXT = path.join(OUT_DIR, CASE + '.txt');
const IDX = path.join(OUT_DIR, CASE + '.index.json');
const EVP = path.join(OUT_DIR, CASE + '.evidence.json');
const CHK = path.join(OUT_DIR, CASE + (STUB ? '.checks.llm.json' : '.checks.llm.json'));
const RUBRIC_PATH = path.resolve(root, argOf('--rubric', 'design/canonical-rubric.cs3223-test.json'));
const PROFILE_PATH = path.resolve(root, argOf('--profile', 'design/rubric-assessment-profile.cs3223-test.json'));

// ------------------------------------------------------------------ stub：脚本化的"模型行为"

// 每个条目的脚本：一个数组，逐次工具调用的参数；用尽后收尾（不再提交）。
// 刻意混进四种"不规矩"的提交，好把两道闸都走一遍：
//   R2.1 第一次塞 v0.2 的 score 字段 → 工具 schema 里已没有这个字段 → 拒；第二次才合规
//   R2.2 引用一个不存在的 check → 该引用被丢弃（assessment 仍在）
//   R2.3 判断"材料不足"→ 不下结论；补一条**有歧义**的引用 → 被丢弃 + 强制送审
//   R1.2 的 finding 定位用了出现两次的 'Run 1' → 歧义 → 定位断链（finding 保留）+ 送审
//   R3.3 干脆不提交 → 该条目无 assessment（覆盖账目记 missing）
const STUB_SCRIPT = {
  'R1.1': [{ args: {
    rubric_item_id: 'R1.1', judgment: 'satisfied',
    findings: [{ polarity: 'strength', kind: 'completeness', note: '报告给出了实验所用各表与 Figure 1 的表结构说明，覆盖了"数据集与各表结构"这一条。' }],
    evidence_refs: [{ bundle_id: 'ev0001', span_indices: [0], role: 'support' }],
    verification_refs: [],
    rationale: '数据集与各表结构的说明齐全。',
  } }],
  'R1.2': [{ args: {
    rubric_item_id: 'R1.2', judgment: 'partially_satisfied',
    findings: [
      { polarity: 'concern', kind: 'completeness', note: '说明了所用索引（下划线属性）与两条查询语句，但未逐条说明每个查询选用的索引配置。' },
      { polarity: 'neutral', kind: 'presentation', note: '运行编号的引用存在歧义（原文出现多处）', quote: 'Run 1', severity: 'minor' },
    ],
    evidence_refs: [
      { bundle_id: 'ev0002', span_indices: [0, 1, 2], role: 'support' },
      { bundle_id: 'ev0003', span_indices: [0], role: 'support' },
    ],
    verification_refs: [],
    rationale: '覆盖了索引说明但逐项配置不完整。',
  } }],
  'R2.1': [
    { args: {   // ← 故意塞 v0.2 的 score 字段：工具 schema 里已经没有它 → 拒
      rubric_item_id: 'R2.1', judgment: 'satisfied',
      score: { strategy: 'points', awarded: 16, maximum: 15 },
      findings: [{ polarity: 'strength', kind: 'completeness', note: '四个方案五次运行与平均值都有给出。' }],
      evidence_refs: [{ bundle_id: 'ev0005', span_indices: [0], role: 'support' }],
      rationale: '系统应当拒绝这个带 score 字段的提交。',
    } },
    { args: {
      rubric_item_id: 'R2.1', judgment: 'partially_satisfied',
      findings: [
        { polarity: 'strength', kind: 'completeness', note: '四个方案五次运行与平均值都有给出。' },
        { polarity: 'concern', kind: 'calculation', note: '4-table 那组的报告均值与五次运行的自算均值不一致（L3 机械验证已确认）。', severity: 'major', check_id: 'ck0006' },
      ],
      evidence_refs: [
        { bundle_id: 'ev0005', span_indices: [0, 1, 2, 3, 4], role: 'support' },
        { bundle_id: 'ev0006', span_indices: [0, 1], role: 'support' },
      ],
      verification_refs: [
        { check_id: 'ck0001', impact: 'support' },
        { check_id: 'ck0006', impact: 'contradict' },
      ],
      rationale: '呈现齐全，但 4-table 那组的数据不自洽（有 L3 fail 反证）。',
    } },
  ],
  'R2.2': [{ args: {
    rubric_item_id: 'R2.2', judgment: 'satisfied',
    findings: [{ polarity: 'strength', kind: 'reasoning', note: '讨论了下划线属性（hash index）对计划选择与 block access 的影响。' }],
    evidence_refs: [
      { bundle_id: 'ev0007', span_indices: [0], role: 'support' },
      { bundle_id: 'ev0010', span_indices: [0, 1], role: 'support' },
    ],
    verification_refs: [{ check_id: 'ck9999', impact: 'support' }],   // ← 不存在的 check：该引用会被丢弃
    rationale: '分析与结论相互支撑。',
  } }],
  'R2.3': [{ args: {
    rubric_item_id: 'R2.3', judgment: 'insufficient_evidence',
    findings: [],                                                     // 材料不足，无定性发现
    evidence_refs: [{ bundle_id: 'ev0012', span_indices: [0, 1], role: 'context' }],
    asset_refs: [{ asset_id: 'page-4', role: 'context' }],
    supplemental_quotes: [{ quote: 'Run 1', role: 'support' }],      // ← 出现两次 → 歧义 → 丢弃
    rationale: '报告只给了截图与图注，图例与坐标轴规范是否达标仅凭现有证据无法可靠判断。',
  } }],
  'R3.1': [{ args: {
    rubric_item_id: 'R3.1', judgment: 'partially_satisfied',
    findings: [
      { polarity: 'strength', kind: 'reasoning', note: '把计时结果与 block access 数对照着分析，并用查询条件解释差异。', quote: 'Query: select dname, title from dept, course where deptid < 450 and deptid = did', entry_hint: 'e0019' },
      { polarity: 'concern', kind: 'completeness', note: '对异常值的讨论偏薄。', severity: 'minor' },
    ],
    evidence_refs: [
      { bundle_id: 'ev0015', span_indices: [0, 1, 2], role: 'support' },
      { bundle_id: 'ev0016', span_indices: [0, 1], role: 'support' },
    ],
    supplemental_quotes: [{ quote: 'Query: select dname, title from dept, course where deptid < 450 and deptid = did', entry_hint: 'e0019', role: 'support' }],
    rationale: '对照分析有理有据，异常值讨论不足。',
  } }],
  'R3.2': [{ args: {
    rubric_item_id: 'R3.2', judgment: 'not_satisfied',
    findings: [{ polarity: 'concern', kind: 'calculation', note: '结论段的"数据支撑"被 4-table 那组的不自洽削弱：报告自述均值与原始运行数据对不上，且未说明该异常。', severity: 'major', check_id: 'ck0006' }],
    evidence_refs: [
      { bundle_id: 'ev0018', span_indices: [0], role: 'counterevidence' },
      { bundle_id: 'ev0017', span_indices: [0], role: 'counterevidence' },
    ],
    verification_refs: [{ check_id: 'ck0006', impact: 'contradict' }],
    rationale: '反证充分：数据不自洽且未获解释。',
  } }],
  'R3.3': [],   // ← 模型不提交
};

function startStub() {
  const seen = [];
  const counts = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      seen.push({ messages: payload.messages, tools: payload.tools?.length ?? 0 });
      const last = [...(payload.messages ?? [])].reverse().find(m => m.role === 'user');
      const text = Array.isArray(last?.content) ? (last.content.find(c => c.type === 'text')?.text ?? '') : String(last?.content ?? '');
      const itemId = (text.match(/## rubric 条目[^\n]*\n- (R[0-9.]+)/) ?? [])[1] ?? null;
      const n = counts.get(itemId) ?? 0;
      counts.set(itemId, n + 1);
      const step = (STUB_SCRIPT[itemId] ?? [])[n] ?? null;
      const msg = step
        ? {
          role: 'assistant', content: null,
          tool_calls: [{ id: `call_${itemId}_${n}`, type: 'function', function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(step.args) } }],
        }
        : { role: 'assistant', content: n === 0 && itemId ? '材料不足以提交该条目的评估。' : '已提交。', tool_calls: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'stub', model: 'stub', choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen, counts })));
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
const idxBody = await read(IDX);
const idx = JSON.parse(idxBody);
const evBody = await read(EVP);
const evFile = JSON.parse(evBody);
const chkBody = await read(CHK);
const checksFile = JSON.parse(chkBody);
const rubricBody = await read(RUBRIC_PATH);
const rubric = JSON.parse(rubricBody);
const profileBody = await read(PROFILE_PATH);
const profile = JSON.parse(profileBody);
const schema = JSON.parse(await read(path.join(design, 'rubric-assessment.schema.json')));

const pv = validateProfile(profile, rubric);
if (!pv.ok) { process.stderr.write(`_l4run 拒绝启动：profile 与 rubric 不自洽\n  ${pv.errors.join('\n  ')}\n`); process.exitCode = 1; throw new Error('profile invalid'); }

// ★★ 跨层身份校验（fail-closed）：所有上游必须**逐字节**对上，否则不跑、不写产物。
//   与 validateProfile 的分工：那个查"profile 与 rubric 语义自洽"（profile 是对着哪个 rubric 做的），
//   这里查"上游文件真的就是它们自称的那份"（rubric 原文 / evidence / verification / index 的字节身份）。
//   ★ rubric 原文按 `rubric.source.file` 定位（默认与 canonical JSON 同目录），
//     它才是哈希链的根；canonical JSON 只是派生结构。
const RUBRIC_SRC_PATH = path.resolve(path.dirname(RUBRIC_PATH), rubric.source?.file ?? '');
let rubricSourceBody = null;
try { rubricSourceBody = await read(RUBRIC_SRC_PATH); } catch { rubricSourceBody = null; }
const ident = verifyUpstreamIdentity({
  rubricSourceBody, rubric, profileBody, profile,
  evidenceBody: evBody, verificationBody: chkBody, indexBody: idxBody, docBody: full,
});
if (!ident.ok) {
  process.stderr.write(`_l4run 拒绝启动：跨层身份校验失败（上游可能被替换/篡改）\n  ${ident.errors.join('\n  ')}\n`);
  process.exitCode = 1;
  throw new Error('upstream identity broken');
}
if (rubricSourceBody === null) {
  process.stderr.write(`_l4run 警告：找不到 rubric 原文 ${RUBRIC_SRC_PATH}，无法逐字节核对哈希链的根\n`);
}

const parts = partitionChecks(checksFile.checks);
const leaves = scorableLeaves(profile);

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
    } catch { /* usage 拿不到就算了，不影响主流程 */ }
    usage.calls++;
    return res;
  };
}

// 页面图：视觉条目要真的能看图，所以把 asset_refs 指向的整页渲染作为附件给出
async function imageParts(assets) {
  const out = [];
  for (const a of assets ?? []) {
    if (a.readable === false) continue;
    try {
      const buf = await fsp.readFile(path.join(root, a.file));
      out.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${buf.toString('base64')}` } });
    } catch { a.readable = false; }
  }
  return out;
}

const ids = { next: 1 };
const itemOutcomes = [];
const allAssessments = [];

for (const itemId of leaves) {
  const ctx = buildItemContext({
    rubric, profile, evidenceFile: evFile, checks: checksFile.checks, idx, full, itemId,
    assetExists: rel => existsSync(path.join(root, rel)),
  });
  const runner = createAssessmentRunner({ ctx, ids, maxCalls: 6 });
  const body = assessmentMessage({
    item: ctx.item, pItem: ctx.pItem, bundles: ctx.bundles, checks: ctx.checks,
    documentChecks: ctx.documentChecks, assets: ctx.assets, idx, full,
  });
  const imgs = await imageParts(ctx.assets);
  const loop = await runToolLoop({
    runner, cfg, tools: l4Tools(ctx.pItem?.scoring_strategy?.type), maxTurns: TURNS, fetchImpl, resultFor: l4ResultFor,
    // 视觉条目把整页渲染一起给出去；纯文本条目就只给文本（不重复塞无关图片）
    messages: [{ role: 'system', content: L4_SYSTEM_PROMPT }, { role: 'user', content: imgs.length ? [{ type: 'text', text: body }, ...imgs] : body }],
  });
  const s = runner.summary();
  itemOutcomes.push({
    item_id: itemId, turns: loop.turns, done: loop.done,
    attempted: s.attempted, accepted: s.accepted, rejected: s.rejected,
    rejected_calls: runner.rejected().map(r => ({ ...r, rubric_item_id: itemId })),
    assets: ctx.assets.length, bundles: ctx.bundles.length, checks: ctx.checks.length,
  });
  allAssessments.push(...runner.assessments);
}

const out = assembleAssessmentArtifact({
  doc: { name: idx.doc.name, sha256: idx.doc.sha256, text_file: path.basename(TXT), index_file: path.basename(IDX) },
  rubric, rubricFile: path.basename(RUBRIC_PATH),
  profile, profileFile: path.basename(PROFILE_PATH), profileSha: sha(profileBody),
  evidenceRef: { file: path.basename(EVP), sha256: sha(evBody), plan_id: evFile.retrieval_plan?.plan_id ?? null, plan_version: evFile.retrieval_plan?.version ?? null },
  verificationRef: {
    file: path.basename(CHK), sha256: sha(chkBody),
    layer_version: checksFile.authority?.layer_version ?? null,      // v0.1 产物没有这个字段 → null
    scope_inferred: parts.any_inferred_scope,                        // v0.1 产物没有 scope → 推导来的
    checks_total: (checksFile.checks ?? []).length,
    rubric_item_checks: (checksFile.checks ?? []).filter(c => checkScopeTxt(c) === 'rubric_item').length,
    document_checks: parts.document.length,
  },
  indexRef: { file: path.basename(IDX), sha256: sha(idxBody), tables: (idx.tables ?? []).length },
  assessments: allAssessments, itemOutcomes,
  notices: `★ 由${STUB ? '本地 stub 服务（离线）' : '真实模型'}产出（model=${cfg.model}）。`
    + '上游 L2 证据与 L3 验证只按文件名 + SHA-256 引用；每条的审查路由由系统规则强制，模型只能建议。',
});
function checkScopeTxt(c) { return c.scope === 'document' ? 'document' : 'rubric_item'; }

const body = JSON.stringify(out, null, 2) + '\n';
await fsp.writeFile(OUT, body, 'utf8');

// ------------------------------------------------------------------ 自证（设计稿 §12 的机械部分）

const vr = (() => { try { return validate(schema, out); } catch (e) { return { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; } })();
const allKeys = (o, acc = []) => {
  if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
  return acc;
};
const keys = allKeys(out);
const leafSet = new Set(leaves);
const checkIds = new Set((checksFile.checks ?? []).map(c => c.id));
const byItem = new Map(allAssessments.map(a => [a.rubric_item_id, a]));

rep.push(`模式：${STUB ? '本地 stub（离线）' : '真实 API'}   model=${cfg.model}   L4=${L4_VERSION}`);
rep.push(`上游：checks=${path.basename(CHK)}（L3 ${checksFile.authority?.layer_version ?? '未知版本（无 scope，作用域为推导）'}）  可评分叶子=${leaves.length}`);
rep.push(`产出 ${path.relative(root, OUT).split(path.sep).join('/')}（${body.length} 字节）`);
rep.push(`调用账目：attempted=${out.diagnostics.attempted} accepted=${out.diagnostics.accepted} rejected=${out.diagnostics.rejected}`
  + (STUB ? '' : `   tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}  HTTP=${usage.calls}`));
// 与 L2/L3 驱动统一格式（评测脚本按这一行采集成本）
rep.push(`调用成本：calls=${usage.calls} prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens}${STUB ? '（stub 模式，token 为 0）' : ''}`);
rep.push('');
rep.push('--- 每个叶子的定性评估（无分值）---');
for (const id of leaves) {
  const a = byItem.get(id);
  if (!a) { const o = itemOutcomes.find(x => x.item_id === id); rep.push(`  ${id.padEnd(6)} [无 assessment]  回合=${o?.turns} 拒收=${o?.rejected} → 覆盖账目记 missing`); continue; }
  const verdict = a.strategy_type === 'levels'
    ? `${a.level_status}${a.candidate_level_ids.length ? ` ${JSON.stringify(a.candidate_level_ids)}` : ''}${a.boundary_condition ? '（卡点已写明）' : ''}`
    : String(a.judgment);
  rep.push(`  ${id.padEnd(6)} ${verdict.padEnd(28)} findings=${a.findings.length}（${a.findings.filter(f => f.polarity === 'concern').length} concern / ${a.findings.filter(f => f.polarity === 'strength').length} strength）`
    + `  evidence=${a.evidence_refs.length} 补充=${a.supplemental_evidence.length} asset=${a.asset_refs.length} checks=${a.verification_refs.length}`
    + ` 丢弃=${Object.values(a.diagnostics).filter(Array.isArray).reduce((s, v) => s + v.length, 0)}`
    + `  review=${a.review.required ? a.review.required_reason_codes.join(',') : '—'}`);
}
rep.push('');
rep.push('--- 覆盖账目（机器不产生分值；教师给分）---');
for (const s of out.aggregation.sections) rep.push(`  ${s.rubric_item_id}  满分=${s.maximum}  complete=${s.complete}  子项=${s.children.map(c => `${c.rubric_item_id}:${c.status}`).join(' ')}`);
rep.push(`  总覆盖 complete=${out.aggregation.total.complete}  满分参考=${out.aggregation.total.maximum}  缺=${JSON.stringify(out.aggregation.total.incomplete_items)}  rule=${out.aggregation.total.rule}`);
rep.push('');
rep.push('--- 自证 ---');

// ---- 不变量（任何模型输出都必须成立）----
const itemChecksOf = id => (checksFile.checks ?? []).filter(c => c.rubric_item_id === id && c.scope !== 'document');
const stateOf = a => a.judgment ?? a.level_status ?? null;   // 两个分支的「状态」在此对齐
const bearingOf = a => [...a.evidence_refs, ...a.supplemental_evidence].filter(r => r.role !== 'context')
  .concat(a.findings.filter(f => f.located || f.verification));   // ★ v0.3：带有效定位的 finding 也是起作用依据
const strategyOf = id => profile.items.find(p => p.rubric_item_id === id)?.scoring_strategy?.type ?? null;

eq('★ artifact 通过正式 JSON Schema', vr.ok, true);
if (!vr.ok) for (const e of vr.errors.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
eq('★ 只为 scorable 叶子生成 assessment', allAssessments.map(a => a.rubric_item_id), leaves.filter(id => byItem.has(id)));
eq('★ assessments 里绝不出现父项（R1/R2/R3）', allAssessments.every(a => leafSet.has(a.rubric_item_id)), true);
eq('★ 每条 assessment 的 id 由系统分配且连续', allAssessments.every((a, i) => a.assessment_id === 'a' + String(i + 1).padStart(4, '0')), true);
eq('★ 同一 rubric 条目不能重复评估',
  allAssessments.length === new Set(allAssessments.map(a => a.rubric_item_id)).size, true);
eq('★ facet 不参与评估：产物里没有任何 facet 级结论',
  allAssessments.every(a => typeof a.rubric_item_id === 'string' && !('facet_id' in a)) &&
  !keys.includes('facet_scores') && !keys.includes('facet_score'), true);
eq('★ v0.3：产物里没有分值字段（awarded / score 都不存在；maximum 只在覆盖账目里作满分参考）',
  !keys.includes('awarded') && !keys.includes('score'), true);
eq('★ 契约按 strategy 分支：strategy_type 与 profile 一致；levels 条目无 judgment、points/binary 条目无 level_status',
  allAssessments.every(a => a.strategy_type === strategyOf(a.rubric_item_id) &&
    (a.strategy_type === 'levels'
      ? a.judgment === undefined && LEVEL_STATUSES.includes(a.level_status)
      : a.level_status === undefined && a.candidate_level_ids === undefined && JUDGMENTS.includes(a.judgment))), true);
eq('★ L3 impact 约束：pass 不能标 contradict / fail 不能标 support / unverified 只能 neutral',
  allAssessments.every(a => a.verification_refs.every(r =>
    !(r.stance === 'pass' && r.impact === 'contradict') &&
    !(r.stance === 'fail' && r.impact === 'support') &&
    !(r.stance === 'unverified' && r.impact !== 'neutral'))), true);
eq('★ 该条目有 L3 fail → 必须送审',
  allAssessments.every(a => !itemChecksOf(a.rubric_item_id).some(c => c.stance === 'fail') ||
    a.review.required_reason_codes.includes('l3_fail_for_item')), true);
eq('★ 引用了 fail 作为反证 → 必须送审',
  allAssessments.every(a => !a.verification_refs.some(r => r.stance === 'fail') ||
    a.review.required_reason_codes.includes('referenced_l3_fail')), true);
eq('★ unverified 不被无条件送审；显式引用它才算"对判断必要"',
  allAssessments.every(a => !a.review.required_reason_codes.includes('referenced_l3_unverified') ||
    a.verification_refs.some(r => r.stance === 'unverified')), true);
eq('★ unverified 不影响判断：引用了 unverified 的地方一律是 neutral',
  allAssessments.every(a => a.verification_refs.filter(r => r.stance === 'unverified').every(r => r.impact === 'neutral')), true);
eq('★ 「材料不足 / 不适用」状态强制送审（教师确认），且 levels 非 candidate 状态不带候选档',
  allAssessments.every(a => {
    const s = stateOf(a);
    if (s === 'insufficient_evidence') return a.review.required_reason_codes.includes('insufficient_evidence');
    if (s === 'not_applicable') return a.review.required_reason_codes.includes('not_applicable');
    if (s === 'outside_defined_levels') {
      return a.review.required_reason_codes.includes('outside_defined_levels') &&
        (!a.candidate_level_ids || a.candidate_level_ids.length === 0);   // ★ 留空候选，不硬选
    }
    return true;
  }), true);
eq('★ 被丢弃的引用一律没进产物（按 id 核对）', (() => {
  for (const a of allAssessments) {
    if (a.diagnostics.dropped_evidence_refs.some(d => a.evidence_refs.some(r => r.bundle_id === d.bundle_id && r.resolved.every(s => !(d.span_indices ?? []).includes(s.span_index))))) return false;
    if (a.diagnostics.dropped_verification_refs.some(d => a.verification_refs.some(r => r.check_id === d.check_id))) return false;
    if (a.diagnostics.dropped_supplemental_quotes.some(d => a.supplemental_evidence.some(s => s.quote === d.quote))) return false;
  }
  return true;
})(), true);
eq('★ 接纳的 supplemental evidence 全都逐字可回溯且 unambiguous',
  allAssessments.every(a => a.supplemental_evidence.every(s =>
    full.slice(s.offset.start, s.offset.end) === s.quote && s.binding.selection === 'unambiguous' && !!s.source_ref.entry)), true);
eq('★ evidence 引用逐字可回溯（full.slice(offset) === quote）',
  allAssessments.every(a => a.evidence_refs.every(r => r.resolved.every(s => full.slice(s.offset.start, s.offset.end) === s.quote))), true);
eq('★ findings：带 quote 的一律逐字可回溯；挂了 check 的一律真实存在且回填了 stance',
  allAssessments.every(a => a.findings.every(f =>
    (!f.located || (full.slice(f.located.offset.start, f.located.offset.end) === f.quote && f.located.binding.selection === 'unambiguous')) &&
    (!f.verification || (checkIds.has(f.verification.check_id) && typeof f.verification.stance === 'string')) &&
    (f.located || !f.quote))), true);
eq('★ finding 定位断链 → finding 保留（定性观察不丢）但必须送审',
  allAssessments.every(a => a.diagnostics.dropped_findings.every(d =>
    a.review.required === true && a.review.required_reason_codes.includes('dropped_assessment_ref'))), true);
// ★ 不变量：上游**声明了** L3 版本就照抄、并明确「作用域不是推导的」；没声明就必须标"推导"。
eq('★ attribution 不混：上游声明了版本就照抄，没声明才标「推导」，且逐条引用都说清',
  out.verification.scope_inferred === (out.verification.layer_version === null) &&
  allAssessments.every(a => a.verification_refs.every(r =>
    typeof r.scope_inferred === 'boolean' && r.scope_inferred === out.verification.scope_inferred)), true);
eq('★ 文档级 check 不影响任何评价（只计数；引用它也只能是 neutral）',
  out.diagnostics.document_checks_not_used_for_score === parts.document.length &&
  allAssessments.every(a => a.verification_refs.every(r => r.scope === 'rubric_item' || r.impact === 'neutral')), true);
eq('★ 账目平：accepted + rejected = attempted', out.diagnostics.accepted + out.diagnostics.rejected === out.diagnostics.attempted, true);
eq('★ 只要有一条提交的引用被丢弃（evidence/check/asset/补充引用/finding 定位）→ 该条目必须送审',
  allAssessments.every(a => {
    const d = a.diagnostics.dropped_evidence_refs.length + a.diagnostics.dropped_verification_refs.length
      + a.diagnostics.dropped_supplemental_quotes.length + a.diagnostics.dropped_asset_refs.length
      + a.diagnostics.dropped_findings.length;
    return d === 0 || (a.review.required === true && a.review.required_reason_codes.includes('dropped_assessment_ref'));
  }), true);
eq('★ 送审原因码只可能来自系统规则表（模型没有"建议送审"的通道）',
  allAssessments.every(a => a.review.required_reason_codes.every(r => SYSTEM_REVIEW_CODES.includes(r))) &&
  Object.keys(out.assessments[0]?.review ?? {}).every(k => !/suggest/i.test(k)), true);
eq('★ 覆盖账目：机器不产生分值；任一叶子无有效状态 → complete=false 并列出缺失',
  out.aggregation.total.rule === 'no_machine_scores_teacher_decides' &&
  !('awarded' in out.aggregation.total) &&
  out.aggregation.total.maximum === leaves.reduce((s, id) => s + (profile.items.find(p => p.rubric_item_id === id)?.scoring_strategy.max ?? 0), 0) &&
  out.aggregation.total.complete === leaves.every(id => {
    const a = byItem.get(id);
    return a && (a.judgment || a.level_status);
  }) &&
  out.aggregation.total.incomplete_items.every(id => {
    const a = byItem.get(id);
    return !a || (!a.judgment && !a.level_status);
  }), true);
eq('★ rationale 永远标为模型派生；长度是软上限（超过建议长度只记 over_limit 并送审，不拒收不改写）',
  allAssessments.every(a => a.rationale.derived_by === 'model' && a.rationale.chars === a.rationale.text.length &&
    a.rationale.chars <= 2000 && a.rationale.over_limit === (a.rationale.chars > a.rationale.limit) &&
    (!a.rationale.over_limit || a.review.required_reason_codes.includes('rationale_over_limit'))), true);
// ★★ 2026-09-24 修（0938 暴露）：旧断言要求"每条都必须有依据"，与 v0.3 设计冲突 ——
//   v0.3 对"缺依据"的处理是**该条目送审**（`missing_support_evidence`），而不是让**整份产物作废**。
//   实测代价：一条条目漏给依据 → 整个样本被判失败、进不了指标（1/24 就丢在这）。
//   现在改为：**无依据且未送审**才算问题（即"缺依据时必须带送审码"）。
const noBearing = allAssessments.filter(a => bearingOf(a).length === 0 &&
  !['insufficient_evidence', 'not_applicable', 'outside_defined_levels'].includes(stateOf(a)));
const silentlyUnsupported = noBearing.filter(a => !(a.review?.required === true &&
  (a.review.required_reason_codes ?? []).includes('missing_support_evidence')));
eq('★ 没有起作用依据的条目**必须送审**（不是"整份失败"）', silentlyUnsupported.length, 0);
if (noBearing.length) rep.push(`  注：${noBearing.length} 条条目没有起作用依据，已按设计送审（missing_support_evidence）`);
eq('★ 上游只引用不复制：evidence/verification/index 都是 文件名 + sha256',
  !!out.evidence.file && /^[0-9a-f]{64}$/.test(out.evidence.sha256) &&
  /^[0-9a-f]{64}$/.test(out.verification.sha256) && /^[0-9a-f]{64}$/.test(out.assessment_profile.sha256), true);
eq('★ v0.3 权威声明：机器不产生分值，最终分由教师定',
  out.authority.advisory_only === true && out.authority.final_score_requires_teacher_review === true && out.authority.layer_produces_score === false, true);

// ---- 下面是**脚本化模型**的行为断言（真实模型的输出不按脚本走，所以只在 stub 模式下检查）----
if (STUB) {
  const r21 = byItem.get('R2.1'), r32 = byItem.get('R3.2'), r23 = byItem.get('R2.3'), r22 = byItem.get('R2.2'), r12 = byItem.get('R1.2'), r31 = byItem.get('R3.1');
  const userTextOf = s => {
    const u = s.messages.find(m => m.role === 'user');
    return Array.isArray(u?.content) ? (u.content.find(c => c.type === 'text')?.text ?? '') : String(u?.content ?? '');
  };
  eq('★ stub · v0.2 的 score 字段被拒（工具 schema 里已没有它），该条目随后仍拿到一条合规的 assessment',
    out.diagnostics.rejected_calls.some(r => r.reason_code === 'arguments_failed_schema' && r.rubric_item_id === 'R2.1') &&
    r21?.judgment === 'partially_satisfied' && r21?.findings.length === 2, true);
  eq('★ stub · 可机械验证的断言挂上了 L3 check（R2.1 的 calculation finding → ck0006，回填 stance=fail）',
    r21?.findings.some(f => f.kind === 'calculation' && f.verification?.check_id === 'ck0006' && f.verification?.stance === 'fail' && f.severity === 'major'), true);
  eq('★ stub · finding 的歧义定位（Run 1 出现两次）→ finding 保留但 located=null，且触发 dropped_assessment_ref 送审',
    r12?.findings.length === 2 && r12?.findings.some(f => f.polarity === 'neutral' && f.located === null) &&
    r12?.diagnostics.dropped_findings.some(d => d.reason === 'ambiguous_quote') &&
    r12?.review.required_reason_codes.includes('dropped_assessment_ref'), true);
  eq('★ stub · 不存在的 check 引用被丢弃，不计入 verification_refs',
    r22?.verification_refs.length === 0 && r22?.diagnostics.dropped_verification_refs.some(d => d.reason === 'unknown_check' && d.check_id === 'ck9999'), true);
  eq('★ stub · 引用 fail 作为反证的条目（R3.2 引 ck0006 → contradict）送审',
    r32?.review.required === true && r32?.review.required_reason_codes.includes('referenced_l3_fail') && r32?.verification_refs[0].stance === 'fail', true);
  eq('★ stub · 不提交评估的条目（R3.3）覆盖账目记 missing',
    out.aggregation.total.complete === false && out.aggregation.total.incomplete_items.includes('R3.3'), true);
  eq('★ stub · 「材料不足」（R2.3）不下结论且送审',
    r23?.judgment === 'insufficient_evidence' && r23?.review.required === true, true);
  eq('★ stub · 有歧义的补充引用（Run 1 出现两次）被丢弃 + 送审（insufficient_evidence 本身即送审码，不再重复记 missing_support）',
    r23?.supplemental_evidence.length === 0 && r23?.diagnostics.dropped_supplemental_quotes.some(d => d.reason === 'ambiguous_quote') &&
    r23?.review.required_reason_codes.includes('dropped_assessment_ref') &&
    r23?.review.required_reason_codes.includes('insufficient_evidence'), true);
  eq('★ stub · 干净的补充引用被接纳（切片一致 + entry 覆盖 + 走 entry_hint）',
    (() => {
      const a = r31;
      const s = a?.supplemental_evidence?.[0];
      return !!s && full.slice(s.offset.start, s.offset.end) === s.quote && s.binding.mode === 'entry_hint' &&
        !!s.source_ref.entry && a.review.required_reason_codes.includes('supplemental_evidence_used');
    })(), true);
  eq('★ stub · finding 的干净定位被接纳（R3.1 的 reasoning finding 绑定原文成功）',
    (() => {
      const f = r31?.findings?.find(x => x.polarity === 'strength');
      return !!f?.located && full.slice(f.located.offset.start, f.located.offset.end) === f.quote && !!f.located.source_ref.entry;
    })(), true);
  eq('★ stub · 每次请求都带上了 submit_rubric_assessment 工具', stub.seen.every(s => s.tools === 1), true);
  eq('★ stub · 材料里给了**完整原文**（逐字，未经改写）', stub.seen.every(s => userTextOf(s).includes(full)), true);
  eq('★ stub · 视觉条目附了页面图（R2.3 的 asset_refs 真的作为图片给出去）',
    stub.seen.some(s => JSON.stringify(s.messages).includes('data:image/png;base64,')), true);
  eq('★ stub · 每个条目都被单独问过一次（8 个叶子 → 8 次会话起点）',
    [...stub.counts.keys()].filter(Boolean).sort(), [...leaves].sort());
  eq('★ stub · 喂回给模型的只有结论（没有材料、没有措辞）',
    stub.seen.slice(1).every(s => (s.messages.filter(m => m.role === 'tool')).every(m => {
      const o = JSON.parse(m.content);
      return o.ok === false ? !('text' in o) : !('full' in o) && !('rationale' in o);
    })), true);
  eq('★ stub · 每条 user 消息都按条目分开了（含条目标题与评分策略）',
    stub.seen.every(s => userTextOf(s).includes('## rubric 条目')) &&
    stub.seen.every(s => userTextOf(s).includes('## 评分策略')), true);
}

rep.push('');
rep.push('--- 跨层身份校验（哈希链）---');
rep.push(`  rubric 原文=${ident.shas.rubric_source?.slice(0, 12)}…（${rubric.source?.file}）  profile=${ident.shas.profile.slice(0, 12)}…`);
rep.push(`  evidence=${ident.shas.evidence.slice(0, 12)}…  verification=${ident.shas.verification.slice(0, 12)}…  index=${ident.shas.index.slice(0, 12)}…`);
rep.push(`  doc（原件身份，L1 从上传原件算出）=${ident.shas.doc?.slice(0, 12)}…  正文 .txt=${ident.shas.doc_text?.slice(0, 12)}…`);
rep.push(`  ★ 两者不同是**对的**：doc.sha256 绑的是学生上传原件（全文原则），不是抽取出来的 .txt。`);

eq('★ 跨层身份：上游全部对上（rubric 原文 → profile 链 + evidence/verification 同源 + index 结构）',
  ident.ok, true);
if (!ident.ok) for (const e of ident.errors.slice(0, 8)) rep.push(`        ${e}`);
eq('★ 产物里记录的 sha = 校验时实际算出的 sha（不存在"自报与实测不符"）',
  out.rubric.source_sha256 === ident.shas.rubric_source &&
  out.assessment_profile.sha256 === ident.shas.profile &&
  out.evidence.sha256 === ident.shas.evidence &&
  out.verification.sha256 === ident.shas.verification &&
  out.index.sha256 === ident.shas.index, true);
eq('★ doc 身份三层一致（evidence/verification/index 绑的是同一份原件）',
  ident.parsed.evidence?.doc?.sha256 === ident.shas.doc &&
  ident.parsed.verification?.doc?.sha256 === ident.shas.doc, true);

// ---- ★★ 负向回归：真的改一个字节，必须被拦下（fail-closed）----
//   这是这条校验唯一的价值证明 —— 不翻一个字节，"校验通过"可能只是因为函数什么都没查。
function flipByte(s) {
  // 找一个**语义无关**的位置翻转：末尾空白/第一个非 ASCII 安全位置都可；
  // 这里直接改最后一个字符，保证 JSON 仍可解析（除非末尾是结构字符）。
  if (!s.length) return s;
  const i = s.length - 1;
  const c = s[i];
  const alt = c === '}' ? ' ' : (c === 'a' ? 'b' : 'a');
  return s.slice(0, i) + alt + s.slice(i + 1);
}
const negs = [];
const posControls = [];
{
  // ① rubric 原文翻一位 → rubric.source.sha256 对不上（哈希链的根断了）
  const r1 = verifyUpstreamIdentity({ rubricSourceBody: flipByte(rubricSourceBody ?? ''), rubric, profileBody, profile, evidenceBody: evBody, verificationBody: chkBody, indexBody: idxBody, docBody: full });
  negs.push(['rubric 原文翻一位', r1.ok === false && r1.errors.some(e => e.includes('rubric.source.sha256'))]);
  // ② profile 换一份**别的** rubric 的 sha → profile 链断
  const badProfile = JSON.parse(profileBody); badProfile.rubric.source_sha256 = 'f'.repeat(64);
  const r2 = verifyUpstreamIdentity({ rubricSourceBody, rubric, profileBody: JSON.stringify(badProfile), profile: badProfile, evidenceBody: evBody, verificationBody: chkBody, indexBody: idxBody, docBody: full });
  negs.push(['profile 绑到别的 rubric', r2.ok === false && r2.errors.some(e => e.includes('profile.rubric.source_sha256'))]);
  // ③ evidence 绑到**别的**原件 → 与 index 的 doc 身份不一致，必须被拦
  const evOtherDoc = JSON.parse(evBody); evOtherDoc.doc = { ...(evOtherDoc.doc ?? {}), sha256: 'a'.repeat(64) };
  const r3 = verifyUpstreamIdentity({ rubricSourceBody, rubric, profileBody, profile, evidenceBody: JSON.stringify(evOtherDoc), verificationBody: chkBody, indexBody: idxBody, docBody: full });
  negs.push(['evidence 绑到别的原件', r3.ok === false && r3.errors.some(e => e.includes('evidence(L2).doc.sha256'))]);
  // ④ index 的 offset 乱序 → 单调性断言必须报
  // ★★ 用**合成 index**（两条确定逆序）而不是"改现有 index 的前两条"：
  //   旧写法依赖"至少两条 entry"，在极短文档（实测一份正文仅 12 字符 → index 只有 1 条）上
  //   根本构造不出乱序 → 测试**假失败**。合成法与被测文档规模无关，永远有效。
  const badIdx = { ...(JSON.parse(idxBody) ?? {}), entries: [
    { id: 'neg_a', start: 100, end: 200, text: 'x' },
    { id: 'neg_b', start: 50, end: 99, text: 'y' },
  ] };
  const r4 = verifyUpstreamIdentity({ rubricSourceBody, rubric, profileBody, profile, evidenceBody: evBody, verificationBody: chkBody, indexBody: JSON.stringify(badIdx), docBody: null });
  const r4b = verifyUpstreamIdentity({ rubricSourceBody, rubric, profileBody, profile, evidenceBody: evBody, verificationBody: chkBody, indexBody: JSON.stringify(badIdx), docBody: full });
  negs.push(['index offset 乱序', r4.ok === false || r4b.ok === false]);
  // ⑤ evidence 不声明 rubric_sha256 → 不能被当成"同源"
  const evNoRub = JSON.parse(evBody); delete evNoRub.authority?.rubric_sha256; delete evNoRub.rubric;
  const r5 = verifyUpstreamIdentity({ rubricSourceBody, rubric, profileBody, profile, evidenceBody: JSON.stringify(evNoRub), verificationBody: chkBody, indexBody: idxBody, docBody: full });
  negs.push(['evidence 未声明 rubric_sha256', r5.ok === false && r5.errors.some(e => e.includes('未声明 rubric_sha256'))]);
  // ⑥ ★ 反向对照：**不动任何东西**时必须通过 —— 证明上面几条不是因为"函数永远返回 false"
  const r6 = verifyUpstreamIdentity({ rubricSourceBody, rubric, profileBody, profile, evidenceBody: evBody, verificationBody: chkBody, indexBody: idxBody, docBody: full });
  posControls.push(['原样不动 → 必须通过（否则上面几条全是假阳性）', r6.ok === true]);
}
for (const [name, ok] of negs) eq(`★ 负向回归 · ${name} → 必须被拦下（fail-closed）`, ok, true);
for (const [name, ok] of posControls) eq(`★ 正向对照 · ${name}`, ok, true);

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
  process.stderr.write(`_l4run: ${bad} 项自证失败
` + failLines.join('\n') + '\n');
  try { await fsp.writeFile(path.join(here, '_l4run.failures.txt'), rep.join('\n') + '\n', 'utf8'); } catch { /* 尽力而为 */ }
  process.exitCode = 1;
}
