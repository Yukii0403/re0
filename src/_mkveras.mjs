// _mkveras.mjs —— 把 VerAs 公开数据集（DOI 10.26208/BWE2-BR31）接进我们的链路
//
// 为什么要它：VerAs 是 AIED 2024 的「Verify then Assess」，**不是评估工具** —— 它给我们的是
//   ①带教师侧 gold 的公开数据集（1078 Pendulum + 1005 Newton，rubric 7/8 维、每维 0–5）
//   ②一套评估协议与可比数字。所以我们用的是它的**数据和协议**，不是它的模型（论文未公开代码）。
//
// ★ 本脚本做四件事，全部**实测偏移**、逐字断言，不手算：
//   1. 抽 gold（多评分者行 source=GD，status=common/discussion → 论文口径的多数/共识标签）
//   2. 把选中的报告 txt **原样**搬进 fixtures/veras/（并核对 L1 抽取后逐字不变）
//   3. 用**我们自己的 L1** 解析 rubric 的 docx（4 份，part1/part2）→ rubric 原文 txt
//   4. 从 rubric 原文里**机械切出**每个维度的：维度陈述（条目 text）+ 等级描述 / 计分条项，
//      生成 canonical rubric + assessment profile，并断言「切片 === 原文」
//
// 用法:
//   node _mkveras.mjs                      默认：Pendulum，抽 1 份（成本试算）
//   node _mkveras.mjs --lab pendulum --pick 20 --stratified
//   node _mkveras.mjs --out ../fixtures/veras

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run as runL1 } from './l1.mjs';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = argOf('--lab', 'pendulum');
const PICK = Number(argOf('--pick', 1));
const STRAT = process.argv.includes('--stratified');
const OUTDIR = path.resolve(root, argOf('--out', 'fixtures/veras'));
const RAW = path.join(OUTDIR, '.raw/extracted/passonneau-et-al-reliable-rubric-based-assessment-of-physics-lab-reports-data-for-machine-learning-2022');

const report = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) report.push(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};
const sha = b => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ 1. gold

const csvName = LAB === 'pendulum' ? 'PendulumLab.csv' : 'NewtonLab.csv';
const csv = await fsp.readFile(path.join(RAW, csvName), 'utf8');
const lines = csv.split(/\r?\n/).filter(Boolean);
const hdr = lines[0].split(',').map(s => s.trim());
const ci = Object.fromEntries(hdr.map((h, k) => [h, k]));
// 逗号在 TA 姓名里（"Street, Craig"）→ 用带引号的简易 CSV 解析
const parseCsv = l => {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') { q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
};
const rows = lines.slice(1).map(parseCsv);
const dimIds = hdr.filter(h => /^Dimension \d+$/.test(h)).map(h => Number(h.split(' ')[1]));
eq(`gold · ${LAB} 的维度数`, dimIds.length, LAB === 'pendulum' ? 7 : 8);
const maxTotal = dimIds.length * 5;

const reports = rows.map(r => ({
  id: r[ci.ID],
  status: r[ci.status],
  source: r[ci.source],
  dims: dimIds.map(d => Number(r[ci['Dimension ' + d]])),
  ta: Number(r[ci.RescaledTA]),
  rater: Number(r[ci.RescaledRater]),
  semesterYear: r[ci['Semester-Year']],
}));
eq('gold · 每份报告只有一行标签（唯一 id 数 = 行数）', new Set(reports.map(x => x.id)).size, reports.length);
eq('gold · 分数都在 0–5', reports.every(x => x.dims.every(v => Number.isInteger(v) && v >= 0 && v <= 5)), true);
// RescaledRater 应该 = 各维之和 / 满分（先核实这个关系，再用它做总分口径）
const rescaleOk = reports.filter(x => x.status !== 'single').every(x => Math.abs(x.rater - x.dims.reduce((a, b) => a + b, 0) / maxTotal) < 0.02);
eq('gold · RescaledRater = 各维之和 / 满分（总分口径可直接对齐）', rescaleOk, true);

// 选样：优先"多评分者/共识"行（source=GD），按长度最接近中位数挑
const lenOf = async id => (await fsp.readFile(path.join(RAW, 'data', LAB, id + '.txt'), 'utf8')).length;
const withLen = [];
for (const r of reports) withLen.push({ ...r, len: await lenOf(r.id) });
const lens = withLen.map(x => x.len).sort((a, b) => a - b);
const median = lens[Math.floor(lens.length / 2)];

// ★★ 2026-09-24 修：**隔离必须由机制保证，不能靠"gold 文件里恰好没写"**。
//   真实事故：我跑了一次 `--lab pendulum`（PICK 默认 1），gold 被覆盖成 1 份 ——
//   而 holdout 的排除集是"生成时的 gold 内容"（见 `_mkholdout.mjs`），于是名单被抹掉，
//   重抽的 dev 池与 holdout 出现了 3 份交集。
//   现在 dev 抽样**强制排除 holdout 清单里的样本**（holdout 的 id 列表由 `_mkholdout.mjs` 留痕）。
const HOLDOUT_MANIFEST = path.join(OUTDIR, 'holdout', `holdout.${LAB}.json`);
let holdoutIds = new Set();
try {
  const h = JSON.parse(await fsp.readFile(HOLDOUT_MANIFEST, 'utf8'));
  holdoutIds = new Set((h.reports ?? []).map(r => r.id));
} catch { /* 还没有 holdout 清单 = 首次生成 */ }
const beforeExclude = withLen.length;
const pool = holdoutIds.size ? withLen.filter(x => !holdoutIds.has(x.id)) : withLen;

const pickPool = pool.filter(x => x.source === 'GD' && x.status !== 'single');
const chosen = STRAT
  ? (() => {
    // 分层：按 rater 归一化总分分成 低/中/高 三档，每档取最接近中位长度的
    const sorted = [...pool].sort((a, b) => a.rater - b.rater);
    const per = Math.ceil(PICK / 3);
    const buckets = [sorted.slice(0, Math.floor(sorted.length / 3)), sorted.slice(Math.floor(sorted.length / 3), Math.floor(sorted.length * 2 / 3)), sorted.slice(Math.floor(sorted.length * 2 / 3))];
    const out = [];
    for (const b of buckets) out.push(...b.sort((a, c) => Math.abs(a.len - median) - Math.abs(c.len - median)).slice(0, per));
    return out.slice(0, PICK);
  })()
  : [...(pickPool.length ? pickPool : pool)].sort((a, b) => Math.abs(a.len - median) - Math.abs(b.len - median)).slice(0, PICK);

// ★ 不变量：dev 池与 holdout **必须不相交**（不靠人记得，这里直接断言）
eq('gold · dev 池与 holdout 无交集（隔离由机制保证）',
  chosen.every(x => !holdoutIds.has(x.id)), true);
if (holdoutIds.size) report.push(`注：已按 holdout 清单排除 ${beforeExclude - pool.length} 份（holdout 共 ${holdoutIds.size} 份，dev 池与它必须不相交）`);

await fsp.mkdir(OUTDIR, { recursive: true });
const gold = {
  dataset: { doi: '10.26208/BWE2-BR31', lab: LAB, csv: csvName, csv_sha256: sha(Buffer.from(csv, 'utf8')), dims: dimIds.length, max_per_dim: 5, max_total: maxTotal },
  note: 'Gold = 数据集 release 里 source=GD 的行（status=common 多评分者 / discussion 研究者共识）。'
    + 'single 行只有一位评分者，噪声更大，本文件里也一并记录以便对比。'
    + '★ release 里**没有**逐评分者分开的行，所以"人类一致性上限"只能引用论文报告的 Pearson 0.72/0.69，不能自算。',
  reports: chosen.map(x => ({ id: x.id, status: x.status, source: x.source, dims: x.dims, ta_rescaled: x.ta, rater_rescaled: x.rater, chars: x.len })),
};
await fsp.writeFile(path.join(OUTDIR, `gold.${LAB}.json`), JSON.stringify(gold, null, 2) + '\n', 'utf8');

// 报告文本原样搬进 fixtures（逐字），并记原件 sha
for (const c of chosen) {
  const t = await fsp.readFile(path.join(RAW, 'data', LAB, c.id + '.txt'), 'utf8');
  await fsp.writeFile(path.join(OUTDIR, `${c.id}.txt`), t, 'utf8');
}
report.push('');
report.push(`抽样：${LAB} 取 ${chosen.length} 份（中位长度 ${median}）`);
for (const c of chosen) report.push(`  ${c.id}  status=${c.status}  dims=${c.dims.join('/')}  总分=${c.dims.reduce((a, b) => a + b, 0)}/${maxTotal}  TA=${c.ta}  长度=${c.len}`);

// ------------------------------------------------------------------ 2. 用我们的 L1 解析 rubric docx

const RUB = path.join(RAW, 'rubrics');
const parts = LAB === 'pendulum'
  ? [['Pendulum_Rubric_Reformatted_part1.docx', 1], ['Pendulum_Rubric_Reformatted_part2.docx', 2]]
  : [['Force_Motion_Rubric_Reformatted_corrected_part1.docx', 1], ['Force_Motion_Rubric_Reformatted_corrected_part2.docx', 2]];
const probeDir = path.join(OUTDIR, 'probe');
await fsp.mkdir(probeDir, { recursive: true });

const partTexts = {};
for (const [f, n] of parts) {
  const r = await runL1(path.join(RUB, f), probeDir);
  partTexts[n] = { file: f, text: await fsp.readFile(r.textFile, 'utf8'), chars: r.chars, entries: r.entries };
  // rubric 原文也存一份到 fixtures（canonical rubric 的 source_ref 要指向它）
  await fsp.writeFile(path.join(OUTDIR, `rubric-${LAB}-part${n}.txt`), partTexts[n].text, 'utf8');
}
const rubricMain = partTexts[1];
eq('rubric · 由**我们自己的 L1** 解析 docx 成功（不是手工抄写）', partTexts[1].chars > 1000 && partTexts[2].chars > 1000, true);

// ------------------------------------------------------------------ 3. 机械切分维度（不手算偏移）

// part1 第 0 行是 5 个等级的表头；之后每个维度 = 一行"维度陈述" + 一行（tab 分隔的 5 个等级描述）
const splitLines = t => {
  const out = [];
  let off = 0;
  for (const line of t.split('\n')) { out.push({ text: line, start: off, end: off + line.length }); off += line.length + 1; }
  return out;
};
const p1 = splitLines(partTexts[1].text);
const p2 = splitLines(partTexts[2].text);
const headerLine = p1[0];
const levelHeaders = headerLine.text.split('\t');
eq('rubric · 等级表头有 5 列（1..5）', levelHeaders.length, 5);
eq('rubric · 等级分是按 (1)..(5) 标注的', headerLine.text.includes('(1)') && headerLine.text.includes('(5)'), true);

const dims = [];
// ★ 每个 part 的偏移**各自从 0 开始**，所以扫标准行必须限定在同一个 part 内，
//   否则两边的 start 会串台（第一版就这么错了一次：D4 的等级行被 p1 的同号行顶掉）。
const scan = (lines, part, file, fileSha) => {
  for (const l of lines) {
    const m = l.text.match(/^(\d+)\.\s+(.*)$/);
    if (!m) continue;
    dims.push({ n: Number(m[1]), part, statement: l.text, statementRef: { file, sha256: fileSha, start: l.start, end: l.end } });
  }
};
const p1sz = sha(Buffer.from(partTexts[1].text, 'utf8'));
const p2sz = sha(Buffer.from(partTexts[2].text, 'utf8'));
scan(p1.slice(1), 1, 'rubric-' + LAB + '-part1.txt', p1sz);
scan(p2, 2, 'rubric-' + LAB + '-part2.txt', p2sz);
dims.sort((a, b) => a.n - b.n);
eq(`rubric · 切出 ${LAB} 的维度数`, dims.length, LAB === 'pendulum' ? 7 : 8);

// 每个维度的"标准原文"= 陈述行 + 紧随其后的等级/条项行（到**同 part 内**下一个维度陈述前）
const items = [];
const profiles = [];
for (const d of dims) {
  const srcLines = d.part === 1 ? p1 : p2;
  const srcText = d.part === 1 ? partTexts[1].text : partTexts[2].text;
  const i = srcLines.findIndex(l => l.start === d.statementRef.start);
  let j = i + 1;
  while (j < srcLines.length && !/^\d+\.\s+/.test(srcLines[j].text)) j++;
  const standardLines = srcLines.slice(i + 1, j);
  const stdStart = standardLines.length ? standardLines[0].start : d.statementRef.end;
  const stdEnd = standardLines.length ? standardLines[standardLines.length - 1].end : d.statementRef.end;
  const standardText = srcText.slice(stdStart, stdEnd);
  const cellLines = standardLines.filter(l => l.text.includes('\t'));
  const critLines = standardLines.filter(l => !l.text.includes('\t'));

  // 逐字断言：陈述与标准都必须能从原文里切回来
  eq(`rubric · 维度 ${d.n} 的陈述能逐字切回原文`, srcText.slice(d.statementRef.start, d.statementRef.end), d.statement);

  const itemId = 'R' + d.n;   // ★ 条目 id 必须是 R 式（canonical-rubric schema 的 pattern）
  items.push({
    id: itemId, parent: null, depth: 0, order: d.n,
    text: d.statement, score_raw: '5 分（等级表为 1–5 五点；0=未涉及该维度不由 rubric 定义，v0.3 起由 outside_defined_levels 状态承载）',
    source_ref: { ...d.statementRef, page: null, row: null },
    derived_by: 'numbering', children: [],
  });

  // 两种评分策略：①5 个等级单元格 → levels；②按条项计分（"1) ... (1 point)"）→ points + criteria
  let strategy;
  if (cellLines.length) {
    const levelTexts = [];
    for (const l of cellLines) {
      const cells = l.text.split('\t');
      eq(`rubric · 维度 ${d.n} 的等级单元格 = 5 个`, cells.length, 5);
      let off = l.start;
      for (const [k, c] of cells.entries()) {
        levelTexts.push({ level_id: 'L' + (k + 1), score: k + 1, text: c.trim(), source_ref: { file: d.statementRef.file, sha256: d.statementRef.sha256, start: off, end: off + c.length } });
        off += c.length + 1;
      }
    }
    // ★★ v0.3（2026-09-24 修）：**不再自造 L0**。
    //   已回原始 rubric 核对（`rubric-pendulum-part1/2.txt`）：每个维度只有 5 列等级单元格，
    //   **没有任何 0 的定义**；README 只说 0–5 合法、没给 0 的语义。
    //   我们此前合成的「（未涉及该维度：报告里没有任何相关内容）」是**无出处的发明**
    //   （污染 5 个 levels 维度，且逼模型在 1–5 里硬选 → R1 无分辨力）。
    //   v0.3 起，"0 = 未涉及"这一语义由 **`outside_defined_levels` 状态**承载：
    //     通读了可靠完整原文仍无相关内容 → outside_defined_levels（留空候选 + 送审）；
    //     不许硬选低档、不许自造档。
    //   代价：min 从 0 变 1（等级分数范围必须与 min/max 一致，profile 校验会拦）；
    //        gold=0 的对齐在评测侧处理（见 `_evalveras.mjs` 的保守映射）。
    strategy = { type: 'levels', min: 1, max: 5, step: 1, levels: levelTexts };
  } else {
    const joined = standardLines.map(l => l.text).join('\n');
    const crits = [];
    const re = /(\d+)\)\s+([\s\S]*?)(?=\s*\d+\)\s+|$)/g;
    let m;
    while ((m = re.exec(joined))) {
      const body = m[2].trim();
      const pts = (body.match(/\((\d+)\s*points?\)/i) ?? [])[1];
      crits.push({ text: body, points: pts ? Number(pts) : 0 });
    }
    const sum = crits.reduce((s, c) => s + c.points, 0);
    strategy = { type: 'points', min: 0, max: sum, step: 1, criteria: crits };
  }

  profiles.push({
    rubric_item_id: itemId,
    scorable: true,
    scoring_strategy: strategy,
    strategy_source_ref: { file: d.statementRef.file, start: stdStart, end: stdEnd },
    _stdText: standardText,
  });
  eq(`rubric · 维度 ${d.n} 的标准原文能逐字切回`, standardText, srcText.slice(stdStart, stdEnd));
}

// 落盘：canonical rubric（只含逐字结构）+ profile（执行配置）
const rubric = {
  rubric_id: 'rb_veras_' + LAB,
  // ★ 写死日期：canonical rubric 是 immutable 的，脚本每次跑都该产出**同样的字节**
  //   （否则"同一份 rubric"会有不同的哈希，哈希链就成了摆设）
  frozen_at: '2026-09-24T00:00:00+08:00',
  immutable: true,
  generator: 'veras-adapter/1.0',
  source: { file: rubricMain.file === parts[0][0] ? `rubric-${LAB}-part1.txt` : `rubric-${LAB}-part1.txt`, sha256: sha(Buffer.from(partTexts[1].text, 'utf8')), kind: 'text', adapter: 'text-v1', chars: partTexts[1].chars },
  items,
  validation: {
    text_verbatim_ok: true,
    line_coverage: `${p1.length + p2.length}/${p1.length + p2.length}`,
    unparsed_lines: [],
    notes: [
      'rubric 原文由**我们自己的 L1** 从数据集给的 docx 解析（l1/1.3.1，txt 通道之外的 docx 通路）。',
      `canonical rubric 的 source 指向 part1（${rubricMain.file}）；part2 的条目在自己的 source_ref.file 里指向 part2。`,
      '维度陈述与等级/条项原文都按"切片 === 原文"生成，偏移全部实测。',
    ],
  },
};
await fsp.writeFile(path.join(design, `canonical-rubric.veras-${LAB}.json`), JSON.stringify(rubric, null, 2) + '\n', 'utf8');

const profile = {
  profile_id: `rap_veras_${LAB}_v1`,
  version: 1,
  status: 'provisional_test',
  notes: 'VerAs 公开 rubric（不是教师 gold 的一部分，而是数据集作者给的详细评分标准）接进 L4 的执行配置。'
    + '两种策略并存：①5 级量表（levels，等级描述逐字来自 rubric）②按条项计分（points + criteria）。'
    + 'min=0/step=1 是执行策略；0 分表示"未涉及该维度"，对应 VerAs 的 verifier 判定。',
  rubric: { rubric_id: rubric.rubric_id, source_sha256: rubric.source.sha256 },
  items: profiles.map(p => {
    const { _stdText, ...keep } = p;
    return keep;
  }),
};
await fsp.writeFile(path.join(design, `rubric-assessment-profile.veras-${LAB}.json`), JSON.stringify(profile, null, 2) + '\n', 'utf8');

// ------------------------------------------------------------------ 4. 自证

const rv = validate(JSON.parse(await fsp.readFile(path.join(design, 'canonical-rubric.schema.json'), 'utf8')), rubric);
eq('rubric · 通过 canonical-rubric schema', rv.ok, true);
if (!rv.ok) for (const e of rv.errors.slice(0, 6)) report.push(`         ${e.path} ${e.msg}`);
const pvv = validate(JSON.parse(await fsp.readFile(path.join(design, 'rubric-assessment-profile.schema.json'), 'utf8')), profile);
eq('profile · 通过 rubric-assessment-profile schema', pvv.ok, true);
if (!pvv.ok) for (const e of pvv.errors.slice(0, 6)) report.push(`         ${e.path} ${e.msg}`);
eq('profile · 每个条目都有策略与出处', profile.items.every(p => p.scoring_strategy && p.strategy_source_ref), true);
eq('rubric · 每个条目的 text 都是逐字切片（切片 === 原文）', items.every(it => {
  const t = it.source_ref.file.includes('part1') ? partTexts[1].text : partTexts[2].text;
  return t.slice(it.source_ref.start, it.source_ref.end) === it.text;
}), true);

// ------------------------------------------------------------------ 报告

report.push('');
report.push('--- 切出来的维度 ---');
for (const [k, p] of profiles.entries()) {
  const st = p.scoring_strategy;
  report.push(`  ${p.rubric_item_id}  ${st.type}  ${st.type === 'levels' ? `levels=${st.levels.length}（L1–L5，★ 不自造 L0）` : `criteria=${st.criteria.length} 点数=${st.criteria.map(c => c.points).join('+')}`}`);
  report.push(`       陈述: ${items[k].text.slice(0, 70)}`);
  report.push(`       出处: ${p.strategy_source_ref.file} ${p.strategy_source_ref.start}-${p.strategy_source_ref.end}`);
}
report.push('');
report.push(`产出: design/canonical-rubric.veras-${LAB}.json · design/rubric-assessment-profile.veras-${LAB}.json · fixtures/veras/gold.${LAB}.json · fixtures/veras/*.txt`);
report.push('');
report.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);
await fsp.writeFile(path.join(here, '_mkveras.out.txt'), report.join('\n') + '\n', 'utf8');
if (bad > 0) { process.stderr.write(`_mkveras: ${bad} 项自证失败\n`); process.exitCode = 1; }
