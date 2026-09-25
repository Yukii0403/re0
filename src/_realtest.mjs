// _realtest.mjs —— 用真实 PDF / docx 跑 L1，把结果落到 _realtest.out.txt
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './l1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(here, '..', 'fixtures');
const outDir = path.join(fx, 'out');
const report = path.join(here, '_realtest.out.txt');
await fs.mkdir(outDir, { recursive: true });

const out = [];
const produced = [];
const flush = async () => fs.writeFile(report, out.join('\n') + '\n', 'utf8');

for (const f of ['report.pdf', 'report-2col.pdf', 'report.docx']) {
  const src = path.join(fx, f);
  out.push(`================ ${f} ================`);
  try {
    await fs.access(src);
  } catch {
    out.push('SKIP: 夹具不存在');
    out.push('');
    await flush();
    continue;
  }
  try {
    const t0 = Date.now();
    const r = await run(src, outDir);
    const ms = Date.now() - t0;
    out.push(`OK  ${ms}ms  chars=${r.chars} entries=${r.entries}`);
    out.push(`产出 = ${path.basename(r.textFile)} + ${path.basename(r.indexFile)}`);
    produced.push(r.textFile, r.indexFile);
    out.push(`warnings = ${JSON.stringify(r.warnings)}`);
    out.push(`verify   = ${JSON.stringify(r.check)}`);
    out.push(`coverage = ${JSON.stringify(r.coverage)}`);

    const idx = JSON.parse(await fs.readFile(r.indexFile, 'utf8'));
    const fullText = await fs.readFile(r.textFile, 'utf8');
    const byType = {};
    for (const e of idx.entries) byType[e.type] = (byType[e.type] || 0) + 1;
    out.push(`类型分布 = ${JSON.stringify(byType)}`);
    out.push(`表格还原 = ${idx.tables.length} 张  (带 cell_breaks 的条目 ${idx.entries.filter(e => e.cell_breaks).length} 个)`);
    for (const t of idx.tables) {
      out.push(`  ${t.id}  ${t.entry_range}  header=${t.header_detected}  cols=${t.column_count}  truncated=${t.truncated}${t.truncated_at ? `@${t.truncated_at}` : ''}  caption=${t.caption_entry ?? '-'}  key_query_safe=${t.key_query_safe}  列边界来源=${t.cell_split_source}`);
      if (t.columns) out.push(`     列头 | ${t.columns.map(c => `${c.text}@${c.start}`).join('  |  ')}`);
      for (const row of t.rows) out.push(`     行   | ${row.cells.map(c => `${c.text}@${c.start}`).join('  |  ')}`);
      // 单元格必须都能逐字切回正文 —— 与全项目同一条断言
      const cells = [...(t.columns ?? []), ...t.rows.flatMap(x => x.cells)];
      const badCells = cells.filter(c => fullText.slice(c.start, c.end) !== c.text).length;
      out.push(`     单元格可逐字回溯: ${badCells === 0 ? 'OK' : `不一致 ${badCells} 个`}`);
      if (badCells) process.exitCode = 1;
      // 按 (列头, 行标签) 能不能唯一确定一个值
      if (t.columns) {
        const ci = t.columns.findIndex(c => c.text === '验证准确率');
        const row = t.rows.find(x => x.label === '+ attention');
        out.push(`     键值查询 (验证准确率, + attention) = ${ci >= 0 && row ? JSON.stringify(row.cells[ci]?.text) : '列头或行标签不在 → 查不到（如实报告）'}`);
      }
    }

    out.push(`--- 索引条目 ---`);
    for (const e of idx.entries.slice(0, 70)) {
      out.push(`  [${String(e.type).padEnd(9)}] p${e.page ?? '-'} num=${e.num ?? '-'} tbl=${e.table_id ?? '-'} ${JSON.stringify(e.text.slice(0, 46))}`);
    }
    if (idx.entries.length > 70) out.push(`  ... 另有 ${idx.entries.length - 70} 条`);

    const lines = fullText.split('\n');
    out.push(`--- 抽取文本（共 ${lines.length} 行，前 45 行）---`);
    lines.slice(0, 45).forEach((l, i) => out.push(`  ${String(i).padStart(3)}| ${l.slice(0, 88)}`));
  } catch (e) {
    out.push(`ERROR: ${e && e.message}`);
    out.push(String(e && e.stack).slice(0, 1500));
  }
  out.push('');
  await flush();
}

// 产出文件名必须互不冲突（report.pdf 与 report.docx 不能都写 report.txt）
const uniq = new Set(produced);
out.push(`产出文件去重: ${produced.length} 个路径 / ${uniq.size} 个唯一 ${produced.length === uniq.size ? 'OK' : '冲突!'}`);
if (produced.length !== uniq.size) process.exitCode = 1;

const missing = [];
for (const f of produced) await fs.access(f).catch(() => missing.push(path.basename(f)));
out.push(`产出文件都存在: ${missing.length === 0 ? 'OK' : '缺失 ' + missing.join(',')}`);
if (missing.length) process.exitCode = 1;

await flush();
