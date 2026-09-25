// _rprofile2.mjs —— 对比画像：上传 **纯文本(.txt)** 时的时长与内存峰值
// 用途：如果 PDF 渲染太吃内存，给"免费小规格也能跑通演示"的可选路径提供实测依据。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 8093;
const B = 'http://localhost:' + PORT;
const TXT = path.join(root, 'fixtures/veras/holdout/2019-calculus-RR03-0531.txt');

const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash', REALTIME_QUOTA: '3', REALTIME_CONCURRENCY: '1' },
});
for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/cases'); if (r.ok) break; } catch {} await new Promise(s => setTimeout(s, 300)); }

const sample = () => new Promise(res => {
  execFile('powershell', ['-NoProfile', '-Command',
    "Get-Process node,msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | Select-Object -ExpandProperty Sum"],
    { timeout: 15000 }, (e, out) => res(e ? 0 : Number(String(out).trim()) || 0));
});
let peak = 0, peakAt = 0, n = 0;
const t0 = Date.now();
const timer = setInterval(async () => { const m = await sample(); n++; if (m > peak) { peak = m; peakAt = Math.round((Date.now() - t0) / 1000); } }, 3000);

const b64 = fs.readFileSync(TXT).toString('base64');
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'profile-text-pendulum.txt', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
const j0 = await r.json();
console.log('提交（TXT）：HTTP ' + r.status + '  job=' + (j0.job_id || JSON.stringify(j0).slice(0, 160)));

let state = '', view = null;
for (let i = 0; i < 160; i++) {
  await new Promise(s => setTimeout(s, 5000));
  const j = await (await fetch(B + '/api/job/' + j0.job_id + '?token=' + j0.job_token)).json();
  if (j.state !== state) { state = j.state; console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] ' + state); }
  if (j.state === 'done') { view = j.view_url; break; }
  if (j.state === 'failed') { console.log('  失败：' + j.error + ' / ' + String(j.stderr_tail || '').slice(-300)); break; }
}
clearInterval(timer);
const secs = Math.round((Date.now() - t0) / 1000);
if (view) {
  const html = await (await fetch(B + view)).text();
  console.log('  教师视图：' + (html.length / 1024).toFixed(0) + ' KB，含页图 ' + (html.match(/data:image\/png;base64/g) || []).length + ' 张（纯文本输入无页图 → 查看原文会退回文本定位，页面会写明原因）');
}
srv.kill('SIGKILL');

console.log('\n=== 对比画像（纯文本上传）===');
console.log('  单次全链分析时长：' + secs + ' 秒');
console.log('  node+浏览器 内存峰值：' + (peak / 1024 / 1024).toFixed(0) + ' MB（' + peakAt + 's，' + n + ' 次采样）');
console.log('  （对照：PDF 上传实测 346 秒 / 峰值 ~1988 MB —— 差异主要来自 PDF 页面渲染）');
