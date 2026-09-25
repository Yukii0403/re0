// _rtest.mjs —— 实时流程端到端实测：启动服务 → 上传全新 PDF → 轮询 → 校验结果
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 8098;
const B = 'http://localhost:' + PORT;

const env = { ...process.env,
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
  LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash',
};
console.log('模型配置：base=' + env.LLM_BASE_URL + ' model=' + env.LLM_MODEL
  + ' key=' + (env.LLM_API_KEY ? '已设置(' + env.LLM_API_KEY.length + ')' : '缺失'));

const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env });
let slog = '';
srv.stdout.on('data', d => { slog += d; });
srv.stderr.on('data', d => { slog += d; });
const kill = () => { try { srv.kill('SIGKILL'); } catch {} };

for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/cases'); if (r.ok) break; } catch {} await new Promise(s => setTimeout(s, 300)); }
console.log('服务端已就绪');

// 实时页可访问
const rt = await fetch(B + '/realtime/');
console.log('GET /realtime/ → ' + rt.status + ' ' + ((await rt.text()).length / 1024 | 0) + 'KB');
const q0 = await (await fetch(B + '/api/quota')).json();
console.log('配额：' + JSON.stringify(q0));

// ★ 上传那份**全新 PDF**
const file = path.join(root, 'fixtures/uploads/new-report-pendulum.pdf');
const b64 = fs.readFileSync(file).toString('base64');
console.log('上传：new-report-pendulum.pdf（' + (b64.length / 1024 / 1024 * 0.75).toFixed(0) + ' KB 原始）');

const r0 = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'new-report-pendulum.pdf', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
const job0 = await r0.json();
console.log('提交 → HTTP ' + r0.status + ' job=' + (job0.job_id || JSON.stringify(job0).slice(0, 200)));
if (r0.status !== 202) { kill(); process.exit(0); }

const t0 = Date.now();
let last = '';
for (let i = 0; i < 400; i++) {
  await new Promise(s => setTimeout(s, 5000));
  let j;
  try { j = await (await fetch(B + '/api/job/' + job0.job_id)).json(); } catch { continue; }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (j.state !== last) { last = j.state; console.log('  [' + secs + 's] state=' + j.state + ' steps=' + (j.steps || []).length); }
  if (j.log_tail) console.log('    日志尾：' + String(j.log_tail).split('\n').slice(-3).join(' | ').slice(0, 240));
  if (j.state === 'done') {
    console.log('★ 分析完成，用时 ' + secs + 's');
    console.log('  view_url=' + j.view_url);
    const v = await fetch(B + j.view_url);
    const html = await v.text();
    console.log('  教师视图 → HTTP ' + v.status + ' ' + (html.length / 1024 / 1024).toFixed(2) + 'MB'
      + ' 含内联PDF=' + html.includes('data:application/pdf')
      + ' 含页图=' + (html.match(/data:image\/png;base64/g) || []).length + '张');
    // 关键内容抽查
    for (const k of ['整篇：最值得先看的', '关键缺项／论述不足', '逐条 rubric', '生成评语草稿', '依据已绑定，内容待核对']) {
      console.log('    ' + (html.includes(k) ? '✓ ' : '✗ ') + k);
    }
    break;
  }
  if (j.state === 'failed') { console.log('✗ 失败：' + j.error); console.log(String(j.stderr_tail || '').slice(-800)); break; }
}
const q1 = await (await fetch(B + '/api/quota')).json();
console.log('配额（分析后）：' + JSON.stringify(q1));
kill();
console.log('=== 服务端日志尾 ==='); console.log(slog.trim().split('\n').slice(-4).join('\n'));
