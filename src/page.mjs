// page.mjs —— 按需把原件的某一页渲染成 PNG。
// 这是「图形内容」唯一保真的读取通道：文本层里没有图的像素，也没有表格的行列结构。
// 用法: node page.mjs <file.pdf> <pageNo> [outPng] [scale=2]

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function renderPage(file, pageNo, outPng, scale = 2) {
  let pdfjs;
  let createCanvas;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    throw new Error('缺少 pdfjs-dist：' + e.message);
  }
  try {
    ({ createCanvas } = await import('@napi-rs/canvas'));
  } catch (e) {
    throw new Error('缺少 @napi-rs/canvas（页面渲染需要它）：' + e.message);
  }

  const data = new Uint8Array(await fs.readFile(file));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  if (pageNo < 1 || pageNo > doc.numPages) throw new Error(`页号越界：${pageNo} / 共 ${doc.numPages} 页`);

  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  const out = outPng ?? path.join(path.dirname(file), `${path.basename(file)}.p${String(pageNo).padStart(3, '0')}.png`);
  await fs.writeFile(out, canvas.toBuffer('image/png'));
  return { out, page: pageNo, pages: doc.numPages, width: canvas.width, height: canvas.height };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [, , file, pageNo, out, scale] = process.argv;
  if (!file || !pageNo) {
    console.error('用法: node page.mjs <file.pdf> <pageNo> [outPng] [scale=2]');
    process.exit(2);
  }
  renderPage(file, Number(pageNo), out, scale ? Number(scale) : 2)
    .then(r => console.log(JSON.stringify({ ok: true, ...r })))
    .catch(e => { console.error('失败:', e.message); process.exit(1); });
}
