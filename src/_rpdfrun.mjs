// _rpdfrun.mjs —— 线上实测：大学计算机专业实验报告 PDF 的实时全链
// 用仓库里的 CS3223 课程实验报告（真实计算机专业实验报告），配它自己的 rubric/profile
// 目的：拿到**真实耗时**与**是否成功**（免费档内存是已知风险），替换此前的推算值
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.RT_BASE || 'https://autograder-sotv.onrender.com';
const PDF = path.join(root, 'fixtures/real/cs3223-writeup.pdf');
const OUT = path.join(root, 'fixtures/uploads');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const shot = (url, name, h) => new Promise(res => {
  execFile(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + path.join('D:\\temp', 'edgepdf_' + Date.now()),
    '--window-size=1400,' + h, '--virtual-time-budget=40000', '--screenshot=' + path.join(OUT, name), url],
    { timeout: 240000 }, e => res(e ? 'ERR' : 'ok'));
});

// 先等实例重建（判据：配额 used 归零，说明新实例磁盘为空；本次构建含 npm install 会更久）
console.log('=== 等待 Render 重建（含 npm install，可能 5–15 分钟）===');
let ready = false;
for (let i = 0; i < 60; i++) {
  let q = null;
  try { const r = await fetch(B + '/api/quota'); if (r.ok) q = await r.json(); } catch {}
  console.log('  [' + (i * 20) + 's] ' + (q ? ('used=' + q.used) : '服务不可用（构建中）'));
  if (q && q.used === 0) { ready = true; console.log('  → 新实例就绪'); break; }
  await new Promise(s => setTimeout(s, 20000));
}
if (!ready) console.log('  （20 分钟未见归零：可能未开启自动部署，仍继续测一次）');

const size = fs.statSync(PDF).size;
console.log('=== 线上 PDF 实测 ===');
console.log('样本：' + path.basename(PDF) + '（' + (size / 1024).toFixed(0) + ' KB，CS3223 数据库课程实验报告）');

const b64 = fs.readFileSync(PDF).toString('base64');
const t0 = Date.now();
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'cs3223-live-test.pdf', file_base64: b64,
    rubric: 'design/canonical-rubric.cs3223-test.json', profile: 'design/rubric-assessment-profile.cs3223-test.json' }) });
const j0 = await r.json().catch(() => ({}));
console.log('提交 → HTTP ' + r.status + '  source_kind=' + (j0.source_kind || '-'));
if (j0.eta_note) console.log('服务端给的预计：' + j0.eta_note);
if (r.status !== 202) { console.log('未入队：' + JSON.stringify(j0).slice(0, 300)); process.exit(0); }

let last = '', view = null;
for (let i = 0; i < 300; i++) {
  await new Promise(s => setTimeout(s, 10000));
  let j;
  try { j = await (await fetch(B + '/api/job/' + j0.job_id + '?token=' + j0.job_token)).json(); } catch { continue; }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (j.state !== last) {
    last = j.state;
    console.log('  [' + secs + 's] state=' + j.state + '  steps=' + (j.steps || []).map(s => s.name).join(' → '));
  } else if (i % 6 === 0) {
    console.log('  [' + secs + 's] 仍在 ' + j.state + '…');
  }
  if (j.state === 'done') { view = j.view_url; break; }
  if (j.state === 'failed') {
    console.log('\n✗ 失败（' + secs + 's）：' + j.error);
    console.log('===== 完整日志（尾部）=====');
    console.log(String(j.log_tail || '').slice(-4000));
    process.exit(0);
  }
}

const secs = Math.round((Date.now() - t0) / 1000);
if (!view) { console.log('\n（超时：' + secs + 's 未结束）'); process.exit(0); }

console.log('\n★ 成功！实际耗时 ' + secs + ' 秒（约 ' + (secs / 60).toFixed(1) + ' 分钟）');
const vr = await fetch(B + view);
const html = await vr.text();
console.log('教师视图 HTTP ' + vr.status + ' · ' + (html.length / 1024).toFixed(0) + 'KB');
for (const k of ['整篇：最值得先看的', '关键缺项／论述不足', '逐条 rubric', '生成评语草稿', '导出教师工作表']) {
  console.log('  ' + (html.includes(k) ? '✓' : '✗') + ' ' + k);
}
console.log('页图内联：' + (html.match(/data:image\/png;base64/g) || []).length + ' 张 ｜ 原 PDF 内联：' + (html.includes('data:application/pdf') ? '✓' : '✗'));
console.log('截图：' + await shot(B + view, '_online_pdf_walk.png', 2000));
