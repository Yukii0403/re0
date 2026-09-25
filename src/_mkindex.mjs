// _mkindex.mjs —— 由 design/document-index.example.txt 生成 document-index.example.json
//
// 为什么要有这个脚本：**偏移必须实测，不能手算**（手算过两次，两次都错一位）。
// 示例是发布出去的契约样板，它必须自洽 —— 所以让它由脚本算出来，而不是靠眼睛。
//
// 顺带让示例覆盖到表格行列还原：正文里有 4 行真实形状的表格
//（列头「配置 / 验证准确率 / 训练时长(min)」+ 3 行数据），detectTables 会把它还原成可查询的对象。
//
// 依赖顺序：l1 无需先跑（本脚本只读示例 .txt）
// 用法: node _mkindex.mjs

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, verifyTables, detectTables, splitCells } from './l1.mjs';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const design = path.join(here, '..', 'design');
const TXT = path.join(design, 'document-index.example.txt');
const OUT = path.join(design, 'document-index.example.json');

const txt = await fsp.readFile(TXT, 'utf8');

// 类型/编号/层级/页码是**示例给定的语义**（没有 PDF 在后面，无法由规则推出）；
// 偏移与表格结构一律由脚本实测。
const SPEC = [
  { text: '实验二 模型调参与分析', type: 'heading', num: null, level: 1, page: 1 },
  { text: '3 实验结果', type: 'heading', num: '3', level: 1, page: 3 },
  { text: '本实验采用交叉熵损失衡量模型收敛情况。', type: 'paragraph', num: null, level: null, page: 3 },
  { text: 'L = -1/N * sum(y_i * log(y_hat_i))', type: 'formula', num: null, level: null, page: 3 },
  { text: '(1)', type: 'formula', num: '1', level: null, page: 3 },
  { text: 'def train(model, loader, lr):', type: 'code', num: null, level: null, page: 3 },
  { text: '    for x, y in loader:', type: 'code', num: null, level: null, page: 3 },
  { text: '图 3 不同学习率下的验证损失曲线', type: 'figure', num: '3', level: null, page: 3 },
  { text: '表 4 各模块消融对比', type: 'table', num: '4', level: null, page: 4 },
  { text: '配置  验证准确率  训练时长(min)', type: 'paragraph', num: null, level: null, page: 4 },
  { text: 'baseline  0.812  6.4', type: 'paragraph', num: null, level: null, page: 4 },
  { text: '+ attention  0.847  7.1', type: 'paragraph', num: null, level: null, page: 4 },
  { text: '+ attention + 数据增强  0.861  9.8', type: 'paragraph', num: null, level: null, page: 4 },
];

let cursor = 0;
const entries = SPEC.map((s, i) => {
  const start = txt.indexOf(s.text, cursor);   // 按顺序推进游标：重复行也不会错位
  if (start < 0) throw new Error(`示例正文里找不到这一行: ${JSON.stringify(s.text)}`);
  const end = start + s.text.length;
  cursor = end;
  return { id: 'e' + String(i + 1).padStart(4, '0'), ...s, lines: 1, start, end };
});

const { tables, owner } = detectTables(txt, entries);
for (const e of entries) e.table_id = owner.get(e.id) ?? null;

const index = {
  doc: {
    name: '实验二_模型调参与分析.pdf',
    kind: 'pdf',
    sha256: '9f2c1b7e4a1d5c03b8e6472a0f19d3c5e2b704168fb93a1cd0e5f27a4b6c8d31',
    chars: txt.length,
    text_file: 'document-index.example.txt',
    generator: 'l1/1.3.0',
    warnings: [],
    line_coverage: `${entries.reduce((n, e) => n + e.lines, 0)}/${txt.split('\n').length}`,
    tables: tables.length,
  },
  tables,
  entries,
};

const body = JSON.stringify(index, null, 2);
await fsp.writeFile(OUT, body, 'utf8');

// ------------------------------------------------------------------ 自证
const schema = JSON.parse(await fsp.readFile(path.join(design, 'document-index.schema.json'), 'utf8'));
const vr = validate(schema, index);
const v = verify(txt, entries);
const vt = verifyTables(txt, tables);
const allCells = (t, acc = []) => {
  for (const c of t.columns ?? []) acc.push(c);
  for (const r of t.rows) acc.push(...r.cells);
  return acc;
};

const checks = [
  ['示例通过真正的 schema 校验', vr.ok, true],
  ['每条 text 都能按 start:end 在正文里逐字切出', v.substringOk, true],
  ['offset 单调、不越界', v.monotonic && v.inBounds, true],
  ['chars 字段与正文长度一致', index.doc.chars, txt.length],
  ['lines 合计等于正文行数', entries.reduce((n, e) => n + e.lines, 0), txt.split('\n').length],
  ['识别出 1 张表', tables.length, 1],
  ['★ 每个单元格也能按 start:end 逐字切回正文', vt.ok, true],
  ['表格：列头被识别出来（首行不含数字 → 判为列头）',
    tables[0]?.header_detected === true && tables[0].columns.map(c => c.text).join('|'), '配置|验证准确率|训练时长(min)'],
  ['表格：3 行数据，行标签就是第一个单元格',
    tables[0]?.rows.map(r => r.label).join('|'), 'baseline|+ attention|+ attention + 数据增强'],
  ['表格：列数一致、无截断',
    tables[0]?.column_count === 3 && tables[0]?.truncated === false && tables[0]?.truncated_at === null, true],
  ['表格：挂在紧邻其前的「表 4 …」条目上',
    tables[0]?.caption_entry === 'e0009' && entries.find(e => e.id === 'e0009')?.type === 'table', true],
  ['表格：所属条目都带上了 table_id，其余为 null',
    entries.filter(e => e.table_id === 't0001').length === 4 &&
    entries.filter(e => e.table_id === null).length === 9, true],
  ['★ 能按 (列头, 行标签) 唯一确定一个单元格 —— 这正是「选对对象」能机械化的地方',
    (() => {
      const t = tables[0];
      const ci = t.columns.findIndex(c => c.text === '验证准确率');
      const row = t.rows.find(r => r.label === '+ attention');
      return ci === 1 && row.cells[ci].text === '0.847' && txt.slice(row.cells[ci].start, row.cells[ci].end) === '0.847';
    })(), true],
  ['单格切分：单元格内部单空格不当作列边界（"+ attention + 数据增强" 是一个标签）',
    splitCells(0, '+ attention + 数据增强  0.861  9.8').map(c => c.text).join('|'), '+ attention + 数据增强|0.861|9.8'],
];

const rep = [];
rep.push(`由 design/document-index.example.txt（${txt.length} 字符 / ${txt.split('\n').length} 行）生成`);
rep.push(`产出 design/document-index.example.json（${body.length} 字节）· ${entries.length} 条目 · ${tables.length} 张表`);
rep.push('');
rep.push('--- 条目（偏移全部实测）---');
for (const e of entries) rep.push(`  ${e.id} [${String(e.type).padEnd(9)}] p${e.page} ${String(e.start).padStart(4)}-${String(e.end).padStart(4)}  ${JSON.stringify(e.text.slice(0, 40))}  table=${e.table_id ?? '-'}`);
rep.push('');
rep.push('--- 表格还原 ---');
for (const t of tables) {
  rep.push(`  ${t.id}  caption=${t.caption_entry ?? '-'}  ${t.entry_range}  header=${t.header_detected}  cols=${t.column_count}  truncated=${t.truncated}${t.truncated_at ? `@${t.truncated_at}` : ''}`);
  rep.push(`    列头: ${t.columns.map(c => `"${c.text}"@${c.start}`).join('  ')}`);
  for (const r of t.rows) {
    rep.push(`    行  : ${r.cells.map(c => `${JSON.stringify(c.text)}@${c.start}`).join('  ')}  label=${JSON.stringify(r.label)}`);
  }
}
rep.push('');
rep.push('--- 自证 ---');
let bad = 0;
for (const [name, got, want] of checks) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    if (name.includes('schema')) for (const e of vr.errors.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
    else rep.push(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
}
rep.push('');
rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

await fsp.writeFile(path.join(here, '_mkindex.out.txt'), rep.join('\n') + '\n', 'utf8');
if (bad > 0) {
  process.stderr.write(`_mkindex: ${bad} 项自证失败\n`);
  process.exitCode = 1;
}
