// _repoaudit.mjs —— 仓库提交内容审计：列出会入库/被排除的文件，标出风险项
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));

const globToRe = g => {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '§DS§').replace(/\*\*/g, '§D§').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/§DS§/g, '(?:.*/)?').replace(/§D§/g, '.*');
  return new RegExp('^' + esc + '$');
};
const res = rules.map(r => ({ raw: r, re: globToRe(r.replace(/^\//, '')) }));
const ignored = rel => res.some(r => r.re.test(rel) || r.re.test(path.basename(rel)));

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) walk(full);
    else files.push({ rel, size: fs.statSync(full).size });
  }
})(root);

const kept = files.filter(f => !ignored(f.rel));
const excluded = files.filter(f => ignored(f.rel));
const sum = a => a.reduce((s, x) => s + x.size, 0);
const fmt = n => n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';

console.log('=== 仓库提交审计 ===');
console.log('  会入库：' + kept.length + ' 个文件，合计 ' + fmt(sum(kept)));
console.log('  被排除：' + excluded.length + ' 个文件，合计 ' + fmt(sum(excluded)));

const top = [...kept].sort((a, b) => b.size - a.size).slice(0, 12);
console.log('\n  入库文件中最大的 12 个：');
for (const f of top) console.log('    ' + fmt(f.size).padStart(9) + '  ' + f.rel);

// 风险检查
const RISK = [
  { name: '疑似密钥/凭据', re: /(^|\/)(\.env|secrets\.json|.*\.key)$/i },
  { name: '样本原件（PDF）', re: /\.pdf$/i },
  { name: '上传件/产物目录', re: /^fixtures\/uploads\// },
  { name: '一次性脚本/临时文件', re: /(^|\/)_(p\d+|mem).*\.(py|mjs)$/ },
  { name: '大文件（>5MB）', re: null },
];
console.log('\n  风险项：');
let risk = 0;
for (const r of RISK) {
  const hits = r.re ? kept.filter(f => r.re.test(f.rel)) : kept.filter(f => f.size > 5 * 1024 * 1024);
  if (hits.length) { risk += hits.length; console.log('    ⚠ ' + r.name + '：' + hits.length + ' 个 → ' + hits.slice(0, 4).map(h => h.rel).join(', ')); }
}
// 内容层：扫密钥字样
const secretRe = /sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|authorization)\s*[:=]\s*["'][^"']{16,}/;
const textExt = /\.(mjs|js|json|py|html|md|yaml|yml|txt)$/i;
const leaky = [];
for (const f of kept) {
  if (!textExt.test(f.rel) || f.size > 2 * 1024 * 1024) continue;
  const t = fs.readFileSync(path.join(root, f.rel), 'utf8');
  if (secretRe.test(t)) leaky.push(f.rel);
}
console.log('  ' + (leaky.length ? '⚠ 内容里疑似密钥：' + leaky.join(', ') : '✓ 入库文本文件中未发现硬编码密钥'));
console.log(risk || leaky.length ? '\n  → 请先处理以上项再提交。' : '\n  ✓ 未发现风险项。');
