// _teacherui.mjs —— 最薄的教师操作界面（本地可演示闭环）
//
// 目标（Yukii 2026-09-25 定）：看整篇重点 → 点开原文 → 按 rubric 修改或确认评价 → 教师给分 → 生成评语草稿。
// ★ 形态：**单文件自包含 HTML**（数据与前端逻辑全部内联，双击即开，不依赖服务与网络）。
//   这是"最薄、可演示"；公网部署与精致页面留到后面（届时把内联数据换成后端接口即可，交互结构不变）。
// ★ 纪律：主视图**不显示** AI 候选档位、AI 判断与任何 AI 分数；档位描述取自 rubric（参考标准）；
//   每条观察标可核查性；不确定的写明"请勿当作确定结论"。
// ★ 工程约定：**前端逻辑写在 src/teacherui.app.js 里**，本文件只负责骨架与内联 ——
//   不要把 JS 塞进模板字符串（会被 `\n`／正则转义吞掉；这是踩过的坑）。
//
// 用法：node _teacherui.mjs [--case cs3223-writeup.pdf] [--out fixtures/real/out]

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeacherView } from './teacherview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

const CASE = argOf('--case', 'cs3223-writeup.pdf');
const OUT = path.resolve(root, argOf('--out', 'fixtures/real/out'));
const RUBRIC = path.resolve(root, argOf('--rubric', 'design/canonical-rubric.cs3223-test.json'));
const PROFILE = path.resolve(root, argOf('--profile', 'design/rubric-assessment-profile.cs3223-test.json'));

const readJson = async p => JSON.parse(await fsp.readFile(p, 'utf8'));
const readIf = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } };

const assessmentArtifact = await readJson(path.join(OUT, CASE + '.assessment.json'));
const rubric = await readJson(RUBRIC);
const profile = await readJson(PROFILE);
const fullText = (await readIf(path.join(OUT, CASE + '.txt'))) ?? '';
const idxDoc = await readJson(path.join(OUT, CASE + '.index.json')).catch(() => null);
const parseInfo = idxDoc ? {
  chars: idxDoc.doc?.chars ?? null, entries: (idxDoc.entries ?? []).length,
  warnings: idxDoc.doc?.warnings ?? [], index_file: CASE + '.index.json', text_file: CASE + '.txt',
} : null;

const view = buildTeacherView({ assessmentArtifact, rubric, profile, topN: 3, parseInfo, missingLimit: 3 });
const appJs = await fsp.readFile(path.join(here, 'teacherui.app.js'), 'utf8');
const exportJs = await fsp.readFile(path.join(here, 'teacherui.export.js'), 'utf8');

// ★ 满分来自 profile（权威值，校验器会核对）——不能让界面自己编
const maxByItem = {};
for (const it of profile.items ?? []) {
  if (it.scorable === true && Number.isInteger(it.scoring_strategy?.max)) maxByItem[it.rubric_item_id] = it.scoring_strategy.max;
}

// ★ 折叠项要能**顺手核对**：把每条目被折叠的观察一并内联（只给内容，不给 AI 档位/分数）
const shownKeys = new Set();
for (const it of view.items) {
  for (const f of [it.primary_concern, it.primary_strength]) if (f) shownKeys.add(it.rubric_item_id + '|' + f.note);
}
const foldedByItem = {};
for (const a of assessmentArtifact.assessments ?? []) {
  const list = (a.findings ?? [])
    .filter(f => !shownKeys.has(a.rubric_item_id + '|' + f.note))
    .map(f => ({ polarity: f.polarity, kind: f.kind, severity: f.severity ?? null, note: f.note,
      quote: f.quote ?? null, anchored: !!(f.located || f.verification),
      source_page: f.located?.source_ref?.page ?? null }));
  if (list.length) foldedByItem[a.rubric_item_id] = list;
}

// ★ 原件（PDF）：抽取后的 TXT 看不到图表/加粗/下划线 —— 必须给一个"打开原件"的入口
// 静态自包含视图内联原件：预览服务只映射单个 HTML 文件，同目录、上级路径不可用。
// 实时视图则使用任务令牌保护的原件直链，不把 PDF 编进 HTML。
const pdfAbs = path.resolve(root, argOf('--pdf', path.join('fixtures/real', CASE.replace(/\.[a-z]+$/i, '') + '.pdf')));
// ★ 原件直链（服务端部署时传入）：给了它就**不内联 PDF、也不内联整页 PNG** ——
//   评价页通过"新标签打开原件 #page=N"交给浏览器原生查看器（缩放/翻页/搜索都好用），
//   不把整份 PDF / 几十张页图编进 HTML（Yukii 9/25 要求：实时站不必把整份 PDF 编进教师视图 HTML）。
//   页图只在"无直链（静态自包含，双击即开）"时才内联，作离线兜底。
const PDF_URL = argOf('--pdf-url', null);
const pdfBytes = PDF_URL ? null : await fsp.readFile(pdfAbs).catch(() => null);   // ★ 有直链就不再内联 PDF
// ★★ 原始页面图：L2 把 PDF 渲成整页 PNG（`<case>.p00N.png`）。
//   仅当**没有原件直链**（静态自包含模式）才内联它们当"原 PDF 的可视化" —— 不引入新依赖、页码/缩放可控。
//   （实时站有真 PDF 直链，页图属于"把整份 PDF 编进 HTML"，按 Yukii 要求不内联。）
const inlinePages = !PDF_URL;
const pngFiles = inlinePages
  ? (await fsp.readdir(OUT).catch(() => []))
    .filter(f => f.startsWith(CASE + '.p') && f.endsWith('.png'))
    .map(f => ({ file: f, page: Number((f.match(/\.p(\d+)\.png$/) || [])[1]) }))
    .filter(x => Number.isInteger(x.page))
    .sort((a, b) => a.page - b.page)
  : [];
const pages = [];
for (const x of pngFiles) {
  const buf = await fsp.readFile(path.join(OUT, x.file)).catch(() => null);
  if (buf) pages.push({ page: x.page, b64: buf.toString('base64'), kb: Math.round(buf.length / 1024) });
}
const pdfB64 = pdfBytes ? pdfBytes.toString('base64') : null;
const pdfKB = pdfBytes ? Math.round(pdfBytes.length / 1024) : 0;
// ★ 原件文件名：有直链时从直链里取 basename（更准确），否则用本地推断
const pdfName = PDF_URL
  ? decodeURIComponent(String(PDF_URL.split('?')[0].split('/').pop()))
  : path.basename(pdfAbs);

const DATA = {
  pdfUrl: PDF_URL,
  view, fullText,
  rubricItems: Object.fromEntries((rubric.items ?? []).map(i => [i.id, i.text ?? ''])),
  rubricId: rubric.rubric_id ?? null,
  maxByItem,
  foldedByItem,
  generatedAt: new Date().toISOString(),
  sourceReport: CASE,
  pages,
  pages_total_kb: pages.reduce((a, x) => a + x.kb, 0),
  source: {
    // ★ 抽取文本 vs 原件：界面必须区分清楚（图表/加粗/下划线只能在原件里核）
    text_note: '下方文本框是抽取后的纯文本，图表、加粗、下划线等信息不在这里',
    pdf_available: !!pdfBytes,
    pdf_via_url: !!PDF_URL,
    pages_available: pages.length > 0,
    pdf_kb: pdfKB,
    pdf_name: pdfName,
  },
};

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const J = o => JSON.stringify(o).replace(/</g, '\\u003c');

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--line:#e3e3df;--ink:#1d1d1b;--dim:#6b6b66;--warn:#b45309;--acc:#1f4e79}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:12px 20px;z-index:10}
header h1{margin:0 0 4px;font-size:16px}
header .meta{color:var(--dim);font-size:12.5px}
.banner{background:#fff8e6;border-bottom:1px solid #f0e0b8;color:#7a5a12;padding:8px 20px;font-size:12.5px}
main{max-width:980px;margin:0 auto;padding:18px 20px 150px}
h2{font-size:14px;color:var(--acc);margin:18px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:8px 0}
.card.primary{border-left:4px solid #c2410c}
.card.pending{border-left:4px solid var(--warn);background:#fffbf2}
.meta-row{color:var(--dim);font-size:12.5px;margin-bottom:6px}
.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11.5px;color:var(--dim);margin-right:6px;background:#fafaf8}
.chip.p{background:#eef6ff;border-color:#cfe3f7;color:#1f4e79}
.chip.w{background:#fff4e5;border-color:#f3d9ae;color:#8a5a09}
.chip.g{background:#eefaf0;border-color:#c7ecd2;color:#166534}
.note{margin:6px 0 8px}
.quote{background:#f4f4f1;border-left:3px solid #cfcfc8;padding:6px 10px;font:13px/1.5 ui-monospace,Consolas,monospace;color:#3a3a36;white-space:pre-wrap;margin:6px 0;max-height:340px;overflow:auto}
.basis{background:#f6f8fb;border:1px dashed #cbd7e6;border-radius:8px;padding:8px 10px;margin:8px 0;font-size:13.5px}
.basis b{color:var(--acc)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
button{font:inherit;padding:5px 12px;border:1px solid var(--line);border-radius:7px;background:#fff;cursor:pointer}
button:hover{background:#f2f2ee}
button.on{background:#eef6ff;border-color:#9cc4e8}
button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
button.pri:hover{background:#173e60}
.source-action{display:inline-block;font:inherit;padding:5px 12px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);text-decoration:none}
.source-action:hover{background:#f2f2ee}
input[type=number]{width:78px;font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:7px}
input[type=number].on{background:#eefaf0;border-color:#c7ecd2}
input[type=number].bad{background:#fff5f0;border-color:#c2410c}
input[type=text]{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:7px;width:130px}
label.chk{font-size:12.5px;color:var(--dim);display:flex;gap:4px;align-items:center}
textarea{width:100%;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:7px;min-height:48px}
.fold{color:var(--dim);font-size:12.5px;margin-top:6px;cursor:pointer;user-select:none}
.hidden-box{display:none;margin-top:8px;border-top:1px dashed var(--line);padding-top:8px}
.level{font-size:12.5px;color:var(--dim);margin-top:6px}
.level span{display:block;margin:2px 0}
footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid var(--line);padding:10px 20px;display:flex;gap:10px;align-items:center;justify-content:flex-end}
#draft{white-space:pre-wrap;background:#fbfbf9;border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:14px}
.tiny{color:var(--dim);font-size:12px}
mark{background:#fff2a8;padding:0 2px}
.viewer-bar{gap:6px}
.pagewrap{margin-top:8px;border:1px solid var(--line);border-radius:8px;background:#e9e9e6;padding:8px;overflow:auto;max-height:76vh}
.pagewrap img{display:block;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.12);height:auto;margin:0 auto}
.quotebar{margin-top:8px;background:#fffbe9;border:1px solid #f0e0b8;border-radius:8px;padding:8px 10px;font:13px/1.55 ui-monospace,Consolas,monospace;color:#5a4a12;white-space:pre-wrap;display:none}
.pagechip{cursor:pointer}
.card.hit{border-color:#c2410c;box-shadow:0 0 0 2px #ffe8d6}
`;

const B = [];
B.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">');
B.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
B.push('<title>教师视图 · ' + esc(CASE) + '</title>');
B.push('<style>' + STYLE + '</style></head><body>');
B.push('<header><h1>教师视图 · ' + esc(CASE) + '</h1>');
B.push('<div class="meta">整篇优先观察 → rubric 条目 → 原文 ｜ 教师自行确认评价并给分</div></header>');
B.push('<div class="banner">★ 本视图<b>不显示 AI 档位或分数</b>；页面上的评价由 AI 提出，<b>供教师核对</b>。档位描述取自 rubric（参考标准）。'
  + '标为「依据已绑定，内容待核对」的，系统只核对了原话能否定位、解释与依据是否成文 —— <b>内容是否正确仍需教师判断</b>。</div>');
B.push('<main>');
B.push('<section><h2>① 整篇：最值得先看的 ' + view.whole_report.top_concerns.length + ' 个问题</h2>'
  + '<div id="top"></div><div class="tiny" id="topfold"></div></section>');
B.push('<section><h2>待核查 · 可能缺少的关键内容</h2><div id="missing"></div></section>');
B.push('<section><h2>② 逐条 rubric（确认 / 修改 / 给分）</h2><div id="items"></div></section>');
B.push('<section><h2>③ 评语草稿</h2><div id="draft">（点右下角「生成评语草稿」）</div>'
  + '<div class="tiny">本地模板拼装，用教师给分与已确认的评价生成；正式版措辞由评语层（模型）产出。</div></section>');
// ★ 原始页面查看器：默认「适合阅读区宽度」；缩放由教师掌控且**不随切换评价而重置**
if (pages.length) {
  B.push('<section id="secpages"><h2>原始页面与抽取文本'
    + (PDF_URL ? '（<span style="color:#8a5a09">备用方式</span>：请在浏览器里打开原件核对）' : '')
    + '（' + pages.length + ' 页）</h2>');
  B.push('<div class="tiny">这是报告的**原始页面渲染**（索引格式、图表、加粗/下划线都在这里核）。'
    + '点右侧评价里的「查看原文」会跳到对应页，并在下方显示引文。</div>');
  B.push('<div class="row viewer-bar">'
    + '<button id="pgPrev">← 上一页</button>'
    + '<span class="chip" id="pgLabel">第 — / ' + pages.length + ' 页</span>'
    + '<button id="pgNext">下一页 →</button>'
    + '<span class="tiny" style="margin-left:8px">缩放</span>'
    + '<button id="zoomFit" class="on">适合阅读区宽度</button>'
    + '<button id="zoomOut">缩小</button>'
    + '<button id="zoomIn">放大</button>'
    + '<span class="chip" id="zoomLabel">—</span>'
    + '<button id="zoomReset">恢复适应宽度</button>'
    + '</div>');
  B.push('<div class="pagewrap"><img id="pageImg" alt="报告原始页面" /></div>');
  B.push('<div class="quotebar" id="pageQuote"></div>');
  B.push('</section>');
}
B.push('<section><h2>原文（抽取文本）</h2>'
  + '<div class="tiny" id="srcnote"></div>'
  + '<div class="row" id="srcrow"></div>'
  + '<div class="quote" id="full"></div></section>');
// ★ 原件区（服务端部署）：不内联，直接给"新标签打开"的直链 —— 用浏览器自带的缩放/翻页/搜索
if (PDF_URL) {
  B.push('<section><h2>原件（PDF · 在新标签页打开）</h2>'
    + '<div class="tiny">用浏览器自带的查看器核对原件：<b>缩放、翻页、搜索</b>都可用。'
    + '索引格式、图表规范、加粗/下划线等只能在这里看；抽取文本可能丢失这些信息。</div>'
    + '<div class="row"><a class="source-action" id="btnPdfOpen" href="' + esc(PDF_URL) + '" target="_blank" rel="noopener noreferrer">在新标签页打开原件</a>'
    + '<span class="tiny">点条目里的「查看原文」会直接跳到该条对应的页（<code>#page=N</code>）。</span></div></section>');
}
// ★ 原件区（静态自包含）：PDF 已内联成 data URI —— 不依赖任何服务映射，双击打开也能看
else if (pdfB64) {
  B.push('<section><h2>原件（PDF · 内联 ' + pdfKB + ' KB）</h2>'
    + '<div class="tiny">索引格式、图表规范、加粗/下划线等只能在这里核对；抽取文本可能丢失这些信息。</div>'
    + '<div class="row"><button id="btnPdfToggle" class="pri">展开原件</button>'
    + '<button id="btnPdfOpen">在新标签页打开原件</button>'
    + '<button id="btnPdfDownload">下载原件</button>'
    + '<span class="tiny">（' + esc(path.basename(pdfAbs)) + '）</span></div>'
    + '<div id="pdfbox" style="display:none;margin-top:8px">'
    + '<embed id="pdfembed" type="application/pdf" src="data:application/pdf;base64,' + pdfB64 + '" '
    + 'style="width:100%;height:640px;border:1px solid var(--line);border-radius:8px;background:#fff"></embed>'
    + '<div class="tiny" id="pdfnote">若上方没有渲染，请点"在新标签页打开原件"。</div>'
    + '</div></section>');
} else if (/\.txt$/i.test(CASE)) {
  B.push('<section><h2>原件（TXT）</h2><div class="tiny">本次上传的是纯文本报告；上方「原文（抽取文本）」即供核对的原始文字，没有 PDF 页面视图。</div></section>');
} else {
  B.push('<section><h2>原件（PDF）</h2><div class="tiny">⚠ 未能读取原件文件，只能核对抽取文本。</div></section>');
}
B.push('</main>');
B.push('<footer>'
  + '<span class="tiny" id="stat"></span>'
  + '<label class="chk"><input type="checkbox" id="chkConfirmed"> 我已核对完毕</label>'
  + '<input type="text" id="teacherName" placeholder="教师姓名（可选）">'
  + '<button id="btnDraft" class="pri">生成评语草稿</button>'
  + '<button id="btnExport">导出教师工作表 JSON</button></footer>');
B.push('<script>const DATA = ' + J(DATA) + ';</script>');
B.push('<script>' + exportJs + '</script>');
B.push('<script>' + appJs + '</script>');
B.push('</body></html>');

const html = B.join('\n');
await fsp.mkdir(OUT, { recursive: true });
const outPath = path.join(OUT, CASE + '.teacher-ui.html');
await fsp.writeFile(outPath, html, 'utf8');

console.log('教师操作界面已生成：' + path.relative(root, outPath).split(path.sep).join('/'));
console.log('  报告：' + CASE + '（' + fullText.length + ' 字）· rubric ' + (rubric.rubric_id ?? '?'));
console.log('  rubric 文件：' + path.relative(root, RUBRIC).split(path.sep).join('/'));
console.log('  profile 文件：' + path.relative(root, PROFILE).split(path.sep).join('/'));
console.log('  整篇优先观察：' + view.whole_report.top_concerns.length + ' 条（门槛后）· 折叠 ' + view.whole_report.folded_count);
console.log('  待核查（可能缺少）：' + (view.whole_report.possibly_missing?.entries?.length ?? 0) + ' 条');
console.log('  条目：' + view.items.length + ' 条（可逐条确认/修改/给分）');
console.log('  大小：' + (html.length / 1024).toFixed(0) + ' KB（自包含，双击即开）');
