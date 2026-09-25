// _mklist.mjs —— 生成「准备提交的文件清单」文档（分类 + 排除说明）
// 用法：先 `git add -A --dry-run` 得到清单，或直接读 .gitignore 规则由 git 判断
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = execFileSync('git', ['add', '-A', '--dry-run'], { cwd: root, encoding: 'utf8' });
const files = raw.split(/\r?\n/).map(l => l.replace(/^add '/, '').replace(/'$/, '')).filter(Boolean).sort();

const bt = String.fromCharCode(96);   // 反引号，避免被 shell 误解析
const code = s => bt + s + bt;

const cat = f => {
  if (/^src\/.*\.(mjs|js)$/.test(f)) return '代码';
  if (/^(Dockerfile|render\.yaml|\.dockerignore|\.gitignore|README\.md)$/.test(f)) return '配置与文档';
  if (/^design\/.*\.schema\.json$/.test(f)) return 'schema';
  if (/^design\/.*(canonical-rubric|assessment-profile).*\.json$/.test(f)) return 'rubric / profile 定义';
  if (/^design\/.*\.example\.(json|txt)$/.test(f) || /^design\/rubric.*\.(txt|json)$/.test(f)) return '示例与标注';
  if (/^design\/.*\.md$/.test(f)) return '设计文档';
  if (/^fixtures\/(web|realtime)\//.test(f)) return '网页';
  return '其他';
};
const groups = {};
for (const f of files) (groups[cat(f)] ||= []).push(f);

const L = [];
L.push('# 准备提交的文件清单（共 ' + files.length + ' 个）', '');
L.push('> 生成方式：' + code('git add -A --dry-run') + '（尊重 ' + code('.gitignore') + '，权威口径）。');
L.push('> 原则：**只保留运行所需的代码、配置、schema 与网页文件**；运行输出、原始报告、教师工作表、日志、密钥一律排除。', '');
for (const [k, v] of Object.entries(groups)) {
  L.push('## ' + k + '（' + v.length + '）', '');
  for (const f of v) L.push('- ' + code(f));
  L.push('');
}
L.push('---', '', '## 已排除（要点）', '');
L.push('- **密钥**：' + code('.env*') + '、' + code('*.key') + '、' + code('secrets.json') + '、' + code('.npmrc'));
L.push('- **运行输出**：' + code('fixtures/out/') + '、' + code('fixtures/**/out*/') + '、' + code('*.out.txt') + '、' + code('*.index.json') + '、' + code('src/*.txt') + '、' + code('src/*.pid'));
L.push('- **原始报告与测试夹具**：' + code('fixtures/report*.pdf|html|docx|txt') + '、' + code('fixtures/real/*.pdf'));
L.push('- **教师工作表**：' + code('design/teacher-scores*.json') + '、' + code('design/*-work.json'));
L.push('- **用户数据**：' + code('fixtures/uploads/') + '（上传原件与分析产物）');
L.push('- **本地样本与数据集**：' + code('fixtures/veras/'));
L.push('- **日志与本地工具**：' + code('*.log') + '、' + code('*.err') + '、' + code('tools/') + '（cloudflared 二进制 ~55MB）');
L.push('', '## 两个说明', '');
L.push('- ' + code('fixtures/web/cases/*.html') + ' 由 ' + code('src/_mksite.mjs') + ' 生成，但**保留入库** —— 否则演示站点没有页面内容，无法直接部署。');
L.push('- ' + code('src/') + ' 下另有若干开发期探针（如 ' + code('_apiprobe.mjs') + '、' + code('_pdfprobe.mjs') + '），体积很小；如需更精简可再移除。');

fs.writeFileSync(path.join(root, 'SUBMISSION-FILES.md'), L.join('\n') + '\n', 'utf8');
console.log('SUBMISSION-FILES.md 已生成：' + files.length + ' 个文件，' + Object.keys(groups).length + ' 个类别');
for (const [k, v] of Object.entries(groups)) console.log('  ' + k + '：' + v.length);
