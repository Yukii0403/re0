// _pdfprobe.mjs —— 探查 pdfjs 在真实 PDF 上提供的原始信号
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = [];
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const data = new Uint8Array(await fs.readFile(path.join(here, '..', 'fixtures', 'report.pdf')));
const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
out.push(`numPages=${doc.numPages}`);

const page = await doc.getPage(1);
const vp = page.getViewport({ scale: 1 });
out.push(`page1 viewport w=${vp.width} h=${vp.height}`);

const tc = await page.getTextContent();
out.push(`items=${tc.items.length}`);
out.push('--- 前 34 个 item ---');
for (const it of tc.items.slice(0, 34)) {
  out.push(JSON.stringify({
    str: it.str,
    hasEOL: it.hasEOL,
    w: it.width != null ? Math.round(it.width * 100) / 100 : undefined,
    h: it.height != null ? Math.round(it.height * 100) / 100 : undefined,
    font: it.fontName,
    tr: it.transform ? it.transform.map(n => Math.round(n * 100) / 100) : null,
  }));
}

// 同一行的 item 在同一 y 上的 x 分布，看代码缩进能不能靠 x 反推
out.push('');
out.push('--- 按 y 聚行后每行 x 起点与字号 ---');
const rows = new Map();
for (const it of tc.items) {
  if (!it.str || !it.transform) continue;
  const y = Math.round(it.transform[5] / 2) * 2;
  if (!rows.has(y)) rows.set(y, []);
  rows.get(y).push(it);
}
for (const y of [...rows.keys()].sort((a, b) => b - a)) {
  const items = rows.get(y).sort((a, b) => a.transform[4] - b.transform[4]);
  const first = items[0];
  const size = Math.round(Math.hypot(first.transform[2], first.transform[3]) * 10) / 10;
  out.push(`y=${String(y).padStart(4)} x=${first.transform[4].toFixed(1).padStart(6)} size=${String(size).padStart(5)} font=${first.fontName} items=${items.length} eol=${items.filter(i => i.hasEOL).length} :: ${JSON.stringify(items.map(i => i.str).join('').slice(0, 52))}`);
}

await fs.writeFile(path.join(here, '_pdfprobe.out.txt'), out.join('\n') + '\n', 'utf8');
