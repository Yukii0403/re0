// _rwalk.mjs —— 线上完整走查：上传全新 TXT → 分析 → 取教师视图 → headless 截图留证
// （给分/导出是浏览器端交互，截图用于证明页面与控件正常渲染；实际点击由人在浏览器完成）
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = process.env.RT_BASE || 'https://autograder-sotv.onrender.com';
const OUT = path.join(root, 'fixtures/uploads');
// ★ 一份此前**从未**被任何分析跑过的样本，保证"全新"
const TXT = path.join(root, 'fixtures/veras/holdout/2019-algebra-RR03-0272.txt');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const shot = (url, name, h = 2600) => new Promise(res => {
  execFile(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + path.join('D:\\temp', 'edgewalk_' + Date.now()),
    '--window-size=1400,' + h, '--virtual-time-budget=30000',
    '--screenshot=' + path.join(OUT, name), url],
    { timeout: 180000 }, e => res(e ? 'ERR ' + e.message.slice(0, 60) : 'ok'));
});

console.log('=== 线上走查 ' + B + ' ===');
const q0 = await (await fetch(B + '/api/quota')).json();
console.log('配额：' + q0.used + '/' + q0.limit);

console.log('\n① 上传（全新样本 ' + path.basename(TXT) + '）');
const b64 = fs.readFileSync(TXT).toString('base64');
const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'walk-full-pendulum.txt', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
const j0 = await r.json();
console.log('   → HTTP ' + r.status + (j0.error ? ' / ' + j0.error : '（已入队 job=' + j0.job_id + '）'));
if (r.status !== 202) process.exit(0);

console.log('\n② 分析中…');
const t0 = Date.now();
let view = null;
for (let i = 0; i < 200; i++) {
  await new Promise(s => setTimeout(s, 5000));
  const j = await (await fetch(B + '/api/job/' + j0.job_id + '?token=' + j0.job_token)).json();
  if (j.state === 'done') { view = j.view_url; console.log('   → 完成，用时 ' + Math.round((Date.now() - t0) / 1000) + 's'); break; }
  if (j.state === 'failed') { console.log('   → 失败：' + j.error); console.log(String(j.log_tail || '').slice(0, 2500)); process.exit(0); }
}
if (!view) { console.log('   → 超时'); process.exit(0); }

console.log('\n③ 教师视图（经带 token 的接口取）');
const vr = await fetch(B + view);
const html = await vr.text();
const need = { '整篇：最值得先看的': '整篇优先观察', '逐条 rubric': '逐条条目区',
  '生成评语草稿': '评语草稿按钮', '导出教师工作表': '导出按钮', '准确': '三选按钮（准确）',
  '不准确': '三选按钮（不准确）', 'type="number"': '给分输入框', '本次实例运行期间有效': '（预置站文案）' };
console.log('   HTTP ' + vr.status + ' · ' + (html.length / 1024).toFixed(0) + 'KB');
for (const [k, label] of Object.entries(need)) console.log('   ' + (html.includes(k) ? '✓' : '✗') + ' ' + label);
console.log('   隐私声明：' + (html.includes('不做匿名公开') ? '✓' : '（此页无，属实时站说明）'));

console.log('\n④ 截图（证明页面在真实浏览器里可渲染）');
const u = B + view;
console.log('   顶部视图：' + await shot(u, '_online_walk_top.png', 1600));
console.log('   长页视图：' + await shot(u, '_online_walk_full.png', 4200));
console.log('\n视图地址（带 token，可用于人工点击核对）：' + u.slice(0, 120) + '…');
