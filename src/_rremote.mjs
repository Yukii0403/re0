// _rremote.mjs —— 线上诊断：提交一次真实分析，看服务端到底卡在哪一步
// 先测 TXT（设计上的可行路径），失败再看具体错误；不消耗多余配额（每次记 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.RT_BASE || 'https://autograder-sotv.onrender.com';

const TXT = path.join(root, 'fixtures/veras/holdout/2019-calculus-RR03-0498.txt');
const PDF = path.join(root, 'fixtures/uploads/new-report-pendulum.pdf');

const post = async (file, name) => {
  const b64 = fs.readFileSync(file).toString('base64');
  const t0 = Date.now();
  const r = await fetch(B + '/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'upload', file_name: name, file_base64: b64,
      rubric: 'design/canonical-rubric.veras-pendulum.json',
      profile: 'design/rubric-assessment-profile.veras-pendulum.json' }),
  });
  let j = null; try { j = await r.json(); } catch {}
  console.log('  提交 ' + name + ' → HTTP ' + r.status + '（' + Math.round((Date.now() - t0) / 1000) + 's）');
  if (j && j.error) console.log('    错误：' + j.error + (j.hint ? ' / ' + j.hint : ''));
  return { status: r.status, job: j };
};

const wait = async (job) => {
  const t0 = Date.now();
  let lastState = '';
  for (let i = 0; i < 240; i++) {
    await new Promise(s => setTimeout(s, 5000));
    let j;
    try {
      const r = await fetch(B + '/api/job/' + job.job_id + '?token=' + job.job_token);
      if (r.status !== 200) { console.log('    [' + Math.round((Date.now() - t0) / 1000) + 's] 轮询 HTTP ' + r.status); continue; }
      j = await r.json();
    } catch (e) { console.log('    [' + Math.round((Date.now() - t0) / 1000) + 's] 轮询异常 ' + String(e.message).slice(0, 60)); continue; }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (j.state !== lastState) { lastState = j.state; console.log('    [' + secs + 's] state=' + j.state + ' steps=' + (j.steps || []).length); }
    if (j.log_tail) console.log('      日志尾: ' + String(j.log_tail).split('\n').slice(-4).join(' | ').slice(0, 400));
    if (j.state === 'done') {
      console.log('    ★ 完成，用时 ' + secs + 's');
      const v = await fetch(B + j.view_url);
      const html = await v.text();
      console.log('    教师视图 → HTTP ' + v.status + ' ' + (html.length / 1024).toFixed(0) + 'KB');
      return { ok: true, secs };
    }
    if (j.state === 'failed') {
      console.log('    ✗ 失败（' + secs + 's）：' + j.error);
      if (j.stderr_tail) console.log('    stderr 尾：\n' + String(j.stderr_tail).slice(-900));
      return { ok: false, secs, error: j.error };
    }
  }
  console.log('    （轮询超时 20 分钟）');
  return { ok: false, error: 'timeout' };
};

console.log('=== 线上诊断 ' + B + ' ===');
const q0 = await (await fetch(B + '/api/quota')).json();
console.log('配额：' + JSON.stringify(q0));

console.log('\n[1] 纯文本（.txt）—— 设计上的可行路径');
const r1 = await post(TXT, 'remote-diag-pendulum.txt');
if (r1.status === 202) await wait(r1.job);
else console.log('    提交被拒，未进入分析');

const q1 = await (await fetch(B + '/api/quota')).json();
console.log('\n配额（诊断后）：' + JSON.stringify(q1));
