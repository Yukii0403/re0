// _mksite.mjs —— 组装可部署的静态演示站点（公网 Demo）
//
// ★ 定位：赛事验收要求"部署到浏览器环境、可直接在线体验"。纯静态站无法调用模型，
//   因此本站是**预置案例**的演示：所有评价都是**离线预先生成**的产物，页面上明确标注。
//   真实的上传+分析需要服务端（见 README 与 `server.mjs`），不在此静态站内。
//
// 产出：fixtures/web/
//   index.html          首页（案例列表 + 使用说明 + 预置声明）
//   cases/<case>.html   教师视图（自包含：内联 PDF/页图与数据，无外部依赖）
//   manifest.json       站点清单（含生成时间与产物指纹）

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const WEB = path.join(root, 'fixtures/web');
const NODE = process.execPath;

const CASES = [
  {
    id: 'cs3223-writeup.pdf',
    title: 'CS3223 数据库实验报告（真实 PDF）',
    kind: 'pdf',
    rubric: 'design/canonical-rubric.cs3223-test.json',
    profile: 'design/rubric-assessment-profile.cs3223-test.json',
    out: 'fixtures/real/out',
    blurb: 'points 型 rubric（8 个可评分叶子）。原件是 PDF —— **「查看原文」会跳到原 PDF 的对应页并高亮引文**，缩放可保持。',
    source: 'GitHub 上的 CS3223-DBMS-Project 公开课程报告',
  },
  {
    id: '2019-calculus-RR03-0503.txt',
    title: '单摆实验报告 · VerAs 数据集（纯文本）',
    kind: 'text',
    rubric: 'design/canonical-rubric.veras-pendulum.json',
    profile: 'design/rubric-assessment-profile.veras-pendulum.json',
    out: 'fixtures/veras/out-holdout',
    blurb: 'levels 型 rubric（R1–R4/R7 档位 + R5/R6 points）。输入是**抽取后的纯文本**，没有页面图 —— 「查看原文」会退回文本定位（页面会写明原因）。'
      + '可看到「内容错误候选（依据已绑定，内容待核对）」与「关键缺项／论述不足」两条通道。',
    source: 'VerAs（自动化评分研究）公开数据集',
  },
];

const run = (script, args) => new Promise((res, rej) => {
  execFile(NODE, [script, ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    (e, stdout, stderr) => (e ? rej(new Error(String(stderr || e))) : res(stdout)));
});

await fsp.mkdir(path.join(WEB, 'cases'), { recursive: true });

const made = [];
for (const c of CASES) {
  process.stdout.write(`生成 ${c.id} … `);
  await run(path.join(here, '_teacherui.mjs'), [
    '--case', c.id, '--out', c.out, '--rubric', c.rubric, '--profile', c.profile,
  ]);
  // 生成物在 <out>/<case>.teacher-ui.html → 拷进站点的 cases/
  const src = path.join(root, c.out, c.id + '.teacher-ui.html');
  const buf = await fsp.readFile(src);
  const name = c.id + '.html';
  await fsp.writeFile(path.join(WEB, 'cases', name), buf);
  made.push({ ...c, file: 'cases/' + name, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) });
  console.log(`${Math.round(buf.length / 1024)} KB`);
}

// ---------------------------------------------------------------- 首页
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const H = [];
H.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">');
H.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
H.push('<title>AutoGrader · 教师协作式多模态评分 · 在线 Demo</title>');
H.push(`<style>
:root{--bg:#f7f7f5;--card:#fff;--line:#e3e3df;--ink:#1d1d1b;--dim:#6b6b66;--acc:#1f4e79;--warn:#b45309}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif}
header{background:#fff;border-bottom:1px solid var(--line);padding:22px 24px}
header h1{margin:0 0 6px;font-size:20px}
header .sub{color:var(--dim);font-size:13.5px}
main{max-width:900px;margin:0 auto;padding:22px 24px 80px}
.notice{background:#fff8e6;border:1px solid #f0e0b8;color:#7a5a12;border-radius:10px;padding:12px 14px;font-size:13.5px;margin:16px 0}
.notice b{color:#8a5a09}
.card{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:16px 18px;margin:12px 0}
.card h2{margin:0 0 6px;font-size:16px}
.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:11.5px;color:var(--dim);margin:0 6px 6px 0;background:#fafaf8}
.chip.p{background:#eef6ff;border-color:#cfe3f7;color:#1f4e79}
.chip.w{background:#fff4e5;border-color:#f3d9ae;color:#8a5a09}
.blurb{color:#3a3a36;font-size:14px;margin:8px 0 12px}
a.go{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;padding:7px 16px;border-radius:8px;font-size:14px}
a.go:hover{background:#173e60}
ol{padding-left:22px;color:#3a3a36;font-size:14px}
li{margin:4px 0}
code{background:#f2f2ee;padding:1px 5px;border-radius:4px;font:13px ui-monospace,Consolas,monospace}
footer{color:var(--dim);font-size:12.5px;text-align:center;padding:20px}
.tiny{color:var(--dim);font-size:12.5px}
</style></head><body>`);
H.push('<header><h1>AutoGrader · 教师协作式多模态评分</h1>');
H.push('<div class="sub">AI 提出可核对的观察，教师确认与给分 ｜ 在线 Demo（静态演示站）</div></header>');
H.push('<main>');
H.push('<div class="notice">⚠️ <b>本站是预置案例演示</b>：页面里的评价、判断与验证结果都是<b>离线预先生成</b>的产物，'
  + '<b>不是实时分析</b>。可以真实操作教师侧的完整闭环（看观察 → 跳原文 → 确认/修改 → 给分 → 评语草稿 → 导出）。'
  + '真实"上传报告 + 跑模型分析"需要服务端（模型密钥只从环境变量读取，不会进入网页与仓库）。</div>');
H.push('<h2 style="font-size:15px;color:var(--acc)">选择案例</h2>');
for (const c of made) {
  H.push('<div class="card">');
  H.push(`<h2>${esc(c.title)}</h2>`);
  H.push(`<div><span class="chip p">${c.kind === 'pdf' ? 'PDF 原件' : '纯文本输入'}</span>`
    + `<span class="chip">${esc(c.rubric.split('/').pop().replace('canonical-rubric.', '').replace('.json', ''))}</span>`
    + `<span class="chip">${Math.round(c.bytes / 1024)} KB</span>`
    + `<span class="chip w">预置结果</span></div>`);
  H.push(`<div class="blurb">${c.blurb}</div>`);
  H.push(`<div class="tiny">数据来源：${esc(c.source)} ｜ 产物指纹 ${c.sha256}</div>`);
  H.push(`<div style="margin-top:12px"><a class="go" href="${c.file}">打开教师视图 →</a></div>`);
  H.push('</div>');
}
H.push('<div class="card"><h2>在这个 Demo 里可以做什么</h2><ol>');
H.push('<li><b>看整篇优先观察</b>：每份最多 3 条，过了门槛才上屏（合格不足就不凑满，可能是 0 条）。</li>');
H.push('<li><b>看关键缺项／论述不足</b>：单列「待教师核对」，附带 rubric 要求、学生实际写的段落与跳页入口。</li>');
H.push('<li><b>点「查看原文」</b>：跳到原件的对应页（PDF 案例会高亮引文；缩放由你掌控，切换评价不会重置）。</li>');
H.push('<li><b>按条目确认／修改评价、给分</b>：准确／部分准确／不准确 + 分数（整数，越界会标红）。</li>');
H.push('<li><b>生成评语草稿 / 导出教师工作表</b>：草稿只把标注"准确"的条目当作已确认内容；未全部给分时显示「总分未形成」。</li>');
H.push('</ol><div class="tiny">★ 页面不显示 AI 档位或分数；评价由 AI 提出，供教师核对。</div></div>');
H.push('<div class="card"><h2>为什么这里是静态站</h2>');
H.push('<p class="blurb">评测链（文档解析 → 证据聚焦 → 机械验证 → 条目评估）需要调用模型服务，密钥只能放在服务端。'
  + '本站把所有产物**离线预生成并内联**，因此可以纯静态部署、离线双击打开，也能保证演示稳定。</p>'
  + '<div class="tiny">真实上传与实时分析：见仓库 README 的启动说明（Node 服务端，密钥走环境变量）。</div></div>');
H.push('</main>');
H.push(`<footer>生成时间 ${new Date().toISOString()} ｜ 静态演示站 · 无任何密钥 ｜ AutoGrader</footer>`);
H.push('</body></html>');

await fsp.writeFile(path.join(WEB, 'index.html'), H.join('\n'), 'utf8');
await fsp.writeFile(path.join(WEB, 'manifest.json'), JSON.stringify({
  kind: 'static-demo-site',
  note: '★ 预置案例演示：所有评价为离线预生成产物，不是实时分析。无任何密钥。',
  generated_at: new Date().toISOString(),
  cases: made.map(c => ({ id: c.id, title: c.title, kind: c.kind, file: c.file, bytes: c.bytes, sha256: c.sha256, source: c.source })),
}, null, 2) + '\n', 'utf8');

console.log('\n站点已生成：fixtures/web/');
console.log('  index.html + ' + made.length + ' 个案例页，共 ' + Math.round(made.reduce((a, c) => a + c.bytes, 0) / 1024 / 1024 * 10) / 10 + ' MB（案例）');
