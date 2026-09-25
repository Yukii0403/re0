// server.mjs —— AutoGrader 服务端（零依赖，Node 18+）· 加固版
//
// ★★ 安全边界（2026-09-25 加固，按 Yukii 要求）：
//   ① **产物不匿名公开**：上传原件与分析产物**不再**走静态目录；只能通过
//      `/api/artifact/<jobId>/<file>?token=<jobToken>` 取，且 token 必须与该 job 匹配。
//      （演示级的**持有者令牌**访问控制：jobId 随机 + token 随机，匿名无法枚举或访问。）
//   ② **教师导出不落服务端**：已移除写 `design/` 的接口；导出改成**浏览器下载**（前端 Blob）。
//   ③ **先校验、后落盘、再启动**：大小 → 配额 → 并发 依次校验，全部通过才写文件、才起任务。
//   ④ **配额持久化**：写盘（按天重置），**重启不会把额度清零**。
//   ⑤ 并发上限：同一时刻只跑 N 个分析任务（超出返回 429）。
//
// ★ 密钥纪律：模型密钥只从 `process.env` 读；不写文件、不返回前端、不入日志。

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };

const PORT = Number(argOf('--port', 8080));
const WEB = path.resolve(root, argOf('--web', 'fixtures/web'));
const REALTIME = path.join(root, 'fixtures/realtime');
const UPLOADS = path.join(root, 'fixtures/uploads');
const JOB_ROOT = path.join(UPLOADS, 'jobs');        // ★ 每个任务一个独立目录：uploads/jobs/<jobId>/

const NODE = process.execPath;

const MAX_UPLOAD_MB = Number(process.env.REALTIME_MAX_UPLOAD_MB ?? 10);
const QUOTA_LIMIT = Number(process.env.REALTIME_QUOTA ?? 6);
const CONCURRENCY = Math.max(1, Number(process.env.REALTIME_CONCURRENCY ?? 1));
const QUOTA_FILE = path.join(UPLOADS, '.quota.json');
// ★ PDF 能力标志（只影响**文案与预计等待时间**，**不作为拒绝依据**）：
//   PDF 需要把整页渲染成图（"查看原文"跳页要用），耗时与内存都明显高于纯文本。
//   REALTIME_PDF=1 表示该部署内存充足、PDF 预期能跑完；默认 0 → 提示"可能较慢/可能失败"。
const PDF_REALTIME = process.env.REALTIME_PDF === '1';
// ★ 均为**线上免费档实测值**（2026-09-25）：
//   TXT（2019-algebra-RR03-0272）325s ≈ 5.4 分钟；PDF（CS3223 课程实验报告，527KB）448s ≈ 7.5 分钟。
const ETA_TXT = '约 5–6 分钟';
const ETA_PDF = '约 7–8 分钟';
const JOB_TTL_MS = Number(process.env.REALTIME_JOB_TTL_MS ?? 6 * 60 * 60 * 1000);   // 6 小时后产物不再可取

const PRESETS = [
  { id: 'cs3223-writeup.pdf', title: 'CS3223 数据库实验报告', kind: 'pdf', out: 'fixtures/real/out',
    rubric: 'design/canonical-rubric.cs3223-test.json', profile: 'design/rubric-assessment-profile.cs3223-test.json' },
  { id: '2019-calculus-RR03-0503.txt', title: '单摆实验报告（VerAs）', kind: 'text', out: 'fixtures/veras/out-holdout',
    rubric: 'design/canonical-rubric.veras-pendulum.json', profile: 'design/rubric-assessment-profile.veras-pendulum.json' },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// ---------------------------------------------------------------- 工具
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (!p.startsWith(base)) throw new Error('path outside base');
  return p;
}
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', ...extra });
  res.end(buf);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 2));
const readBody = (req, maxBytes) => new Promise((res, rej) => {
  const chunks = []; let n = 0, tooBig = false;
  req.on('data', c => {
    if (tooBig) return;                       // 超限后继续 drain，但不再累积
    n += c.length;
    if (n > maxBytes) {
      tooBig = true; chunks.length = 0;
      // ★ 不要 req.destroy()：那会让客户端收到 ECONNRESET、拿不到 413 说明。
      //   改为把剩余数据读完（resume），让调用方正常返回 413。
      req.resume();
      rej(Object.assign(new Error('body too large'), { code: 413 }));
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => { if (!tooBig) res(Buffer.concat(chunks)); });
  req.on('error', e => { if (!tooBig) rej(e); });
});
// ★ 流式执行：把子进程输出**实时**交给 onOutput，页面才能边跑边看到进展
//   （原来用 execFile 缓冲到结束，实测表现为"跑几分钟页面毫无变化，日志最后才出现"）
const run = (script, args, timeoutMs = 20 * 60 * 1000, onOutput = null) => new Promise(res => {
  const t0 = Date.now();
  const child = spawn(NODE, [script, ...args], { cwd: root, env: process.env, killSignal: 'SIGKILL' });
  let out = '', err = '', done = false;
  const fire = () => { if (onOutput) { try { onOutput(out, err); } catch { /* 回调出错不影响主流程 */ } } };
  child.stdout.on('data', d => { out += d.toString('utf8'); fire(); });
  child.stderr.on('data', d => { err += d.toString('utf8'); fire(); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
  const finish = (code, killed) => {
    if (done) return; done = true; clearTimeout(timer);
    res({ code, killed: killed === true, stdout: out, stderr: err, ms: Date.now() - t0 });
  };
  child.on('error', e => { err += String(e?.message ?? e); finish(-1, false); });
  child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0), signal === 'SIGKILL'));
});

// ---------------------------------------------------------------- 配额
// ★ 有效期语义（如实标注）：配额**只保证"当前实例运行期间"有效**。
//   它写在实例本地磁盘上；平台若休眠/重建实例（如免费档），文件可能丢失、配额会被重置。
//   → 不要对外宣称"跨休眠持久"。若需跨实例恒定配额，应改用外部存储（本项目未接入）。
const today = () => new Date().toISOString().slice(0, 10);
let quota = { date: today(), used: 0 };
async function loadQuota() {
  try {
    const j = JSON.parse(await fsp.readFile(QUOTA_FILE, 'utf8'));
    quota = (j.date === today()) ? { date: j.date, used: Number(j.used) || 0 } : { date: today(), used: 0 };
  } catch { quota = { date: today(), used: 0 }; }
  await saveQuota();
}
async function saveQuota() {
  try { await fsp.mkdir(UPLOADS, { recursive: true }); await fsp.writeFile(QUOTA_FILE, JSON.stringify(quota, null, 2), 'utf8'); }
  catch { /* 写不动就算了，不能因此中断请求 */ }
}
const quotaLeft = () => Math.max(0, QUOTA_LIMIT - quota.used);

// ---------------------------------------------------------------- 任务（含持有者令牌）
const jobs = new Map();
const runningCount = () => [...jobs.values()].filter(j => j.state === 'running' || j.state === 'pending').length;
function newJob(caseName, rubric) {
  const id = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');     // ★ 只有拿到它的调用方才能访问该 job 的产物
  const job = { id, token, case: caseName, rubric, state: 'pending', steps: [],
    created_at: new Date().toISOString(), expires_at: Date.now() + JOB_TTL_MS };
  jobs.set(id, job);
  return job;
}
function gcJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.expires_at < now) {
      jobs.delete(id);
      // ★ 产物到期即清理该任务的独立目录（不牵扯别的任务）
      fsp.rm(path.join(JOB_ROOT, id), { recursive: true, force: true }).catch(() => {});
    }
  }
}
const publicJob = j => ({ id: j.id, state: j.state, steps: j.steps, case: j.case, rubric: j.rubric,
  created_at: j.created_at, error: j.error, log_tail: j.log_tail, view_url: j.view_url });

// ---------------------------------------------------------------- 分析流水线
async function analyze({ job, caseName, docPath, rubricPath, profilePath, jobDir }) {
  const outDir = jobDir;   // ★ 该任务的所有产物只落在自己的目录里
  job.state = 'running';
  const step = (name, extra = {}) => { job.steps.push({ name, at: new Date().toISOString(), ...extra }); };
  // ★ 排障：保留**完整输出**（上限 20KB），而不是尾部若干行 ——
  //   线上失败时 `_e2e` 会把错误写进 stdout，尾部只剩"账目全平"之类的成功信息，真错会被截掉。
  const keepTail = r => {
    const all = ('--- stdout ---' + String.fromCharCode(10) + r.stdout
      + String.fromCharCode(10) + '--- stderr ---' + String.fromCharCode(10) + r.stderr).trim();
    job.log_tail = all.length > 20000 ? (all.slice(0, 10000) + String.fromCharCode(10)
      + '…（中间省略）…' + String.fromCharCode(10) + all.slice(-10000)) : all;
  };
  // ★ 流式：子进程输出一到就更新 job.log_tail，并把 `▶ 层名 …` / `✔ 层名 完成` 变成可见步骤
  const streamed = new Set();
  const onOut = (out, err) => {
    const all = ('--- stdout ---' + String.fromCharCode(10) + out
      + String.fromCharCode(10) + '--- stderr ---' + String.fromCharCode(10) + err).trim();
    job.log_tail = all.length > 20000 ? all.slice(-20000) : all;
    for (const line of out.split(String.fromCharCode(10))) {
      const a = line.match(/▶\s*(.+?)\s*…/);
      if (a && !streamed.has('S:' + a[1])) { streamed.add('S:' + a[1]); step('开始：' + a[1]); continue; }
      const c = line.match(/✔\s*(.+?)\s*完成/);
      if (c && !streamed.has('D:' + c[1])) { streamed.add('D:' + c[1]); step('完成：' + c[1]); continue; }
    }
  };

  step('评测链 L1→L4', { doc: path.relative(root, docPath) });
  const e2e = await run(path.join(here, '_e2e.mjs'),
    ['--doc', docPath, '--rubric', rubricPath, '--profile', profilePath, '--out', outDir], 20 * 60 * 1000, onOut);
  keepTail(e2e);
  if (e2e.code !== 0) {
    job.state = 'failed'; job.error = '评测链失败';
    job.stderr_tail = e2e.stderr.slice(-1500);
    return;
  }
  step('评测链完成', { ms: e2e.ms });

  step('生成教师视图');
  const tv = await run(path.join(here, '_teacherui.mjs'),
    ['--case', caseName, '--out', outDir, '--rubric', rubricPath, '--profile', profilePath], 5 * 60 * 1000, onOut);
  keepTail(tv);
  if (tv.code !== 0) { job.state = 'failed'; job.error = '教师视图生成失败'; job.stderr_tail = tv.stderr.slice(-1500); return; }
  step('教师视图完成', { ms: tv.ms });

  // ★ 产物留在服务端磁盘，但**不放进任何静态目录**；只经由带 token 的接口取
  job.view_file = path.join(outDir, caseName + '.teacher-ui.html');
  job.state = 'done';
  job.finished_at = new Date().toISOString();
}

// ---------------------------------------------------------------- 服务
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    gcJobs();

    // ---------- 公开：配置与配额 ----------
    if (p === '/api/cases' && req.method === 'GET') {
      return json(res, 200, {
        presets: PRESETS,
        rubrics: [...new Set(PRESETS.map(x => x.rubric))],
        quota: { limit: QUOTA_LIMIT, used: quota.used, remaining: quotaLeft(),
          // ★ 如实且明确：这不是费用上限，实例重建即归零 → 不能用它做成本控制
          scope: '仅本实例内存计数：实例重建/休眠后即归零，**不是**跨实例的费用上限；'
            + '真正的成本上限请在模型服务商侧设置额度' },
        limit_mb: MAX_UPLOAD_MB,
        pdf_realtime: PDF_REALTIME,
        eta_txt: ETA_TXT,
        eta_pdf: ETA_PDF,
        pdf_note: '**建议上传 .txt**（更快，' + ETA_TXT + '）。'
          + 'PDF 也可以上传，它需要把整页渲染成图，**耗时更长**（' + ETA_PDF + '，免费档实测值）；'
          + (PDF_REALTIME ? '' : '本部署内存偏紧，若失败请改用 TXT —— ')
          + '想看 PDF 的完整效果（含"查看原文"跳页）也可直接用**预置案例**。',
        note: '★ 预置案例的评价是离线预生成产物（不是实时分析）。实时分析需服务端配置模型环境变量；'
          + '上传原件与产物**不公开**，仅通过带 job token 的接口访问。',
      });
    }
    if (p === '/api/quota' && req.method === 'GET') {
      return json(res, 200, { limit: QUOTA_LIMIT, used: quota.used, remaining: quotaLeft(), date: quota.date,
        running: runningCount(),
        scope: '本次实例运行期间有效（写在实例本地磁盘；平台休眠/重建实例后可能重置）' });
    }

    // ---------- 提交分析（顺序：大小 → 配额 → 并发 → 落盘 → 启动）----------
    if (p === '/api/analyze' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, Math.ceil(MAX_UPLOAD_MB * 1024 * 1024 * 1.4) + 64 * 1024)).toString('utf8') || '{}'); }
      catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? '上传内容超过 ' + MAX_UPLOAD_MB + ' MB 限制' : '请求体不是合法 JSON' }); }

      const isPreset = body.source !== 'upload';
      // ① 大小（在落盘之前）
      if (!isPreset) {
        if (!body.file_base64 || !body.file_name) return json(res, 400, { error: '缺少 file_name / file_base64' });
        const approx = Math.floor(body.file_base64.length * 3 / 4);
        if (approx > MAX_UPLOAD_MB * 1024 * 1024) return json(res, 413, { error: '文件超过 ' + MAX_UPLOAD_MB + ' MB 限制' });
        if (!/\.(pdf|txt)$/i.test(body.file_name)) return json(res, 400, { error: '只支持 .pdf / .txt' });
        // ★ 不拒绝 PDF：按 Yukii 的要求"建议 TXT，但真上传 PDF 就说明等待时间"（见下方 202 响应里的 eta_note）
      }
      // ② 配额（持久化，重启不清零）
      if (quotaLeft() <= 0) return json(res, 429, { error: '今日演示配额已用完（' + quota.used + '/' + QUOTA_LIMIT + '）',
        hint: '预置案例仍可随时查看；如需更多额度，调整 REALTIME_QUOTA 后重启。' });
      // ③ 并发
      if (runningCount() >= CONCURRENCY) return json(res, 429, { error: '当前有 ' + runningCount() + ' 个分析在进行（上限 ' + CONCURRENCY + '）', hint: '请稍后重试。' });
      // ④ 模型配置
      if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
        return json(res, 503, { error: '服务端未配置模型环境变量（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），无法执行实时分析',
          hint: '预置案例不需要模型：直接打开 /cases/<id>.html' });
      }
      // ⑤ 落盘（校验全部通过之后）—— ★ 建"每任务独立目录"，原件与产物都放进去
      const job = newJob('', body.rubric || PRESETS[0].rubric);
      const jobDir = path.join(JOB_ROOT, job.id);
      let caseName, docPath, outDir;
      try {
        await fsp.mkdir(jobDir, { recursive: true });
        if (isPreset) {
          const ps = PRESETS.find(x => x.id === body.case);
          if (!ps) { jobs.delete(job.id); return json(res, 400, { error: '未知预置案例' }); }
          caseName = ps.id;
          outDir = path.join(root, ps.out);
          docPath = path.join(outDir, ps.id);
          await fsp.writeFile(path.join(jobDir, 'SOURCE.txt'),
            '预置案例：' + ps.id + '（产物由服务端既有产物提供，未重新上传原件）', 'utf8');
        } else {
          caseName = String(body.file_name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 80);
          outDir = jobDir;                                   // ★ 该任务的产物目录
          docPath = path.join(jobDir, caseName);             // ★ 原件也放本任务目录
          await fsp.writeFile(docPath, Buffer.from(body.file_base64, 'base64'));
        }
      } catch (e) {
        jobs.delete(job.id);
        return json(res, 500, { error: '落盘失败：' + String(e?.message ?? e) });
      }
      const rubricPath = path.resolve(root, body.rubric || PRESETS[0].rubric);
      const profilePath = path.resolve(root, body.profile || PRESETS[0].profile);
      const designDir = path.join(root, 'design');
      if (!rubricPath.startsWith(designDir) || !profilePath.startsWith(designDir)) return json(res, 400, { error: 'rubric / profile 只能取自 design/' });

      // ⑥ 启动任务（配额在**启动前**记账并落盘）
      quota.used += 1;
      await saveQuota();
      job.case = caseName;
      analyze({ job, caseName, docPath, rubricPath, profilePath, jobDir })
        .catch(e => { job.state = 'failed'; job.error = String(e); });
      // ★ token 只返回给提交者本人
      const isPdfJob = /\.pdf$/i.test(caseName);
      return json(res, 202, { job_id: job.id, job_token: job.token, poll: '/api/job/' + job.id,
        quota: { limit: QUOTA_LIMIT, used: quota.used, remaining: quotaLeft() },
        source_kind: isPdfJob ? 'pdf' : 'text',
        eta_note: isPdfJob
          ? ('PDF 需要整页渲染，预计等待 ' + ETA_PDF + '（免费档实测 448 秒跑通；TXT ' + ETA_TXT + '）。'
            + (PDF_REALTIME ? '' : '若长时间无进展或失败，请改用 TXT，或查看预置案例。'))
          : ('预计等待 ' + ETA_TXT + '（免费档实测 325 秒）。') });
    }

    // ---------- 任务状态（需 token）----------
    if (p.startsWith('/api/job/') && req.method === 'GET') {
      const job = jobs.get(p.slice('/api/job/'.length));
      if (!job) return json(res, 404, { error: 'unknown job' });
      if (url.searchParams.get('token') !== job.token) return json(res, 403, { error: '缺少或错误的 token' });
      const out = publicJob(job);
      if (job.view_file) out.view_url = '/api/artifact/' + job.id + '/' + path.basename(job.view_file) + '?token=' + job.token;
      return json(res, 200, out);
    }

    // ---------- 产物（**非公开**：需 token，且只允许该 job 的产物）----------
    if (p.startsWith('/api/artifact/') && req.method === 'GET') {
      const rest = p.slice('/api/artifact/'.length);
      const slash = rest.indexOf('/');
      const jobId = slash < 0 ? rest : rest.slice(0, slash);
      const name = slash < 0 ? '' : rest.slice(slash + 1);
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: 'unknown job' });
      if (url.searchParams.get('token') !== job.token) return json(res, 403, { error: '缺少或错误的 token' });
      if (Date.now() > job.expires_at) return json(res, 410, { error: '产物已过期（TTL）' });
      // ★★ 白名单：只允许取该任务自己生成的教师视图，其余（原件、中间产物、其他文件）一律 404
      const allowed = job.view_file ? path.basename(job.view_file) : null;
      if (!allowed || name !== allowed) return json(res, 404, { error: 'not found（该任务不提供此文件）' });
      try {
        const f = safeJoin(path.dirname(job.view_file), '/' + name);
        return send(res, 200, await fsp.readFile(f), MIME[path.extname(f)] || 'application/octet-stream');
      } catch { return json(res, 404, { error: 'not found' }); }
    }

    // ---------- 静态：只暴露演示站与实时页（**不含上传件与产物**）----------
    const rel = p === '/' ? '/index.html' : p;
    for (const [base, prefix] of [[WEB, ''], [REALTIME, '/realtime']]) {
      if (prefix && !rel.startsWith(prefix)) continue;
      let sub = prefix ? rel.slice(prefix.length) : rel;
      if (prefix === '/realtime' && (sub === '' || sub === '/')) sub = '/index.html';
      try {
        const f = safeJoin(base, sub);
        const stat = await fsp.stat(f);
        if (!stat.isFile()) continue;
        return send(res, 200, await fsp.readFile(f), MIME[path.extname(f)] || 'application/octet-stream');
      } catch { /* 试下一个 base */ }
    }
    return send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) });
  }
});

await loadQuota();
server.listen(PORT, () => {
  console.log(`AutoGrader 服务端已启动：http://localhost:${PORT}`);
  console.log(`  静态站：${path.relative(root, WEB)} ｜ 实时页：/realtime/`);
  console.log(`  配额：${quota.used}/${QUOTA_LIMIT}（★ 仅"当前实例运行期间"有效；平台休眠/重建后会重置）｜ 并发上限：${CONCURRENCY}`);
  console.log(`  上传上限：${MAX_UPLOAD_MB} MB ｜ 产物 TTL：${Math.round(JOB_TTL_MS / 3600000)} 小时 ｜ PDF：${PDF_REALTIME ? '已开启（内存充足）' : '可上传（实测约 7–8 分钟）'}`);
  const hasKey = !!(process.env.LLM_API_KEY && process.env.LLM_BASE_URL && process.env.LLM_MODEL);
  console.log(`  模型配置：${hasKey ? '已就绪' : '未配置 → 仅预置案例可用（/api/analyze 返回 503）'}`
    + (hasKey ? `（base=${String(process.env.LLM_BASE_URL).replace(/\/+$/, '')}  model=${JSON.stringify(String(process.env.LLM_MODEL))}  key=已设置）` : ''));
  console.log('  ★ 上传件与产物不做静态公开：仅经 /api/artifact/<jobId>/<file>?token=… 访问；导出在浏览器端完成。');
});
