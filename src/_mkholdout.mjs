// _mkholdout.mjs —— 建"未用于调规则的验证集"（holdout）
//
// ★ 为什么必须单独一套（Yukii 2026-09-24 的硬约束）：
//   已经跑过的 8 份**被用于诊断**（逐维结果被查看、机制被分析、规则被反推）。
//   用它们再报"改动后准确率变好了"是**自己给自己打分** —— 规则就是从这些样本上长出来的。
//   所以：**任何规则改动只能在从未查看过的样本上验证。**
//
// ★ 抽样口径（修掉 _mkveras 的两个问题）：
//   ① **按 status 分层**（single / common / discussion）—— common 与 discussion 是数据集里
//      可信度最高的两组（多评分者 / 研究者共识），必须各有样本；
//      `_mkveras --stratified` 当年是从全部 1078 份按 rater 分档，**没保证覆盖这两组**（实测 20 份里
//      只有 4 份 common、0 份 discussion）→ 这里改成显式按 status 分层。
//   ② **覆盖全分数档**：每层内再按 gold 总分分低/中/高三档 —— 之前 8 份全落在 11–22/35
//      （低分档），高分档一份没有。
//
// ★ 隔离：验证集写到 `fixtures/veras/holdout/`，**与 out/ 分开**，
//   并在文件里写明"这批样本在规则冻结前不得查看逐维结果"。
//
// 用法: node _mkholdout.mjs --lab pendulum --n 24 --seed veras-holdout-v1

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = argOf('--lab', 'pendulum');
const N = Number(argOf('--n', 24));
const SEED = argOf('--seed', 'veras-holdout-v1');

const OUTDIR = path.join(root, 'fixtures/veras');
const RAW = path.join(OUTDIR, '.raw/extracted/passonneau-et-al-reliable-rubric-based-assessment-of-physics-lab-reports-data-for-machine-learning-2022');
const HOLD = path.join(OUTDIR, 'holdout');

const csvName = LAB === 'pendulum' ? 'PendulumLab.csv' : 'NewtonLab.csv';
const csv = await fsp.readFile(path.join(RAW, csvName), 'utf8');
const parseCsv = l => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') { q = !q; continue; }
    if (c === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
};
const lines = csv.split(/\r?\n/).filter(Boolean);
const hdr = parseCsv(lines[0]);
const ci = Object.fromEntries(hdr.map((h, k) => [h, k]));
const dimIds = hdr.filter(h => /^Dimension \d+$/.test(h)).map(h => Number(h.split(' ')[1]));
const maxTotal = dimIds.length * 5;

const all = lines.slice(1).map(parseCsv).map(r => ({
  id: r[ci.ID],
  status: r[ci.status],
  source: r[ci.source],
  dims: dimIds.map(d => Number(r[ci['Dimension ' + d]])),
  ta: Number(r[ci.RescaledTA]),
  rater: Number(r[ci.RescaledRater]),
})).filter(r => r.id);

// ★★ 排除集：所有已经跑过或看过的样本（dev 池里的全部 + 已产出的产物）。
//   ★ 2026-09-24 修（真实事故的教训）：排除集过去只以 `count` 形式记录，而**名单本体只存在于
//   `gold.<lab>.json` 里**。我误跑一次 `_mkveras`（PICK 默认 1）就把 gold 覆盖成 1 份，
//   名单随之消失 —— 重抽的 dev 池于是与 holdout 出现 3 份交集。
//   → 现在把**排除的 id 列表**连同 count 一起写进 holdout 清单（永久留痕）。
//   → 同时 `_mkveras.mjs` 反过来读这份清单，强制 dev ∩ holdout = ∅（机制保证，不靠人记）。
const used = new Set(JSON.parse(await fsp.readFile(path.join(OUTDIR, `gold.${LAB}.json`), 'utf8')).reports.map(r => r.id));
const produced = (await fsp.readdir(path.join(OUTDIR, 'out')).catch(() => []))
  .filter(f => f.endsWith('.assessment.json')).map(f => f.replace('.txt.assessment.json', ''));
for (const p of produced) used.add(p);
const excludedIds = [...used].sort();

const pool = all.filter(r => !used.has(r.id));

// ------------------------------------------------------------------ 确定性随机（可复现，不依赖 Math.random）
const seeded = str => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
};
const rnd = seeded(SEED);
const shuffle = a => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

// ------------------------------------------------------------------ 按 status 分层 + 层内按分数档分层
const groups = { single: [], common: [], discussion: [] };
for (const r of pool) groups[r.status]?.push(r);

// 每层配额：discussion 只有 12 份且最珍贵 → 全取（上限 6）；common 次之；single 补足
const quota = { discussion: Math.min(6, groups.discussion.length), common: 0, single: 0 };
quota.common = Math.min(8, groups.common.length);
quota.single = Math.max(0, N - quota.discussion - quota.common);

const takeFrom = (rs, k) => {
  // 层内按 gold 总分排序，等距抽取 → 覆盖低/中/高三档（不是随机扎堆）
  const sorted = [...rs].sort((a, b) => a.dims.reduce((x, y) => x + y, 0) - b.dims.reduce((x, y) => x + y, 0));
  if (k >= sorted.length) return sorted;
  const out = [];
  for (let i = 0; i < k; i++) out.push(sorted[Math.round(i * (sorted.length - 1) / (k - 1 || 1))]);
  return [...new Map(out.map(x => [x.id, x])).values()];
};

const picked = [
  ...takeFrom(groups.discussion, quota.discussion),
  ...takeFrom(groups.common, quota.common),
  ...takeFrom(shuffle(groups.single), quota.single),
];

// 断言：不重叠、覆盖三组
const bad = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); };
eq('holdout · 与已用样本零重叠', picked.every(p => !used.has(p.id)), true);
eq('holdout · 覆盖 single', picked.some(p => p.status === 'single'), true);
eq('holdout · 覆盖 common', picked.some(p => p.status === 'common'), true);
eq('holdout · 覆盖 discussion', picked.some(p => p.status === 'discussion'), true);
eq('holdout · 数量正确', picked.length, N);

await fsp.mkdir(HOLD, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
const holdout = {
  dataset: { doi: '10.26208/BWE2-BR31', lab: LAB, csv: csvName, csv_sha256: sha(Buffer.from(csv, 'utf8')), dims: dimIds.length, max_per_dim: 5, max_total: maxTotal },
  kind: 'holdout_for_validation_only',
  rule: '★ 本集样本在规则冻结前**不得查看逐维结果**。任何规则改动只能在本集上报指标，'
    + '禁止用已参与诊断的样本（gold.pendulum.json 里的那批）自证。',
  seed: SEED,
  excluded: { count: used.size, ids: excludedIds, reason: '已跑过或已参与诊断（名单留痕：dev 池与 holdout 必须不相交）' },
  allocation: { single: quota.single, common: quota.common, discussion: quota.discussion },
  reports: picked.map(x => ({ id: x.id, status: x.status, source: x.source, dims: x.dims, ta_rescaled: x.ta, rater_rescaled: x.rater })),
};
await fsp.writeFile(path.join(HOLD, `holdout.${LAB}.json`), JSON.stringify(holdout, null, 2) + '\n', 'utf8');

for (const p of picked) {
  const t = await fsp.readFile(path.join(RAW, 'data', LAB, p.id + '.txt'), 'utf8');
  await fsp.writeFile(path.join(HOLD, p.id + '.txt'), t, 'utf8');
}

console.log(`\n排除已用样本 ${used.size} 份；池中剩余 ${pool.length} 份`);
console.log(`分层配额：discussion ${quota.discussion} / common ${quota.common} / single ${quota.single}`);
console.log(`\n选中 ${picked.length} 份：`);
for (const p of picked) console.log(`  ${p.id.padEnd(24)} ${p.status.padEnd(11)} gold=${String(p.dims.reduce((a, b) => a + b, 0)).padStart(2)}/${maxTotal}`);
const dist = {};
for (const p of picked) dist[`${p.status}`] = (dist[`${p.status}`] ?? 0) + 1;
console.log('\nstatus 分布:', JSON.stringify(dist));
const scoreDist = {};
for (const p of picked) { const t = p.dims.reduce((a, b) => a + b, 0); scoreDist[t] = (scoreDist[t] ?? 0) + 1; }
console.log('总分分布:', JSON.stringify(scoreDist));
if (bad.length) { console.error(`\n${bad.length} FAILED`); process.exitCode = 1; } else console.log('\n全部 PASS');
