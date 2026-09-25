// 比赛版 TXT rubric 适配器：只识别带明确整数分值的编号条目，绝不补写标准或分值。
// 预览和正式提交都调用同一函数；正式提交按原件哈希重新解析，不能信任浏览器预览。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validator.mjs';
import { validateProfile } from './l4.mjs';

export const MAX_RUBRIC_BYTES = 128 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const design = path.join(here, '..', 'design');
const rubricSchema = JSON.parse(readFileSync(path.join(design, 'canonical-rubric.schema.json'), 'utf8'));
const profileSchema = JSON.parse(readFileSync(path.join(design, 'rubric-assessment-profile.schema.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function decodeRubricUpload(fileName, base64) {
  if (typeof fileName !== 'string' || !/\.txt$/i.test(fileName)) throw new Error('新 rubric 目前只支持 UTF-8 .txt');
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_RUBRIC_BYTES * 4 / 3) + 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('rubric 文件编码无效或超过 128 KB');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_RUBRIC_BYTES || bytes.toString('base64') !== base64) {
    throw new Error('rubric 文件编码无效或超过 128 KB');
  }
  let raw;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Buffer 保留 UTF-8 BOM；source_ref 偏移与原始字节哈希必须指向同一份原件。
    raw = bytes.toString('utf8');
  }
  catch { throw new Error('rubric 必须是 UTF-8 文本'); }
  if (raw.includes('\0')) throw new Error('rubric 不能包含 NUL 字符');
  return { bytes, raw, sha256: sha256(bytes) };
}

export function adaptTextRubric(raw, sourceName = 'rubric-upload.txt') {
  const errors = [], warnings = [];
  const bytes = Buffer.from(raw, 'utf8');
  const sourceSha = sha256(bytes);
  const lines = raw.split('\n');
  const rows = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    if (line.trim()) rows.push({ line: i + 1, text: line, start: offset, end: offset + line.length });
    offset += lines[i].length + 1;
  }
  const items = [], titles = [];
  let mode = null, parent = null, topNo = 0, childNo = 0;
  const scoreRe = /([0-9]{1,4})\s*(分|points?|pts?)/gi;

  for (const row of rows) {
    const t = row.text.trim();
    const chinese = t.match(/^[一二三四五六七八九十百]+[、．.]\s*/);
    const arabic = t.match(/^\d{1,2}[.、)]\s*/);
    if (!chinese && !arabic) {
      if (!items.length && !scoreRe.test(t)) titles.push(row.text);
      else errors.push(`第 ${row.line} 行无法识别为编号评分条目；请改成「一、标题（20 分）」或「1. 条目（10 分）」`);
      scoreRe.lastIndex = 0;
      continue;
    }
    scoreRe.lastIndex = 0;
    const scores = [...t.matchAll(scoreRe)];
    if (scores.length !== 1) {
      errors.push(`第 ${row.line} 行必须有且只有一个明确整数分值（如 10 分或 10 points）`);
      continue;
    }
    const points = Number(scores[0][1]);
    if (!Number.isInteger(points) || points < 1 || points > 1000) {
      errors.push(`第 ${row.line} 行分值必须是 1–1000 的整数`);
      continue;
    }
    let id, parentId;
    if (chinese) {
      if (mode === 'flat') errors.push(`第 ${row.line} 行出现中文父项，但前面已有平铺条目；请统一层级`);
      mode = 'hierarchy'; id = `R${++topNo}`; parentId = null; parent = id; childNo = 0;
    } else if (mode === 'hierarchy') {
      if (!parent) { errors.push(`第 ${row.line} 行找不到父项`); continue; }
      id = `${parent}.${++childNo}`; parentId = parent;
    } else {
      mode = 'flat'; id = `R${++topNo}`; parentId = null;
    }
    items.push({
      id, parent: parentId, depth: parentId ? 1 : 0, order: items.length + 1,
      text: row.text, score_raw: scores[0][0],
      source_ref: { file: sourceName, sha256: sourceSha, page: null, row: null, start: row.start, end: row.end },
      derived_by: 'numbering', children: [],
    });
  }
  for (const it of items) if (it.parent) items.find(p => p.id === it.parent)?.children.push(it.id);
  const leaves = items.filter(it => !it.children.length);
  if (!leaves.length) errors.push('没有可评分条目');
  if (leaves.length > 20) errors.push('比赛版最多支持 20 个可评分条目，以限制等待时间和模型费用');
  if (titles.length) warnings.push(`前置标题/说明 ${titles.length} 行没有作为评分条目：${titles.join(' / ').slice(0, 120)}`);

  const scoreOf = it => Number((it.score_raw.match(/\d+/) || [])[0]);
  const scoreConsistency = [];
  for (const it of items.filter(x => x.children.length)) {
    const sum = it.children.reduce((n, id) => n + scoreOf(items.find(x => x.id === id)), 0);
    const ok = sum === scoreOf(it);
    scoreConsistency.push({ rubric_item_id: it.id, parent_score: it.score_raw, children_sum: `${sum} 分`, ok,
      ...(!ok ? { note: '父项分值与子项之和不一致；请修改原始 TXT 后重新上传，系统不会调整分值' } : {}) });
    if (!ok) errors.push(`${it.id} 原文分值 ${scoreOf(it)} 与子项合计 ${sum} 不一致`);
  }
  const textVerbatimOk = items.every(it => raw.slice(it.source_ref.start, it.source_ref.end) === it.text);
  if (!textVerbatimOk) errors.push('条目文本无法逐字切回原件');
  const tag = sourceSha.slice(0, 16);
  const rubric = {
    rubric_id: `rb_upload_${tag}`, frozen_at: new Date().toISOString(), immutable: true,
    generator: 'rubric-adapt/upload-text-v1',
    source: { file: sourceName, sha256: sourceSha, kind: 'text', adapter: 'upload-text-v1', chars: raw.length },
    items,
    validation: { text_verbatim_ok: textVerbatimOk, line_coverage: `${items.length}/${rows.length}`,
      unparsed_lines: titles, score_consistency: scoreConsistency,
      notes: ['条目正文与分值逐字来自上传 TXT；层级仅由编号确定，未使用模型改写或补分。'] },
  };
  const profile = {
    profile_id: `rap_upload_${tag}`, version: 1, status: 'provisional_test',
    notes: '上传 TXT 派生的执行配置；上传者在页面核对条目与分值，系统不验证其教师身份。只用于定性评价与教师给分，不生成 AI 分数。',
    rubric: { rubric_id: rubric.rubric_id, source_sha256: sourceSha },
    items: items.map(it => it.children.length
      ? { rubric_item_id: it.id, scorable: false, aggregation: { type: 'sum_children', children: it.children } }
      : { rubric_item_id: it.id, scorable: true,
          scoring_strategy: { type: 'points', min: 0, max: scoreOf(it), step: 1 },
          strategy_source_ref: { file: sourceName, start: it.source_ref.start, end: it.source_ref.end } }),
  };
  const vr = validate(rubricSchema, rubric), vp = validate(profileSchema, profile), linked = validateProfile(profile, rubric);
  if (!vr.ok) errors.push(...vr.errors.slice(0, 3).map(x => `rubric schema：${x.path} ${x.msg}`));
  if (!vp.ok) errors.push(...vp.errors.slice(0, 3).map(x => `profile schema：${x.path} ${x.msg}`));
  if (!linked.ok) errors.push(...linked.errors.slice(0, 3).map(x => `profile 绑定：${x}`));
  return { ok: errors.length === 0, errors, warnings, rubric, profile,
    preview: { sha256: sourceSha, source_name: sourceName, line_coverage: rubric.validation.line_coverage,
      unparsed_lines: titles,
      leaves: leaves.length, total_points: leaves.reduce((n, it) => n + scoreOf(it), 0),
      items: items.map(it => ({ id: it.id, parent: it.parent, text: it.text,
        points: scoreOf(it), scorable: it.children.length === 0 })) } };
}

export async function writeUploadedRubric(jobDir, upload) {
  if (!upload?.ok || !upload.bytes || upload.rubric?.source?.sha256 !== sha256(upload.bytes)) {
    throw new Error('rubric 原件与规范化结果不一致，拒绝写入');
  }
  const rubricPath = path.join(jobDir, 'canonical-rubric.json');
  const profilePath = path.join(jobDir, 'rubric-assessment-profile.json');
  await fsp.writeFile(path.join(jobDir, 'rubric-upload.txt'), upload.bytes);
  await fsp.writeFile(rubricPath, JSON.stringify(upload.rubric, null, 2) + '\n', 'utf8');
  await fsp.writeFile(profilePath, JSON.stringify(upload.profile, null, 2) + '\n', 'utf8');
  return { rubricPath, profilePath };
}
