// _e2e.mjs —— 一键跑完整闭环 + 端到端账目
//
// 定位：**只做编排与对账**，不重写任何一层的逻辑（各层实现与自证留在自己的驱动里）。
//   学生原件 + canonical rubric + profile  →  L1 → L2 → L3 → L4 →（可选）总结评语
//   然后对**唯一真相**逐项核对，把"多一个/少一个"全部列出来。
//
// ★★ 唯一真相（对账的基准，不来自任何产物自报）：
//     ① 学生**原件**的字节 sha256 —— 现算（全项目原则：原文 = 学生上传原件）
//     ② profile 里 `scorable === true` 的**叶子集合** —— 每层"评了什么"都必须与它对齐
//   任何一层的条目数/结论数偏离这个集合（多或少），都要在报告里显式列出，而不是静默通过。
//
// ★ fail-closed：任一层 exit≠0 → **不跑下游**（省下真金白银，也不让"部分失败"被平均成看起来还行的结果）。
//
// 用法：
//   node _e2e.mjs --doc fixtures/real/cs3223-writeup.pdf \
//                 --rubric design/canonical-rubric.cs3223-test.json \
//                 --profile design/rubric-assessment-profile.cs3223-test.json \
//                 [--scores design/teacher-scores.cs3223-test.json]   # 给了就跑总结评语
//                 [--out fixtures/real/out] [--turns 3] [--stub] [--skip-l1]
//
// 产出：<out>/<case>.e2e.json（机器可读）+ <out>/<case>.e2e.txt（人可读）

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run as l1run } from './l1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const NODE = process.execPath;

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DOC = argOf('--doc', path.join(root, 'fixtures/real/cs3223-writeup.pdf'));
const RUBRIC_PATH = argOf('--rubric', path.join(root, 'design/canonical-rubric.cs3223-test.json'));
const PROFILE_PATH = argOf('--profile', path.join(root, 'design/rubric-assessment-profile.cs3223-test.json'));
const SCORES_PATH = argOf('--scores', null);
const OUT_DIR = path.resolve(root, argOf('--out', 'fixtures/real/out'));
const TURNS = String(argOf('--turns', '3'));
const STUB = process.argv.includes('--stub');
const SKIP_L1 = process.argv.includes('--skip-l1');
// ★ --audit-only：**只对账，不跑任何层**（用已有产物）。账目必须能独立重算 ——
//   与 `_evalsum` 同一哲学：跑一次很贵，对账要能随时离线重来。
const AUDIT_ONLY = process.argv.includes('--audit-only');
// ★ --strict：账目有偏离时也返回非 0（CI/回归用）。默认只报告、不失败 ——
//   "结果不完整"是**数据状态**，不是"工具坏了"；两者不该混成同一个退出码。
const STRICT = process.argv.includes('--strict');

const CASE = path.basename(DOC);                    // 例：cs3223-writeup.pdf
const read = async p => fsp.readFile(p, 'utf8');
const readIf = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return ''; } };
const readJsonIf = async p => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; } };
const sha = b => createHash('sha256').update(b).digest('hex');

const rep = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) rep.push(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};
const note = s => rep.push(`  ${s}`);

// ------------------------------------------------------------------ 唯一真相

const docBytes = await fsp.readFile(DOC);
const docSha = sha(docBytes);
const rubric = JSON.parse(await read(RUBRIC_PATH));
const profile = JSON.parse(await read(PROFILE_PATH));
const leaves = profile.items.filter(p => p.scorable === true).map(p => p.rubric_item_id).sort();
const leafSet = new Set(leaves);
const rubricItems = new Set((rubric.items ?? []).map(i => i.id));

const TRUTH = {
  doc_file: path.relative(root, DOC).split(path.sep).join('/'),
  doc_sha256: docSha,
  rubric_file: path.relative(root, RUBRIC_PATH).split(path.sep).join('/'),
  rubric_source_sha256: rubric.source?.sha256 ?? null,
  leaves,
};

// ------------------------------------------------------------------ 逐层编排（fail-closed）

const run = (script, args, env = {}) => new Promise(resolve => {
  const t0 = Date.now();
  const child = execFile(NODE, [script, ...args], { cwd: here, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr, ms: Date.now() - t0 }));
  child.on('error', e => resolve({ code: -1, stdout: '', stderr: String(e), ms: Date.now() - t0 }));
});

const stages = [];
let stoppedAt = null;
const stage = async (name, fn) => {
  if (stoppedAt) return null;
  if (AUDIT_ONLY) { stages.push({ stage: name, code: 0, ms: 0, note: '--audit-only：跳过（用已有产物）' }); return null; }
  const t0 = Date.now();
  const r = await fn();
  const rec = { stage: name, code: r?.code ?? (r?.ok === false ? 1 : 0), ms: r?.ms ?? (Date.now() - t0), note: r?.note ?? null };
  stages.push(rec);
  if (rec.code !== 0) {
    stoppedAt = name;
    rep.push(`  ★ ${name} 失败（exit=${rec.code}）→ **不跑下游**（fail-closed）`);
    const err = (r?.stderr || '').replace(/\s+/g, ' ').slice(0, 300);
    if (err) rep.push(`      ${err}`);
  }
  return r;
};

rep.push('=== 端到端闭环（L1 → L2 → L3 → L4 → 评语）===');
rep.push(`原件：${TRUTH.doc_file}   sha256=${docSha.slice(0, 16)}…`);
rep.push(`rubric：${TRUTH.rubric_file}   source_sha256=${String(TRUTH.rubric_source_sha256).slice(0, 16)}…`);
rep.push(`profile：${path.basename(PROFILE_PATH)}   可评分叶子=${leaves.length}  满分=${leaves.reduce((s, id) => s + (profile.items.find(p => p.rubric_item_id === id)?.scoring_strategy?.max ?? 0), 0)}`);
rep.push(`模式：${STUB ? '离线 stub' : '真实模型'}    turns=${TURNS}${SCORES_PATH ? '   +总结评语' : ''}`);
rep.push('');

// ---- L1（本地解析，无模型）
let l1r = null;
await stage('L1 文档解析', async () => {
  if (SKIP_L1) {
    // 复用已有产物：仍要核对它们与原件是否一致（下面账目里做）
    return { code: 0, ms: 0, note: '--skip-l1：复用已有 L1 产物' };
  }
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const r = await l1run(DOC, OUT_DIR);
  l1r = r;
  return { code: 0, ms: 0, note: `chars=${r.chars} entries=${r.entries} warnings=${(r.warnings ?? []).length}` };
});

const TXT = path.join(OUT_DIR, CASE + '.txt');
const IDX = path.join(OUT_DIR, CASE + '.index.json');
// ★ 产物命名约定（与各驱动一致）：BASE = basename(--file)；L2/L3 的 --file 传**原件**（它们在 out 里找 <BASE>.txt）
const EVP = path.join(OUT_DIR, CASE + (STUB ? '.evidence.stub.json' : '.evidence.json'));
const CHK = path.join(OUT_DIR, CASE + (STUB ? '.checks.llm-stub.json' : '.checks.llm.json'));
const L4OUT = path.join(OUT_DIR, CASE + '.assessment' + (STUB ? '.stub' : '') + '.json');
const SOUT = path.join(OUT_DIR, CASE + '.summary' + (STUB ? '.stub' : '') + '.json');
const stubArg = STUB ? ['--stub'] : [];

// ---- L2
await stage('L2 证据聚焦', async () => {
  const r = await run('_l2run.mjs', ['--file', DOC, '--out', OUT_DIR, '--rubric', RUBRIC_PATH, ...stubArg]);
  const cost = (await readIf(path.join(here, '_l2run.out.txt'))).match(/调用成本：calls=(\d+)/);
  return { code: r.code, ms: r.ms, stderr: r.stderr, note: cost ? `calls=${cost[1]}` : null };
});

// ---- L3（依赖 L2 的 evidence）
await stage('L3 机械验证', async () => {
  const r = await run('_llmrun.mjs', ['--file', DOC, '--out', OUT_DIR, '--rubric', RUBRIC_PATH, '--evidence', EVP, '--turns', TURNS, ...stubArg]);
  const cost = (await readIf(path.join(here, '_llmrun.out.txt'))).match(/调用成本：calls=(\d+)/);
  return { code: r.code, ms: r.ms, stderr: r.stderr, note: cost ? `calls=${cost[1]}` : null };
});

// ---- L4
await stage('L4 定性评估', async () => {
  const r = await run('_l4run.mjs', ['--case', CASE, '--out', OUT_DIR, '--rubric', RUBRIC_PATH, '--profile', PROFILE_PATH, '--turns', TURNS, ...stubArg]);
  const cost = (await readIf(path.join(here, STUB ? '_l4run.out.txt' : '_l4run.real.out.txt'))).match(/调用成本：calls=(\d+)/);
  return { code: r.code, ms: r.ms, stderr: r.stderr, note: cost ? `calls=${cost[1]}` : null };
});

// ---- 总结评语（可选）
if (SCORES_PATH) {
  await stage('S 总结评语', async () => {
    const r = await run('_summaryrun.mjs', ['--case', CASE, '--out', OUT_DIR, '--rubric', RUBRIC_PATH, '--profile', PROFILE_PATH, '--scores', SCORES_PATH, ...stubArg]);
    const cost = (await readIf(path.join(here, STUB ? '_summaryrun.out.txt' : '_summaryrun.real.out.txt'))).match(/调用成本：calls=(\d+)/);
    return { code: r.code, ms: r.ms, stderr: r.stderr, note: cost ? `calls=${cost[1]}` : null };
  });
}

rep.push('');
rep.push('--- 各层执行 ---');
if (AUDIT_ONLY) rep.push('  （--audit-only：不跑任何层，只对账；以下时间/调用数为 0）');
for (const s of stages) rep.push(`  ${s.stage.padEnd(14)} exit=${s.code}  ${(s.ms / 1000).toFixed(0)}s  ${s.note ?? ''}`);
if (stoppedAt) rep.push(`  ★ 在「${stoppedAt}」处停止；下游未执行。`);

// ------------------------------------------------------------------ 端到端账目（唯一真相对齐）

const idx = await readJsonIf(IDX);
const full = await readIf(TXT);
const ev = await readJsonIf(EVP);
const chk = await readJsonIf(CHK);
const art = await readJsonIf(L4OUT);
const sum = SCORES_PATH ? await readJsonIf(SOUT) : null;

const ledger = { l1: null, l2: null, l3: null, l4: null, summary: null };
const diffs = [];   // ★ 所有"偏离唯一真相"的地方都进这里
const addDiff = (layer, kind, detail) => diffs.push({ layer, kind, detail });

rep.push('');
rep.push('--- 端到端账目（对唯一真相：原件 sha + 可评分叶子集合）---');

// L1：索引必须绑同一份原件，且正文能逐字切回（这是"原文没被换"的唯一机械证据）
if (idx) {
  const entries = idx.entries ?? [];
  let mismatch = null;
  for (const e of entries) if (full.slice(e.start, e.end) !== e.text) { mismatch = e.id; break; }
  const lastEnd = Math.max(0, ...entries.map(e => e.end ?? 0));
  ledger.l1 = {
    doc_sha256: idx.doc?.sha256 ?? null,
    bound_to_original: idx.doc?.sha256 === docSha,
    entries: entries.length,
    slice_mismatch: mismatch,
    last_end: lastEnd,
    text_length: full.length,
  };
  if (idx.doc?.sha256 !== docSha) addDiff('L1', 'doc_sha_mismatch', `索引绑的原件 ${String(idx.doc?.sha256).slice(0, 12)}… ≠ 现算 ${docSha.slice(0, 12)}…`);
  if (mismatch) addDiff('L1', 'slice_mismatch', `entry ${mismatch} 的 offset 切不回 entry.text（全文可能被替换）`);
  if (lastEnd > full.length) addDiff('L1', 'offset_out_of_range', `末条 end=${lastEnd} > 正文长度 ${full.length}`);
  note(`L1：entries=${entries.length}  绑定原件=${idx.doc?.sha256 === docSha ? '✓' : '✗'}  逐字切片=${mismatch ? `✗(${mismatch})` : '✓'}  正文 ${full.length} 字`);
} else if (!stoppedAt || stoppedAt !== 'L1 文档解析') addDiff('L1', 'missing_index', '没有索引产物');

// L2：覆盖率 —— **非汇总条目**必须全部被检索过（汇总父项按设计跳过，不算漏）
if (ev) {
  const coverage = ev.diagnostics?.facet_coverage ?? ev.coverage ?? null;
  const base = { file: path.basename(EVP), sha256: sha(await readIf(EVP)), plan_id: ev.retrieval_plan?.plan_id ?? null };
  // evidence 的条目集合（bundle 归属的 rubric_item_id）
  const evItems = [...new Set((ev.evidence ?? []).map(b => b.rubric_item_id).filter(Boolean))];
  const evOutside = evItems.filter(id => !leafSet.has(id));
  ledger.l2 = { ...base, items_with_evidence: evItems.length, coverage };
  if (evOutside.length) addDiff('L2', 'unknown_item', `证据挂在非可评分叶子上：${evOutside.join('、')}`);
  note(`L2：有证据的条目=${evItems.length}  plan=${base.plan_id ?? '—'}  ${coverage ? `覆盖=${JSON.stringify(coverage).slice(0, 80)}` : ''}`);
} else if (stoppedAt === null || stages.find(s => s.stage === 'L2 证据聚焦')?.code === 0) {
  addDiff('L2', 'missing_evidence', '没有证据产物');
}

// L3：check 的归属必须 ⊆ 可评分叶子（document 作用域的检查按设计没有归属）
if (chk) {
  const checks = chk.checks ?? [];
  const scoped = checks.filter(c => (c.scope ?? (c.rubric_item_id ? 'rubric_item' : 'document')) === 'rubric_item');
  const owners = [...new Set(scoped.map(c => c.rubric_item_id).filter(Boolean))];
  const outside = owners.filter(id => !leafSet.has(id));
  const acc = chk.diagnostics?.accepted ?? chk.accounting?.accepted ?? null;
  const rej = chk.diagnostics?.rejected ?? chk.accounting?.rejected ?? null;
  const att = chk.diagnostics?.attempted ?? chk.accounting?.attempted ?? null;
  ledger.l3 = { file: path.basename(CHK), checks_total: checks.length, rubric_item_scoped: scoped.length, document_scoped: checks.length - scoped.length, owners, accepted: acc, rejected: rej, attempted: att };
  if (outside.length) addDiff('L3', 'unknown_item', `check 归属到非可评分叶子：${outside.join('、')}`);
  if (att !== null && acc !== null && rej !== null && acc + rej !== att) addDiff('L3', 'accounting', `账目不平：accepted(${acc}) + rejected(${rej}) ≠ attempted(${att})`);
  // ★ 信息项（不是缺陷）：L3 是按需验证 —— 模型自己决定验哪些条目，**不要求全覆盖**。
  //   但"哪些条目一条 check 都没有"必须看得见，否则读者会误以为全被验过。
  const noCheck = leaves.filter(id => !owners.includes(id));
  ledger.l3.no_check_leaves = noCheck;
  note(`L3：checks=${checks.length}（条目级 ${scoped.length} / 文档级 ${checks.length - scoped.length}）  归属覆盖=${owners.length} 个条目  账目=${acc !== null ? `${acc}+${rej}=${att}` : '—'}`);
  note(`     ★ L3 是按需验证（不要求全覆盖）：有 check 的条目 ${owners.length}/${leaves.length}${noCheck.length ? `；无 check 的：${noCheck.join('、')}` : ''}`);
} else if (stages.find(s => s.stage === 'L3 机械验证')?.code === 0) {
  addDiff('L3', 'missing_verification', '没有验证产物');
}

// L4：★ 核心 —— 结论集合必须**恰好等于**可评分叶子集合（多一个少一个都报）
if (art) {
  const got = art.assessments ?? [];
  const gotIds = got.map(a => a.rubric_item_id).sort();
  const missing = leaves.filter(id => !gotIds.includes(id));
  const extra = gotIds.filter(id => !leafSet.has(id));
  const dup = gotIds.length !== new Set(gotIds).size;
  const noScoreField = !got.some(a => 'score' in a || 'awarded' in a);
  const levelsNoJudgment = got.filter(a => a.strategy_type === 'levels').every(a => a.judgment === undefined);
  const pointsNoLevelStatus = got.filter(a => a.strategy_type !== 'levels').every(a => a.level_status === undefined && a.candidate_level_ids === undefined);
  const withStatus = got.filter(a => a.judgment || a.level_status).length;
  const reviewRequired = got.filter(a => a.review?.required).length;
  ledger.l4 = {
    file: path.basename(L4OUT), layer_version: art.authority?.layer_version ?? null,
    assessments: got.length, missing, extra, duplicate: dup,
    with_status: withStatus, review_required: reviewRequired,
    no_score_field: noScoreField,
    anchored_findings: got.flatMap(a => a.findings ?? []).length,
    unanchored_findings: got.flatMap(a => a.findings ?? []).filter(f => !f.located && !f.verification).length,
    accounting: art.diagnostics ? { attempted: art.diagnostics.attempted, accepted: art.diagnostics.accepted, rejected: art.diagnostics.rejected } : null,
  };
  if (missing.length) addDiff('L4', 'missing_leaves', `缺结论：${missing.join('、')}`);
  if (extra.length) addDiff('L4', 'extra_items', `多出非叶子条目：${extra.join('、')}`);
  if (dup) addDiff('L4', 'duplicate', '同一条目出现多次');
  if (!noScoreField) addDiff('L4', 'score_field_present', '产物里出现了分值字段（v0.3 不该有）');
  if (!levelsNoJudgment) addDiff('L4', 'branch_mixup', 'levels 条目带 judgment');
  if (!pointsNoLevelStatus) addDiff('L4', 'branch_mixup', 'points/binary 条目带 level_status/candidate_level_ids');
  if (art.diagnostics && art.diagnostics.accepted + art.diagnostics.rejected !== art.diagnostics.attempted) addDiff('L4', 'accounting', 'L4 账目不平');
  note(`L4：结论=${got.length}/${leaves.length}  有状态=${withStatus}  送审=${reviewRequired}  无分值字段=${noScoreField ? '✓' : '✗'}  findings=${ledger.l4.anchored_findings}（无锚 ${ledger.l4.unanchored_findings}）`);
} else if (stages.find(s => s.stage === 'L4 定性评估')?.code === 0) {
  addDiff('L4', 'missing_assessment', '没有 L4 产物');
}

// 评语：覆盖必须等于叶子集合；分数必须由程序回抄（模型无输出通道）
if (sum) {
  const ids = (sum.per_item ?? []).map(x => x.rubric_item_id).sort();
  const missing = leaves.filter(id => !ids.includes(id));
  const extra = ids.filter(id => !leafSet.has(id));
  ledger.summary = {
    file: path.basename(SOUT), chars: sum.summary?.chars ?? null, pending_chars: sum.summary?.pending_chars ?? null,
    missing, extra, release: sum.release?.status ?? null, blockers: sum.release?.blockers ?? [],
    unconfirmed: sum.unconfirmed_items ?? [], unanchored: (sum.unanchored_findings ?? []).length,
  };
  if (missing.length) addDiff('S', 'missing_items', `评语缺条目：${missing.join('、')}`);
  if (extra.length) addDiff('S', 'extra_items', `评语多出条目：${extra.join('、')}`);
  note(`S：覆盖 ${ids.length}/${leaves.length}  正文 ${sum.summary?.chars ?? '—'} 字  待确认 ${sum.summary?.pending_chars ?? '—'} 字  release=${sum.release?.status}  blockers=${JSON.stringify(sum.release?.blockers)}`);
}

rep.push('');
if (diffs.length === 0) {
  rep.push('  ★ 账目全平：各层条目集合与唯一真相一致，无偏离。');
} else {
  rep.push(`  ★ 偏离唯一真相 ${diffs.length} 处：`);
  for (const d of diffs) rep.push(`    [${d.layer}] ${d.kind}：${d.detail}`);
}

// ------------------------------------------------------------------ 自证（不变量）

rep.push('');
rep.push('--- 自证（检验账目**机制**本身，不要求数据必须完美）---');
eq('★ 唯一真相里的叶子集合 = profile 的可评分叶子', leaves, profile.items.filter(p => p.scorable).map(p => p.rubric_item_id).sort());
eq('★ 叶子必须都存在于 canonical rubric（不能凭空造叶子）', leaves.every(id => rubricItems.has(id)), true);
eq('★ 未在 L1 失败时，索引必须绑当前原件（doc.sha256 = 现算）', stoppedAt === 'L1 文档解析' || AUDIT_ONLY || ledger.l1?.bound_to_original === true, true);
eq('★ L4 产物没有分值字段（v0.3：机器不产生分数）', !art || ledger.l4.no_score_field === true, true);
// ★ 关键这条改口径：不是"数据必须完美"，而是"**偏离必须被显式记录**"（缺/多都要出现在 diffs 里）
eq('★ L4 覆盖偏离必须进 diffs（缺一个/多一个都不许静默通过）',
  !art || (() => {
    const l4diffs = diffs.filter(d => d.layer === 'L4' && (d.kind === 'missing_leaves' || d.kind === 'extra_items' || d.kind === 'duplicate'));
    const hasDeviation = ledger.l4.missing.length > 0 || ledger.l4.extra.length > 0 || ledger.l4.duplicate;
    return hasDeviation === (l4diffs.length > 0);
  })(), true);
eq('★ 评语覆盖偏离同理进 diffs', !sum || (() => {
  const hasDeviation = ledger.summary.missing.length > 0 || ledger.summary.extra.length > 0;
  return hasDeviation === diffs.some(d => d.layer === 'S');
})(), true);
eq('★ fail-closed：任一层失败时，下游没有产物被写', stoppedAt === null || stages[stages.length - 1].stage === stoppedAt, true);

// ------------------------------------------------------------------ 落盘

const out = {
  truth: TRUTH,
  mode: STUB ? 'stub' : 'real',
  turns: Number(TURNS),
  stages,
  stopped_at: stoppedAt,
  ledger,
  diffs,
  ledger_clean: diffs.length === 0,
  artifacts: {
    text: path.basename(TXT), index: path.basename(IDX), evidence: path.basename(EVP),
    verification: path.basename(CHK), assessment: path.basename(L4OUT),
    ...(sum ? { summary: path.basename(SOUT) } : {}),
  },
  note: '唯一真相 = 原件字节 sha256 + profile 的可评分叶子集合。各层偏离都会进 diffs（多一个/少一个都算）。'
    + '本报告只做编排与对账；每层的详细自证见各自驱动的 *.out.txt。',
};
await fsp.mkdir(OUT_DIR, { recursive: true });
await fsp.writeFile(path.join(OUT_DIR, CASE + '.e2e' + (STUB ? '.stub' : '') + '.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

// ★ 自证（针对产物）与**退出码口径**：
//   ① 自证失败 = 账目机制/实现有问题 → exit 1
//   ② 账目偏离 = 这一轮结果不完整（可能只是某层没跑）→ 默认只报告；`--strict` 时才 exit 1
//   两者不混：结果状态不该让工具"看起来坏了"，工具坏了也不该被当成结果状态。
eq('★ 账目干净标志与 diffs 一致（ledger_clean ⇔ diffs 为空）', out.ledger_clean === (out.diffs.length === 0), true);

rep.push('');
const verdictLine = bad === 0 && diffs.length === 0 ? 'ALL PASS（账目全平）'
  : `自证失败 ${bad} 项${bad ? '' : '（无）'}　账目偏离 ${diffs.length} 处`;
rep.push(`==== ${verdictLine} ====`);
await fsp.writeFile(path.join(here, '_e2e.out.txt'), rep.join('\n') + '\n', 'utf8');
console.log(rep.join('\n'));

if (bad > 0 || stoppedAt) process.exitCode = 1;
else if (STRICT && diffs.length) process.exitCode = 1;
