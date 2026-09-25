// _rprofile.mjs —— 资源画像：跑一次完整分析，采样服务端进程与渲染浏览器的内存峰值
// 用途：判断 Render 免费档（内存较小）能否完成一次新 PDF 的全链分析 —— 给规格建议提供依据（不改配置）。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 8094;
const B = 'http://localhost:' + PORT;
const PDF = path.join(root, 'fixtures/uploads/new-report-pendulum.pdf');

const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash', REALTIME_QUOTA: '3', REALTIME_CONCURRENCY: '1' },
});
for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/cases'); if (r.ok) break; } catch {} await new Promise(s => setTimeout(s, 300)); }

// 采样：node（服务端 + 评测子进程）与 msedge（PDF 页面渲染）
const sample = () => new Promise(res => {
  execFile('powershell', ['-NoProfile', '-Command',
    "Get-Process node,msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum | Select-Object -ExpandProperty Sum"],
    { timeout: 15000 }, (e, out) => res(e ? 0 : Number(String(out).trim()) || 0));
});
let peak = 0, peakAt = 0, samples = 0;
const t0 = Date.now();
const timer = setInterval(async () => {
  const m = await sample();
  samples++;
  if (m > peak) { peak = m; peakAt = Math.round((Date.now() - t0) / 1000); }
}, 3000);

const b64 = fs.readFileSync(PDF).toString('base64');
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'profile-pendulum.pdf', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
const j0 = await r.json();
console.log('提交：HTTP ' + r.status + '  job=' + (j0.job_id || JSON.stringify(j0).slice(0, 160)));

let state = '';
for (let i = 0; i < 160; i++) {
  await new Promise(s => setTimeout(s, 5000));
  const j = await (await fetch(B + '/api/job/' + j0.job_id + '?token=' + j0.job_token)).json();
  if (j.state !== state) { state = j.state; console.log('  [' + Math.round((Date.now() - t0) / 1000) + 's] ' + state); }
  if (j.state === 'done' || j.state === 'failed') { if (j.state === 'failed') console.log('  失败：' + j.error); break; }
}
clearInterval(timer);
const secs = Math.round((Date.now() - t0) / 1000);
srv.kill('SIGKILL');

console.log('\n=== 资源画像（本机实测，供规格参考）===');
console.log('  单次全链分析时长：' + secs + ' 秒');
console.log('  node+浏览器 内存峰值：' + (peak / 1024 / 1024).toFixed(0) + ' MB（出现在 ' + peakAt + 's，共 ' + samples + ' 次采样）');
console.log('  本机 CPU 核数：' + os.cpus().length + '（Render 免费档通常只给很小的 CPU 配额）');
console.log('  ★ 提示：PDF 页面渲染（chromium/Edge）是内存峰值的主要来源；上传纯文本(.txt)可显著降低占用。');
