// _newcheck.mjs —— 新案例检查（小规模，用于冻结）
//
// 检查三项（Yukii 2026-09-25 定）：
//   ① **第一屏是否说对** —— 逐条连同原文上下文给出，供人核对（脚本不替人下结论）
//   ② **是否重复** —— 机械可查：同一引文是否在第一屏出现两次（合并规则生效后应为 0）
//   ③ **折叠区是否埋了关键问题** —— ★ 机械信号：**够格上屏（有依据绑定的内容错误候选 / L3 反证）却被折叠** 的观察。
//      这类"够格但名额不够"的情况必须显式列出来，而不是让它悄悄沉底。
//
// ★ 数据纪律：本脚本用的样本必须**未参与规则制定**（0503/0516 等只做回归，不进这里）。
//
// 用法：node _newcheck.mjs [--out fixtures/veras/out-holdout]

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTeacherView, qualifiesForTop } from './teacherview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(root, argOf('--out', 'fixtures/veras/out-holdout'));
const VDIR = path.join(root, 'fixtures/veras');

const rubric = JSON.parse(await fsp.readFile(path.join(root, 'design/canonical-rubric.veras-pendulum.json'), 'utf8'));
const profile = JSON.parse(await fsp.readFile(path.join(root, 'design/rubric-assessment-profile.veras-pendulum.json'), 'utf8'));
const gold = JSON.parse(await fsp.readFile(path.join(VDIR, 'holdout/holdout.pendulum.json'), 'utf8'));

// ★ 未参与规则制定的新案例（0503/0516 等只做回归）
const NEW_CASES = [
  { id: '2019-calculus-RR03-0655', note: '高质量 · discussion' },
  { id: '2019-calculus-RR03-0820', note: '中高质量 · common' },
  { id: '2019-calculus-RR03-0535', note: '中低质量 · common' },
  { id: '2019-algebra-RR03-0272', note: '低质量 · single' },
];

const L = [];
const stats = { cases: 0, top: 0, dup: 0, buried_qualified: 0, cannot_confirm: 0, warrant_bound: 0, warrant_unbound: 0 };
const json = { rule: '★ 脚本只把材料摆齐；"说对没对"必须人判。', cases: [] };

L.push('# 新案例检查（用于冻结）');
L.push('');
L.push('> 检查三项：**① 第一屏是否说对**（逐条连原文给出，供核对）· **② 是否重复**（机械）· **③ 折叠区是否埋了关键问题**（机械信号：够格上屏却被折叠）。');
L.push('> ★ 这些样本**未参与规则制定**（0503/0516 只做回归，不在其中）。');
L.push('> ★ 未填 ≠ 通过：请逐条核对后在「核对」处标注。');
L.push('');

for (const c of NEW_CASES) {
  const caseFile = c.id + '.txt';
  const art = JSON.parse(await fsp.readFile(path.join(OUT, caseFile + '.assessment.json'), 'utf8'));
  const full = await fsp.readFile(path.join(VDIR, 'holdout', caseFile), 'utf8');
  const idxDoc = await fsp.readFile(path.join(OUT, caseFile + '.index.json'), 'utf8').then(JSON.parse).catch(() => null);
  const parseInfo = idxDoc ? {
    chars: idxDoc.doc?.chars ?? null, entries: (idxDoc.entries ?? []).length,
    warnings: idxDoc.doc?.warnings ?? [], index_file: caseFile + '.index.json', text_file: caseFile + '.txt',
  } : null;

  const view = buildTeacherView({ assessmentArtifact: art, rubric, profile, topN: 3, parseInfo, missingLimit: 3 });
  const g = gold.reports.find(r => r.id === c.id);
  const gTotal = g ? g.dims.reduce((a, b) => a + b, 0) : null;

  // 折叠区里"够格却被折叠"的观察（★ 关键信号）
  const topKeys = new Set(view.whole_report.top_concerns.map(f => `${f.rubric_item_id}|${f.note}`));
  const usedK = new Set([...topKeys,
    ...view.items.flatMap(it => [it.primary_concern, it.primary_strength].filter(Boolean)).map(f => `${f.rubric_item_id}|${f.note}`)]);
  const allConcerns = (art.assessments ?? []).flatMap(a => (a.findings ?? [])
    .filter(f => f.polarity === 'concern')
    .map(f => ({ id: f.rubric_item_id, ...f })));
  const buriedQualified = allConcerns.filter(f => !usedK.has(`${f.rubric_item_id}|${f.note}`) && qualifiesForTop({
    anchored: !!(f.located || f.verification), warrant: f.warrant ?? null, verification: f.verification ?? null,
  }));

  // 重复检测（第一屏内同引文）
  const normQ = s => String(s ?? '').replace(/[\s\p{P}]+/gu, '').toLowerCase();
  const qs = view.whole_report.top_concerns.map(f => normQ(f.warrant?.student_quote ?? f.quote ?? '')).filter(Boolean);
  const dup = qs.length - new Set(qs).size;

  stats.cases++; stats.top += view.whole_report.top_concerns.length; stats.dup += dup;
  stats.buried_qualified += buriedQualified.length;
  stats.cannot_confirm += (view.whole_report.possibly_missing?.entries ?? []).filter(e => e.status === 'cannot_confirm').length;
  const wAll = (art.assessments ?? []).flatMap(a => (a.findings ?? []).map(f => f.warrant)).filter(Boolean);
  stats.warrant_bound += wAll.filter(w => w.bound).length;
  stats.warrant_unbound += wAll.filter(w => !w.bound).length;

  L.push(`## ${c.id}（gold ${gTotal}/35 · ${g?.status ?? '?'} · ${c.note} · 正文 ${full.length} 字）`);
  L.push('');
  L.push(`- 第一屏：**${view.whole_report.top_concerns.length}** 条（上限 3）· 折叠 concern ${view.whole_report.folded_count} 条 · 内容错误候选（已绑定）${wAll.filter(w => w.bound).length} 条 / 未绑定 ${wAll.filter(w => !w.bound).length} 条`);
  L.push(`- 机械检查：第一屏重复引文 **${dup}**（应为 0）· ★ **够格却被折叠** **${buriedQualified.length}** 条`);
  L.push('');

  if (!view.whole_report.top_concerns.length) {
    L.push('### ① 第一屏：（空）—— 没有合格观察（不凑满）');
    L.push('');
  } else {
    L.push('### ① 第一屏（逐条核对）');
    L.push('');
    view.whole_report.top_concerns.forEach((f, i) => {
      const ids = f.rubric_item_ids ?? [f.rubric_item_id];
      const q = f.warrant?.student_quote ?? f.quote ?? '';
      L.push(`**${i + 1}. [${ids.join(' / ')}] ${f.kind}${f.severity ? '/' + f.severity : ''}**　${f.anchored ? '可回原文核对' : '⚠ 无法核对'}`);
      L.push('');
      L.push(`- 观察：${f.note}`);
      if (q) {
        const at = full.indexOf(q);
        const ctx = at >= 0 ? full.slice(Math.max(0, at - 90), at) + '⟨' + q + '⟩' + full.slice(at + q.length, at + q.length + 90)
          : `**（引文在原文中找不到）** ${q}`;
        L.push(`- 原文上下文：`);
        L.push('');
        L.push('  ```text');
        L.push('  ' + ctx.replace(/\n/g, ' '));
        L.push('  ```');
      } else {
        L.push('- 原文上下文：**（无引文）**');
      }
      if (f.warrant?.bound) {
        L.push(`- ★ 内容错误候选（依据已绑定，内容待核对）：`);
        L.push(`  - 错在哪：${f.warrant.what_is_wrong}`);
        L.push(`  - 依据（${f.warrant.basis_kind}）：${f.warrant.basis_detail}`);
      }
      if (f.verification) L.push(`- L3 机械验证：\`${f.verification.check_id}\` → ${f.verification.stance}`);
      L.push(`- 核对（待填）：① 这条说对了吗 \`是 / 否 / 部分\`　② 严重程度是否过头 \`是 / 否\`　③ 是否有更该先看的被埋 \`____\``);
      L.push('');
    });
  }

  if (buriedQualified.length) {
    L.push('### ③ ★ 折叠区里"够格却被折叠"的（名额限制）');
    L.push('');
    for (const f of buriedQualified) {
      L.push(`- [${f.id}] ${f.kind}${f.severity ? '/' + f.severity : ''}：${String(f.note).slice(0, 200)}`);
      L.push(`  - ${f.warrant?.bound ? '有依据绑定的内容错误候选' : ''}${f.verification?.stance === 'fail' ? '｜有 L3 反证' : ''} ← 与第一屏同级别，因 N=3 上限被挤下`);
    }
    L.push('');
  }

  const pm = view.whole_report.possibly_missing;
  if (pm?.entries?.length) {
    L.push('### 待核查 · 可能缺少的关键内容');
    L.push('');
    for (const e of pm.entries) {
      L.push(`- [${e.rubric_item_id}] ${e.statement}`);
      L.push(`  - 检查范围：已解析 ${e.check_scope.parsed_chars} 字 / ${e.check_scope.parsed_entries} 条结构条目 / 解析警告 ${e.check_scope.parse_warnings} 条`);
    }
    L.push('');
  }
  L.push('---');
  L.push('');

  json.cases.push({
    id: c.id, gold_total: gTotal, status: g?.status ?? null, text_chars: full.length,
    top: view.whole_report.top_concerns.map(f => ({
      ids: f.rubric_item_ids ?? [f.rubric_item_id], kind: f.kind, severity: f.severity, anchored: f.anchored,
      note: f.note, quote: f.warrant?.student_quote ?? f.quote ?? null,
      warrant: f.warrant?.bound ? { what_is_wrong: f.warrant.what_is_wrong, basis_kind: f.warrant.basis_kind, basis_detail: f.warrant.basis_detail } : null,
    })),
    buried_qualified: buriedQualified.map(f => ({ id: f.id, kind: f.kind, severity: f.severity, note: f.note })),
    duplicate_in_top: dup,
    possibly_missing: pm?.entries ?? [],
  });
}

L.push('## 汇总（机械部分）');
L.push('');
L.push(`- 检查样本：${stats.cases} 份 · 第一屏合计 ${stats.top} 条 · ★ 主动去重后**重复引文 ${stats.dup} 条**`);
L.push(`- ★ **够格却被折叠**：${stats.buried_qualified} 条（这是"折叠区埋关键"的机械信号）`);
L.push(`- 内容错误候选：已绑定 ${stats.warrant_bound} / 未绑定 ${stats.warrant_unbound}`);
L.push(`- 待核查里标"无法确认"的：${stats.cannot_confirm} 条`);
L.push('');
L.push('> ★ 本文件只说明**机械部分**（重复、够格被埋、计数）。"第一屏是否说对"必须人判 → 见 `newcheck-findings.md`。');

json.summary = stats;
await fsp.writeFile(path.join(OUT, 'newcheck-sheet.md'), L.join('\n') + '\n', 'utf8');
await fsp.writeFile(path.join(OUT, 'newcheck.json'), JSON.stringify(json, null, 2) + '\n', 'utf8');

console.log(`新案例检查表已生成：${stats.cases} 份`);
for (const c of json.cases) {
  console.log(`  ${c.id}  gold ${c.gold_total}/35  第一屏 ${c.top.length} 条  重复 ${c.duplicate_in_top}  ★够格被折叠 ${c.buried_qualified.length}  待核查 ${c.possibly_missing.length}`);
}
console.log(`  汇总：第一屏 ${stats.top} 条 · 重复 ${stats.dup} · 够格被折叠 ${stats.buried_qualified} · 内容错误候选 ${stats.warrant_bound} 绑定/${stats.warrant_unbound} 未绑定`);
console.log('  产出：fixtures/veras/out-holdout/newcheck-sheet.md · newcheck.json');
