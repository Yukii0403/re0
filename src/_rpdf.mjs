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
ck('pdf_note 明确"建议用 TXT + PDF 看预置案例"',
  /建议使用 TXT/.test(c.pdf_note) && /预置案例/.test(c.pdf_note), String(c.pdf_note).slice(0, 60));
ck('配额 scope 明确"不是跨实例的费用上限"',
  /不是.*费用上限/.test(c.quota.scope) && /归零/.test(c.quota.scope), String(c.quota.scope).slice(0, 50));
const rPdf = await post('should-reject.pdf', pdfB64);
const jPdf = await rPdf.json().catch(() => ({}));
ck('上传 PDF → 422 立即拒绝（不让用户白等）', rPdf.status === 422, 'HTTP ' + rPdf.status);
ck('拒绝时给出可点的预置案例指引', /预置案例|\/cases\//.test(String(jPdf.hint || '')), String(jPdf.hint || '').slice(0, 70));
const rTxt = await post('ok.txt', txtB64);
ck('上传 TXT → 202（正常入队）', rTxt.status === 202, 'HTTP ' + rTxt.status);
srv.kill('SIGKILL'); await new Promise(s => setTimeout(s, 600));

console.log('\n=== B. REALTIME_PDF=1（大内存部署）===');
srv = launch(true); await ready();
const c2 = await (await fetch(B + '/api/cases')).json();
ck('pdf_realtime=true', c2.pdf_realtime === true, String(c2.pdf_realtime));
const rPdf2 = await post('allowed.pdf', pdfB64);
ck('上传 PDF → 202（已开启时允许）', rPdf2.status === 202 || rPdf2.status === 429, 'HTTP ' + rPdf2.status + '（429=并发占满，亦属放行）');
srv.kill('SIGKILL');

console.log('\n==== ' + pass + ' PASS / ' + fail + ' FAIL ====');
process.exit(fail ? 1 : 0);
