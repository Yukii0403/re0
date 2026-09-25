// _verifyui.mjs —— 本地验证：带 --pdf-url 生成的教师视图是否符合预期
// （不内联 PDF/页图、有直链、抽取文本仅作备用；静态模式保持内联可双击）
//
// ★ 注意：teacherui.app.js 是内联进 HTML 的，里面会出现 'data:image/png;base64'、'备用' 等
//   字符串字面量 —— 不能靠子串 grep 判断，必须从 `const DATA = {...}` 里解析出对象再断言。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CASE = 'cs3223-writeup.pdf';
const INPUT_OUT = path.join(root, 'fixtures/real/out');
// 在临时目录生成视图，避免测试覆盖现有演示产物。
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'autograder-verifyui-'));
for (const name of fs.readdirSync(INPUT_OUT)) {
  if (name === CASE + '.assessment.json' || name === CASE + '.txt' || name === CASE + '.index.json'
      || (name.startsWith(CASE + '.p') && name.endsWith('.png'))) {
    fs.copyFileSync(path.join(INPUT_OUT, name), path.join(OUT, name));
  }
}
process.on('exit', () => {
  if (path.resolve(path.dirname(OUT)) === path.resolve(os.tmpdir())
      && path.basename(OUT).startsWith('autograder-verifyui-')) {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
});
const FILE = path.join(OUT, 'cs3223-writeup.pdf.teacher-ui.html');
const PDF_URL_ARG = '/api/artifact/DEMO/cs3223-writeup.pdf?token=DEMO';

const run = (args) => new Promise(res => execFile(process.execPath, [path.join(here, '_teacherui.mjs'), ...args],
  { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (e, so, se) => res({ code: e?.code ?? 0, out: String(so), err: String(se) })));

const base = ['--case', CASE, '--out', OUT,
  '--rubric', 'design/canonical-rubric.cs3223-test.json',
  '--profile', 'design/rubric-assessment-profile.cs3223-test.json'];

let pass = 0, fail = 0;
const ck = (n, ok, extra = '') => { (ok ? pass++ : fail++); console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '  → ' + extra : '')); };
const stat = () => {
  const h = fs.readFileSync(FILE, 'utf8');
  const m = h.match(/const DATA = (\{[\s\S]*?\});<\/script>/);
  let data = null;
  try { data = JSON.parse(m[1]); } catch {}
  return {
    kb: Math.round(h.length / 1024),
    inlinePdf: h.includes('data:application/pdf'),   // 只在 <embed src="data:application/pdf;base64,.."> 出现，可靠
    openBtn: h.includes('在新标签页打开原件'),
    pageJump: h.includes('#page='),
    sourceLinks: h.includes('class="source-action"') && h.includes('rel="noopener noreferrer"'),
    falseMissingPdf: h.includes('⚠ 未能读取原件文件，只能核对抽取文本。'),
    falsePopupCheck: h.includes("const w = window.open(url, '_blank', 'noopener')"),
    foldedPages: data ? Object.values(data.foldedByItem || {}).flat().filter(f => Number.isInteger(f.source_page)).length : -1,
    pdfUrl: data ? data.pdfUrl : undefined,
    pdfViaUrl: data ? !!(data.source && data.source.pdf_via_url) : false,
    pages: data ? (data.pages || []).length : -1,
  };
};

console.log('=== A. 服务端模式（--pdf-url：不内联，交浏览器原生查看器）===');
let r = await run([...base, '--pdf-url', PDF_URL_ARG]);
ck('生成成功', r.code === 0, String(r.err).slice(0, 80));
let a = stat();
ck('**不再内联 PDF**（无 <embed data:application/pdf>）', !a.inlinePdf, a.kb + 'KB');
ck('已注入 DATA.pdfUrl（直链）', a.pdfUrl === PDF_URL_ARG, String(a.pdfUrl));
ck('pdf_via_url = true', a.pdfViaUrl === true);
ck('有「在新标签页打开原件」按钮', a.openBtn);
ck('前端有 #page= 跳页逻辑', a.pageJump);
ck('查看原文使用可直接打开的新标签链接', a.sourceLinks && !a.falsePopupCheck);
ck('实时模式不显示「原件读取失败」误报', !a.falseMissingPdf);
ck('折叠评价保留了 PDF 页码', a.foldedPages > 0, a.foldedPages + ' 条');
ck('**实时站不再内联页图**（DATA.pages 为空，更轻量）', a.pages === 0, a.pages + ' 张');

console.log('\n=== B. 静态自包含模式（不给 --pdf-url：保持内联，双击即开）===');
r = await run(base);
ck('生成成功', r.code === 0, String(r.err).slice(0, 80));
let b = stat();
ck('仍然内联 PDF（离线可看）', b.inlinePdf, b.kb + 'KB');
ck('静态模式不显示「原件读取失败」误报', !b.falseMissingPdf);
ck('未注入 pdfUrl（pdf_via_url = false）', b.pdfViaUrl === false && b.pdfUrl == null);
ck('页图已内联（离线兜底可用）', b.pages > 0, b.pages + ' 张');

console.log('\n==== ' + pass + ' PASS / ' + fail + ' FAIL ====');
process.exit(fail ? 1 : 0);
