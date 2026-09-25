// _pdfjump.mjs —— 验证"点评价 → 新标签打开原 PDF → 跳到 source_ref.page"
// 关键是 <url>#page=N 在目标浏览器（Edge/Chromium 内置 PDF 查看器）里是否真的跳页
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const OUT = path.join(root, 'fixtures/uploads');
const PORT = 8087;
const B = 'http://localhost:' + PORT;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash', REALTIME_QUOTA: '9', REALTIME_CONCURRENCY: '3' },
});
for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/api/cases')).ok) break; } catch {} await new Promise(s => setTimeout(s, 250)); }

const b64 = fs.readFileSync(path.join(root, 'fixtures/real/cs3223-writeup.pdf')).toString('base64');
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'pdfjump-cs3223.pdf', file_base64: b64,
    rubric: 'design/canonical-rubric.cs3223-test.json', profile: 'design/rubric-assessment-profile.cs3223-test.json' }) });
const j = await r.json();
if (r.status !== 202) { console.log('提交失败：' + JSON.stringify(j).slice(0, 200)); srv.kill('SIGKILL'); process.exit(0); }

let pdfUrl = null;
for (let i = 0; i < 20; i++) {
  const s = await (await fetch(B + '/api/job/' + j.job_id + '?token=' + j.job_token)).json();
  if (s.pdf_url) { pdfUrl = B + s.pdf_url; break; }
  await new Promise(t => setTimeout(t, 500));
}
console.log('=== 原件直链 ===');
console.log('  ' + (pdfUrl ? pdfUrl.replace(j.job_token, 'TOKEN…') : '（未拿到 pdf_url）'));
if (!pdfUrl) { srv.kill('SIGKILL'); process.exit(0); }

// 头信息确认：inline + application/pdf
const h = await fetch(pdfUrl, { method: 'HEAD' });
console.log('  HEAD → ' + h.status + '  ' + h.headers.get('content-type') + '  ' + (h.headers.get('content-disposition') || '-'));

const shoot = (url, name) => new Promise(res => {
  execFile(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + path.join('D:\\temp', 'edgejump_' + Date.now()),
    '--window-size=1100,1000', '--virtual-time-budget=25000',
    '--screenshot=' + path.join(OUT, name), url],
    { timeout: 180000 }, e => res(e ? 'ERR ' + String(e.message).slice(0, 50) : 'ok'));
});

console.log('\n=== 浏览器跳页验证（#page=N）===');
const cases = [['', '_jump_none.png'], ['#page=2', '_jump_p2.png'], ['#page=4', '_jump_p4.png']];
for (const [suffix, name] of cases) {
  const r2 = await shoot(pdfUrl + suffix, name);
  const f = path.join(OUT, name);
  const sz = fs.existsSync(f) ? fs.statSync(f).size : 0;
  console.log('  ' + (suffix || '(无 hash)').padEnd(10) + ' → ' + r2 + '  ' + (sz / 1024).toFixed(0) + ' KB');
}
console.log('\n（截图已存 fixtures/uploads/_jump_*.png：对比同名标签页"当前页"是否随 #page 变化）');
srv.kill('SIGKILL');
