// _smoke.mjs —— 服务端走查（启动 → 打各端点 → 停止）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const require = createRequire(import.meta.url);
const { buildTeacherScores } = require('./teacherui.export.js');

const PORT = 8099;
const B = 'http://localhost:' + PORT;
const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), '--port', String(PORT)],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', d => { log += d; });
srv.stderr.on('data', d => { log += d; });

const t = async (name, fn) => {
  try { console.log('  ' + name + ' → ' + await fn()); }
  catch (e) { console.log('  ' + name + ' → ERR ' + String(e.message).slice(0, 70)); }
};

for (let i = 0; i < 40; i++) { try { const r = await fetch(B + '/api/cases'); if (r.ok) break; } catch {} await new Promise(s => setTimeout(s, 300)); }

console.log('=== 服务端走查 ===');
await t('GET /api/cases', async () => { const r = await fetch(B + '/api/cases'); const j = await r.json(); return r.status + ' presets=' + j.presets.length + ' rubrics=' + j.rubrics.length; });
await t('GET /', async () => { const r = await fetch(B + '/'); const s = await r.text(); return r.status + ' ' + (s.length / 1024 | 0) + 'KB'; });
await t('GET /cases/cs3223(PDF 案例)', async () => { const r = await fetch(B + '/cases/cs3223-writeup.pdf.html'); const s = await r.text(); return r.status + ' ' + (s.length / 1024 | 0) + 'KB 含内联PDF=' + s.includes('data:application/pdf'); });
await t('GET /cases/veras(纯文本案例)', async () => { const r = await fetch(B + '/cases/2019-calculus-RR03-0503.txt.html'); const s = await r.text(); return r.status + ' ' + (s.length / 1024 | 0) + 'KB'; });
await t('GET /api/job/nope（应 404）', async () => { const r = await fetch(B + '/api/job/nope'); return r.status; });
await t('POST /api/analyze 无密钥（应 503 且有提示）', async () => {
  const r = await fetch(B + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'preset', case: 'cs3223-writeup.pdf' }) });
  const j = await r.json(); return r.status + ' ' + String(j.error || '').slice(0, 34);
});
await t('路径穿越防护（应 404/500，不得读到 design/）', async () => { const r = await fetch(B + '/cases/../../design/rubric-assessment.schema.json'); return r.status; });

// ★ 导出（用同一份纯函数构造教师给分）
const view = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/real/out/cs3223-writeup.pdf.teacher-view.json'), 'utf8'));
const profile = JSON.parse(fs.readFileSync(path.join(root, 'design/rubric-assessment-profile.cs3223-test.json'), 'utf8'));
const maxByItem = {};
for (const i of profile.items ?? []) if (i.scorable === true && Number.isInteger(i.scoring_strategy?.max)) maxByItem[i.rubric_item_id] = i.scoring_strategy.max;
const states = {};
view.items.forEach((it, i) => { states[it.rubric_item_id] = { verdict: i === 0 ? 'inaccurate' : 'accurate', score: Math.floor((maxByItem[it.rubric_item_id] || 0) / 2), note: null }; });
const ts = buildTeacherScores({ view, states, maxByItem, opts: { sourceReport: 'cs3223-writeup.pdf', rubricId: view.rubric?.rubric_id ?? null, confirmed: true, teacherName: '走查' } });
await t('POST /api/export（教师给分层校验）', async () => {
  const r = await fetch(B + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ teacher_scores: ts, filename: '_smoke-teacher-scores', case: 'cs3223-writeup.pdf', profile: 'design/rubric-assessment-profile.cs3223-test.json' }) });
  const j = await r.json();
  return r.status + ' saved=' + j.saved + ' 教师层错误=' + JSON.stringify(j.teacher_layer_errors);
});

srv.kill('SIGKILL');
console.log('=== 服务端日志 ===');
console.log(log.trim().split('\n').slice(0, 6).join('\n'));
