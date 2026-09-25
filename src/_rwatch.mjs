// _rwatch.mjs —— 等 Render 重新部署完成，然后实测线上「TXT 全链」
// 判定重建：轮询 /api/quota，观察是否出现短暂失败（构建中）→ 恢复
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.RT_BASE || 'https://autograder-sotv.onrender.com';
const TXT = path.join(root, 'fixtures/veras/holdout/2019-calculus-RR03-0498.txt');

const probe = async () => {
  try { const r = await fetch(B + '/api/quota'); return r.status === 200 ? await r.json() : { http: r.status }; }
  catch (e) { return { err: String(e.message).slice(0, 40) }; }
};

console.log('=== 等待 Render 重新部署（最多 20 分钟）===');
let sawDown = false, deployed = false;
for (let i = 0; i < 40; i++) {
  const q = await probe();
  const tag = q.err ? ('不可用(' + q.err + ')') : ('HTTP ok used=' + q.used + '/' + q.limit);
  if (q.err || q.http) sawDown = true;
  console.log('  [' + (i * 30) + 's] ' + tag);
  if (sawDown && !q.err && !q.http) { deployed = true; console.log('  → 检测到"先中断后恢复"，判定已完成重新部署'); break; }
  if (!sawDown && i === 0) console.log('    （没看到中断：可能还没开始重建，或未开启 Auto-Deploy）');
  await new Promise(s => setTimeout(s, 30000));
}
if (!deployed) console.log('  （20 分钟内未观察到重建迹象）');

console.log('\n=== 实测：提交一份全新 TXT，跑完整链路 ===');
const b64 = fs.readFileSync(TXT).toString('base64');
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'watch-diag-pendulum.txt', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
const j0 = await r.json().catch(() => null);
console.log('  提交 → HTTP ' + r.status + (j0 && j0.error ? ' / ' + j0.error : ''));
if (r.status !== 202) { console.log('  （未能提交，结束）'); process.exit(0); }

const t0 = Date.now();
let last = '';
for (let i = 0; i < 240; i++) {
  await new Promise(s => setTimeout(s, 5000));
  let j;
  try { j = await (await fetch(B + '/api/job/' + j0.job_id + '?token=' + j0.job_token)).json(); } catch { continue; }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (j.state !== last) { last = j.state; console.log('  [' + secs + 's] state=' + j.state + ' steps=' + (j.steps || []).length); }
  if (j.log_tail) console.log('      ' + String(j.log_tail).split('\n').filter(l => l.trim()).slice(-6).join('\n      ').slice(0, 800));
  if (j.state === 'done') {
    console.log('  ★ 完成，用时 ' + secs + 's');
    const v = await fetch(B + j.view_url);
    const html = await v.text();
    console.log('  教师视图 → HTTP ' + v.status + ' ' + (html.length / 1024).toFixed(0) + 'KB'
      + ' ｜ 含关键区块：'
      + ['整篇：最值得先看的', '关键缺项／论述不足', '逐条 rubric', '生成评语草稿', '导出教师工作表']
        .map(k => (html.includes(k) ? '✓' : '✗')).join(''));
    break;
  }
  if (j.state === 'failed') { console.log('  ✗ 失败（' + secs + 's）：' + j.error); console.log(String(j.stderr_tail || '').slice(-600)); break; }
}
