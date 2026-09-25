// _mkrubric.mjs —— 从「自由文本 rubric」生成 design/canonical-rubric.example.json
//
// 这份脚本要证明的核心机制（也是四种输入里最难的一种）：
//   1. 结构标注只给「哪一行归到哪个父项、id 是什么」—— 模拟 LLM 只输出**结构引用**
//   2. 文本一律由系统从原件逐字切出（模型没有任何机会改写 rubric）
//   3. 层级必须记录判据 derived_by
//   4. 行覆盖：未归入的行必须显式列出，不能静默丢弃
//   5. 分值只做算术一致性检查：解析只在校验里用，结果不写回、不参与评分、不重新分配
// 用法: node _mkrubric.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const design = path.join(here, '..', 'design');
// 默认跑 design/rubric.example.txt（那份带"分值对不上"的真实错误）；
// 真实样本测试可以指定 --in / --ann / --out / --id，那几条示例专属断言会自动跳过。
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const isExample = !argOf('--in');
const SRC = argOf('--in') ?? path.join(design, 'rubric.example.txt');
const OUT = argOf('--out') ?? path.join(design, 'canonical-rubric.example.json');
const ANN = argOf('--ann');
const RUBRIC_ID = argOf('--id') ?? 'rb_lab2_v1';

const raw = await fs.readFile(SRC, 'utf8');
const sha = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
const lines = raw.split('\n');
const lineStart = [];
{
  let off = 0;
  for (const ln of lines) { lineStart.push(off); off += ln.length + 1; }
}

// ---- 结构标注：模型只给「第几行 → 哪个 id、父项是谁」，不给文本
const annotation = ANN
  ? JSON.parse(await fs.readFile(ANN, 'utf8'))
  : [
    { id: 'R1', line: 1, parent: null },
    { id: 'R1.1', line: 2, parent: 'R1' },
    { id: 'R1.2', line: 3, parent: 'R1' },
    { id: 'R1.3', line: 4, parent: 'R1' },
    { id: 'R2', line: 5, parent: null },
    { id: 'R2.1', line: 6, parent: 'R2' },
    { id: 'R2.2', line: 7, parent: 'R2' },
    { id: 'R3', line: 8, parent: null },
    { id: 'R3.1', line: 9, parent: 'R3' },
    { id: 'R3.2', line: 10, parent: 'R3' },
  ];

const SCORE = /[（(]\s*([0-9]+(?:\.[0-9]+)?)\s*分\s*[）)]/;

const items = annotation.map((a, i) => {
  const text = lines[a.line];                                  // 逐字切出，不经模型
  const start = lineStart[a.line];
  const end = start + text.length;
  const m = text.match(SCORE);
  return {
    id: a.id,
    parent: a.parent,
    depth: a.id.split('.').length - 1,
    order: i + 1,
    text,
    score_raw: m ? `${m[1]} 分` : null,
    source_ref: { file: path.basename(SRC), sha256: sha, page: null, row: null, start, end },
    derived_by: 'numbering',
    children: annotation.filter(b => b.parent === a.id).map(b => b.id),
  };
});

const coveredLines = new Set(annotation.map(a => a.line));
const unparsed = lines
  .map((t, i) => ({ t, i }))
  .filter(x => x.t.trim() && !coveredLines.has(x.i))
  .map(x => x.t);

const num = s => (s ? Number((s.match(/[0-9]+(?:\.[0-9]+)?/) || [NaN])[0]) : NaN);
const scoreConsistency = items
  .filter(it => it.children.length)
  .map(it => {
    const p = num(it.score_raw);
    const sum = it.children.reduce((n, cid) => n + num(items.find(x => x.id === cid).score_raw), 0);
    const comparable = Number.isFinite(p) && it.children.every(cid => Number.isFinite(num(items.find(x => x.id === cid).score_raw)));
    return {
      rubric_item_id: it.id,
      parent_score: it.score_raw,
      children_sum: comparable ? `${sum} 分` : null,
      ok: comparable ? p === sum : null,
      ...(comparable && p !== sum ? { note: '父项分值与子项之和不一致，交教师核对；系统不自动改正' } : {}),
      ...(comparable ? {} : { note: '原件未给足分值，无法比较' }),
    };
  });

const textVerbatimOk = items.every(it => raw.slice(it.source_ref.start, it.source_ref.end) === it.text);

const out = {
  rubric_id: RUBRIC_ID,
  frozen_at: '2026-09-22T22:55:00+08:00',
  immutable: true,
  generator: 'rubric-adapt/text-v1',
  source: {
    file: path.basename(SRC),
    sha256: sha,
    kind: 'text',
    adapter: 'text-v1',
    chars: raw.length,
  },
  items,
  validation: {
    text_verbatim_ok: textVerbatimOk,
    line_coverage: `${coveredLines.size}/${lines.filter(t => t.trim()).length}`,
    unparsed_lines: unparsed,
    score_consistency: scoreConsistency,
    notes: [
      '文本一律由系统从原件逐字切出；结构标注（哪一行归哪个父项）由模型给出，模型不产生任何 rubric 文本',
      '分值解析只用于本区块的算术一致性检查，解析结果不写回、不参与评分、不做重新分配',
    ],
  },
};

await fs.writeFile(OUT, JSON.stringify(out, null, 2), 'utf8');

// ------------------------------------------------------------------ 自证
const checks = [
  ['每条 item.text 都能按 source_ref 逐字切回原件', textVerbatimOk, true],
  ['行覆盖 + 未归入行 = 非空总行数',
    coveredLines.size + unparsed.length === lines.filter(t => t.trim()).length, true],
  ['children 与 parent 互为逆关系',
    items.every(i => i.children.every(c => items.find(x => x.id === c).parent === i.id)), true],
  ['immutable 恒为 true', out.immutable === true, true],
  // 下面三条是 design/rubric.example.txt 那份**故意带错**的示例专属断言
  ...(isExample ? [
    ['父项分值 = 子项之和（不含被显式标出的不一致）',
      scoreConsistency.filter(c => c.ok === false).length === 1, true],
    ['不一致的那条被显式标出且没被自动改正',
      scoreConsistency.filter(c => c.ok === false).every(c => c.note && items.find(i => i.id === c.rubric_item_id).score_raw === c.parent_score), true],
    ['未归入的行被显式列出（不静默丢弃）', unparsed.length === 1, true],
    ['层级深度正确', items.filter(i => i.depth === 0).length === 3 && items.filter(i => i.depth === 1).length === 7, true],
  ] : [
    ['（自定义输入）层级至少两层且父项都被引用',
      items.some(i => i.depth === 1) && items.filter(i => i.depth === 1).every(i => i.parent), true],
  ]),
];

const rep = [];
rep.push(`输入: design/${path.basename(SRC)}  (${raw.length} 字符, ${lines.filter(t => t.trim()).length} 非空行)`);
rep.push(`输出: design/${path.basename(OUT)}`);
rep.push(`rubric sha256=${sha.slice(0, 16)}…`);
rep.push('');
rep.push('--- canonical rubric（层级：大评分点 → 子评分点）---');
for (const it of items) {
  rep.push(`  ${'  '.repeat(it.depth)}${it.id.padEnd(6)} depth=${it.depth} ${String(it.score_raw ?? '-').padEnd(7)} ${JSON.stringify(it.text)}  判据=${it.derived_by}`);
}
rep.push('');
rep.push('--- 一致性校验（只报告，不修改）---');
for (const c of scoreConsistency) {
  rep.push(`  ${c.rubric_item_id} 父=${String(c.parent_score).padEnd(7)} 子项和=${String(c.children_sum).padEnd(7)} ok=${c.ok}${c.note ? '  ← ' + c.note : ''}`);
}
rep.push(`  行覆盖=${out.validation.line_coverage}  未归入行=${JSON.stringify(unparsed)}`);
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

await fs.writeFile(path.join(here, '_mkrubric.out.txt'), rep.join('\n') + '\n', 'utf8');
