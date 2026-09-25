// 新 TXT rubric：纯适配器 + 无模型、无分析额度的预览 API 回归。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adaptTextRubric, decodeRubricUpload, writeUploadedRubric } from './rubric-upload.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const raw = await fs.readFile(path.join(root, 'design/rubric.cs3223-test.txt'), 'utf8');
const b64 = Buffer.from(raw, 'utf8').toString('base64');
let pass = 0, fail = 0;
const check = (name, ok) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };

const valid = adaptTextRubric(raw);
check('CS3223 原文解析为 11 条、8 叶子、100 分', valid.ok && valid.preview.items.length === 11
  && valid.preview.leaves === 8 && valid.preview.total_points === 100);
check('所有条目能逐字切回 rubric 原文', valid.rubric.items.every(x => raw.slice(x.source_ref.start, x.source_ref.end) === x.text));
check('profile 强绑定同一原件哈希', valid.profile.rubric.source_sha256 === valid.rubric.source.sha256);
const flat = adaptTextRubric('1. 结果展示（5 分）\n2. 讨论与结论（7 分）\n');
check('全新平铺 TXT 可解析', flat.ok && flat.preview.leaves === 2 && flat.preview.total_points === 12);
const template = adaptTextRubric(await fs.readFile(path.join(root, 'fixtures/realtime/rubric-template.txt'), 'utf8'));
check('页面提供的格式示例可解析', template.ok && template.preview.leaves === 4 && template.preview.total_points === 40);
check('父项与子项分值冲突时拒收', !adaptTextRubric('一、分析（20 分）\n1. 解释结果（10 分）\n').ok);
check('没有明确分值时拒收', !adaptTextRubric('1. 解释结果\n').ok);
check('正文未编号时拒收', !adaptTextRubric('解释结果（10 分）\n').ok);
check('CRLF 的来源偏移仍可逐字切回', (() => {
  const x = '一、分析（20 分）\r\n1. 解释结果（20 分）\r\n';
  const r = adaptTextRubric(x);
  return r.ok && r.rubric.items.every(it => x.slice(it.source_ref.start, it.source_ref.end) === it.text);
})());
check('UTF-8 BOM 原件哈希与派生 rubric 一致', (() => {
  const bytes = Buffer.from('\ufeff1. 结果展示（5 分）\n');
  const d = decodeRubricUpload('bom.txt', bytes.toString('base64'));
  const r = adaptTextRubric(d.raw);
  return r.ok && r.rubric.source.sha256 === d.sha256;
})());
check('非法 base64 拒收', (() => { try { decodeRubricUpload('r.txt', '!!!!'); return false; } catch { return true; } })());
check('非 UTF-8 拒收', (() => { try { decodeRubricUpload('r.txt', Buffer.from([0xff]).toString('base64')); return false; } catch { return true; } })());

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autograder-rubric-test-'));
const saved = await writeUploadedRubric(temp, { ...decodeRubricUpload('new-rubric.txt', b64), ...valid });
const savedRaw = await fs.readFile(path.join(temp, 'rubric-upload.txt'));
const savedRubric = JSON.parse(await fs.readFile(saved.rubricPath, 'utf8'));
const savedProfile = JSON.parse(await fs.readFile(saved.profilePath, 'utf8'));
check('任务内原件字节、canonical 与 profile 绑定一致', savedRaw.equals(Buffer.from(raw))
  && savedRubric.source.sha256 === savedProfile.rubric.source_sha256
  && savedRubric.source.sha256 === crypto.createHash('sha256').update(savedRaw).digest('hex'));
const port = 21000 + crypto.randomInt(20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(port), '--uploads', temp], {
  cwd: root, stdio: 'ignore', env: { ...process.env, LLM_BASE_URL: 'http://127.0.0.1:9/v1',
    LLM_API_KEY: 'dummy', LLM_MODEL: 'deepseek-flash', REALTIME_QUOTA: '2' },
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/api/cases')).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  check('隔离测试服务器启动', ready);
  if (ready) {
    const page = await (await fetch(base + '/realtime/')).text();
    check('实时页面显示新 rubric 上传与确认入口', page.includes('id="rubricFile"') && page.includes('id="rubricConfirm"'));
    const templateResponse = await fetch(base + '/realtime/rubric-template.txt');
    check('格式示例可从实时站打开', templateResponse.status === 200
      && (await templateResponse.text()).includes('评分标准'));
    const sendPreview = text => fetch(base + '/api/rubric/preview', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_name: 'new-rubric.txt', file_base64: Buffer.from(text).toString('base64') }) });
    const good = await sendPreview(raw);
    const preview = await good.json();
    check('预览 API 返回同一原件哈希与条目', good.status === 200 && preview.ok
      && preview.preview.sha256 === valid.preview.sha256 && preview.preview.leaves === 8);
    const bad = await sendPreview('1. 没有分值\n');
    check('有歧义的 rubric 预览返回 422', bad.status === 422 && (await bad.json()).ok === false);
    const quota = await (await fetch(base + '/api/quota')).json();
    check('预览不消耗实时分析配额', quota.used === 0);
    const rejected = await fetch(base + '/api/analyze', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'upload', file_name: 'report.txt', file_base64: Buffer.from('实验报告').toString('base64'),
        rubric_upload: { file_name: 'new-rubric.txt', file_base64: b64, confirmed_sha256: '0'.repeat(64) } }) });
    check('未确认相同 SHA 的 rubric 不启动分析', rejected.status === 409);
    const quotaAfter = await (await fetch(base + '/api/quota')).json();
    check('拒收未确认 rubric 后配额仍为零', quotaAfter.used === 0);
    // 用故意损坏的 PDF 测试正式提交与任务隔离：L1 会拒绝它，因此绝不会调用外部模型。
    const accepted = await fetch(base + '/api/analyze', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'upload', file_name: 'invalid-report.pdf',
        file_base64: Buffer.from('%PDF-invalid').toString('base64'),
        rubric_upload: { file_name: 'new-rubric.txt', file_base64: b64, confirmed_sha256: valid.preview.sha256 } }) });
    const job = await accepted.json();
    check('确认相同 SHA 后接受新报告与新 rubric', accepted.status === 202 && !!job.job_id && !!job.job_token);
    if (job.job_id) {
      const dir = path.join(temp, 'jobs', job.job_id);
      const source = await fs.readFile(path.join(dir, 'rubric-upload.txt'));
      const canonical = JSON.parse(await fs.readFile(path.join(dir, 'canonical-rubric.json'), 'utf8'));
      const profile = JSON.parse(await fs.readFile(path.join(dir, 'rubric-assessment-profile.json'), 'utf8'));
      check('正式提交的 rubric 三份文件仅在该任务目录', source.equals(Buffer.from(raw))
        && canonical.source.sha256 === valid.preview.sha256
        && profile.rubric.source_sha256 === canonical.source.sha256);
      let state = '';
      for (let i = 0; i < 60; i++) {
        const result = await (await fetch(base + '/api/job/' + job.job_id + '?token=' + job.job_token)).json();
        state = result.state;
        if (state === 'failed' || state === 'done') break;
        await new Promise(r => setTimeout(r, 100));
      }
      check('损坏报告在 L1 即失败，不进入真实模型调用', state === 'failed');
    }
  }
} finally {
  server.kill('SIGKILL');
  if (path.resolve(path.dirname(temp)) === path.resolve(os.tmpdir())
      && path.basename(temp).startsWith('autograder-rubric-test-')) {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
