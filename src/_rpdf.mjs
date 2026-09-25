// _rpdf.mjs —— 验证「PDF 能力开关」与「配额语义」文案（本地起服务，默认 PDF 关闭）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 8092;
const B = 'http://localhost:' + PORT;

const launch = (pdfOn) => {
  const env = { ...process.env,
    LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    LLM_API_KEY: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY,
    LLM_MODEL: (process.env.LLM_MODEL || 'deepseek-flash'),
    REALTIME_QUOTA: '6', REALTIME_CONCURRENCY: '1',
  };
  if (pdfOn) env.REALTIME_PDF = '1'; else delete env.REALTIME_PDF;
  return spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], { cwd: root, stdio: 'ignore', env });
};
const ready = async () => { for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/cases'); if (r.ok) return; } catch {} await new Promise(s => setTimeout(s, 200)); } };

let pass = 0, fail = 0;
const ck = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  → ' + extra : '')); };

const pdfB64 = fs.readFileSync(path.join(root, 'fixtures/uploads/new-report-pendulum.pdf')).toString('base64');
const txtB64 = fs.readFileSync(path.join(root, 'fixtures/veras/holdout/2019-algebra-RR03-0272.txt')).toString('base64');
const post = (name, b64) => fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'upload', file_name: name, file_base64: b64,
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' }) });

console.log('=== A. 默认（PDF 实时关闭，即免费档配置）===');
let srv = launch(false); await ready();
const c = await (await fetch(B + '/api/cases')).json();
ck('/api/cases 告知 pdf_realtime=false', c.pdf_realtime === false, String(c.pdf_realtime));
ck('pdf_note 明确"建议 TXT，但 PDF 也可以 + 给时间"',
  /建议上传 \.txt/.test(c.pdf_note) && /PDF 也可以上传/.test(c.pdf_note) && /分钟/.test(c.pdf_note),
  String(c.pdf_note).slice(0, 80));
ck('配额 scope 明确"不是跨实例的费用上限"',
  /不是.*费用上限/.test(c.quota.scope) && /归零/.test(c.quota.scope), String(c.quota.scope).slice(0, 50));
// ★ 并发上限为 1：任务一旦入队就会占住并发，所以先测 TXT，再测 PDF
const rTxt = await post('ok.txt', txtB64);
ck('上传 TXT → 202（正常入队）', rTxt.status === 202, 'HTTP ' + rTxt.status);
if (rTxt.status === 202) { const jt = await rTxt.json(); ck('TXT 的 eta_note 说明预计时间', /预计等待/.test(String(jt.eta_note || '')), String(jt.eta_note || '').slice(0, 50)); }
srv.kill('SIGKILL'); await new Promise(s => setTimeout(s, 800));

// 重启一个干净实例，再单独验证 PDF 被放行
srv = launch(false); await ready();
const rPdf = await post('accepted.pdf', pdfB64);
const jPdf = await rPdf.json().catch(() => ({}));
ck('上传 PDF → 202 放行（不拒绝，只提示等待时间）', rPdf.status === 202, 'HTTP ' + rPdf.status);
ck('202 响应带 source_kind=pdf 与 eta_note（说明等待时间）',
  jPdf.source_kind === 'pdf' && /预计等待/.test(String(jPdf.eta_note || '')), String(jPdf.eta_note || '').slice(0, 80));
srv.kill('SIGKILL'); await new Promise(s => setTimeout(s, 600));

console.log('\n=== B. REALTIME_PDF=1（大内存部署）===');
srv = launch(true); await ready();
const c2 = await (await fetch(B + '/api/cases')).json();
ck('pdf_realtime=true', c2.pdf_realtime === true, String(c2.pdf_realtime));
const rPdf2 = await post('allowed.pdf', pdfB64);
ck('REALTIME_PDF=1 时 PDF 同样放行（202/429）', rPdf2.status === 202 || rPdf2.status === 429, 'HTTP ' + rPdf2.status);
srv.kill('SIGKILL');

console.log('\n==== ' + pass + ' PASS / ' + fail + ' FAIL ====');
process.exit(fail ? 1 : 0);
