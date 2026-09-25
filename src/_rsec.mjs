// _rsec.mjs —— 加固后的安全行为自测（逐条验证，含重启后配额不失控）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 8095;
const B = 'http://localhost:' + PORT;
const PDF = path.join(root, 'fixtures/uploads/new-report-pendulum.pdf');

let srv = null;
const env = () => ({ ...process.env,
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
  LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash',
  REALTIME_QUOTA: '2', REALTIME_CONCURRENCY: '1' });

async function start() {
  srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], { cwd: root, stdio: 'ignore', env: env() });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/cases'); if (r.ok) return; } catch {} await new Promise(s => setTimeout(s, 300)); }
  throw new Error('server 未就绪');
}
function stop() { try { srv.kill('SIGKILL'); } catch {} }

let pass = 0, fail = 0;
const ck = (name, ok, extra = '') => { (ok ? pass++ : fail++); console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  → ' + extra : '')); };

// 配额文件先清掉，保证从零开始（模拟首次部署）
const QF = path.join(root, 'fixtures/uploads/.quota.json');
try { fs.unlinkSync(QF); } catch {}

await start();
console.log('=== 加固自测（配额 2 / 并发 1）===');

// ① 静态面
ck('静态演示站可访问', (await fetch(B + '/')).status === 200);
ck('实时页可访问', (await fetch(B + '/realtime/')).status === 200);
ck('上传件目录不再静态公开（/uploads/... 应 404）', (await fetch(B + '/uploads/new-report-pendulum.pdf')).status === 404);
ck('产物目录不再静态公开（/uploads/out/... 应 404）', (await fetch(B + '/uploads/out/new-report-pendulum.pdf.teacher-ui.html')).status === 404);

// ② 导出接口已移除
ck('/api/export 已移除（应 404）', (await fetch(B + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 404);
ck('design/ 下没有服务端写入的教师给分文件', !fs.existsSync(path.join(root, 'design', '_smoke-teacher-scores.json')));

// ③ 上传过大 → 413 且**未落盘**
const before = fs.readdirSync(path.join(root, 'fixtures/uploads')).length;
const big = 'A'.repeat(Math.ceil(12 * 1024 * 1024 * 1.4));
let bigStatus = 0;
try {
  const rBig = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'upload', file_name: 'too-big.pdf', file_base64: big, rubric: 'design/canonical-rubric.veras-pendulum.json' }) });
  bigStatus = rBig.status;
} catch (e) { bigStatus = -1; }
ck('超过大小限制 → 413（而非连接被重置）', bigStatus === 413, 'HTTP ' + bigStatus);
const after = fs.readdirSync(path.join(root, 'fixtures/uploads')).length;
ck('被拒的上传**没有落盘**', after === before, before + ' → ' + after);

// ④ 提交一份真实分析，立刻再提一次 → 并发 429
const b64 = fs.readFileSync(PDF).toString('base64');
const body = JSON.stringify({ source: 'upload', file_name: 'sec-test-pendulum.pdf', file_base64: b64,
  rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' });
const r1 = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const j1 = await r1.json();
ck('首次提交 → 202 且返回 job_token', r1.status === 202 && !!j1.job_token, 'HTTP ' + r1.status);
const r2 = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
ck('并发已满 → 429', r2.status === 429, 'HTTP ' + r2.status);
const r3 = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'too-big.pdf', file_base64: big }) });
ck('超大 body 的请求在**大小检查**阶段就被拒（413），未进入并发/配额判断', r3.status === 413, 'HTTP ' + r3.status);

// ⑤ token 控制
ck('无 token 查 job → 403', (await fetch(B + '/api/job/' + j1.job_id)).status === 403);
ck('错 token 查 job → 403', (await fetch(B + '/api/job/' + j1.job_id + '?token=deadbeef')).status === 403);
const jq = await fetch(B + '/api/job/' + j1.job_id + '?token=' + j1.job_token);
ck('正确 token 查 job → 200', jq.status === 200);
const jd = await jq.json();
ck('未知 jobId 取产物 → 404', (await fetch(B + '/api/artifact/nope/' + 'x.html')).status === 404);

// ⑥ 等分析完成 → 产物访问控制
const t0 = Date.now();
let view = null;
for (let i = 0; i < 120; i++) {
  await new Promise(s => setTimeout(s, 5000));
  const j = await (await fetch(B + '/api/job/' + j1.job_id + '?token=' + j1.job_token)).json();
  if (j.state === 'done') { view = j.view_url; break; }
  if (j.state === 'failed') { console.log('    （分析失败：' + j.error + '）'); break; }
}
console.log('    （分析用时 ' + Math.round((Date.now() - t0) / 1000) + 's）');
if (view) {
  const name = view.split('/').pop().split('?')[0];
  ck('带 token 取产物 → 200', (await fetch(B + view)).status === 200);
  ck('**不带 token** 取产物 → 403', (await fetch(B + '/api/artifact/' + j1.job_id + '/' + name)).status === 403);
  ck('**错 token** 取产物 → 403', (await fetch(B + '/api/artifact/' + j1.job_id + '/' + name + '?token=bad')).status === 403);
  ck('路径穿越取产物 → 400/404', [400, 404].includes((await fetch(B + '/api/artifact/' + j1.job_id + '/..%2f..%2fserver.mjs?token=' + j1.job_token)).status));
  // ★★ 白名单：该任务目录里的其他文件（原件、中间产物）一律不可取
  const jobDir = path.join(root, 'fixtures/uploads/jobs', j1.job_id);
  const filesInDir = fs.existsSync(jobDir) ? fs.readdirSync(jobDir) : [];
  ck('每任务独立目录存在（uploads/jobs/<jobId>/）', fs.existsSync(jobDir), jobDir.replace(root, ''));
  ck('任务目录里既有原件也有产物', filesInDir.length > 1, filesInDir.length + ' 个文件');
  const nonView = filesInDir.find(f => f !== name);
  if (nonView) {
    const rOther = await fetch(B + '/api/artifact/' + j1.job_id + '/' + encodeURIComponent(nonView) + '?token=' + j1.job_token);
    ck('白名单：任务目录里的非视图文件 → 404', rOther.status === 404, nonView + ' → HTTP ' + rOther.status);
  }
  ck('上传的原件本身不可经接口取回（白名单外）',
    [404, 400].includes((await fetch(B + '/api/artifact/' + j1.job_id + '/sec-test-pendulum.pdf?token=' + j1.job_token)).status));
} else {
  ck('分析完成（未完成则跳过产物访问控制检查）', false);
}

// ⑦ 配额已记账并落盘
const q1 = await (await fetch(B + '/api/quota')).json();
ck('配额已扣减 1（used=1/2）', q1.used === 1, JSON.stringify(q1));
ck('配额接口如实标注"仅本次实例运行期间有效"', /实例运行期间有效/.test(String(q1.scope)), String(q1.scope || '').slice(0, 40));
ck('配额已落盘', fs.existsSync(QF));

// ⑧ ★ 重启后配额不失控
stop();
await new Promise(s => setTimeout(s, 800));
await start();
const q2 = await (await fetch(B + '/api/quota')).json();
ck('**同一实例内重启后配额保留**（used 仍为 1）—— ★ 但不宣称跨休眠/跨实例持久', q2.used === 1, JSON.stringify(q2));

// ⑨ 用尽配额
const r4 = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'quota-test.pdf', file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });
ck('第 2 次提交 → 202（配额 2/2）', r4.status === 202, 'HTTP ' + r4.status);
if (r4.status === 202) { try { const jj = await r4.json(); stop(); await new Promise(s => setTimeout(s, 500)); await start(); } catch {} }
const r5 = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: 'quota-test2.pdf', file_base64: b64 }) });
ck('配额用尽 → 429', r5.status === 429, 'HTTP ' + r5.status);

stop();
console.log('\n==== ' + pass + ' PASS / ' + fail + ' FAIL ====');
process.exit(fail ? 1 : 0);
