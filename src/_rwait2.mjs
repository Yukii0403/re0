// _rwait2.mjs —— 等 Render 重建完成（判据：配额 used 归零，说明新实例的磁盘是空的），随后重测并打印完整日志
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.RT_BASE || 'https://autograder-sotv.onrender.com';
const TXT = path.join(root, 'fixtures/veras/holdout/2019-calculus-RR03-0498.txt');

const quota = async () => { try { const r = await fetch(B + '/api/quota'); return r.ok ? await r.json() : null; } catch { return null; } };

console.log('=== 等待重建（判据：used 归零）===');
let ok = false;
for (let i = 0; i < 40; i++) {
  const q = await quota();
  console.log('  [' + (i * 20) + 's] ' + (q ? ('used=' + q.used + '/' + q.limit) : '服务不可用（建设中）'));
  if (q && q.used === 0) { ok = true; console.log('  → 新实例就绪'); break; }
  await new Promise(s => setTimeout(s, 20000));
}
if (!ok) { console.log('  （15 分钟内未检测到重建；可能未开启自动部署，仍按现状重测一次）'); }

console.log('\n=== 重测：TXT 全链 + 打印完整日志 ===');
const b64 = fs.readFileSync(TXT).toString('base64');
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'wait2-pendulum.txt', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
const j0 = await r.json().catch(() => null);
console.log('  提交 → HTTP ' + r.status + (j0 && j0.error ? ' / ' + j0.error : ''));
if (r.status !== 202) process.exit(0);

const t0 = Date.now();
let last = '';
for (let i = 0; i < 200; i++) {
  await new Promise(s => setTimeout(s, 5000));
  let j;
  try { j = await (await fetch(B + '/api/job/' + j0.job_id + '?token=' + j0.job_token)).json(); } catch { continue; }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (j.state !== last) { last = j.state; console.log('  [' + secs + 's] state=' + j.state); }
  if (j.state === 'done') {
    console.log('  ★ 完成 ' + secs + 's');
    const v = await fetch(B + j.view_url);
    const html = await v.text();
    console.log('  教师视图 HTTP ' + v.status + ' ' + (html.length / 1024).toFixed(0) + 'KB ｜ '
      + ['整篇：最值得先看的', '关键缺项／论述不足', '逐条 rubric', '生成评语草稿'].map(k => (html.includes(k) ? '✓' : '✗')).join(''));
    break;
  }
  if (j.state === 'failed') {
    console.log('  ✗ 失败 ' + secs + 's：' + j.error);
    console.log('===== 完整日志 =====');
    console.log(String(j.log_tail || '（无）').slice(0, 9000));
    break;
  }
}
