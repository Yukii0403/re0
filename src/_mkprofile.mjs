// _mkprofile.mjs —— 生成 design/rubric-assessment-profile.<rubric>.json（L4 的执行配置）
//
// 为什么要有这一层：L4 需要「哪些条目可评分 / 怎么给分 / 父项怎么聚合」这些**执行策略**，
// 但它们**不能写回教师 rubric**（rubric 是冻结的评分权威）。所以单开一个可版本化的 profile：
//     rubric(source_sha256) → profile(自身 sha256) → assessment
// 原始 rubric 变 → L2/L3/L4 全失效；profile 变 → 只失效 L4 及以后。
//
// ★ 分值不从天上掉：`max` 必须来自 rubric 原件里写着它的那一处（`strategy_source_ref`），
//   本脚本会断言 `原件.slice(start,end) === 该条目原文`。step 是**执行策略**（这里取 1），
//   不是教师给的 —— 所以它写在 profile 的 notes 里，源头上留痕。
//
// 用法: node _mkprofile.mjs            （默认 CS3223 测试 rubric）
//       node _mkprofile.mjs --rubric design/canonical-rubric.example.json --text design/rubric.example.txt --id rap_example_v1

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');

const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};

const RUBRIC_PATH = path.resolve(root, argOf('--rubric', 'design/canonical-rubric.cs3223-test.json'));
const OUT = path.resolve(root, argOf('--out', 'design/rubric-assessment-profile.cs3223-test.json'));
const PROFILE_ID = argOf('--id', 'rap_cs3223_test_v1');
const STATUS = argOf('--status', 'provisional_test');

const rubric = JSON.parse(await fsp.readFile(RUBRIC_PATH, 'utf8'));
const rubricText = await fsp.readFile(path.join(design, rubric.source.file), 'utf8');
const schema = JSON.parse(await fsp.readFile(path.join(design, 'rubric-assessment-profile.schema.json'), 'utf8'));

const report = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) report.push(`         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};

// 分值：只从 rubric 原件里**逐字切出来**的那段文字里读，不猜
const scoreOf = item => {
  const m = String(item.score_raw ?? '').match(/(\d+)\s*分/);
  return m ? Number(m[1]) : null;
};

const byId = new Map(rubric.items.map(i => [i.id, i]));
const profileItems = [];

for (const it of rubric.items) {
  const isLeaf = (it.children ?? []).length === 0;
  const src = it.source_ref;
  // ★ 出处必须真的能切回原件 —— 切不回来就不许用
  const slice = rubricText.slice(src.start, src.end);
  eq(`profile · ${it.id} 的策略出处能逐字切回 rubric 原件`, slice, it.text);

  if (isLeaf) {
    const max = scoreOf(it);
    eq(`profile · ${it.id} 的分值能从原文读出`, typeof max, 'number');
    profileItems.push({
      rubric_item_id: it.id,
      scorable: true,
      scoring_strategy: { type: 'points', min: 0, max, step: 1 },
      strategy_source_ref: { file: src.file, start: src.start, end: src.end },
    });
  } else {
    profileItems.push({
      rubric_item_id: it.id,
      scorable: false,
      aggregation: { type: 'sum_children', children: [...it.children] },
    });
  }
}

const profile = {
  profile_id: PROFILE_ID,
  version: 1,
  status: STATUS,
  notes: 'L4 的执行配置，**不是**教师 rubric。points 的 max 逐字来自 rubric 原件（见各条 strategy_source_ref）；'
    + 'min=0 与 step=1 是系统执行策略（比赛版取最小步长），不是教师给的，也不回写 rubric。'
    + 'status=provisional_test 表示用的是测试 rubric，拿到教师真 rubric 后另建正式 profile。',
  rubric: { rubric_id: rubric.rubric_id, source_sha256: rubric.source.sha256 },
  items: profileItems,
};

// ---- 自证 ----
eq('profile · 绑定的是 rubric **原件**的 sha256（而不是 canonical json 自身）',
  profile.rubric.source_sha256 === createHash('sha256').update(Buffer.from(rubricText, 'utf8')).digest('hex'), true);
const leafIds = rubric.items.filter(i => (i.children ?? []).length === 0).map(i => i.id);
eq('profile · 可评分叶子数正确', profileItems.filter(i => i.scorable).map(i => i.rubric_item_id), leafIds);
eq('profile · 叶子总分 = 各父项分值之和', profileItems.filter(i => i.scorable).reduce((s, i) => s + i.scoring_strategy.max, 0), 100);
const v = validate(schema, profile);
eq('profile · 通过正式 JSON Schema', v.ok, true);
if (!v.ok) for (const e of v.errors.slice(0, 6)) report.push(`         ${e.path} ${e.msg}`);

const body = JSON.stringify(profile, null, 2) + '\n';
await fsp.writeFile(OUT, body, 'utf8');
report.push('');
report.push(`profile_id=${profile.profile_id}  可评分叶子=${profileItems.filter(i => i.scorable).length}  父项=${profileItems.filter(i => !i.scorable).length}`);
report.push(`产出 ${path.relative(root, OUT).split(path.sep).join('/')}（${body.length} 字节，sha256=${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 16)}…）`);
report.push('');
report.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

await fsp.writeFile(path.join(here, '_mkprofile.out.txt'), report.join('\n') + '\n', 'utf8');
if (bad > 0) { process.stderr.write(`_mkprofile: ${bad} 项自证失败\n`); process.exitCode = 1; }
