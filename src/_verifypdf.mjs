// _verifypdf.mjs —— 服务端原件访问白名单的确定性验证（不依赖浏览器渲染 / 不依赖本机摆原件）
//
// 验什么：
//   ① /api/artifact/<job>/<doc>?token  → 200 + application/pdf + content-disposition:inline + 字节==原件
//   ② 错 token / 缺 token              → 403
//   ③ 非白名单文件（其它名 / 路径穿越）  → 404（绝不开放上传目录 / 越权文件）
//   ④ #page=N 是客户端 fragment，不会发给服务端（GET 时不带） —— 单独断言 URL 形态
//
// 说明：本机没有 cs3223 原件（被 gitignore），故脚本**自带一个最小合法 PDF**上传，
//       只验证服务端契约（白名单 + inline + token）；#page=N 在真实浏览器的"视觉跳页"只能由人核
//       （headless 不加载 PDF 插件、截图不可信）。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = 8087;
const B = 'http://localhost:' + PORT;

// ★ 最小合法 PDF（1 页，300x144）—— 仅用于验证"服务端按扩展名返回 application/pdf + inline"
const MINI_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >>\nendobj\n' +
  'trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');

const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env,
    LLM_BASE_URL: process.env.LLM_BASE_URL || 'http://127.0.0.1:9/v1',
    LLM_API_KEY: process.env.LLM_API_KEY || 'dummy',
    LLM_MODEL: process.env.LLM_MODEL || 'deepseek-flash',
    REALTIME_QUOTA: '9', REALTIME_CONCURRENCY: '1' },
});

let pass = 0, fail = 0;
const ck = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  → ' + extra : '')); };
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(s => setTimeout(s, ms));

try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/api/cases')).ok) break; } catch {} await sleep(250); }

  // 上传最小 PDF：doc_file 写入 job 独立目录，先于 analyze 设置；立即拿 pdf_url
  const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'upload', file_name: 'verifypdf.pdf', file_base64: MINI_PDF.toString('base64'),
      rubric: 'design/canonical-rubric.cs3223-test.json', profile: 'design/rubric-assessment-profile.cs3223-test.json' }) });
  const j = await r.json();
  ck('提交 PDF → 202', r.status === 202, JSON.stringify(j).slice(0, 80));
  if (r.status !== 202) throw new Error('提交失败');

  let pdfUrl = null;
  for (let i = 0; i < 20; i++) {
    const s = await (await fetch(B + '/api/job/' + j.job_id + '?token=' + j.job_token)).json();
    if (s.pdf_url) { pdfUrl = B + s.pdf_url; break; }
    await sleep(300);
  }
  ck('拿到原件直链 pdf_url', !!pdfUrl, pdfUrl ? pdfUrl.replace(j.job_token, 'TOKEN…') : '（无）');
  if (!pdfUrl) throw new Error('无 pdf_url');

  // ① 直链头信息（浏览器用 GET 打开 PDF，故用 GET 取头；服务端未实现 HEAD）
  const h = await fetch(pdfUrl);
  ck('直链 GET → 200', h.status === 200, String(h.status));
  ck('content-type = application/pdf', (h.headers.get('content-type') || '').includes('application/pdf'), h.headers.get('content-type'));
  ck('content-disposition = inline（浏览器才可原生查看，不下载）', (h.headers.get('content-disposition') || '').includes('inline'), h.headers.get('content-disposition'));

  // ① 字节一致性（服务端按 basename 精确放行该 job 的原件）
  const body = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer());
  ck('返回字节 == 原件（sha256 一致）', sha256(body) === sha256(MINI_PDF), sha256(body).slice(0, 12) + ' / ' + sha256(MINI_PDF).slice(0, 12));
  ck('不缩减、不偏移', body.length === MINI_PDF.length, body.length + 'B vs ' + MINI_PDF.length + 'B');

  // ② 鉴权
  ck('错 token → 403', (await fetch(pdfUrl.replace(j.job_token, 'wrong'))).status === 403);
  ck('缺 token → 403', (await fetch(pdfUrl.split('?')[0])).status === 403);

  // ③ 白名单：非白名单文件 404（绝不开放上传目录 / 越权文件）
  const base = pdfUrl.split('?')[0];
  ck('其它文件名 → 404（不开放上传目录）', (await fetch(base.replace(/[^\/]+$/, 'not-a-real-file.json') + '?token=' + j.job_token)).status === 404);
  ck('视图未生成时视图名 → 404', (await fetch(base.replace(/[^\/]+$/, 'verifypdf.pdf.teacher-ui.html') + '?token=' + j.job_token)).status === 404);
  const traversal = B + '/api/artifact/' + j.job_id + '/' + encodeURIComponent('../') + encodeURIComponent('../') + 'server.mjs?token=' + j.job_token;
  ck('路径穿越 → 404（安全）', (await fetch(traversal)).status === 404);

  // ④ #page=N 是 fragment，不带进请求
  const withPage = pdfUrl + '#page=4';
  const reqUrl = new URL(withPage);
  ck('#page=N 是 fragment（请求不含 hash）', reqUrl.hash === '#page=4' && !reqUrl.searchParams.has('page'));
  ck('带 #page=N 的直链 GET 仍 200（fragment 不影响取件）', (await fetch(withPage)).status === 200);

  console.log('\n==== ' + pass + ' PASS / ' + fail + ' FAIL ====');
} catch (e) {
  console.log('异常：' + String(e?.stack || e).slice(0, 300));
  fail++;
} finally {
  try { srv.kill('SIGKILL'); } catch {}
  process.exit(fail ? 1 : 0);
}
