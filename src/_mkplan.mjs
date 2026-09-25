// _mkplan.mjs —— 生成 design/retrieval-plan.example.json（独立存储的 retrieval plan）
//
// plan 独立成文件，不嵌进 evidence：它是**版本化的工作物**，每一版只应存在一份权威副本。
// sha256 = 本文件字节的哈希，evidence 侧据此绑定「用的是哪一版」。
//
// facet 用三个正交维度描述（这是 Yukii 的修正，替换掉早期把三者混成一个 kind 的做法）：
//   form     语义形式：要找的是一句什么样的话
//   modality 模态：这段材料以什么形态存在（决定走哪些结构通道）
//   channels 检索通道：跑哪几条网（显式声明，不由代码隐式推导）
// 用法: node _mkplan.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const design = path.join(here, '..', 'design');
const RUBRIC = path.join(design, 'canonical-rubric.example.json');
const OUT = path.join(design, 'retrieval-plan.example.json');

const cr = JSON.parse(await fs.readFile(RUBRIC, 'utf8'));

// facet 定义表：[id, text, form, modality[], channels[]]
const FACETS = {
  R1: [['F1', '方案设计的整体表述', 'narrative', ['text'], ['llm:semantic']]],
  'R1.1': [['F1', '实验目标的陈述', 'narrative', ['text'], ['llm:semantic']]],
  'R1.2': [
    ['F1', '自变量与因变量的说明', 'narrative', ['text'], ['llm:semantic']],
    ['F2', '控制变量的列举', 'value', ['text', 'table'], ['rule:numeric', 'llm:semantic']],
  ],
  'R1.3': [
    ['F1', '器材清单', 'value', ['text', 'table'], ['rule:numbering', 'rule:numeric', 'llm:semantic']],
    ['F2', '操作步骤描述', 'procedure', ['text'], ['rule:numbering', 'llm:semantic']],
  ],
  R2: [['F1', '结果与分析的整体表述', 'narrative', ['text'], ['llm:semantic']]],
  'R2.1': [
    ['F1', '结果数值', 'value', ['text', 'table'], ['rule:numeric', 'structure:table', 'llm:semantic']],
    ['F2', '趋势解释', 'narrative', ['text', 'figure'], ['structure:figure', 'llm:semantic']],
    ['F3', '误差来源', 'relation', ['text'], ['rule:relation', 'llm:semantic']],
    ['F4', '异常数据', 'value', ['text', 'table', 'figure'], ['rule:numeric', 'structure:table', 'structure:figure', 'llm:semantic']],
    ['F5', '与理论值的比较', 'relation', ['text', 'table'], ['rule:relation', 'structure:table', 'llm:semantic']],
    ['F6', '结论与数据的关系', 'relation', ['text'], ['rule:relation', 'llm:semantic']],
  ],
  'R2.2': [
    ['F1', '图的编号与标题', 'narrative', ['figure', 'text'], ['rule:numbering', 'structure:figure', 'llm:semantic']],
    ['F2', '表的编号与标题', 'narrative', ['table', 'text'], ['rule:numbering', 'structure:table', 'llm:semantic']],
  ],
  R3: [['F1', '结论与讨论的整体表述', 'narrative', ['text'], ['llm:semantic']]],
  'R3.1': [
    ['F1', '由数据得出的结论性表述', 'relation', ['text'], ['rule:relation', 'llm:semantic']],
    ['F2', '结论处的数据引用', 'relation', ['text', 'table'], ['rule:numeric', 'rule:relation', 'structure:table', 'llm:semantic']],
  ],
  'R3.2': [
    ['F1', '局限与不足的陈述', 'narrative', ['text'], ['llm:semantic']],
    ['F2', '改进方向', 'procedure', ['text'], ['llm:semantic']],
  ],
};

const BLIND = {
  'R1.2': [['合理', '判断性措辞，无法转成可检索的材料面']],
  'R2.1': [
    ['充分', '判断性措辞，原文里不存在一段叫「充分」的材料'],
    ['合理', '判断性措辞，无法转成可检索的材料面'],
  ],
};

const plan = {
  plan_id: 'rp_lab2',
  version: 2,
  batch_id: 'b2026-10-lab2',
  pinned: true,
  generated_at: '2026-09-22T23:20:00+08:00',
  generator: 'l2-r/0.3.0',
  revision_note: 'v2 把 facet 的 kind 拆成语义形式 / 模态 / 检索通道三个维度，并补齐父项 facet',
  rubric_sha256: cr.source.sha256,
  revision_log: [
    { version: 1, at: '2026-09-22T22:50:00+08:00', by: 'l2-r/0.1.0', change: '初版（单维度 kind）' },
    { version: 2, at: '2026-09-22T23:20:00+08:00', by: 'l2-r/0.3.0', change: 'kind 拆成 form / modality / channels 三维；覆盖父项' },
  ],
  items: cr.items.map(it => ({
    rubric_item_id: it.id,
    facets: (FACETS[it.id] ?? []).map(([id, text, form, modality, channels]) => ({ id, text, form, modality, channels })),
    blind_spots: (BLIND[it.id] ?? []).map(([text, reason]) => ({ text, reason })),
  })),
};

const body = JSON.stringify(plan, null, 2);
const sha = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
await fs.writeFile(OUT, body, 'utf8');

// ------------------------------------------------------------------ 自证
const facetCount = plan.items.reduce((n, s) => n + s.facets.length, 0);
const allForms = new Set(['value', 'relation', 'narrative', 'procedure']);
const allMods = new Set(['text', 'table', 'figure', 'formula', 'code']);
const CH = new Set(['rule:numeric', 'rule:relation', 'rule:numbering', 'rule:keyword',
  'structure:table', 'structure:figure', 'structure:formula', 'structure:code', 'llm:semantic']);

const checks = [
  ['plan 覆盖 canonical rubric 的所有条目（含父项）',
    plan.items.length === cr.items.length && cr.items.every(it => plan.items.some(p => p.rubric_item_id === it.id)), true],
  ['每个 facet 都声明了 form / modality / channels 三个维度',
    plan.items.every(s => s.facets.every(f => allForms.has(f.form) && f.modality.length > 0 && f.channels.length > 0)), true],
  ['modality 与 channels 的取值都在枚举内',
    plan.items.every(s => s.facets.every(f => f.modality.every(m => allMods.has(m)) && f.channels.every(c => CH.has(c)))), true],
  ['plan 与 rubric 强绑定（rubric_sha256 = 原件哈希）',
    plan.rubric_sha256 === cr.source.sha256, true],
  ['已版本化 + 批内固定 + 修订留痕',
    plan.version >= 1 && plan.pinned === true && plan.revision_log.length >= 1, true],
  ['sha256 等于写出的文件字节哈希',
    createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex') === sha, true],
];

const rep = [];
rep.push(`输入 design/${path.basename(RUBRIC)}   输出 design/${path.basename(OUT)}`);
rep.push(`plan=${plan.plan_id} v${plan.version}  batch=${plan.batch_id}  pinned=${plan.pinned}`);
rep.push(`rubric_sha256=${plan.rubric_sha256.slice(0, 16)}…  plan sha256=${sha.slice(0, 16)}…`);
rep.push(`条目=${plan.items.length}  facet=${facetCount}`);
rep.push('');
rep.push('--- 维度分布（三个维度各自统计）---');
const cnt = (arr, f) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m].sort().map(([k, n]) => `${k}:${n}`).join('  ');
};
const flat = plan.items.flatMap(s => s.facets);
rep.push(`  form      ${cnt(flat.map(f => f.form), null)}`);
rep.push(`  modality  ${cnt(flat.flatMap(f => f.modality), null)}   （并列计数，可重复）`);
rep.push(`  channels  ${cnt(flat.flatMap(f => f.channels), null)}   （并列计数，可重复）`);
rep.push(`  llm:semantic 覆盖率=${flat.filter(f => f.channels.includes('llm:semantic')).length}/${flat.length}`);
rep.push('');
rep.push('--- 逐条目 ---');
for (const s of plan.items) {
  for (const f of s.facets) {
    rep.push(`  ${s.rubric_item_id.padEnd(6)} ${f.id} ${f.form.padEnd(9)} mod=[${f.modality.join(',')}] ${JSON.stringify(f.text)}`);
    rep.push(`         channels=[${f.channels.join(', ')}]`);
  }
  for (const b of s.blind_spots) rep.push(`  ${s.rubric_item_id.padEnd(6)} × 盲点 ${b.text} —— ${b.reason}`);
}
rep.push('');
rep.push('--- 自证 ---');
let bad = 0;
for (const [name, got, want] of checks) {
  const ok = got === want;
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

await fs.writeFile(path.join(here, '_mkplan.out.txt'), rep.join('\n') + '\n', 'utf8');
if (bad > 0) {
  process.stderr.write(`_mkplan: ${bad} 项自证失败\n`);
  process.exitCode = 1;
}
