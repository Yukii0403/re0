// _selftest.mjs —— L1 回归测试（零依赖，不读入真实文件；真实文件见 _realtest.mjs）
// 用法: node _selftest.mjs   结果写入 _selftest.out.txt

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  classify, mergeRuns, buildIndex, verify, detectRepeats, bodySizeOf,
  parseXml, docxLines, tagOf, findFirst, textOf, attrOf, run as runL1,
  detectTables, splitCells, verifyTables,
} from './l1.mjs';
import { bindQuote, allOccurrences } from './quote-binding.mjs';
import { validate } from './validator.mjs';
import { runCheck, buildBundleIndex, KIND_OPERATORS, normalizeUnit, parseNumeric, spanIsUnstructured, REASONS, ALL_CODES, renderStatement, preconditionsOf, CALL_REJECT_CODES, llmTools, isCompleteNumericToken, allCompleteTokens, inferDimSourceStatus, DIM_SOURCE_STATUSES, dimFromEvidence, L3_VERSION } from './verify-tools.mjs';
import { createRunner } from './toolcalling.mjs';
import { l2Tools, validatePlanArgs, planFromArgs, applyHardRule, resolveCandidates, assembleEvidence } from './l2.mjs';
import * as L4 from './l4.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = [];
const log = s => out.push(s);
let fail = 0;

function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    log(`        got  ${JSON.stringify(got)}`);
    log(`        want ${JSON.stringify(want)}`);
  }
}

const PAGE_H = 841.92;
const L = (text, o) => ({ text, page: 1, pageH: PAGE_H, ...o });

// ★ 量纲来源状态：数值 span 操作数必须表态（枚举）。合成夹具一律按"守规矩的生产者"自动补
//   （inline＝值自带单位 / cited＝另给依据 / undeclared＝找不到来源）。
//   专门测「漏表态」「表态与原文不符」的用例会**故意**绕过这个助手。
const st = (quote, spec = {}) => ({ dim_source_status: inferDimSourceStatus(quote, spec) });

// ---- 夹具：坐标/字号/字体名全部取自在真实 PDF 上实测到的值
// ---- 特别注意：缩进在文本层里没有空格字符，只能靠 x 反推（正文 x=45.0，代码 51→70.8→90.6）
const pdfFixture = [
  L('人工智能实验报告 · 2021150xxx · 张同学', { y: 788, x: 45, size: 8, font: 'g_d0_f14' }),
  L('实验二 模型调参与分析', { y: 771.42, x: 45, size: 16, font: 'g_d0_f1' }),
  L('1 实验目的', { y: 739.17, x: 45, size: 12, font: 'g_d0_f11' }),
  L('本实验旨在验证不同学习率对模型收敛速度的影响，并观察注意力模块在消融实验中的作用。', { y: 715.92, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('PyTorch 2.1 完成，训练集为 CIFAR-10 的子集，共 10000 张图像。', { y: 697.17, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('为控制变量，除学习率外其余超参数保持一致：批大小 64，优化器 Adam，训练 300 轮，', { y: 674.67, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('评价指标采用验证集准确率与验证损失。', { y: 655.92, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('2 实验方法', { y: 626.67, x: 45, size: 12, font: 'g_d0_f11' }),
  L('本实验采用交叉熵损失衡量模型收敛情况，损失函数定义如下。', { y: 603.42, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('L = -1/N * sum(y_i * log(y_hat_i)) (1)', { y: 580.17, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('其中 N 为批内样本数，y_i 为真实标签的独热编码，y_hat_i 为模型输出的预测概率。', { y: 557.67, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('如下所示。', { y: 538.92, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('def train(model, loader, lr):', { y: 511.17, x: 51, size: 9, font: 'g_d0_f17' }),
  L('opt = Adam(model.parameters(), lr=lr)', { y: 497.67, x: 70.79, size: 9, font: 'g_d0_f17' }),
  L('for x, y in loader:', { y: 484.92, x: 70.79, size: 9, font: 'g_d0_f17' }),
  L('loss = criterion(model(x), y)', { y: 472.17, x: 90.59, size: 9, font: 'g_d0_f17' }),
  L('loss.backward()', { y: 458.67, x: 90.59, size: 9, font: 'g_d0_f17' }),
  L('3 实验结果', { y: 400.17, x: 45, size: 12, font: 'g_d0_f11' }),
  L('三组学习率下验证损失的下降曲线如图所示。', { y: 376.92, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('图 3 不同学习率下的验证损失曲线', { y: 240, x: 227.6, size: 9, font: 'g_d0_f14' }),
  L('如图 3 所示，学习率取 0.01 时模型在前 200 轮收敛速度明显优于其他设置，但后期出现轻微振荡；', { y: 218, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('率取 0.001 时曲线更为平滑，但收敛显著更慢。', { y: 198, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('4 消融实验', { y: 170, x: 45, size: 12, font: 'g_d0_f11' }),
  L('为验证各模块的贡献，我们逐一移除组件并记录准确率变化，结果如表 4 所示。', { y: 146, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('表 4 各模块消融对比', { y: 84, x: 45, size: 10.5, font: 'g_d0_f14' }),
  L('深圳大学 计算机与软件学院', { y: 56, x: 45, size: 8, font: 'g_d0_f14' }),
];

eq('正文字号按字符数加权估计（不被代码块带偏）', bodySizeOf(pdfFixture), 10.5);

const cls = classify(pdfFixture);
eq('PDF 逐行类型', cls.map(b => b.type), [
  'paragraph', 'heading', 'heading',
  'paragraph', 'paragraph', 'paragraph', 'paragraph',
  'heading', 'paragraph', 'formula', 'paragraph', 'paragraph',
  'code', 'code', 'code', 'code', 'code',
  'heading', 'paragraph', 'figure', 'paragraph', 'paragraph',
  'heading', 'paragraph', 'table', 'paragraph',
]);
eq('PDF 编号抓取', cls.map(b => b.num), [
  null, null, '1', null, null, null, null, '2', null, null, null, null,
  null, null, null, null, null, '3', null, '3', null, null, '4', null, '4', null,
]);
eq('PDF 标题层级（12pt 对 10.5pt 必须判出来）', cls.map(b => b.level), [
  null, 1, 2, null, null, null, null, 2, null, null, null, null,
  null, null, null, null, null, 2, null, null, null, null, 2, null, null, null,
]);

// 页眉页脚：重复 + 位置，只打标签不删除
const multi = [];
for (const p of [1, 2, 3, 4]) {
  multi.push({ text: '人工智能实验报告 · 2021150xxx · 张同学', page: p, pageH: PAGE_H, x: 45, y: 788, size: 8 });
  multi.push({ text: `正文第 ${p} 页的内容`, page: p, pageH: PAGE_H, x: 45, y: 500, size: 10.5 });
  multi.push({ text: `第 ${p} 页`, page: p, pageH: PAGE_H, x: 45, y: 56, size: 8 });
}
const reps = detectRepeats(multi, 4);
eq('页眉页脚识别（数字归一化后跨页重复）', [...reps].sort((a, b) => a - b), [0, 2, 3, 5, 6, 8, 9, 11]);
eq('页眉页脚被正确打标', classify(pdfFixture, { repeats: new Set([0, 25]) }).map(b => b.type).filter(t => t === 'header' || t === 'footer'), ['header', 'footer']);

// ---- 段落合并
const merged = mergeRuns(cls, { bodySize: 10.5 });
eq('合并后类型序列', merged.map(b => b.type), [
  'paragraph', 'heading', 'heading',
  'paragraph', 'paragraph',
  'heading', 'paragraph', 'formula', 'paragraph',
  'code',
  'heading', 'paragraph', 'figure', 'paragraph',
  'heading', 'paragraph', 'table', 'paragraph',
]);
eq('合并后每个块占几行', merged.map(b => b.lines), [1, 1, 1, 2, 2, 1, 1, 1, 2, 5, 1, 1, 1, 2, 1, 1, 1, 1]);
eq('合并后块数', merged.length, 18);
eq('段内不断句（第一段合并了两行）', merged[3].text.includes('\n'), true);
eq('段间不误合（第二个段落首行独立）', merged[5].text, '2 实验方法');
eq('代码块合并成一整块', merged[9].text.split('\n').length, 5);

// ---- 自写 XML 走查：必须保序
const tree = parseXml(`<a x="1" y='2'><b/><c>t&amp;t</c><!--注释--><b/></a>`);
eq('parseXml 保留子节点顺序', findFirst(tree, 'a').map(tagOf), ['b', 'c', 'b']);
eq('parseXml 解码实体', textOf(findFirst(tree, 'c')), 't&t');
eq('parseXml 双引号属性', attrOf(tree, 'a', 'x'), '1');
eq('parseXml 单引号属性', attrOf(tree, 'a', 'y'), '2');

const docxXml = `<w:document xmlns:w="W" xmlns:m="M"><w:body>
<w:p><w:r><w:t>第一段</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二段</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>code line</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:sz w:val="30"/></w:rPr><w:t>1.1 标题</w:t></w:r></w:p>
<w:p><w:r><w:drawing/></w:r></w:p>
<w:p><w:r><w:t>图 1 架构</w:t></w:r></w:p>
<w:p><w:r><m:oMath><m:t>x=1</m:t></m:oMath></w:r></w:p>
</w:body></w:document>`;
const dl = docxLines(docxXml);
eq('docx 段落/表格顺序未被重排', dl.lines.map(l => l.text),
  ['第一段', 'A1\tB1', '第二段', 'code line', '1.1 标题', '', '图 1 架构', 'x=1']);
eq('docx 逐行类型', classify(dl.lines).map(b => b.type),
  ['paragraph', 'table', 'heading', 'code', 'heading', 'figure', 'figure', 'formula']);
eq('docx 表格单元格以 \\t 分隔', dl.lines[1].text, 'A1\tB1');
eq('docx 无 Heading 样式时靠编号+加粗兜住', classify(dl.lines)[4].level, 2);

// ---- 偏移对齐
const dup = ['重复行', '其他', '重复行'];
const dupEntries = buildIndex(dup.join('\n'), dup.map(t => ({ text: t, type: 'paragraph' })));
eq('重复行偏移不错位', dupEntries.map(e => e.start), [0, 4, 7]);

let threw = false;
try { buildIndex('abc', [{ text: 'xyz', type: 'paragraph' }]); } catch { threw = true; }
eq('块文本缺失时抛错而非静默', threw, true);

let skippedEmpty = false;
{
  const e = buildIndex('AB\nCD', [{ text: '', type: 'figure' }, { text: 'AB', type: 'paragraph' }, { text: 'CD', type: 'paragraph' }]);
  skippedEmpty = e.length === 2 && e[0].type === 'paragraph' && e[1].start === 3;
}
eq('空文本块被跳过且后续偏移正确', skippedEmpty, true);

// ---- 发布出去的示例文件必须自洽
const txt = await fs.readFile(path.join(here, '..', 'design', 'document-index.example.txt'), 'utf8');
const idx = JSON.parse(await fs.readFile(path.join(here, '..', 'design', 'document-index.example.json'), 'utf8'));
const v = verify(txt, idx.entries);
eq('示例文件 substringOk', v.substringOk, true);
eq('示例文件 offset 单调', v.monotonic, true);
eq('示例文件 offset 不越界', v.inBounds, true);
eq('示例文件 chars 字段与正文长度一致', idx.doc.chars, txt.length);
eq('示例文件条目数', idx.entries.length, 13);
eq('示例文件 lines 合计等于正文行数', idx.entries.reduce((n, e) => n + e.lines, 0), txt.split('\n').length);
eq('示例文件 line_coverage 与条数一致', idx.doc.line_coverage, `${idx.entries.length}/${txt.split('\n').length}`);

// ---- 最小表格行列还原（示例文件里的那张表）
const vtEx = verifyTables(txt, idx.tables);
eq('示例文件：每个单元格也能按 start:end 逐字切回正文', vtEx.ok, true);
eq('示例文件：识别出 1 张表，列头不含数字 → 判为列头',
  idx.tables.length === 1 && idx.tables[0].header_detected === true, true);
eq('示例文件：列头逐字正确',
  idx.tables[0].columns.map(c => c.text), ['配置', '验证准确率', '训练时长(min)']);
eq('示例文件：行标签就是第一个单元格',
  idx.tables[0].rows.map(r => r.label), ['baseline', '+ attention', '+ attention + 数据增强']);
eq('示例文件：★ 按 (列头, 行标签) 能唯一确定一个单元格 —— 「选对对象」机械化的入口',
  (() => {
    const t = idx.tables[0];
    const ci = t.columns.findIndex(c => c.text === '验证准确率');
    const row = t.rows.find(r => r.label === '+ attention');
    return ci === 1 && row.cells[ci].text === '0.847';
  })(), true);
eq('示例文件：表格列数与列头一致、无截断',
  idx.tables[0].column_count === 3 && idx.tables[0].truncated === false && idx.tables[0].truncated_at === null, true);
eq('示例文件：表格所属条目带 table_id', idx.entries.filter(e => e.table_id === 't0001').length, 4);
eq('示例文件：文档里声明了表数量（与 tables 长度一致）', idx.doc.tables, idx.tables.length);
eq('示例文件：表可用于键值查询，列边界来源被标注（示例是文本空格判据）',
  idx.tables[0].key_query_safe === true && idx.tables[0].cell_split_source === 'text_wide_space', true);

// ---- 最小表格行列还原：边界（合成条目，专测判据本身）
const mkTableEntries = body => {
  let k = 0;
  return body.split('\n').map((t, i) => {
    const s = body.indexOf(t, k); k = s + t.length;
    return { id: 'e' + String(i + 1).padStart(4, '0'), text: t, lines: 1, start: s, end: s + t.length };
  });
};
const head3 = '列A  列B  列C\nx  1  2\ny  3  4';
eq('表格边界：列数不一致的行**不被吞进表里**，而是在下一行显式标出截断',
  (() => {
    const body = '列A  列B\nx  1\ny  2  3';
    const r = detectTables(body, mkTableEntries(body));
    return r.tables.length === 1 && r.tables[0].rows.length === 1 &&
      r.tables[0].truncated === true && r.tables[0].truncated_at === 'e0003';
  })(), true);
eq('表格边界：单行不成表（必须 ≥2 行）',
  detectTables('a  1  2', mkTableEntries('a  1  2')).tables.length, 0);
eq('表格边界：列间只有单空格 → 不认它是表格（宁可不认，也不猜错）',
  detectTables('a b\n1 2', mkTableEntries('a b\n1 2')).tables.length, 0);
eq('表格边界：首行含数字 → 不设列头（不猜）',
  (() => {
    const body = 'a  1\nb  2';
    const r = detectTables(body, mkTableEntries(body));
    return r.tables[0].header_detected === false && r.tables[0].columns === null && r.tables[0].rows.length === 2;
  })(), true);
eq('表格边界：只有列头 + 1 个数据行 → 认它是表',
  (() => {
    const body = '列A  列B\nx  1';
    const r = detectTables(body, mkTableEntries(body));
    return r.tables.length === 1 && r.tables[0].rows.length === 1;
  })(), true);
eq('表格边界：docx 的 \\t 也当列边界（回退判据）',
  splitCells(0, 'x\t1').map(c => c.text).join('|'), 'x|1');
eq('表格边界：一个条目里的多行（docx 整张表是一个条目）也能还原',
  (() => {
    const body = '列A\t列B\nx\t1\ny\t2';
    const es = mkTableEntries(body);
    es[0].lines = 3;                       // docx：整张表是一个块
    const r = detectTables(body, es);
    return r.tables.length === 1 && r.tables[0].rows.length === 2 && r.tables[0].rows[1].label === 'y';
  })(), true);
eq('表格边界：几何 cell_breaks 优先于文本判据（"a b  1" 里单空格不是边界，但几何说它是）',
  (() => {
    const text = 'a b  1';
    return splitCells(0, text, [{ start: 1, end: 2 }]).map(c => c.text).join('|');
  })(), 'a|b  1');
eq('表格边界：3 列表正常还原', (() => {
  const r = detectTables(head3, mkTableEntries(head3));
  return r.tables.length === 1 && r.tables[0].column_count === 3 && r.tables[0].rows.length === 2;
})(), true);
eq('表格边界：图注在表**下方**也要认出来（中文报告里很常见，真实夹具就是这样）',
  (() => {
    const body = '列A  列B\nx  1\ny  2\n表 7 某对照实验';
    const es = mkTableEntries(body);
    es[3].type = 'table';
    const r = detectTables(body, es);
    return r.tables[0].caption_entry === 'e0004';
  })(), true);

// ---- canonical rubric：文本逐字 + 层级可核 + 分值只校验不改
const rbTxt = await fs.readFile(path.join(here, '..', 'design', 'rubric.example.txt'), 'utf8');
const cr = JSON.parse(await fs.readFile(path.join(here, '..', 'design', 'canonical-rubric.example.json'), 'utf8'));
eq('canonical rubric：每条 text 都能按 source_ref 逐字切回原件',
  cr.validation.text_verbatim_ok === true &&
  cr.items.every(it => rbTxt.slice(it.source_ref.start, it.source_ref.end) === it.text), true);
eq('canonical rubric：sha256 绑定教师原件（冻结凭据是原件哈希）',
  cr.source.sha256 === createHash('sha256').update(Buffer.from(rbTxt, 'utf8')).digest('hex'), true);
eq('canonical rubric：行覆盖 + 显式未归入行 = 非空总行数（不静默丢行）',
  Number(cr.validation.line_coverage.split('/')[0]) + cr.validation.unparsed_lines.length ===
  rbTxt.split('\n').filter(t => t.trim()).length, true);
eq('canonical rubric：不可变，且 parent/children 互为逆关系',
  cr.immutable === true &&
  cr.items.every(it => it.children.every(c => cr.items.find(x => x.id === c).parent === it.id) &&
    (it.parent === null || cr.items.find(x => x.id === it.parent).children.includes(it.id))), true);
eq('canonical rubric：每条 item 都带层级判据 derived_by（层级是派生结构）',
  cr.items.every(it => !!it.derived_by), true);
eq('canonical rubric：父子分值不一致被标出且未被自动改正',
  cr.validation.score_consistency.filter(c => c.ok === false).length === 1 &&
  cr.validation.score_consistency.filter(c => c.ok === false).every(c => !!c.note), true);
eq('canonical rubric：支持两级以上（大评分点 + 子评分点）',
  cr.items.some(i => i.depth === 0) && cr.items.some(i => i.depth === 1), true);

// ---- L2 证据示例：对着真实文件（report.pdf）的三方自洽
const fxOut = path.join(here, '..', 'fixtures', 'out');
if (!(await exists(path.join(fxOut, 'report.pdf.index.json')))) {
  log('（首次运行：先对 fixtures/report.pdf 跑一遍 L1）');
  await runL1(path.join(here, '..', 'fixtures', 'report.pdf'), fxOut);
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
const rTxt = await fs.readFile(path.join(fxOut, 'report.pdf.txt'), 'utf8');
const rIdx = JSON.parse(await fs.readFile(path.join(fxOut, 'report.pdf.index.json'), 'utf8'));
const planBody = await fs.readFile(path.join(here, '..', 'design', 'retrieval-plan.example.json'), 'utf8');
const pl = JSON.parse(planBody);
const l2doc = await fs.readFile(path.join(here, '..', 'design', 'L2-evidence-focus.md'), 'utf8');
const ev = JSON.parse(await fs.readFile(path.join(here, '..', 'design', 'evidence-candidates.example.json'), 'utf8'));
const allKeys = (o, acc = []) => {
  if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
  else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
  return acc;
};
const spans = ev.evidence.flatMap(e => e.spans);

eq('L2 示例：每个 span 的 quote 都能按 source_ref + offset 逐字切回原文',
  spans.every(s => rTxt.slice(s.offset.start, s.offset.end) === s.quote), true);
eq('L2 示例：source_ref 指向的就是这份作业原件',
  spans.every(s => s.source_ref.sha256 === ev.doc.sha256 && s.source_ref.file === ev.doc.name), true);
eq('L2 示例：source_ref.entry 确实覆盖该 span 范围',
  spans.every(s => {
    const e = rIdx.entries.find(x => x.id === s.source_ref.entry);
    return !!e && s.offset.start >= e.start && s.offset.end <= e.end;
  }), true);
eq('L2 示例：原始上下文确实是从原文切出来的',
  spans.every(s =>
    rTxt.slice(Math.max(0, s.offset.start - s.context.before.length), s.offset.start) === s.context.before &&
    rTxt.slice(s.offset.end, s.offset.end + s.context.after.length) === s.context.after), true);
eq('L2 示例：多 span bundle 存在（一条证据可由多处原文共同构成）',
  ev.evidence.every(e => e.spans.length >= 1) && ev.evidence.some(e => e.spans.length > 1), true);
eq('L2 示例：asset_refs 指向的资产真实存在',
  ev.evidence.flatMap(e => e.asset_refs ?? []).every(a => existsSync(path.join(here, '..', a.ref))), true);

// ---- 引用绑定：重复 quote 必须能绑到不同位置（这是本次修的 bug）
const dupQuote = ev.evidence.filter(e => e.spans.some(s => s.binding.occurrences > 1))[0]?.spans[0].quote;
const occ = allOccurrences(rTxt, dupQuote);
eq('引用绑定：测试前提成立（该引用在原文里确实出现多次）', occ.length > 1, true);
const dupBundles = ev.evidence.filter(e => e.spans[0].quote === dupQuote);
eq('引用绑定：示例里同一 quote 被绑到了不同偏移',
  dupBundles.length >= 2 && new Set(dupBundles.map(e => e.spans[0].offset.start)).size === dupBundles.length, true);
eq('引用绑定：旧实现 indexOf(首次出现) 会让它们撞在同一处（对照）',
  new Set(dupBundles.map(() => String(rTxt.indexOf(dupQuote)))).size, 1);
const bA = bindQuote(rTxt, dupQuote, { entryHint: dupBundles[0].spans[0].source_ref.entry, entries: rIdx.entries });
const bB = bindQuote(rTxt, dupQuote, { entryHint: dupBundles[1].spans[0].source_ref.entry, entries: rIdx.entries });
eq('引用绑定：entry_hint 生效且两处不同',
  bA.start !== bB.start && bA.mode === 'entry_hint' && bB.mode === 'entry_hint', true);
const bNone = bindQuote(rTxt, dupQuote, { entries: rIdx.entries });
eq('引用绑定：无提示时取首次出现并显式标记歧义',
  bNone.mode === 'first' && bNone.ambiguous === true, true);
const bCursor = bindQuote(rTxt, dupQuote, { entries: rIdx.entries, cursor: bNone.end + 1 });
eq('引用绑定：游标推进能拿到下一处',
  bCursor.start > bNone.start && bCursor.mode === 'cursor', true);
eq('引用绑定：找不到时明确失败而不是静默兜底',
  bindQuote(rTxt, '这段文字根本不在原文里', { entries: rIdx.entries }).ok, false);

eq('L2 示例：权威链三处哈希一致（authority / rubric 引用 / canonical 原件）',
  ev.authority.rubric_sha256 === cr.source.sha256 && ev.rubric.sha256 === cr.source.sha256, true);
eq('L2 示例：rubric 只引用不复制（权威只有一处）',
  Object.keys(ev.rubric).sort().join(',') === 'file,frozen_at,rubric_id,sha256', true);
eq('L2 示例：plan 只引用不复制，且哈希指向 plan 文件真实字节',
  Object.keys(ev.retrieval_plan).sort().join(',') === 'batch_id,file,pinned,plan_id,sha256,version' &&
  ev.retrieval_plan.sha256 === createHash('sha256').update(Buffer.from(planBody, 'utf8')).digest('hex'), true);
eq('L2 示例：plan 已版本化、已批内固定、有修订留痕',
  pl.version >= 1 && pl.pinned === true && pl.revision_log.length >= 1, true);
eq('L2 示例：plan 与 rubric 强绑定（rubric_sha256 = 原件哈希）',
  pl.rubric_sha256 === cr.source.sha256, true);
eq('L2 示例：plan 覆盖 canonical rubric 的所有条目（含汇总型父项）',
  cr.items.every(it => pl.items.some(p => p.rubric_item_id === it.id)), true);
eq('L2 示例：每个 facet 都带 form / modality / channels 三个维度',
  pl.items.every(s => s.facets.every(f =>
    ['value', 'relation', 'narrative', 'procedure'].includes(f.form) &&
    f.modality.length > 0 && f.channels.length > 0)), true);
eq('L2 示例：plan 不参与评分（权威声明里写死）',
  ev.authority.scoring_authority === 'rubric' && ev.authority.plan_participates_in_scoring === false, true);

eq('L2 示例：每个 facet 都有诊断记录（含 0 命中的）',
  pl.items.reduce((n, s) => n + s.facets.length, 0) === ev.diagnostics.facet_coverage.length, true);
eq('L2 示例：诊断里 status 与 outcome 分离，取值都在枚举内',
  ev.diagnostics.facet_coverage.every(f =>
    ['complete', 'partial', 'source_unavailable', 'channel_error'].includes(f.status) &&
    ['located', 'no_candidate', 'undetermined'].includes(f.outcome)), true);
eq('L2 示例：读不到 / 通道出错时不许记成 no_candidate（必须是 undetermined）',
  ev.diagnostics.facet_coverage.every(f =>
    !['source_unavailable', 'channel_error'].includes(f.status) || f.outcome === 'undetermined'), true);
eq('L2 示例：rubric_item_summary 与证据条数一致',
  cr.items.every(ri => {
    const rec = ev.diagnostics.rubric_item_summary.find(x => x.rubric_item_id === ri.id);
    const n = ev.evidence.filter(x => x.rubric_item_id === ri.id).length;
    return !!rec && rec.candidates === n;
  }), true);
eq('L2 示例：诊断被显式标记为 diagnostic_only',
  ev.diagnostics.diagnostic_only === true, true);
eq('L2 示例：产物任何层级都不存在 recall 字段（诊断不会被冒充成召回）',
  allKeys(ev).every(k => !/recall/i.test(k)), true);
eq('L2 示例：证据条目字段集合固定（结构上无法产生评分字段）',
  ev.evidence.every(e => Object.keys(e).every(k =>
    ['id', 'rubric_item_id', 'facet_id', 'spans', 'asset_refs', 'note'].includes(k))), true);
eq('L2 示例：证据引用的 rubric_item 与 facet 都真实存在（item 可为任意深度）',
  ev.evidence.every(e =>
    cr.items.some(r => r.id === e.rubric_item_id) &&
    (pl.items.find(s => s.rubric_item_id === e.rubric_item_id)?.facets ?? []).some(f => f.id === e.facet_id)), true);
eq('L2 示例：盲点被记录在 R 阶段',
  pl.items.some(s => (s.blind_spots ?? []).length > 0), true);
eq('L2 示例：advisory_lint 被标为 advisory 且只扫模型生成的字段',
  ev.advisory_lint.advisory === true &&
  ev.advisory_lint.scanned_fields.every(f => !/quote|context|source_ref/.test(f)), true);
eq('L2 示例：advisory_lint 只是提示（命中也不阻断产物写出）',
  ev.advisory_lint.advisory === true && typeof ev.advisory_lint.passed === 'boolean', true);
eq('L2 示例：advisory_lint 误伤了合法技术术语（「验证准确率」命中「准确」）—— 它不能当硬闸的活证据',
  ev.advisory_lint.violations.some(v => v.word === '准确'), true);
eq('已删除「quote 不能含 facet 措辞」的错误规则（设计文档里明确记录了这次删除）',
  l2doc.includes('这条是错的，已删除'), true);

// ---- 真正的 schema 校验：四份示例都必须过各自的 schema
const schemaPairs = [
  ['document-index.schema.json', 'document-index.example.json'],
  ['canonical-rubric.schema.json', 'canonical-rubric.example.json'],
  ['retrieval-plan.schema.json', 'retrieval-plan.example.json'],
  ['evidence-candidates.schema.json', 'evidence-candidates.example.json'],
  ['verification-checks.schema.json', 'verification-checks.example.json'],
];
for (const [s, d] of schemaPairs) {
  const sc = JSON.parse(await fs.readFile(path.join(here, '..', 'design', s), 'utf8'));
  const dd = JSON.parse(await fs.readFile(path.join(here, '..', 'design', d), 'utf8'));
  let r;
  try { r = validate(sc, dd); } catch (e) { r = { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; }
  eq(`schema 校验通过：${d}`, r.ok, true);
  if (!r.ok) for (const e of r.errors.slice(0, 5)) log(`        ${e.path} ${e.msg}`);
}

// ---- validator 自身的 fail-closed 行为
let vThrewUnknown = false;
try { validate({ type: 'object', totallyUnknownKeyword: 1 }, {}); } catch { vThrewUnknown = true; }
eq('validator：遇到未支持的关键字会抛错（fail-closed，不静默忽略）', vThrewUnknown, true);
let vThrewFormat = false;
try { validate({ type: 'string', format: 'email' }, 'x'); } catch { vThrewFormat = true; }
eq('validator：遇到未实现的 format 会抛错', vThrewFormat, true);
eq('validator：缺必填字段会被抓出',
  validate({ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, {}).ok, false);
eq('validator：additionalProperties:false 会抓出多余字段',
  validate({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { a: 'x', b: 1 }).ok, false);
eq('validator：const 生效', validate({ const: 'rubric' }, 'score').ok, false);
eq('validator：$ref 能解析', validate({ $defs: { X: { type: 'integer' } }, type: 'object', properties: { n: { $ref: '#/$defs/X' } } }, { n: 'x' }).ok, false);

// ---- L3 机械验证：核心是「可以少验证，不可以错验证」
const vf = JSON.parse(await fs.readFile(path.join(here, '..', 'design', 'verification-checks.example.json'), 'utf8'));
const vfSchemaBody = await fs.readFile(path.join(here, '..', 'design', 'verification-checks.schema.json'), 'utf8');
const evBody2 = await fs.readFile(path.join(here, '..', 'design', 'evidence-candidates.example.json'), 'utf8');
const bundleIndex = buildBundleIndex(ev);
const evSpans = ev.evidence.flatMap(e => e.spans);
const judged = vf.checks.filter(c => c.stance === 'pass' || c.stance === 'fail');

eq('L3 示例：★ pass / fail 只在操作数选择无歧义时产出（降级规则）',
  judged.every(c => c.operands.every(o => o.ok && o.selection === 'unambiguous')), true);
eq('L3 示例：每个 span 通道操作数的 quote 都能按其 offset 逐字切回原文',
  vf.checks.flatMap(c => c.operands).filter(o => o.ok && o.offset && o.quote)
    .every(o => rTxt.slice(o.offset.start, o.offset.end) === o.quote), true);
eq('L3 示例：★ 每个表格通道操作数的单元格也能按其 offset 逐字切回原文',
  vf.checks.flatMap(c => c.operands).filter(o => o.ok && o.cell)
    .every(o => rTxt.slice(o.cell.offset.start, o.cell.offset.end) === o.cell.text), true);
eq('L3 示例：每条 check 的 claim 都能按其 offset 逐字切回原文（审计行）',
  vf.checks.every(c => rTxt.slice(c.claim.offset.start, c.claim.offset.end) === c.claim.quote), true);
eq('L3 示例：存在「标签无法唯一确定对象」的用例',
  vf.checks.some(c => c.operands.some(o => o.selection === 'ambiguous')), true);
eq('L3 示例：存在「值贴着标签也找不到」的用例（ck0006）',
  vf.checks.find(c => c.id === 'ck0006')?.reason_codes.some(r => r === 'operand_quote_not_in_declared_span' || r === 'operand_quote_not_near_label'), true);
eq('L3 示例：★ 量纲对照 —— 同一个算式，给了依据 → pass；不给 → unverified(unknown_dimension)',
  vf.checks.find(c => c.id === 'ck0001')?.stance === 'pass' &&
  vf.checks.find(c => c.id === 'ck0002')?.reason_codes.includes('unknown_dimension'), true);
eq('L3 示例：没有量纲依据时记 unknown（不是 ratio、也不是 scalar）',
  vf.checks.find(c => c.id === 'ck0002')?.operands.every(o => o.dim === 'unknown'), true);

// ★★ 表格键值查询：定位歧义消掉了，但选对业务对象仍由模型负责
eq('L3 示例：★ 键值查询（表 id + 行标签 + 列头）不碰 span 也能取到数并算出结果（ck0010 pass）',
  vf.checks.find(c => c.id === 'ck0010')?.stance === 'pass' &&
  Math.abs(vf.checks.find(c => c.id === 'ck0010').computed.value - 0.035) < 1e-12, true);
eq('L3 示例：键值查询返回原始单元格内容 + 行列标题 + 单位来源 + source_ref',
  (() => {
    const o = vf.checks.find(c => c.id === 'ck0010')?.operands[0];
    return o.cell.cell_id === 't0001:r2:c2' && o.cell.text === '0.847' &&
      o.row.label === '+ attention' && o.column.header === '验证准确率' &&
      o.unit_source.marker === '准确率' && o.source_ref.entry === 'e0018' &&
      rTxt.slice(o.unit_source.offset.start, o.unit_source.offset.end) === '验证准确率';
  })(), true);
eq('L3 示例：★ 派生来源逐字段标注（查询=模型 / 结构=L1 规则 / 列边界=几何 / 单位=列头）',
  (() => {
    const o = vf.checks.find(c => c.id === 'ck0010')?.operands[0];
    return o.query_source === 'model_supplied' && o.provenance.query === 'model_supplied' &&
      o.provenance.table_structure === 'l1_rule_parse' && o.provenance.cell_split === 'pdf_geometry' &&
      o.provenance.unit === 'column_header' && o.structure_source.origin === 'l1_rule_parse';
  })(), true);
eq('L3 示例：★ 选错表（table_id 不存在）→ 零匹配 → unverified(table_not_found)',
  vf.checks.find(c => c.id === 'ck0011')?.stance === 'unverified' &&
  vf.checks.find(c => c.id === 'ck0011')?.reason_codes.includes('table_not_found'), true);
eq('L3 示例：★ 选错指标（列名写错）→ 零匹配 → unverified(column_not_found)，程序不替模型猜',
  vf.checks.find(c => c.id === 'ck0012')?.stance === 'unverified' &&
  vf.checks.find(c => c.id === 'ck0012')?.reason_codes.includes('column_not_found') &&
  vf.checks.find(c => c.id === 'ck0012')?.operands[0].columns.includes('验证准确率'), true);
eq('L3 示例：unverified 都带了原因',
  vf.checks.filter(c => c.stance === 'unverified').every(c => c.reason_codes.length > 0), true);
eq('L3 示例：本层不产生分数（authority 里写死）', vf.authority.layer_produces_score === false, true);
// ★ 键名守卫必须按**整个键名**判定，不能按子串 ——
//   子串会把 dim_source.marker 当成 mark（分数）。这是本项目第三次踩到「子串匹配误伤」。
const SCORE_KEYS = new Set(['recall', 'score', 'scores', 'point', 'points', 'grade', 'grades', 'credit', 'credits', 'mark', 'marks']);
const SCORE_ALLOWED = ['layer_produces_score', 'scoring_authority', 'not_scoring', 'plan_participates_in_scoring'];
const looksLikeScoreKey = k => !SCORE_ALLOWED.includes(k) && (SCORE_KEYS.has(String(k).toLowerCase()) || /recall/i.test(k));
eq('L3 示例：产物无 recall / 分数类字段', allKeys(vf).every(k => !looksLikeScoreKey(k)), true);
eq('L3 示例：键名守卫本身不误伤（dim_source.marker 曾被 /mark/ 子串误判）',
  allKeys(vf).includes('marker') && !looksLikeScoreKey('marker'), true);
eq('L3 示例：证据引用绑定到 L2 产物的真实字节哈希',
  vf.evidence.sha256 === createHash('sha256').update(Buffer.from(evBody2, 'utf8')).digest('hex'), true);
eq('L3 示例：L1 索引引用绑定到索引文件的真实字节哈希',
  vf.index.sha256 === createHash('sha256').update(Buffer.from(await fs.readFile(path.join(fxOut, 'report.pdf.index.json'), 'utf8'), 'utf8')).digest('hex') &&
  vf.index.tables === rIdx.tables.length, true);
eq('L3 示例：检查种类与算子的映射在工具层闭合',
  vf.checks.every(c => KIND_OPERATORS[c.kind].includes(c.operator)), true);
eq('L3 示例：诊断计数与 checks 一致',
  vf.diagnostics.counts.pass === vf.checks.filter(c => c.stance === 'pass').length &&
  vf.diagnostics.counts.fail === vf.checks.filter(c => c.stance === 'fail').length &&
  vf.diagnostics.counts.unverified === vf.checks.filter(c => c.stance === 'unverified').length, true);

// ★★ 措辞不进产物；模板只有一份（renderStatement），且 fail 必须四项前置条件全真
eq('L3 示例：★ 产物里没有任何自由措辞字段 —— 展示句由程序生成',
  !allKeys(vf).some(k => /^(statement|message|comment|explanation|reason_text|wording|verdict_text|prose)$/i.test(k)) &&
  vf.checks.every(c => !('statement' in c)), true);
eq('L3 示例：★ 展示句 pass 为 null、非 pass 必带免责句，且不含评价性表述',
  vf.checks.filter(c => c.stance === 'pass').every(c => renderStatement(c) === null) &&
  vf.checks.filter(c => c.stance !== 'pass').every(c => renderStatement(c).includes('不表示对学生的评价')) &&
  vf.checks.map(c => renderStatement(c) ?? '').every(s => !/(学生|同学)[^，。]{0,6}(算错|写错|做错)|不合格|不达标|优秀|较差/.test(s)), true);
eq('L3 示例：★ reason_codes 全部在枚举内（未知码不可能出现）',
  vf.checks.flatMap(c => c.reason_codes).every(c => ALL_CODES.includes(c)), true);
eq('L3 示例：★ schema 里 reason_codes 的 enum 与工具层的码表完全一致（唯一的措辞来源）',
  (() => {
    const sc = JSON.parse(vfSchemaBody);
    const en = sc.properties.checks.items.properties.reason_codes.items.enum;
    return en.length === ALL_CODES.length && en.every(c => ALL_CODES.includes(c));
  })(), true);
eq('L3 示例：★ 非 pass 的项都带 basis 与四项前置条件',
  vf.checks.filter(c => c.stance !== 'pass').every(c => c.basis?.preconditions &&
    ['input_binding', 'rule_applicable', 'tolerance_policy', 'computation_complete']
      .every(k => typeof c.basis.preconditions[k] === 'boolean')), true);
eq('L3 示例：★ 每条 fail 的四项前置条件全为 true，且诊断里留了实测值',
  vf.diagnostics.fail_precondition_status.every(x => x.all_true === true) &&
  vf.diagnostics.fail_precondition_status.length === vf.checks.filter(c => c.stance === 'fail').length, true);

// 负例：选择无歧义、span 结构化，但算术不成立（用 ev0008 的单行表体 + ev0009 列头作为量纲依据）
const DIM_ACC = { bundle_id: 'ev0009', span_index: 0, quote: '验证准确率' };
const CLAIM_ATTN_Q = { bundle_id: 'ev0005', span_index: 0, quote: '注意力模块带来约 3.5 个百分点的提升' };
const failProbe = runCheck(rTxt, bundleIndex, evSpans, {
  id: 'ck9001', kind: 'numeric_recompute', operator: 'difference',
  claim: CLAIM_ATTN_Q,
  operands: [
    { bundle_id: 'ev0008', span_index: 2, quote: '0.861', label: '+ attention + 数据增强 0.861 9.8', dim_evidence: DIM_ACC, dim_source_status: 'cited' },
    { bundle_id: 'ev0008', span_index: 0, quote: '0.812', label: 'baseline 0.812 6.4', dim_evidence: DIM_ACC, dim_source_status: 'cited' },
  ],
  expected: { bundle_id: 'ev0005', span_index: 0, quote: '3.5 个百分点', label: '约 3.5 个百分点', ...st('3.5 个百分点') },
  tolerance: 'abs_0_5',   // ★ 故意传一个数值明显不同的容差
}, rIdx);
eq('L3 工具：选择无歧义 + span 结构化但算术不成立 → fail（fail 路径通）', failProbe.stance, 'fail');
eq('L3 工具：该 fail 不是由选择或结构问题造成的（唯一的码是 check_not_upheld）',
  JSON.stringify(failProbe.reason_codes), JSON.stringify(['check_not_upheld']));
eq('L3 工具：★ fail 的四项前置条件全为 true —— 这才是「判断正确」的依据，不是那句措辞',
  Object.values(failProbe.basis.preconditions).every(Boolean), true);
eq('L3 工具：★ 容差由服务端决定 —— 传入的 abs_0_5 被忽略，用 difference 登记的 rel_5pct',
  failProbe.tolerance, 'rel_5pct');
eq('L3 工具：★ 展示句由程序生成，只能表述「机械检查不成立」，且产物里不存这句话',
  renderStatement(failProbe).includes('机械检查不成立') &&
  renderStatement(failProbe).includes('不表示对学生的评价') &&
  !('statement' in failProbe) &&
  !/学生[^，。]{0,6}(算错|写错|做错)/.test(renderStatement(failProbe)), true);

let tOp = false;
try { runCheck(rTxt, bundleIndex, evSpans, { id: 'x', kind: 'numeric_recompute', operator: 'eval_python', operands: [] }); } catch { tOp = true; }
eq('L3 工具：算子不在枚举内 → 抛错（fail-closed）', tOp, true);
let tKind = false;
try { runCheck(rTxt, bundleIndex, evSpans, { id: 'x', kind: 'unit_check', operator: 'difference', operands: [] }); } catch { tKind = true; }
eq('L3 工具：kind 与算子不匹配 → 抛错', tKind, true);
// 容差不再抛错 —— 它被整体忽略（服务端按算子决定），模型没有这个自由度
const tTol = runCheck(rTxt, bundleIndex, evSpans, {
  id: 'x', kind: 'numeric_recompute', operator: 'difference', tolerance: 'any',
  claim: CLAIM_ATTN_Q,
  operands: [
    { bundle_id: 'ev0008', span_index: 2, quote: '0.861', label: '+ attention + 数据增强 0.861 9.8', dim_evidence: DIM_ACC },
    { bundle_id: 'ev0008', span_index: 0, quote: '0.812', label: 'baseline 0.812 6.4', dim_evidence: DIM_ACC },
  ],
}, rIdx);
eq('L3 工具：容差不在枚举内也不再抛错 —— 它被整体忽略，用服务端登记值', tTol.tolerance, 'rel_5pct');

// ================= ★ 表格键值查询边界（合成 L1 索引，专测五类降级）=================
// 自带一套最小夹具，避免依赖后面的合成夹具（声明顺序会咬人）
const tkFull = '部分 0.5';
const tkSpan = { offset: { start: 0, end: tkFull.length }, source_ref: { file: 'synth-table.txt', sha256: 'stt', page: 1, entry: 'eTK' } };
const tkB = buildBundleIndex({ evidence: [{ id: 'evTK', spans: [tkSpan] }] });
const tkClaim = { bundle_id: 'evTK', span_index: 0, quote: '部分 0.5' };
const tkRun = (operands, idx = tkIdx) => runCheck(tkFull, tkB, [tkSpan], {
  id: 'ckTK', kind: 'numeric_recompute', operator: 'difference', claim: tkClaim, operands,
}, idx);
const tkq = (row_label, column, table_id = 't0001') => ({ table_id, row_label, column });

// 列头既有能判出量纲的（准确率 → ratio；时长(min) → duration），也有判不出的（列D）
// 行标签 '乙' 出现两次，用来测多匹配
const TK_TXT = [
  '配置  准确率  时长(min)  列D',
  '甲  0.1  10  7',
  '乙  0.2  20  8',
  '乙  0.3  30  9',
  '丙  0.4  40  10',
  '汇总  0.5  50  11',
].join('\n');
const mkIdx = (txt, opts = {}) => {
  let off = 0;
  const entries = txt.split('\n').map((t, i) => {
    const start = txt.indexOf(t, off); off = start + t.length;
    return { id: 'e' + String(i + 1).padStart(4, '0'), type: 'paragraph', num: null, level: null, page: 1, lines: 1, start, end: start + t.length, text: t, table_id: null };
  });
  const { tables, owner } = detectTables(txt, entries);
  for (const e of entries) e.table_id = owner.get(e.id) ?? null;
  const t0 = tables[0];
  if (t0 && opts.unsafe) t0.key_query_safe = false;
  if (t0 && opts.dupColumn) t0.columns = [...t0.columns, { ...t0.columns[1] }];   // 列头重名
  return { tables, entries, doc: { name: 'synth-table.txt', sha256: 'stt', kind: 'pdf', chars: txt.length, text_file: 'synth-table.txt', tables } };
};
const tkIdx = mkIdx(TK_TXT);

eq('表格边界 · 夹具前提：识别出 4 列且 key_query_safe',
  tkIdx.tables[0]?.column_count === 4 && tkIdx.tables[0]?.key_query_safe === true &&
  tkIdx.tables[0]?.cell_split_source === 'text_wide_space', true);
eq('表格边界 · 两张表同名行/列时，表格身份是必须的（table_id 在查询里）',
  tkq('甲', '准确率').table_id, 't0001');
eq('表格边界 · 键值查询：命中唯一单元格，返回 cell_id / 行标签 / 列头 / 单位来源 / source_ref',
  (() => {
    const o = tkRun([tkq('甲', '准确率'), tkq('汇总', '准确率')]).operands[0];
    return o.ok === true && o.cell.cell_id === 't0001:r1:c2' && o.cell.text === '0.1' &&
      o.row.label === '甲' && o.column.header === '准确率' && o.source_ref.entry === 'e0002' &&
      o.unit_source.marker === '准确率' && o.unit_source.via === 'keyword' &&
      o.query.table_id === 't0001' && o.query_source === 'model_supplied' &&
      o.provenance.table_structure === 'l1_rule_parse' && o.dim === 'ratio';
  })(), true);
eq('表格边界 · 单元格是裸数字，量纲一律取自列头（不是单元格自己声明）',
  (() => {
    const o = tkRun([tkq('甲', '时长(min)'), tkq('汇总', '时长(min)')]).operands[0];
    return o.ok === true && o.dim === 'duration' && o.unit_source.via === 'unit_marker' &&
      o.unit_source.marker === 'min' && o.base_value === 10 * 60;
  })(), true);
eq('★ 表格边界 · 列单位不明确（列头推不出量纲）→ unverified(column_unit_undetermined)',
  (() => {
    const c = tkRun([tkq('甲', '列D'), tkq('汇总', '列D')]);
    return c.stance === 'unverified' && c.reason_codes.includes('column_unit_undetermined');
  })(), true);
eq('表格边界 · 零匹配：行标签不存在 → row_label_not_found',
  tkRun([tkq('不存在', '准确率'), tkq('汇总', '准确率')]).operands[0].reasons, ['row_label_not_found']);
eq('表格边界 · 零匹配：列头不存在 → column_not_found',
  tkRun([tkq('甲', '列Z'), tkq('汇总', '准确率')]).operands[0].reasons, ['column_not_found']);
eq('表格边界 · 多匹配：行标签出现多次 → row_label_ambiguous',
  tkRun([tkq('乙', '准确率'), tkq('汇总', '准确率')]).operands[0].reasons, ['row_label_ambiguous']);
eq('表格边界 · 多匹配：列头重名 → column_ambiguous',
  (() => {
    const idx = mkIdx(TK_TXT, { dupColumn: true });
    return tkRun([tkq('甲', '准确率'), tkq('汇总', '准确率')], idx).operands[0].reasons;
  })(), ['column_ambiguous']);
eq('表格边界 · 表不可用于键值查询（key_query_safe=false）→ table_not_key_query_safe',
  (() => {
    const idx = mkIdx(TK_TXT, { unsafe: true });
    return tkRun([tkq('甲', '准确率'), tkq('汇总', '准确率')], idx).operands[0].reasons;
  })(), ['table_not_key_query_safe']);
eq('表格边界 · table_id 不存在 → table_not_found，且查询原样回带（审计能看到模型想去哪张表）',
  (() => {
    const o = tkRun([tkq('甲', '准确率', 't0099'), tkq('汇总', '准确率')]).operands[0];
    return o.reasons[0] === 'table_not_found' && o.table_id === 't0099' && o.query.table_id === 't0099';
  })(), true);
eq('表格边界 · 未传 L1 索引时，表格通道一律 table_not_found（不会静默当成 span 去猜）',
  (() => {
    const c = runCheck(tkFull, tkB, [tkSpan], {
      id: 'ckTK', kind: 'numeric_recompute', operator: 'difference', claim: tkClaim,
      operands: [tkq('甲', '准确率'), tkq('汇总', '准确率')],
    });
    return c.stance === 'unverified' && c.operands[0].reasons[0] === 'table_not_found';
  })(), true);

// ================= ★ fail 的四项前置条件：逐项断电测试 =================
const goodPre = {
  def: { operator: 'difference' }, allowedOps: ['difference'],
  toleranceName: 'rel_5pct', tol: { kind: 'rel', value: 0.05 },
  ops: [{ ok: true, selection: 'unambiguous', span_structured: true }],
  claim: { ok: true },
  computation: { computed: 1, expected: 0, delta: { abs: 1 } },
};
eq('前置条件 · 四项齐备 → 全 true（这才允许产出 fail）',
  Object.values(preconditionsOf(goodPre)).every(Boolean), true);
eq('前置条件 · 输入绑定无效（claim 没绑回材料）→ input_binding=false',
  preconditionsOf({ ...goodPre, claim: { ok: false } }).input_binding, false);
eq('前置条件 · 操作数有歧义 → input_binding=false',
  preconditionsOf({ ...goodPre, ops: [{ ok: true, selection: 'ambiguous', span_structured: true }] }).input_binding, false);
eq('前置条件 · 片段未结构化 → input_binding=false',
  preconditionsOf({ ...goodPre, ops: [{ ok: true, selection: 'unambiguous', span_structured: false }] }).input_binding, false);
eq('前置条件 · 规则不适用 → rule_applicable=false',
  preconditionsOf({ ...goodPre, def: { operator: 'percent_of' } }).rule_applicable, false);
eq('前置条件 · 容差策略缺失 → tolerance_policy=false',
  preconditionsOf({ ...goodPre, toleranceName: null, tol: null }).tolerance_policy, false);
eq('前置条件 · 计算结果不完整（无期望值）→ computation_complete=false',
  preconditionsOf({ ...goodPre, computation: { computed: 1, expected: null, delta: null } }).computation_complete, false);
eq('前置条件 · 计算结果非有限 → computation_complete=false',
  preconditionsOf({ ...goodPre, computation: { computed: Infinity, expected: 0, delta: { abs: 1 } } }).computation_complete, false);

// ================= L3 工具边界回归（合成夹具，专测数值 / 量纲 / 结构边界）=================
const sTxt = '总量 1，部分 0.5，占比 50%，耗时 300 min，重量 5 kg，放大 1e308，基准 0';
const sSpan = { offset: { start: 0, end: sTxt.length }, source_ref: { file: 'synth.txt', sha256: 'synth', page: null, entry: 'eT1' } };
const sB = buildBundleIndex({ evidence: [{ id: 'evT', spans: [sSpan] }] });
const S = [sSpan];
// ★ 量纲来源状态由上面的 st() 助手自动补（见文件头部注释）
const sop = (quote, label) => ({ bundle_id: 'evT', span_index: 0, quote, label, ...st(quote) });
// 量纲的「额外依据」：一段来自原文的文字。没有单位标记时，必须有它才允许判出量纲。
const DIM_R = { bundle_id: 'evT', span_index: 0, quote: '占比 50%' };
const sopR = (quote, label) => ({ ...sop(quote, label), dim_evidence: DIM_R, dim_source_status: 'cited' });
const sClaim = { bundle_id: 'evT', span_index: 0, quote: '部分 0.5' };
const sRun = o => runCheck(sTxt, sB, S, { id: 'ckT', rubric_item_id: null, claim: sClaim, tolerance: 'abs_1e_3', ...o });

eq('边界 · arity：difference 只给 1 个操作数 → unverified(arity_mismatch)',
  sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sop('0.5', '部分 0.5')] }).reason_codes, ['arity_mismatch']);
eq('边界 · arity：difference 给 3 个操作数 → unverified(arity_mismatch)',
  sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sop('1', '总量 1'), sop('0.5', '部分 0.5'), sop('0', '基准 0')] }).reason_codes, ['arity_mismatch']);

// 除零：量纲先声明（否则会先被 unknown_dimension 拦住，测不到除零这一支）
eq('边界 · 除零：relative_change 旧值为 0 → unverified(division_by_zero)',
  sRun({ kind: 'numeric_recompute', operator: 'relative_change', operands: [sopR('基准 0', '基准 0'), sopR('0.5', '部分 0.5')] }).reason_codes, ['division_by_zero']);
eq('边界 · 除零：ratio_of 分母为 0 → unverified(division_by_zero)',
  sRun({ kind: 'numeric_recompute', operator: 'ratio_of', operands: [sopR('0.5', '部分 0.5'), sopR('基准 0', '基准 0')] }).reason_codes, ['division_by_zero']);
eq('边界 · 溢出：乘积非有限 → unverified(non_finite_result)',
  sRun({ kind: 'numeric_recompute', operator: 'product', operands: [sop('1e308', '放大 1e308'), sop('1e308', '放大 1e308')] }).reason_codes, ['non_finite_result']);

// ★ 量纲不能推断：「没写单位」= unknown，**不是**无量纲。
//   要判出量纲必须有可回溯的额外依据（单位标记，或一段来自原文的 dim_evidence）。
eq('边界 · 量纲：两侧都没声明量纲 → unverified(unknown_dimension)（不推断）',
  sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sop('0.5', '部分 0.5'), sop('1', '总量 1')] }).reason_codes, ['unknown_dimension']);
eq('边界 · 量纲：一侧未声明、一侧已声明 → 仍 unverified(unknown_dimension)（不做补齐推断）',
  sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sop('0.5', '部分 0.5'), sop('50%', '占比 50%')] }).reason_codes, ['unknown_dimension']);
eq('边界 · 量纲：duration 与 ratio 相减 → unverified(incompatible_dimensions)',
  sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sop('300 min', '耗时 300 min'), sop('50%', '占比 50%')] }).reason_codes, ['incompatible_dimensions']);

const dimOK = sRun({ kind: 'unit_check', operator: 'unit_consistent', operands: [sopR('0.5', '部分 0.5'), sopR('1', '总量 1')] });
eq('边界 · 量纲依据可用时判出 ratio → 单位检查这才可以判定', dimOK.stance, 'pass');
eq('边界 · 量纲依据完整记进产物（quote / offset / via / marker 都可回溯）',
  dimOK.operands.every(o => o.dim === 'ratio' && o.dim_source?.via === 'keyword' && o.dim_source?.marker === '占比' &&
    sTxt.slice(o.dim_source.offset.start, o.dim_source.offset.end) === '占比 50%'), true);
eq('边界 · 量纲依据不可用（那段文字里没有可识别的量纲词）→ unverified(dim_evidence_unusable)',
  sRun({
    kind: 'numeric_recompute', operator: 'difference',
    operands: [{ ...sop('0.5', '部分 0.5'), dim_evidence: { bundle_id: 'evT', span_index: 0, quote: '总量 1' }, dim_source_status: 'cited' }, sop('1', '总量 1')],
  }).reason_codes, ['dim_evidence_unusable']);

const pct = sRun({
  kind: 'numeric_recompute', operator: 'percent_of', operands: [sopR('0.5', '部分 0.5'), sopR('1', '总量 1')],
  expected: { bundle_id: 'evT', span_index: 0, quote: '50%', label: '占比 50%', ...st('50%') },
});
eq('边界 · percent_of 输出刻度回到基准（0.5/1 与原文的 50% 应判为一致）', pct.stance, 'pass');
eq('边界 · percent_of 的 value 记在基准刻度上', pct.computed.value, 0.5);
eq('边界 · percent_of 的自然刻度记在 scale 里（信息不丢）', pct.computed.scale, '%');
eq('边界 · percent_of 的输出维度是 ratio', pct.computed.dim, 'ratio');

eq('边界 · 单位检查：全部未声明量纲 → unverified(all_dims_undeclared)',
  sRun({ kind: 'unit_check', operator: 'unit_consistent', operands: [sop('1', '总量 1'), sop('0.5', '部分 0.5')] }).reason_codes, ['all_dims_undeclared']);
eq('边界 · 单位检查：两个已声明但不同 → fail',
  sRun({ kind: 'unit_check', operator: 'unit_consistent', operands: [sop('300 min', '耗时 300 min'), sop('50%', '占比 50%')] }).stance, 'fail');
eq('边界 · 未知单位不猜（kg 不在表里）→ unverified(unknown_unit)',
  sRun({ kind: 'unit_check', operator: 'unit_consistent', operands: [sop('5 kg', '重量 5 kg'), sop('300 min', '耗时 300 min')] }).reason_codes.includes('unknown_unit'), true);

const anchored = sRun({ kind: 'magnitude_sanity', operator: 'range_in', operands: [sop('0', '基准 0')], params: { range: 'non_negative' } });
eq('边界 · 值由标签锚定：quote=0 绑到「基准 0」那一处，而不是 0.5 里的 0',
  sTxt.slice(anchored.operands[0].offset.start, anchored.operands[0].offset.end), '0');
eq('边界 · 锚定位置确实落在「基准 0」附近', anchored.operands[0].offset.start, sTxt.indexOf('基准 0') + 3);

const mlText = 'A行 1.1 2.2\nB行 3.3 4.4';
const mlSpan = { offset: { start: 0, end: mlText.length }, source_ref: { file: 'synth2.txt', sha256: 's2', page: null, entry: 'eT2' } };
const mlB = buildBundleIndex({ evidence: [{ id: 'evM', spans: [mlSpan] }] });
const ml = runCheck(mlText, mlB, [mlSpan], {
  id: 'ckM', kind: 'numeric_recompute', operator: 'difference', tolerance: 'abs_1e_3',
  claim: { bundle_id: 'evM', span_index: 0, quote: 'A行 1.1 2.2' },
  operands: [{ bundle_id: 'evM', span_index: 0, quote: '1.1', label: 'A行 1.1 2.2', ...st('1.1') }, { bundle_id: 'evM', span_index: 0, quote: '3.3', label: 'B行 3.3 4.4', ...st('3.3') }],
  expected: { bundle_id: 'evM', span_index: 0, quote: '2.2', label: 'A行 1.1 2.2', ...st('2.2') },
});
eq('边界 · 多行数值块 span 不得判定 → unverified(multiline_span_not_structured)',
  ml.reason_codes.includes('multiline_span_not_structured'), true);
eq('边界 · 多行判定确实成立（前提检查）', spanIsUnstructured(mlText), true);

const nText = '见图 2 所示\n见图 1 所示';
const nSpans = [
  { offset: { start: 0, end: 7 }, source_ref: { file: 'synth3.txt', sha256: 's3', page: null, entry: 'eT3' } },
  { offset: { start: 8, end: 15 }, source_ref: { file: 'synth3.txt', sha256: 's3', page: null, entry: 'eT4' } },
];
const nB = buildBundleIndex({ evidence: [{ id: 'evN1', spans: [nSpans[0]] }, { id: 'evN2', spans: [nSpans[1]] }] });
const nOp = [
  { bundle_id: 'evN1', span_index: 0, quote: '图 2', label: '见图 2 所示', kind: 'text' },
  { bundle_id: 'evN2', span_index: 0, quote: '图 1', label: '见图 1 所示', kind: 'text' },
];
const numOut = runCheck(nText, nB, nSpans, { id: 'ckN', kind: 'numbering', operator: 'numbering_continuity', tolerance: 'exact', claim: { bundle_id: 'evN1', span_index: 0, quote: '图 2' }, operands: nOp });
eq('边界 · 编号顺序：文档顺序是 2,1 → fail（旧实现先排序会误判为连续）', numOut.stance, 'fail');
eq('边界 · 编号序列按文档顺序记进警告', numOut.warnings.some(w => w.includes('2, 1')), true);
eq('边界 · 编号顺序取文档序，而不是模型罗列的顺序（把 1 写在前面也还是 fail）',
  runCheck(nText, nB, nSpans, { id: 'ckN2', kind: 'numbering', operator: 'numbering_continuity', tolerance: 'exact', claim: { bundle_id: 'evN1', span_index: 0, quote: '图 2' }, operands: [nOp[1], nOp[0]] }).stance, 'fail');

const n2Text = '见图 1 所示\n见图 2 所示';
const n2Spans = [
  { offset: { start: 0, end: 7 }, source_ref: { file: 'synth4.txt', sha256: 's4', page: null, entry: 'eT5' } },
  { offset: { start: 8, end: 15 }, source_ref: { file: 'synth4.txt', sha256: 's4', page: null, entry: 'eT6' } },
];
const n2B = buildBundleIndex({ evidence: [{ id: 'evP1', spans: [n2Spans[0]] }, { id: 'evP2', spans: [n2Spans[1]] }] });
eq('边界 · 编号顺序：文档顺序是 1,2 → pass',
  runCheck(n2Text, n2B, n2Spans, {
    id: 'ckN3', kind: 'numbering', operator: 'numbering_continuity', tolerance: 'exact',
    claim: { bundle_id: 'evP1', span_index: 0, quote: '图 1' },
    operands: [
      { bundle_id: 'evP1', span_index: 0, quote: '图 1', label: '见图 1 所示', kind: 'text' },
      { bundle_id: 'evP2', span_index: 0, quote: '图 2', label: '见图 2 所示', kind: 'text' },
    ],
  }).stance, 'pass');

// ★ 完整 numeric token：值必须是一个**独立的数值**，不能是更长数值的子串。
//   旧实现只做子串匹配，于是 '0' 会被 '1e308' 里的 0 满足、'30' 会被 '300' 满足。
const tokText = '总量 1，部分 0.5，占比 50%，耗时 300 min，放大 1e308';
const tokSpan = { offset: { start: 0, end: tokText.length }, source_ref: { file: 'synth-token.txt', sha256: 'st', page: null, entry: 'eT9' } };
const tokB = buildBundleIndex({ evidence: [{ id: 'evTT', spans: [tokSpan] }] });
const tokRun = (quote, label) => runCheck(tokText, tokB, [tokSpan], {
  id: 'ckTT', kind: 'magnitude_sanity', operator: 'range_in',
  claim: { bundle_id: 'evTT', span_index: 0, quote: '总量 1' },
  operands: [{ bundle_id: 'evTT', span_index: 0, quote, label, ...st(quote) }],
  params: { range: 'non_negative' },
});
eq('边界 · 完整 token：值只在更长数值里作为子串出现（0 在 1e308 里）→ 拒绝',
  tokRun('0', '放大 1e308').reason_codes, ['operand_not_a_complete_numeric_token']);
eq('边界 · 完整 token：值只是更长数值的前缀（30 在 300 里）→ 拒绝',
  tokRun('30', '耗时 300 min').reason_codes, ['operand_not_a_complete_numeric_token']);
eq('边界 · 完整 token 但离标签太远 → 拒绝，且与「子串问题」分开报',
  tokRun('300', '总量 1').reason_codes, ['operand_quote_not_near_label']);
eq('边界 · 完整 token：值就在标签内 → 通过，并记下 anchor 供审计',
  (() => { const r = tokRun('300', '耗时 300 min'); return r.stance === 'pass' && r.operands[0].value_anchor === 'inside_label'; })(), true);

const badClaim = runCheck(sTxt, sB, S, {
  id: 'ckC', kind: 'numeric_recompute', operator: 'difference', tolerance: 'abs_1e_3',
  claim: { bundle_id: 'evT', span_index: 0, quote: '这段不在原文里' },
  operands: [sop('0.5', '部分 0.5'), sop('1', '总量 1')],
});
eq('边界 · claim 走同一套来源验证（找不到 → claim_not_source_bound）',
  badClaim.reason_codes.includes('claim_not_source_bound'), true);

eq('边界 · 一个操作数里出现两个数值 → 拒绝', parseNumeric('1.2 3.4').ok, false);
eq('边界 · 一个操作数里没有数值 → 拒绝', parseNumeric('没有数字').ok, false);
eq('边界 · 科学计数法可解析（原文里就有 1e-4）', parseNumeric('1e-4').value, 0.0001);
eq('边界 · 降级原因清单非空且无重复', new Set(REASONS).size === REASONS.length && REASONS.length > 0, true);
eq('边界 · ★ 工具实际产出的降级原因全在枚举里（不会冒出野字符串）',
  [...new Set([
    ...vf.checks.flatMap(c => c.reason_codes),
    ...vf.checks.flatMap(c => c.operands.flatMap(o => o.reasons ?? [])),
    ...tkRun([tkq('不存在', '准确率'), tkq('汇总', '准确率')]).operands.flatMap(o => o.reasons ?? []),
    ...badClaim.reason_codes,
  ])].every(r => ALL_CODES.includes(r)), true);

// ================= ★ L2 纯函数（不依赖模型的那部分必须有测试钉住）=================
const L2R = cr.items;
eq('L2 · plan 覆盖检查：漏条目 → 拒收（不做"补齐"）',
  validatePlanArgs({ items: [{ rubric_item_id: 'R2.1', facets: [] }] }, L2R).errors.some(e => e.includes('未覆盖')), true);
eq('L2 · plan 覆盖检查：引用不存在的条目 → 拒收',
  validatePlanArgs({ items: [...L2R.map(r => ({ rubric_item_id: r.id, facets: [] })), { rubric_item_id: 'R9.9', facets: [] }] }, L2R)
    .errors.some(e => e.includes('R9.9')), true);
eq('L2 · plan 覆盖检查：覆盖全部条目 → 通过',
  validatePlanArgs({ items: L2R.map(r => ({ rubric_item_id: r.id, facets: [] })) }, L2R).ok, true);
eq('L2 · facet id 由系统编号（模型给什么都会被覆盖成 F1、F2…）',
  planFromArgs({ items: [{ rubric_item_id: 'R2.1', facets: [{ text: 'x', form: 'value', modality: ['text'], channels: ['llm:semantic'] }] }] },
    { rubric: cr, rubricSha256: 's', planId: 'p', batchId: 'b', now: '2026-01-01T00:00:00Z' })
    .items.find(i => i.rubric_item_id === 'R2.1').facets[0].id, 'F1');

eq('L2 · 硬规则①：status=channel_error 却报 located → 覆写成 undetermined，原值留下',
  (() => {
    const h = applyHardRule({ status: 'channel_error', outcome: 'located', locatedCount: 3 });
    return h.outcome === 'undetermined' && h.overridden === true && h.claimed_outcome === 'located';
  })(), true);
eq('L2 · 硬规则②：报 located 但一个候选都没绑上原文 → undetermined（≠ 材料里没有）',
  (() => {
    const h = applyHardRule({ status: 'complete', outcome: 'located', locatedCount: 0 });
    return h.outcome === 'undetermined' && h.overridden === true;
  })(), true);
eq('L2 · 硬规则不误伤：健康且真有命中 → 原样放行',
  (() => {
    const h = applyHardRule({ status: 'complete', outcome: 'located', locatedCount: 2 });
    return h.outcome === 'located' && h.overridden === false;
  })(), true);
eq('L2 · 硬规则不误伤：健康且确实没有 → no_candidate 放行',
  (() => {
    const h = applyHardRule({ status: 'complete', outcome: 'no_candidate', locatedCount: 0 });
    return h.outcome === 'no_candidate' && h.overridden === false;
  })(), true);

const l2facet = { id: 'F1', text: '结果数值', form: 'value', modality: ['table'], channels: ['rule:numeric', 'structure:table', 'llm:semantic'] };
const l2DocRef = { name: rIdx.doc.name, sha256: rIdx.doc.sha256 };
const l2ok = resolveCandidates({
  full: rTxt, entries: rIdx.entries, facet: l2facet, docRef: l2DocRef,
  args: { candidates: [{ quote: '0.812', match_type: 'verbatim' }, { quote: '这段引用在原文里并不存在', match_type: 'verbatim' }] },
});
eq('L2 · 逐字引用绑回原文：带 offset + source_ref，且 slice(offset) === quote',
  l2ok.spans.every(s => rTxt.slice(s.offset.start, s.offset.end) === s.quote && !!s.source_ref.entry), true);
eq('L2 · 绑不上的引用进 dropped（可见），不静默丢',
  l2ok.dropped.length === 1 && /not_found/.test(l2ok.dropped[0].reason), true);
eq('L2 · 模态为 table 的 facet 用「带 table_id 的条目」作 entry_hint（系统侧提示，不是模型给的）',
  l2ok.spans.every(s => rIdx.entries.find(e => e.id === s.source_ref.entry)?.table_id), true);
eq('L2 · 通道归因 ⊆ facet 声明的通道，且数值类命中规则网',
  l2ok.spans.every(s => s.found_by.every(c => l2facet.channels.includes(c))) &&
  l2ok.spans.some(s => s.found_by.includes('rule:numeric')), true);
eq('L2 · 同一处重复提交只留一份',
  resolveCandidates({
    full: rTxt, entries: rIdx.entries, facet: l2facet, docRef: l2DocRef,
    args: { candidates: [{ quote: '0.812', match_type: 'verbatim' }, { quote: '0.812', match_type: 'verbatim' }] },
  }).spans.length, 1);
eq('L2 · 候选只接受 quote / match_type / note 三个字段（结构上写不进分数或评价）',
  Object.keys(l2Tools()[1].function.parameters.properties.candidates.items.properties).sort().join(','),
  'match_type,note,quote');
eq('L2 · 盲点是独立字段（不混进 facet，也不混进候选）',
  Object.keys(l2Tools()[0].function.parameters.properties.items.items.properties.blind_spots.items.properties).sort().join(','),
  'reason,text');

// ================= ★ 本轮四条：负号完整 token / 表格单位语义 / 跳过汇总父项 =================

// ① 负号：引 0.25 而原文是 -0.25 → 丢的是符号，值本身变了
eq('★ 负号 · 原文 "-0.25" 里引 "0.25" → 不是完整 token（丢了负号）',
  isCompleteNumericToken('共 -0.25', 3, 4), false);
eq('★ 负号 · "-0.25" 在行首 / 跟在 = ( 空格 后面，都算真负号',
  isCompleteNumericToken('-0.25', 1, 4) === false && isCompleteNumericToken('= -0.25', 3, 4) === false &&
  isCompleteNumericToken('(-0.25)', 2, 4) === false, true);
eq('★ 负号 · 但 "3-1" / "v-1" / "图-1" / "(a)-1" 里的不是负号（区间与编号不能误伤）',
  isCompleteNumericToken('3-1', 2, 1) && isCompleteNumericToken('v-1', 2, 1) &&
  isCompleteNumericToken('图-1', 2, 1) && isCompleteNumericToken('(a)-1', 4, 1), true);
eq('★ 负号 · 带负号的原文里，"0.25" 一个完整 token 都找不到',
  allCompleteTokens('共 -0.25，另有 -0.3', '0.25').length, 0);
eq('负号 · 正向对照：不带负号时照常找到',
  allCompleteTokens('共 0.25，另有 0.3', '0.25').length, 1);

// ② 表格单位语义（作用域由声明位置决定）
const TBL_HDR = ['配置  准确率  列D', '甲  0.1  7', '乙  0.2  8'].join('\n');   // 只有列头声明量纲
const TBL_ROW = ['配置  列D', '甲  7', '平均耗时(ms)  12'].join('\n');           // 只有行标签声明量纲
const TBL_CFL = ['配置  耗时(min)  占比', '耗时(s)  10  0.5'].join('\n');       // 行标签(秒) 与列头(占比) 量纲不同
const rlRun2 = (txt, spec, id) => {
  let off = 0;
  const es = txt.split('\n').map((t, i) => {
    const start = txt.indexOf(t, off); off = start + t.length;
    return { id: 'e' + String(i + 1).padStart(4, '0'), type: 'paragraph', num: null, level: null, page: 1, lines: 1, start, end: start + t.length, text: t, table_id: null };
  });
  const { tables, owner } = detectTables(txt, es);
  for (const e of es) e.table_id = owner.get(e.id) ?? null;
  const idx = { tables, entries: es, doc: { name: 'tbl.txt', sha256: 'x', kind: 'pdf', chars: txt.length, text_file: 'tbl.txt', tables } };
  const span = { offset: { start: 0, end: txt.length }, source_ref: { file: 'tbl.txt', sha256: 'x', page: 1, entry: es[0].id } };
  const b = buildBundleIndex({ evidence: [{ id: 'evT', spans: [span] }] });
  return runCheck(txt, b, [span], {
    id, kind: 'magnitude_sanity', operator: 'range_in',
    claim: { bundle_id: 'evT', span_index: 0, quote: '甲' },
    operands: [spec], params: { range: 'non_negative' },
  }, idx).operands[0];
};
eq('★ 表格单位语义 · 列头声明 → 作用于整列（applies_to=column）',
  (() => {
    const o = rlRun2(TBL_HDR, { table_id: 't0001', row_label: '甲', column: '准确率' }, 'ckU1');
    return o.ok && o.dim === 'ratio' && o.unit_source.from === 'column_header' && o.unit_source.applies_to === 'column';
  })(), true);
eq('★ 表格单位语义 · 行标签声明 → 作用于整行（applies_to=row）',
  (() => {
    const o = rlRun2(TBL_ROW, { table_id: 't0001', row_label: '平均耗时(ms)', column: '列D' }, 'ckU2');
    return o.ok && o.dim === 'duration' && o.unit_source.from === 'row_label' && o.unit_source.applies_to === 'row';
  })(), true);
eq('★ 表格单位语义 · 行列都没声明、但整表只声明一种量纲 → 兜底为整表（applies_to=table）',
  (() => {
    const o = rlRun2(TBL_ROW, { table_id: 't0001', row_label: '甲', column: '列D' }, 'ckU3');
    return o.ok && o.dim === 'duration' && o.unit_source.applies_to === 'table' &&
      o.unit_source.from === 'row_label' && o.unit_source.marker === 'ms';
  })(), true);
eq('★ 表格单位语义 · 行与列声明了**不同**量纲 → 依据不可用（不猜哪个对）',
  rlRun2(TBL_CFL, { table_id: 't0001', row_label: '耗时(s)', column: '占比' }, 'ckU4').reasons, ['dim_evidence_unusable']);
eq('★ 表格单位语义 · 一点量纲线索都没有 → 仍记 column_unit_undetermined',
  rlRun2(['配置  列D', '甲  7', '乙  8'].join('\n'), { table_id: 't0001', row_label: '甲', column: '列D' }, 'ckU5').reasons,
  ['column_unit_undetermined']);
eq('★ 单位来源必须指回原文那一处（slice(offset) === quote）',
  (() => {
    const txt = TBL_ROW;
    const o = rlRun2(txt, { table_id: 't0001', row_label: '甲', column: '列D' }, 'ckU6');
    return txt.slice(o.unit_source.offset.start, o.unit_source.offset.end) === o.unit_source.quote &&
      o.unit_source.quote === '平均耗时(ms)';
  })(), true);

// ★ 表注（caption）也是量纲来源之一 —— 量纲只写在表注里时也要能解析出来。
//   表注在表**外**，靠位置邻接判定，所以是**最后一级**依据（表内一处都没声明时才用）。
//   这两条用的是**真实报告里的原话**：`Timings` 里没有子串 `time`（词形 tim-ing），
//   所以 `duration` 关键词表里必须有 `timing`，否则这种表注拿不到量纲。
const TBL_CAP = ['配置  列D', '甲  7', '乙  8', 'Figure 3: Timings for 2-table join query'].join('\n');
eq('★ 表格单位语义 · 量纲只写在**表注**里 → 由规则解析（from=caption，作用于整表）',
  (() => {
    const o = rlRun2(TBL_CAP, { table_id: 't0001', row_label: '甲', column: '列D' }, 'ckU7');
    return o.ok && o.dim === 'duration' && o.unit_source.from === 'caption' &&
      o.unit_source.applies_to === 'table' && o.unit_source.marker === 'timing' &&
      o.unit_source.quote.startsWith('Figure 3:');
  })(), true);
eq('★ 关键词表 · 真实表注写法「Timings for …」判出 duration（timings 里没有子串 time）',
  (() => {
    const d = dimFromEvidence('Figure 3: Timings for 2-table join query');
    return d?.dim === 'duration' && d?.via === 'keyword' && d?.marker === 'timing';
  })(), true);
eq('★ 关键词表 · 表注自己带单位标记时用标记（刻度也来自表注）',
  (() => {
    const d = dimFromEvidence('Figure 5: Average latency (ms)');
    return d?.dim === 'duration' && d?.via === 'unit_marker' && d?.marker === 'ms';
  })(), true);

const TBL_CAP2 = ['配置  准确率', '甲  0.1', 'Table 3: Memory usage of each join plan'].join('\n');
eq('★ 表格单位语义 · 表内声明优先于表注（表外注解不覆盖表内，也不与表内做冲突判定）',
  (() => {
    const o = rlRun2(TBL_CAP2, { table_id: 't0001', row_label: '甲', column: '准确率' }, 'ckU8');
    return o.ok && o.dim === 'ratio' && o.unit_source.from === 'column_header' &&
      o.unit_source.scale_from === undefined;
  })(), true);

const TBL_CAP3 = ['Table 2: Memory usage summary', '配置  列D', '甲  7', 'Table 4: Accuracy of each plan'].join('\n');
eq('★ 表格单位语义 · 表注自己声明了**两种**量纲（bytes / ratio）→ 不猜',
  rlRun2(TBL_CAP3, { table_id: 't0001', row_label: '甲', column: '列D' }, 'ckU9').reasons,
  ['dim_evidence_unusable']);

const TBL_SCALE = ['配置  占比', '甲  0.5', '准确率(%)  0.81'].join('\n');
eq('★ 表格单位语义 · 量纲取自关键词、刻度取自同表同量纲的单位标记 → 记进 scale_from（同表不混两种基准值）',
  (() => {
    const o = rlRun2(TBL_SCALE, { table_id: 't0001', row_label: '甲', column: '占比' }, 'ckU10');
    return o.ok && o.dim === 'ratio' && o.unit_source.from === 'column_header' &&
      o.unit_source.scale_from?.marker === '%' && o.unit === '%' && Math.abs(o.base_value - 0.005) < 1e-12;
  })(), true);

// ★★★ 量纲来源状态：数值 span 必须**表态**，且系统拿原文证伪表态。
//     这条约束的对象是**模型的表态**（枚举、可证伪），不是"材料里必须存在什么"。
eq('★ 状态 · 漏表态 → 自己的原因码（绝不与"原文没单位"混成同一种 unverified）',
  sRun({
    kind: 'numeric_recompute', operator: 'difference',
    operands: [{ bundle_id: 'evT', span_index: 0, quote: '0.5', label: '部分 0.5' }, sop('1', '总量 1')],
  }).reason_codes, ['dim_source_status_missing']);
eq('★ 状态 · 表态 inline（说"值自带单位"）但值里没有单位标记 → 表态被证伪',
  sRun({
    kind: 'numeric_recompute', operator: 'difference',
    operands: [{ ...sop('0.5', '部分 0.5'), dim_source_status: 'inline' }, sop('1', '总量 1')],
  }).reason_codes, ['dim_status_inline_without_unit']);
eq('★ 状态 · 表态 cited 却没给依据 → 表态被证伪',
  sRun({
    kind: 'numeric_recompute', operator: 'difference',
    operands: [{ ...sop('0.5', '部分 0.5'), dim_source_status: 'cited' }, sop('1', '总量 1')],
  }).reason_codes, ['dim_status_cited_without_evidence']);
eq('★ 状态 · 表态 undeclared（说"没有来源"）但值自带单位 → 表态被证伪（原文里明明有）',
  sRun({
    kind: 'numeric_recompute', operator: 'difference',
    operands: [{ ...sop('50%', '占比 50%'), dim_source_status: 'undeclared' }, sop('1', '总量 1')],
  }).reason_codes, ['dim_status_undeclared_with_source']);
eq('★ 状态 · 表态 undeclared 但另给了依据 → 同样被证伪',
  sRun({
    kind: 'numeric_recompute', operator: 'difference',
    operands: [{ ...sop('0.5', '部分 0.5'), dim_source_status: 'undeclared', dim_evidence: DIM_R }, sopR('1', '总量 1')],
  }).reason_codes, ['dim_status_undeclared_with_source']);
eq('★ 状态 · undeclared 是**诚实**的：表态"没有来源"本身不会变成 fail，仍走 unknown_dimension',
  sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sop('0.5', '部分 0.5'), sop('1', '总量 1')] }).reason_codes,
  ['unknown_dimension']);
eq('★ 状态 · 状态随产物显式留痕：span 通道给出表态、表格通道恒为 null（那里没有模型表态这一环）',
  (() => {
    const span = sRun({ kind: 'numeric_recompute', operator: 'difference', operands: [sopR('0.5', '部分 0.5'), sopR('1', '总量 1')] });
    const tbl = rlRun2(TBL_ROW, { table_id: 't0001', row_label: '甲', column: '列D' }, 'ckU11');
    return span.operands[0].dim_source_status === 'cited' && tbl.dim_source_status === null;
  })(), true);
eq('★ 状态 · 工具 schema 强制：span 数值操作数缺状态 → 结构不合格（漏参数在调用闸就被拒）',
  (() => {
    const p = llmTools().find(t => t.function.name === 'verify_numeric_recompute').function.parameters;
    return validate(p, {
      scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference',
      operands: [{ bundle_id: 'evT', span_index: 0, quote: '0.5', label: '部分 0.5' }],
    }).ok === false;
  })(), true);
eq('★ 状态 · 工具 schema：表格通道不需要状态（单位全由规则解析，模型无表态权）',
  (() => {
    const p = llmTools().find(t => t.function.name === 'verify_numeric_recompute').function.parameters;
    return validate(p, {
      scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference',
      operands: [{ table_id: 't0001', row_label: 'x', column: 'y' }],
    }).ok === true;
  })(), true);
eq('★ 状态 · 工具 schema：文本操作数不需要状态（没有量纲可言）',
  (() => {
    const p = llmTools().find(t => t.function.name === 'verify_numbering').function.parameters;
    return validate(p, {
      scope: 'rubric_item', rubric_item_id: 'R2.2', claim: sClaim, operator: 'equals_text',
      operands: [
        { bundle_id: 'evT', span_index: 0, quote: '部分', label: '部分 0.5', kind: 'text' },
        { bundle_id: 'evT', span_index: 0, quote: '总量', label: '总量 1', kind: 'text' },
      ],
    }).ok === true;
  })(), true);
eq('★ 状态 · 枚举在工具 schema 与工具层同源（不会漂移出野字符串）',
  (() => {
    const p = llmTools().find(t => t.function.name === 'verify_numeric_recompute').function.parameters;
    return JSON.stringify(p.properties.operands.items.allOf[0].properties.dim_source_status.enum) === JSON.stringify(DIM_SOURCE_STATUSES);
  })(), true);

// ★★ v0.2 · 显式作用域：`rubric_item_id=null` 不许被下游猜成某个条目
const V2P = () => llmTools().find(t => t.function.name === 'verify_numeric_recompute').function.parameters;
const v2Args = o => ({
  scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference',
  operands: [{ bundle_id: 'evT', span_index: 0, quote: '0.5', label: '部分 0.5', dim_source_status: 'undeclared' }],
  ...o,
});
eq('★ v0.2 · 漏 scope → 结构不合格（作用域必须显式，不许默认）',
  validate(V2P(), (() => { const a = v2Args(); delete a.scope; return a; })()).ok, false);
eq('★ v0.2 · scope=rubric_item 但 id 为空串 → 结构不合格',
  validate(V2P(), v2Args({ rubric_item_id: '' })).ok, false);
eq('★ v0.2 · scope=document 却带着条目 id → 结构不合格（null 不许当"忘了填"用）',
  validate(V2P(), v2Args({ scope: 'document', rubric_item_id: 'R2.1' })).ok, false);
eq('★ v0.2 · scope=document + id 显式为 null → 结构合格（真正的文档级检查）',
  validate(V2P(), v2Args({ scope: 'document', rubric_item_id: null })).ok, true);
eq('★ v0.2 · 调用闸：scope=rubric_item 但 id 不在 canonical rubric 里 → 拒收 unknown_rubric_item',
  (() => {
    const r = createRunner({ full: sTxt, bundleIndex: sB, allSpans: S, maxCalls: 10, rubricItems: ['R2.1'] });
    const res = r.call({ function: { name: 'verify_numeric_recompute', arguments: JSON.stringify(v2Args({ rubric_item_id: 'R9.9' })) } });
    return res.reason_code === 'unknown_rubric_item' && r.summary().rejected === 1 && r.summary().accepted === 0;
  })(), true);
eq('★ v0.2 · 作用域随产物落盘（document 级检查的 id 恒为 null）',
  (() => {
    const docCheck = runCheck(sTxt, sB, S, {
      id: 'ckD', scope: 'document', rubric_item_id: 'R2.1',  // 故意给一个 id，runCheck 必须把它压成 null
      kind: 'numbering', operator: 'equals_text', claim: sClaim,
      operands: [
        { bundle_id: 'evT', span_index: 0, quote: '0.5', label: '部分 0.5', kind: 'text' },
        { bundle_id: 'evT', span_index: 0, quote: '0.5', label: '部分 0.5', kind: 'text' },
      ],
    });
    return docCheck.scope === 'document' && docCheck.rubric_item_id === null;
  })(), true);

// ③ 跳过汇总父项：减少 L2 调用与重复证据
eq('L2 · 汇总父项可以不出现在模型提交里（叶子必须全在）',
  (() => {
    const leaves = L2R.filter(r => !(r.children ?? []).length);
    return validatePlanArgs({ items: leaves.map(r => ({ rubric_item_id: r.id, facets: [] })) }, L2R).ok === true;
  })(), true);
eq('L2 · 但漏掉**叶子**条目仍然整次拒收',
  (() => {
    const leaves = L2R.filter(r => !(r.children ?? []).length);
    return validatePlanArgs({ items: leaves.slice(1).map(r => ({ rubric_item_id: r.id, facets: [] })) }, L2R)
      .errors.some(e => e.includes('未覆盖的非汇总条目'));
  })(), true);
eq('★ L2 · 汇总父项强制不生成 facet（模型给了也丢弃，避免重复证据）',
  (() => {
    const parent = L2R.find(r => (r.children ?? []).length);
    const plan = planFromArgs({ items: [{ rubric_item_id: parent.id, facets: [{ text: 'x', form: 'value', modality: ['text'], channels: ['llm:semantic'] }] }] },
      { rubric: cr, rubricSha256: 's', planId: 'p', batchId: 'b', now: '2026-01-01T00:00:00Z' });
    const p = plan.items.find(i => i.rubric_item_id === parent.id);
    return p.summary === true && p.facets.length === 0 && p.children.length === parent.children.length;
  })(), true);
eq('L2 · plan 仍然覆盖**全部**条目（汇总父项也在，只是不带 facet）',
  (() => {
    const plan = planFromArgs({ items: L2R.map(r => ({ rubric_item_id: r.id, facets: [] })) },
      { rubric: cr, rubricSha256: 's', planId: 'p', batchId: 'b', now: '2026-01-01T00:00:00Z' });
    return plan.items.length === L2R.length &&
      plan.items.filter(i => i.summary).length === L2R.filter(r => (r.children ?? []).length).length;
  })(), true);
eq('★ L2 · 跳过的父项在证据产物里标 retrieval_skipped + skipped_summary（不能记成"没找到"）',
  (() => {
    const parent = L2R.find(r => (r.children ?? []).length);
    const plan = planFromArgs({ items: L2R.map(r => ({ rubric_item_id: r.id, facets: [] })) },
      { rubric: cr, rubricSha256: 's', planId: 'p', batchId: 'b', now: '2026-01-01T00:00:00Z' });
    const evd = assembleEvidence({
      doc: { name: 'd', sha256: 'x', text_file: 'd.txt', chars: 1 },
      rubricRef: { rubric_id: 'r', sha256: 's', file: 'r.json' },
      plan, planFile: 'p.json', planSha256: 's', evidence: [], coverage: [], scannedRange: 'e0001-e0001',
    });
    const row = evd.diagnostics.rubric_item_summary.find(x => x.rubric_item_id === parent.id);
    return row.retrieval_skipped === true && row.outcome === 'skipped_summary' && row.candidates === 0;
  })(), true);

// ================= ★ tool calling 适配层（调用闸）=================
// 结构不合格 → 拒收（进拒绝表），**不产生 check**；语义指错 → 照样产生 check，只是 unverified。
const tkRunner = createRunner({ full: sTxt, bundleIndex: sB, allSpans: S, maxCalls: 100 });
const callOf = (name, args) => ({ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const goodArgs = {
  scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference',
  operands: [sopR('0.5', '部分 0.5'), sopR('1', '总量 1')],
};
const cGood = tkRunner.call(callOf('verify_numeric_recompute', goodArgs));
eq('工具调用 · 合法调用 → 变成一条 check，且 id 由系统分配（模型不能自报）',
  cGood.ok === true && cGood.id === 'ck0001', true);
eq('工具调用 · kind 由**工具名**决定 —— 模型无法把算子与 kind 拆开组合',
  tkRunner.checks[0].kind, 'numeric_recompute');
eq('工具调用 · 未知工具名 → 拒收 unknown_tool',
  tkRunner.call(callOf('verify_nope', {})).reason_code, 'unknown_tool');
eq('工具调用 · arguments 不是合法 JSON → 拒收 malformed_arguments_json',
  tkRunner.call(callOf('verify_numeric_recompute', '{"a":')).reason_code, 'malformed_arguments_json');
eq('工具调用 · 操作数参数不过 schema（算子不在该 kind 的 enum）→ 拒收 arguments_failed_schema',
  tkRunner.call(callOf('verify_unit_check', {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference', operands: [sopR('1', '总量 1')],
  })).reason_code, 'arguments_failed_schema');
eq('工具调用 · ★ 表格通道少给 column → 被 if/then 在调用阶段拒收（不会变成一条奇怪的 check）',
  tkRunner.call(callOf('verify_numeric_recompute', {
    scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference',
    operands: [{ table_id: 't0001', row_label: 'x' }], expected: sopR('1', '总量 1'),
  })).reason_code, 'arguments_failed_schema');
eq('工具调用 · 多给 schema 未定义的字段 → 拒收（additionalProperties:false 生效）',
  tkRunner.call(callOf('verify_numeric_recompute', { ...goodArgs, 我猜的容差: 'x' })).reason_code, 'arguments_failed_schema');
eq('工具调用 · ★ 语义指错（表格行不存在）→ 照样产生 check，只是 unverified',
  (() => {
    const r = tkRunner.call(callOf('verify_numeric_recompute', {
      scope: 'rubric_item', rubric_item_id: 'R2.1', claim: sClaim, operator: 'difference',
      operands: [{ table_id: 't0099', row_label: 'x', column: 'y' }, sopR('1', '总量 1')],
      expected: sopR('1', '总量 1'),
    }));
    return r.ok === true && r.stance === 'unverified' && r.reason_codes.includes('table_not_found');
  })(), true);
eq('工具调用 · ★ accepted + rejected = attempted（一次调用不许凭空消失）',
  tkRunner.summary().accepted + tkRunner.summary().rejected, tkRunner.summary().attempted);
eq('工具调用 · 拒收全部落进拒绝表，且码在枚举内',
  tkRunner.rejected().length === tkRunner.summary().rejected &&
  tkRunner.rejected().every(r => CALL_REJECT_CODES.includes(r.reason_code)), true);
eq('工具调用 · ★ 重复调用只计数不丢弃（记下与第几次重复）',
  (() => {
    tkRunner.call(callOf('verify_numeric_recompute', goodArgs));
    const s = tkRunner.summary();
    return s.duplicate === 1 && s.duplicate_calls[0].of_index === 0;
  })(), true);

const budgetRunner = createRunner({ full: sTxt, bundleIndex: sB, allSpans: S, maxCalls: 1 });
budgetRunner.call(callOf('verify_numeric_recompute', goodArgs));
eq('工具调用 · ★ 撞到上限 → 拒收 budget_exhausted，且 budget_exhausted 置位（有检查没做必须可见）',
  budgetRunner.call(callOf('verify_numeric_recompute', goodArgs)).reason_code === 'budget_exhausted' &&
  budgetRunner.summary().budget_exhausted === true, true);

eq('工具表 · 6 个 tool，形态符合 LLM 的 function calling，且 operator enum 与该 kind 一致',
  (() => {
    const t = llmTools();
    return t.length === 6 &&
      t.every(x => x.type === 'function' && x.function.name.startsWith('verify_') &&
        x.function.parameters.type === 'object' &&
        x.function.parameters.properties.operator.enum.every(o => KIND_OPERATORS[x.function.name.replace('verify_', '')].includes(o)));
  })(), true);
eq('工具表 · 操作数双通道由 if/then 强制补齐（缺字段在调用阶段就被拒）',
  (() => {
    const p = llmTools()[0].function.parameters.properties.operands.items;
    return Array.isArray(p.allOf) && !!p.allOf[1].if && !!p.allOf[1].then && !!p.allOf[1].else &&
      p.allOf[1].then.required.includes('column') && p.allOf[1].else.required.includes('quote');
  })(), true);

// ================= ★ 三条修正的回归（数值绑定 / 单位换算 / 期望值来源）=================
// ① 数值 token 必须在**完整原文**上判定 —— 标签末端不能伪造出"数值到此结束"
const tok3Txt = '准确率 0.8612，其余 1';
const tok3Span = { offset: { start: 0, end: tok3Txt.length }, source_ref: { file: 'synth-token3.txt', sha256: 's3', page: 1, entry: 'eT3' } };
const tok3B = buildBundleIndex({ evidence: [{ id: 'evT3', spans: [tok3Span] }] });
const tok3Run = (quote, label) => runCheck(tok3Txt, tok3B, [tok3Span], {
  id: 'ckT3', kind: 'magnitude_sanity', operator: 'range_in',
  claim: { bundle_id: 'evT3', span_index: 0, quote: '其余 1' },
  operands: [{ bundle_id: 'evT3', span_index: 0, quote, label, ...st(quote) }],
  params: { range: 'non_negative' },
});
eq('★ 修正① · 标签被截断时，末端的 "0.861" 不能从原文的 "0.8612" 里被切出来当真值',
  tok3Run('0.861', '准确率 0.861').reason_codes, ['operand_not_a_complete_numeric_token']);
eq('修正① · 正向对照：完整值 0.8612 → 可以判定',
  tok3Run('0.8612', '准确率 0.8612').stance, 'pass');
eq('修正① · 同类情形：绑定到的是那处**完整**的 "1"（原文末尾），而不是 "0.8612" 里的子串',
  (() => {
    const r = tok3Run('1', '准确率 0.8612');
    const o = r.operands[0];
    return o.ok === true && tok3Txt.slice(o.offset.start, o.offset.end) === '1' &&
      o.offset.start === tok3Txt.lastIndexOf('1');
  })(), true);

// ② span 通道也必须应用列头单位的换算 —— 两条通道对同一个量要给同一个基准值
const DIM_DUR = { bundle_id: 'ev0009', span_index: 0, quote: '训练时长(min)' };
const CLAIM_ATTN_Q2 = { bundle_id: 'ev0005', span_index: 0, quote: '注意力模块带来约 3.5 个百分点的提升' };
const spanDur = runCheck(rTxt, bundleIndex, evSpans, {
  id: 'ckT4', kind: 'internal_consistency', operator: 'agree', claim: CLAIM_ATTN_Q2,
  operands: [
    { bundle_id: 'ev0008', span_index: 1, quote: '7.1', label: '+ attention 0.847 7.1', dim_evidence: DIM_DUR, dim_source_status: 'cited' },
    { bundle_id: 'ev0008', span_index: 2, quote: '9.8', label: '+ attention + 数据增强 0.861 9.8', dim_evidence: DIM_DUR, dim_source_status: 'cited' },
  ],
}, rIdx);
const tableDur = runCheck(rTxt, bundleIndex, evSpans, {
  id: 'ckT5', kind: 'internal_consistency', operator: 'agree', claim: CLAIM_ATTN_Q2,
  operands: [
    { table_id: 't0001', row_label: '+ attention', column: '训练时长(min)' },
    { table_id: 't0001', row_label: '+ attention + 数据增强', column: '训练时长(min)' },
  ],
}, rIdx);
eq('★ 修正② · span 通道也应用列头单位的换算（7.1 分钟 → 426 秒，不是 7.1）',
  spanDur.operands[0].base_value === 426 && spanDur.operands[0].unit === 'min' && spanDur.operands[0].base === 'second', true);
eq('★ 修正② · 两条通道对同一个量给出**同一个基准值**（表格通道 7.1 分钟也是 426 秒）',
  tableDur.operands[0].base_value === spanDur.operands[0].base_value, true);
eq('★ 修正② · 值的单位与依据矛盾时不猜（50% 配「训练时长(min)」→ dim_evidence_unusable）',
  runCheck(rTxt, bundleIndex, evSpans, {
    id: 'ckT6', kind: 'numeric_recompute', operator: 'difference', claim: CLAIM_ATTN_Q2,
    operands: [
      { bundle_id: 'ev0005', span_index: 0, quote: '86.1%', label: '数据增强进一步提升至 86.1%', dim_evidence: DIM_DUR, dim_source_status: 'cited' },
      { bundle_id: 'ev0008', span_index: 1, quote: '0.847', label: '+ attention 0.847 7.1', ...st('0.847') },
    ],
  }, rIdx).operands[0].reasons, ['dim_evidence_unusable']);

// ③ 期望值的来源信息不能丢
eq('★ 修正③ · 期望值的来源保留在结果里（quote + offset + source_ref，不再只有 value）',
  (() => {
    const c = vf.checks.find(x => x.id === 'ck0001');
    return c.expected.origin === 'source_bound' && !!c.expected.offset && !!c.expected.source_ref &&
      !!c.expected.quote && rTxt.slice(c.expected.offset.start, c.expected.offset.end) === c.expected.quote &&
      c.expected.raw === '3.5';
  })(), true);
eq('修正③ · 自洽型检查的期望注明来自算子自身（rule_constant + rule 说明）',
  (() => {
    const c = vf.checks.find(x => x.id === 'ck0007');
    return c.expected.origin === 'rule_constant' && typeof c.expected.rule === 'string' && c.expected.rule.includes('恒为 1');
  })(), true);
eq('★ 修正③ · 全产物：每个期望都有出处，且 slice(offset) === quote（不变量在期望值上也成立）',
  vf.checks.every(c => c.expected === null ||
    (c.expected.origin === 'source_bound' && !!c.expected.offset && !!c.expected.quote &&
      rTxt.slice(c.expected.offset.start, c.expected.offset.end) === c.expected.quote) ||
    (c.expected.origin === 'rule_constant' && !!c.expected.rule)), true);

// ★ 真模型跑出来的 bug：降级路径里 rule_applicable 恒为 false（OPERATORS[x] 不带 operator 字段）
eq('★ 前置条件在降级路径也要如实报告：规则适用/容差策略应为 true，缺的是计算完整（ck0002）',
  (() => {
    const c = vf.checks.find(x => x.id === 'ck0002');
    return c.stance === 'unverified' && c.basis.preconditions.rule_applicable === true &&
      c.basis.preconditions.tolerance_policy === true && c.basis.preconditions.computation_complete === false;
  })(), true);

// ★ 真模型跑出来的缺口：单位也可能写在**行标签**里（真实实验表：列头是 Join 方案名，单位在 Average Time (ms)）
// 自带一套最小夹具，不依赖后面的合成夹具（声明顺序会咬人）
const RL_TXT = [
  '配置  准确率  时长(min)  列D',
  '甲  0.1  10  7',
  '乙  0.2  20  8',
  '平均耗时(ms)  0.6  60  12',
].join('\n');
const RL_SPAN = { offset: { start: 0, end: RL_TXT.length }, source_ref: { file: 'synth-rl.txt', sha256: 'rl', page: 1, entry: 'eR1' } };
const RL_B = buildBundleIndex({ evidence: [{ id: 'evRL', spans: [RL_SPAN] }] });
const RL_CLAIM = { bundle_id: 'evRL', span_index: 0, quote: '甲  0.1' };
const mkRLIdx = txt => {
  let off = 0;
  const entries = txt.split('\n').map((t, i) => {
    const start = txt.indexOf(t, off); off = start + t.length;
    return { id: 'e' + String(i + 1).padStart(4, '0'), type: 'paragraph', num: null, level: null, page: 1, lines: 1, start, end: start + t.length, text: t, table_id: null };
  });
  const { tables, owner } = detectTables(txt, entries);
  for (const e of entries) e.table_id = owner.get(e.id) ?? null;
  return { tables, entries, doc: { name: 'synth-rl.txt', sha256: 'rl', kind: 'pdf', chars: txt.length, text_file: 'synth-rl.txt', tables } };
};
const rlRun = (spec, id) => runCheck(RL_TXT, RL_B, [RL_SPAN], {
  id, kind: 'magnitude_sanity', operator: 'range_in', claim: RL_CLAIM,
  operands: [spec], params: { range: 'non_negative' },
}, mkRLIdx(RL_TXT));

eq('★ 表格单位来源：列头推不出来时去看行标签，并记下 from=row_label',
  (() => {
    const o = rlRun({ table_id: 't0001', row_label: '平均耗时(ms)', column: '列D' }, 'ckRL').operands[0];
    return o.ok === true && o.dim === 'duration' && o.unit_source?.from === 'row_label' &&
      o.unit_source?.marker === 'ms' && o.base_value === 12 * 0.001;
  })(), true);
eq('表格单位来源：列头能推出来时优先列头（from=column_header）',
  (() => {
    const o = rlRun({ table_id: 't0001', row_label: '甲', column: '准确率' }, 'ckRL2').operands[0];
    return o.ok === true && o.dim === 'ratio' && o.unit_source?.from === 'column_header';
  })(), true);

// ★ L3 契约版本是锚点 —— 改契约必须先 bump 它，且产物 schema 里的 const 必须与它一致（防漂移）
eq('★ L3 契约版本 = v0.2（v0.1 已冻结，v0.2 按修改意见加显式作用域）', L3_VERSION, 'v0.2');
eq('★ L3 产物 schema 的 authority.layer_version 与代码常量同源（不会一边 v0.2 一边 v0.1）',
  (() => {
    const sc = JSON.parse(vfSchemaBody);
    return sc.properties.authority.properties.layer_version.const === L3_VERSION &&
      sc.properties.authority.required.includes('layer_version') &&
      sc.properties.checks.items.required.includes('scope');
  })(), true);

log('');
log('=== L4 · Rubric-native Assessment（回归） ===');

// 合成契约：一个父项 + 一个 points 叶子 + 一个 levels 叶子
const L4T = '甲 0.5\n乙 0.6\n甲 0.5';
const L4_RUBRIC = {
  rubric_id: 'rb_t',
  source: { file: 't.txt', sha256: 'a'.repeat(64) },
  items: [
    { id: 'P', parent: null, text: '父项（10 分）', score_raw: '10 分', children: ['P.1'] },
    { id: 'P.1', parent: 'P', text: '叶子（10 分）', score_raw: '10 分', children: [] },
    { id: 'L', parent: null, text: '等级条目（5 分）', score_raw: '5 分', children: [] },
  ],
};
const L4_PROFILE = {
  profile_id: 'rap_t_v1', version: 1, status: 'provisional_test',
  rubric: { rubric_id: 'rb_t', source_sha256: 'a'.repeat(64) },
  items: [
    { rubric_item_id: 'P', scorable: false, aggregation: { type: 'sum_children', children: ['P.1'] } },
    { rubric_item_id: 'P.1', scorable: true, scoring_strategy: { type: 'points', min: 0, max: 10, step: 2 }, strategy_source_ref: { file: 't.txt', start: 0, end: 8 } },
    // ★ levels 必须把**等级表列全**：min/max 要与等级分数范围一致，等级原文就是标准本身
    { rubric_item_id: 'L', scorable: true, scoring_strategy: { type: 'levels', min: 0, max: 5, step: 1, levels: [
      { level_id: 'lv_0', score: 0, text: '未做到' }, { level_id: 'lv_1', score: 1, text: '起步' },
      { level_id: 'lv_2', score: 2, text: '部分' }, { level_id: 'lv_part', score: 3, text: '接近完整' },
      { level_id: 'lv_4', score: 4, text: '完整' }, { level_id: 'lv_full', score: 5, text: '完整且有余' },
    ] }, strategy_source_ref: { file: 't.txt', start: 9, end: 20 } },
  ],
};
const L4_ENTRIES = [
  { id: 'e0001', type: 'paragraph', page: 1, start: 0, end: 5, text: '甲 0.5' },
  { id: 'e0002', type: 'paragraph', page: 1, start: 6, end: 11, text: '乙 0.6' },
  { id: 'e0003', type: 'paragraph', page: 1, start: 12, end: 17, text: '甲 0.5' },
];
const L4_CHECKS = [
  { id: 'ck0001', stance: 'pass', kind: 'numeric_recompute', operator: 'difference', rubric_item_id: 'P.1', scope: 'rubric_item' },
  { id: 'ck0002', stance: 'fail', kind: 'internal_consistency', operator: 'agree', rubric_item_id: 'P.1', scope: 'rubric_item' },
  { id: 'ck0003', stance: 'unverified', kind: 'unit_check', operator: 'unit_consistent', rubric_item_id: 'P.1', scope: 'rubric_item' },
  { id: 'ck0009', stance: 'pass', kind: 'numbering', operator: 'numbering_continuity', rubric_item_id: null, scope: 'document' },
];
const mkCtx = itemId => ({
  item: L4_RUBRIC.items.find(i => i.id === itemId),
  pItem: L4_PROFILE.items.find(p => p.rubric_item_id === itemId),
  itemId,
  bundles: [{ id: 'evX', rubric_item_id: 'P.1', facet_id: 'F1', spans: [{ quote: '0.5', offset: { start: 2, end: 5 }, source_ref: { file: 'doc.pdf', page: 1, entry: 'e0001' } }], asset_refs: [{ kind: 'page_render', ref: 'x.png', page: 1 }] }],
  checks: L4_CHECKS.filter(c => c.scope === 'rubric_item'),
  documentChecks: L4_CHECKS.filter(c => c.scope === 'document'),
  checksById: new Map(L4_CHECKS.map(c => [c.id, c])),
  allBundleIds: new Set(['evX']),
  entries: L4_ENTRIES,
  docName: 'doc.pdf',
  full: L4T,
  assets: [{ asset_id: 'page-1', page: 1, file: 'x.png', readable: true }],
});
const l4Args = o => ({
  rubric_item_id: 'P.1', judgment: 'satisfied',
  findings: [{ polarity: 'strength', kind: 'completeness', note: '给出了完整的说明。' }],
  evidence_refs: [{ bundle_id: 'evX', span_indices: [0], role: 'support' }],
  verification_refs: [], rationale: '依据 evX 的 0.5 判定。', ...o,
});
// levels 分支的默认提交（L 条目，等级表 lv_0..lv_full 按 score 0..5）
const l4Levels = o => ({
  rubric_item_id: 'L', level_status: 'candidate', candidate_level_ids: ['lv_part'], boundary_condition: null,
  findings: [{ polarity: 'strength', kind: 'completeness', note: '接近完整。' }],
  evidence_refs: [{ bundle_id: 'evX', span_indices: [0], role: 'support' }],
  verification_refs: [], rationale: '依据 evX 的 0.5 判定。', ...o,
});
const l4Submit = o => L4.assessSubmission(mkCtx(o.itemId ?? 'P.1'), l4Args(o.args ?? o));
const l4SubmitLevels = o => L4.assessSubmission(mkCtx('L'), l4Levels(o.args ?? o));

// ① profile 与 rubric 必须自洽
eq('★ L4 · profile 与 rubric 自洽时校验通过', L4.validateProfile(L4_PROFILE, L4_RUBRIC).ok, true);
eq('★ L4 · levels 的 min/max 与等级分数范围矛盾 → 报错（不然模型选的等级会掉在范围外）', (() => {
  const bad = { ...L4_PROFILE, items: L4_PROFILE.items.map(p => p.rubric_item_id === 'L' ? { ...p, scoring_strategy: { ...p.scoring_strategy, min: 2 } } : p) };
  return L4.validateProfile(bad, L4_RUBRIC).errors.some(e => /等级分数范围/.test(e));
})(), true);
eq('★ L4 · points 的 criteria 点数之和 ≠ max → 报错（"按条项加"和"按 max"必须对得上）', (() => {
  const bad = { ...L4_PROFILE, items: L4_PROFILE.items.map(p => p.rubric_item_id === 'P.1' ? { ...p, scoring_strategy: { type: 'points', min: 0, max: 10, step: 1, criteria: [{ text: 'a', points: 3 }, { text: 'b', points: 3 }] } } : p) };
  return L4.validateProfile(bad, L4_RUBRIC).errors.some(e => /criteria 点数之和/.test(e));
})(), true);
eq('★ L4 · rubric 原件换了（sha 不等）→ profile 立即失效', (() => {
  const bad = { ...L4_PROFILE, rubric: { ...L4_PROFILE.rubric, source_sha256: 'b'.repeat(64) } };
  const r = L4.validateProfile(bad, L4_RUBRIC);
  return r.ok === false && r.errors.some(e => /失效/.test(e));
})(), true);
eq('★ L4 · 父项的聚合子项与 rubric 不一致 → 报错（不静默按错的树聚合）', (() => {
  const bad = { ...L4_PROFILE, items: L4_PROFILE.items.map(p => p.rubric_item_id === 'P' ? { ...p, aggregation: { type: 'sum_children', children: [] } } : p) };
  return L4.validateProfile(bad, L4_RUBRIC).errors.some(e => /聚合子项/.test(e));
})(), true);
eq('★ L4 · 只为 scorable 叶子生成 assessment', L4.scorableLeaves(L4_PROFILE), ['P.1', 'L']);

// ② v0.3 契约：分支互斥 + levels 候选档校验（模型不再提交任何分数）
eq('★ L4 · v0.2 的 score 字段被拒（工具 schema 里已没有它 → 调用闸拦下）', (() => {
  const runner = L4.createAssessmentRunner({ ctx: mkCtx('P.1'), ids: { next: 1 } });
  const r = runner.call({ function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(l4Args({ score: { strategy: 'points', awarded: 8, maximum: 10 } })) } });
  return r.reason_code === 'arguments_failed_schema' && runner.summary().accepted === 0;
})(), true);
eq('★ L4 · points 条目交 level_status → 拒（分支互斥的防御性校验）', l4Submit({ args: { level_status: 'candidate', candidate_level_ids: ['lv_part'] } }).reject, 'level_status_forbidden_for_points');
eq('★ L4 · levels 条目交 judgment → 拒（与候选档重复且易冲突）', l4SubmitLevels({ args: { judgment: 'satisfied' } }).reject, 'judgment_forbidden_for_levels');
eq('★ L4 · levels：候选档不在 profile 定义的等级里 → 拒（不许自造 rubric 没有的档）', l4SubmitLevels({ args: { candidate_level_ids: ['lv_nope'] } }).reject, 'level_not_in_rubric');
eq('★ L4 · levels：候选档超过 2 个 → 拒', l4SubmitLevels({ args: { candidate_level_ids: ['lv_1', 'lv_2', 'lv_part'] } }).reject, 'too_many_candidates');
eq('★ L4 · levels：两个候选档不相邻 → 拒', l4SubmitLevels({ args: { candidate_level_ids: ['lv_1', 'lv_full'], boundary_condition: 'x' } }).reject, 'levels_not_adjacent');
eq('★ L4 · levels：双候选必须写 boundary_condition（卡在哪个条件）', l4SubmitLevels({ args: { candidate_level_ids: ['lv_2', 'lv_part'] } }).reject, 'boundary_condition_required');
eq('★ L4 · levels：相邻双候选 + 卡点说明 → 通过，两档都进产物', (() => {
  const r = l4SubmitLevels({ args: { candidate_level_ids: ['lv_2', 'lv_part'], boundary_condition: '差在异常值的讨论深度' } });
  return r.ok === true && JSON.stringify(r.assessment.candidate_level_ids) === JSON.stringify(['lv_2', 'lv_part']) &&
    r.assessment.boundary_condition === '差在异常值的讨论深度';
})(), true);
eq('★ L4 · levels：非 candidate 状态给候选档 → 拒（非 candidate 一律空数组）',
  l4SubmitLevels({ args: { level_status: 'outside_defined_levels', candidate_level_ids: ['lv_1'] } }).reject, 'candidates_with_non_candidate_status');
eq('★ L4 · levels：candidate 但没给档 → 拒', l4SubmitLevels({ args: { candidate_level_ids: [] } }).reject, 'arguments_failed_schema');
eq('★ L4 · 父项不许被评估（模型交父项 → 拒）', l4Submit({ itemId: 'P', args: { rubric_item_id: 'P' } }).reject, 'not_scorable_item');
eq('★ L4 · 交的条目不是本次被问的那个 → 拒', l4Submit({ args: { rubric_item_id: 'L' } }).reject, 'rubric_item_mismatch');

// ③ 引用必须真实、逐字
eq('★ L4 · 不存在的 evidence bundle → 该引用被丢弃（不进产物）', (() => {
  const r = l4Submit({ args: { evidence_refs: [{ bundle_id: 'evNOPE', span_indices: [0], role: 'support' }] } });
  return r.ok === true && r.assessment.evidence_refs.length === 0 &&
    r.assessment.diagnostics.dropped_evidence_refs[0].reason === 'unknown_bundle';
})(), true);
eq('★ L4 · 不存在的 check → 该引用被丢弃', (() => {
  const r = l4Submit({ args: { verification_refs: [{ check_id: 'ck9999', impact: 'support' }] } });
  return r.assessment.verification_refs.length === 0 && r.assessment.diagnostics.dropped_verification_refs[0].reason === 'unknown_check';
})(), true);
eq('★ L4 · impact 与 stance 冲突的引用一律丢掉（pass↛contradict / fail↛support / unverified 只能 neutral）', (() => {
  const a = l4Submit({ args: { verification_refs: [{ check_id: 'ck0001', impact: 'contradict' }] } });
  const b = l4Submit({ args: { verification_refs: [{ check_id: 'ck0002', impact: 'support' }] } });
  const c = l4Submit({ args: { verification_refs: [{ check_id: 'ck0003', impact: 'contradict' }] } });
  return a.assessment.verification_refs.length === 0 && b.assessment.verification_refs.length === 0 &&
    c.assessment.verification_refs.length === 0 &&
    JSON.stringify([a.assessment.diagnostics.dropped_verification_refs[0].reason, b.assessment.diagnostics.dropped_verification_refs[0].reason, c.assessment.diagnostics.dropped_verification_refs[0].reason]) ===
    JSON.stringify(['impact_conflicts_pass', 'impact_conflicts_fail', 'impact_conflicts_unverified']);
})(), true);
eq('★ L4 · 文档级 check 只能被**显式引用**（不自动进任何 assessment），且照样受 impact 约束', (() => {
  const ok = l4Submit({ args: { verification_refs: [{ check_id: 'ck0009', impact: 'neutral' }] } });
  const bad = l4Submit({ args: { verification_refs: [{ check_id: 'ck0009', impact: 'contradict' }] } });   // pass 不能说成反证
  const none = l4Submit({});
  return ok.assessment.verification_refs[0]?.scope === 'document' && ok.assessment.verification_refs[0]?.impact === 'neutral' &&
    bad.assessment.verification_refs.length === 0 && bad.assessment.diagnostics.dropped_verification_refs[0].reason === 'impact_conflicts_pass' &&
    none.assessment.verification_refs.length === 0;
})(), true);

// ④ 补充引用必须比检索阶段更严
eq('★ L4 · 干净的补充引用被接纳（unambiguous + entry 覆盖 + 切片一致）', (() => {
  const r = l4Submit({ args: { supplemental_quotes: [{ quote: '乙 0.6', entry_hint: 'e0002', role: 'support' }] } });
  const s = r.assessment.supplemental_evidence[0];
  return r.assessment.supplemental_evidence.length === 1 && L4T.slice(s.offset.start, s.offset.end) === s.quote &&
    s.binding.selection === 'unambiguous' && s.source_ref.entry === 'e0002';
})(), true);
eq('★ L4 · 有歧义的补充引用被丢弃（不许"取首次出现"当已确认事实）', (() => {
  const r = l4Submit({ args: { supplemental_quotes: [{ quote: '甲', role: 'support' }] } });
  return r.assessment.supplemental_evidence.length === 0 &&
    r.assessment.diagnostics.dropped_supplemental_quotes[0].reason === 'ambiguous_quote';
})(), true);
eq('★ L4 · 绑不回原文的补充引用被丢弃', (() => {
  const r = l4Submit({ args: { supplemental_quotes: [{ quote: '这句不存在', role: 'support' }] } });
  return r.assessment.supplemental_evidence.length === 0 &&
    r.assessment.diagnostics.dropped_supplemental_quotes[0].reason === 'quote_not_found';
})(), true);

// ④b findings：结构化定性发现（v0.3 的核心交付物）
eq('★ L4 · finding 的干净定位被接纳（逐字绑定 + unambiguous + entry 覆盖，回填 located）', (() => {
  const r = l4Submit({ args: { findings: [{ polarity: 'concern', kind: 'reasoning', note: '乙那行数值异常', quote: '乙 0.6', entry_hint: 'e0002' }] } });
  const f = r.assessment.findings[0];
  return r.ok === true && !!f.located && L4T.slice(f.located.offset.start, f.located.offset.end) === '乙 0.6' &&
    f.located.binding.selection === 'unambiguous' && f.located.source_ref.entry === 'e0002' &&
    r.assessment.diagnostics.dropped_findings.length === 0;
})(), true);
eq('★ L4 · finding 的歧义定位 → finding 保留（定性观察不丢）但 located=null，进 dropped_findings', (() => {
  const r = l4Submit({ args: { findings: [{ polarity: 'neutral', kind: 'other', note: '甲出现两次', quote: '甲' }] } });
  const f = r.assessment.findings[0];
  return r.assessment.findings.length === 1 && f.located === null &&
    r.assessment.diagnostics.dropped_findings[0]?.reason === 'ambiguous_quote';
})(), true);
eq('★ L4 · finding 的定位绑不回原文 → 同样保留 finding、记 dropped_findings', (() => {
  const r = l4Submit({ args: { findings: [{ polarity: 'concern', kind: 'other', note: '引文不存在', quote: '这句不存在' }] } });
  return r.assessment.findings.length === 1 && r.assessment.findings[0].located === null &&
    r.assessment.diagnostics.dropped_findings[0]?.reason === 'quote_not_found';
})(), true);
eq('★ L4 · finding 挂 L3 check：有效的回填 stance，不存在的进 dropped_findings', (() => {
  const ok = l4Submit({ args: { findings: [{ polarity: 'concern', kind: 'calculation', note: '均值对不上', check_id: 'ck0002' }] } });
  const bad = l4Submit({ args: { findings: [{ polarity: 'concern', kind: 'calculation', note: '均值对不上', check_id: 'ck9999' }] } });
  return ok.assessment.findings[0].verification?.stance === 'fail' &&
    ok.assessment.diagnostics.dropped_findings.length === 0 &&
    bad.assessment.findings[0].verification === null && bad.assessment.diagnostics.dropped_findings.some(d => d.reason === 'unknown_check');
})(), true);
eq('★ L4 · finding 的说明是必填：空 note 的 finding 进不了产物，只留诊断', (() => {
  const r = l4Submit({ args: { findings: [{ polarity: 'concern', kind: 'other', note: '' }] } });
  return r.assessment.findings.length === 0 && r.assessment.diagnostics.dropped_findings.length === 1 &&
    r.assessment.diagnostics.dropped_findings[0].reason === 'invalid_finding';
})(), true);
eq('★ L4 · 可机械验证的断言应当有挂钩通道：finding 的 check_id 与 verification_refs 各自独立可用', (() => {
  const r = l4Submit({ args: {
    findings: [{ polarity: 'concern', kind: 'calculation', note: '均值对不上', check_id: 'ck0002' }],
    verification_refs: [{ check_id: 'ck0002', impact: 'contradict' }],
  } });
  return r.assessment.findings[0].verification?.check_id === 'ck0002' &&
    r.assessment.verification_refs[0]?.check_id === 'ck0002' && r.assessment.verification_refs[0]?.impact === 'contradict';
})(), true);

// ⑤ 审查路由（系统强制）
const reviewOf = r => r.assessment.review;
eq('★ L4 · 有 L3 fail 的条目强制送审（即使用户没引用它）',
  reviewOf(l4Submit({})).required === true && reviewOf(l4Submit({})).required_reason_codes.includes('l3_fail_for_item'), true);
eq('★ L4 · unverified 不被无条件送审；显式引用它才算"对判断必要"', (() => {
  const noRef = l4Submit({});
  const ref = l4Submit({ args: { verification_refs: [{ check_id: 'ck0003', impact: 'neutral' }] } });
  return !noRef.assessment.review.required_reason_codes.includes('referenced_l3_unverified') &&
    ref.assessment.review.required_reason_codes.includes('referenced_l3_unverified');
})(), true);
eq('★ L4 · 同时引用支持与反证 → 来源冲突，强制送审', (() => {
  const r = l4Submit({ args: { verification_refs: [{ check_id: 'ck0001', impact: 'support' }, { check_id: 'ck0002', impact: 'contradict' }] } });
  return r.assessment.review.required_reason_codes.includes('source_conflict');
})(), true);
eq('★ L4 · 一条起作用的依据都没有 → 强制送审（缺证据不许静默给分）', (() => {
  const r = l4Submit({ args: { evidence_refs: [] } });
  return r.assessment.review.required === true && r.assessment.review.required_reason_codes.includes('missing_support_evidence');
})(), true);
eq('★ L4 · 基于反证的否定判断算"有依据"（counterevidence 也是依据）', (() => {
  const r = l4Submit({ args: { judgment: 'not_satisfied', evidence_refs: [{ bundle_id: 'evX', span_indices: [0], role: 'counterevidence' }] } });
  return !r.assessment.review.required_reason_codes.includes('missing_support_evidence');
})(), true);
eq('★ L4 · 只要有一条引用被丢弃 → 必须送审（drop 了也仍有有效依据，结论不因此自动改）', (() => {
  const r = l4Submit({ args: { supplemental_quotes: [{ quote: '这句不存在', role: 'support' }] } });
  return r.ok === true && r.assessment.supplemental_evidence.length === 0 &&
    r.assessment.evidence_refs.length === 1 &&                       // 有效依据照常保留
    r.assessment.review.required === true &&
    r.assessment.review.required_reason_codes.includes('dropped_assessment_ref') &&
    r.assessment.judgment === 'satisfied';                            // 判断不因此改变
})(), true);
eq('★ L4 · levels：outside_defined_levels 强制送审且候选档必须为空（不硬选低档、不自造档）', (() => {
  const r = l4SubmitLevels({ args: { level_status: 'outside_defined_levels', candidate_level_ids: [] } });
  return r.ok === true && r.assessment.candidate_level_ids.length === 0 &&
    r.assessment.review.required === true && r.assessment.review.required_reason_codes.includes('outside_defined_levels');
})(), true);
eq('★ L4 · levels：not_applicable 强制送审（标准不适用 ≠ 学生没写，交教师确认）', (() => {
  const r = l4SubmitLevels({ args: { level_status: 'not_applicable', candidate_level_ids: [] } });
  return r.assessment.review.required === true && r.assessment.review.required_reason_codes.includes('not_applicable');
})(), true);
eq('★ L4 · levels：insufficient_evidence 强制送审（原文覆盖不可靠 ≠ 没写）', (() => {
  const r = l4SubmitLevels({ args: { level_status: 'insufficient_evidence', candidate_level_ids: [] } });
  return r.assessment.review.required === true && r.assessment.review.required_reason_codes.includes('insufficient_evidence');
})(), true);
eq('★ L4 · 送审不看 kind 标签：findings 的宽类别不触发任何送审路由', (() => {
  const kinds = ['calculation', 'reasoning', 'completeness', 'presentation', 'other'];
  const r = l4SubmitLevels({ args: {
    candidate_level_ids: ['lv_part'],
    findings: kinds.map(k => ({ polarity: 'concern', kind: k, note: `问题：${k}`, severity: 'minor' })),
  } });
  return r.ok === true && r.assessment.findings.length === 5 &&
    r.assessment.review.required_reason_codes.every(c => L4.SYSTEM_REVIEW_CODES.includes(c)) &&
    !r.assessment.review.required_reason_codes.some(c => /kind/i.test(c)) &&
    r.assessment.review.required_reason_codes.includes('missing_support_evidence') === false;   // 有 evidence 依据
})(), true);
eq('★ L4 · 四类引用（evidence / check / asset / 补充引用）任意一类被丢弃都算', (() => {
  const cases = [
    { evidence_refs: [{ bundle_id: 'evNOPE', span_indices: [0], role: 'support' }] },
    { verification_refs: [{ check_id: 'ck9999', impact: 'support' }] },
    { asset_refs: [{ asset_id: 'page-404', role: 'support' }] },
    { supplemental_quotes: [{ quote: '甲', role: 'support' }] },
  ];
  return cases.every(c => l4Submit({ args: c }).assessment.review.required_reason_codes.includes('dropped_assessment_ref'));
})(), true);
eq('★ L4 · L2 检索阶段丢弃的候选**不**触发 L4 送审（只算本次 assessment 提交里被丢弃的引用）', (() => {
  // 上游 L2 产物带着一堆"判废的候选"，但本次提交一条都没丢 → 不该因为上游的丢弃而送审
  const evWithL2Drops = {
    diagnostics: { facet_coverage: [{ facet_id: 'F1', dropped: [{ quote: '绑不回的候选' }] }, { facet_id: 'F2', rejected: ['x', 'y'] }] },
    evidence: [{ id: 'evX', rubric_item_id: 'P.1', facet_id: 'F1', spans: [{ quote: '0.5', offset: { start: 2, end: 5 }, source_ref: { file: 'doc.pdf', page: 1, entry: 'e0001' } }], asset_refs: [{ kind: 'page_render', ref: 'x.png', page: 1 }] }],
  };
  const ctx = L4.buildItemContext({
    rubric: L4_RUBRIC, profile: L4_PROFILE, evidenceFile: evWithL2Drops,
    checks: [L4_CHECKS[0]],   // 只放一条 pass 的 check，排掉其它送审原因，专测这一条规则
    idx: { entries: L4_ENTRIES, doc: { name: 'doc.pdf' } }, full: L4T, itemId: 'P.1',
  });
  const r = L4.assessSubmission(ctx, l4Args({}));
  const rev = r.assessment.review;
  return r.ok === true && rev.required === false &&
    !rev.required_reason_codes.includes('dropped_assessment_ref') &&
    r.assessment.diagnostics.dropped_evidence_refs.length === 0 &&
    r.assessment.diagnostics.dropped_supplemental_quotes.length === 0;
})(), true);

// ⑥ 覆盖账目（v0.3：不聚合分数；只记每个叶子是否拿到有效状态）
eq('★ L4 · 叶子缺结果 → 覆盖账目 complete=false，并列出缺哪些（无分值）', (() => {
  const agg = L4.aggregate({ rubric: L4_RUBRIC, profile: L4_PROFILE, assessments: [] });
  return agg.total.rule === 'no_machine_scores_teacher_decides' && !('awarded' in agg.total) &&
    agg.total.complete === false && JSON.stringify(agg.total.incomplete_items) === JSON.stringify(['P.1', 'L']) &&
    agg.sections.every(s => s.complete === false && !('awarded' in s)) &&
    agg.sections.find(s => s.rubric_item_id === 'P').children.every(c => c.status === 'missing');
})(), true);
eq('★ L4 · 覆盖账目：judged / candidate / non_candidate_state / missing 四态如实记录，满分仍可算', (() => {
  const a1 = l4Submit({}).assessment;                                        // points → judged
  const a2 = l4SubmitLevels({}).assessment;                                  // levels → candidate
  const agg = L4.aggregate({ rubric: L4_RUBRIC, profile: L4_PROFILE, assessments: [a1, a2] });
  const kids = agg.sections.find(s => s.rubric_item_id === 'P').children;
  return agg.total.complete === true && agg.total.maximum === 15 &&
    kids.find(k => k.rubric_item_id === 'P.1').status === 'judged' &&
    agg.sections.find(s => s.rubric_item_id === 'L') === undefined &&
    kids.every(k => 'judgment' in k && 'level_status' in k && !('awarded' in k));
})(), true);
eq('★ L4 · levels 的 insufficient_evidence 也算"拿到状态"（教师要看，但不是缺失）', (() => {
  const a = l4SubmitLevels({ args: { level_status: 'insufficient_evidence', candidate_level_ids: [] } }).assessment;
  const agg = L4.aggregate({ rubric: L4_RUBRIC, profile: L4_PROFILE, assessments: [l4Submit({}).assessment, a] });
  // L 是顶层叶子（不属于任何 section）→ 只体现在 total 上
  return agg.total.complete === true && agg.total.incomplete_items.length === 0;
})(), true);
eq('★ L4 · 完全没交的叶子才是 missing（覆盖账目唯一的"缺"）', (() => {
  const a1 = l4Submit({}).assessment;
  const agg = L4.aggregate({ rubric: L4_RUBRIC, profile: L4_PROFILE, assessments: [a1] });
  return agg.total.complete === false && JSON.stringify(agg.total.incomplete_items) === JSON.stringify(['L']);
})(), true);

// ⑦ 调用闸：账目 + 重复 + 预算
eq('★ L4 · 同一条目重复提交被拒（已经有一条被接受的 assessment）', (() => {
  const ctx = mkCtx('P.1');
  const ids = { next: 1 };
  const runner = L4.createAssessmentRunner({ ctx, ids });
  const call = args => ({ function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(l4Args(args)) } });
  const a = runner.call(call({}));
  const b = runner.call(call({}));
  return a.ok === true && b.ok === false && b.reason_code === 'duplicate_rubric_item' &&
    runner.summary().attempted === runner.summary().accepted + runner.summary().rejected;
})(), true);
eq('★ L4 · 未知工具名 → 拒收（不产生 assessment）', (() => {
  const runner = L4.createAssessmentRunner({ ctx: mkCtx('P.1'), ids: { next: 1 } });
  return runner.call({ function: { name: 'submit_something_else', arguments: '{}' } }).reason_code === 'unknown_tool';
})(), true);
eq('★ L4 · 账目平：accepted + rejected = attempted', (() => {
  const runner = L4.createAssessmentRunner({ ctx: mkCtx('P.1'), ids: { next: 1 }, maxCalls: 1 });
  const call = args => ({ function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(l4Args(args)) } });
  runner.call(call({ score: { strategy: 'points', awarded: 12, maximum: 10 } }));   // 拒（score 字段不存在）
  runner.call(call({}));                                                            // 撞上限 → 拒
  const s = runner.summary();
  return s.attempted === 2 && s.accepted === 0 && s.rejected === 2 && s.budget_exhausted === true;
})(), true);

// ⑧ 工具 schema / 产物 schema
const l4Tool = (t = 'points') => L4.l4Tools(t)[0].function.parameters;
eq('★ L4 · 工具 schema：rationale 是**软上限** —— 301 字照收；2000 字以上（防爆量）与缺失才拒', (() => {
  const over = validate(l4Tool(), l4Args({ rationale: 'x'.repeat(301) })).ok;      // 超过建议长度 → 仍然合法
  const hard = validate(l4Tool(), l4Args({ rationale: 'x'.repeat(2001) })).ok;     // 撞工程上限 → 拒
  const missing = (() => { const a = l4Args(); delete a.rationale; return validate(l4Tool(), a).ok; })();
  return over === true && hard === false && missing === false;
})(), true);
eq('★ L4 · 超长 rationale：不拒收、不截断，但记 over_limit 并强制送审', (() => {
  const runner = L4.createAssessmentRunner({ ctx: mkCtx('P.1'), ids: { next: 1 } });
  const r = runner.call({ function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(l4Args({ rationale: 'x'.repeat(301) })) } });
  if (r.ok !== true) return false;
  const a = runner.assessments[0];
  return a.rationale.chars === 301 && a.rationale.text.length === 301 && a.rationale.over_limit === true &&
    a.rationale.limit === 300 && a.review.required_reason_codes.includes('rationale_over_limit');
})(), true);
eq('★ L4 · 调用闸真的在 runner 里做 schema 校验（只在回归里 validate 一次是不够的 —— 实测踩到）', (() => {
  const runner = L4.createAssessmentRunner({ ctx: mkCtx('P.1'), ids: { next: 1 } });
  const call = o => ({ function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(o) } });
  const hard = runner.call(call(l4Args({ rationale: 'x'.repeat(2001) })));      // 撞防爆量上限
  const extra = runner.call(call(l4Args({ facet_score: 5 })));                  // 想给 facet 打分 → 字段不存在
  const badEnum = runner.call(call(l4Args({ judgment: '大概满足' })));
  const scoreField = runner.call(call(l4Args({ score: { strategy: 'points', awarded: 8, maximum: 10 } })));   // ★ v0.3：score 已删除
  const nonEnumPolarity = runner.call(call(l4Args({ findings: [{ polarity: '好', kind: 'other', note: 'x' }] })));
  return [hard, extra, badEnum, scoreField, nonEnumPolarity].every(r => r.reason_code === 'arguments_failed_schema') &&
    runner.summary().accepted === 0;
})(), true);
eq('★ L4 · 拒收必须把**原因**喂回给模型（只回一个码，模型只能瞎猜着重试 —— 实测连超长三次）', (() => {
  const runner = L4.createAssessmentRunner({ ctx: mkCtx('P.1'), ids: { next: 1 } });
  const res = runner.call({ function: { name: 'submit_rubric_assessment', arguments: JSON.stringify(l4Args({ rationale: 'x'.repeat(2001) })) } });
  const fed = L4.l4ResultFor(res);
  return fed.ok === false && fed.reason_code === 'arguments_failed_schema' && /maxLength/.test(fed.detail ?? '') &&
    !JSON.stringify(fed).includes('rationale x');
})(), true);
eq('★ L4 · 工具 schema 按条目分支：points 只有 judgment、levels 只有 level_status + 候选档，两者都**没有 score**',
  (() => {
    const p = l4Tool('points'), l = l4Tool('levels');
    const pk = Object.keys(p.properties), lk = Object.keys(l.properties);
    return p.additionalProperties === false && l.additionalProperties === false &&
      pk.includes('judgment') && !pk.includes('level_status') && !pk.includes('candidate_level_ids') &&
      lk.includes('level_status') && lk.includes('candidate_level_ids') && !lk.includes('judgment') &&
      !pk.includes('score') && !lk.includes('score') &&
      JSON.stringify(p.required.sort()) === JSON.stringify(['rubric_item_id', 'judgment', 'findings', 'evidence_refs', 'rationale'].sort()) &&
      JSON.stringify(l.required.sort()) === JSON.stringify(['rubric_item_id', 'level_status', 'findings', 'evidence_refs', 'rationale'].sort());
  })(), true);
eq('★ L4 · 工具 schema：facet 没有落点（模型无处可写 facet 分数）',
  (() => {
    const props = Object.keys(l4Tool().properties);
    return props.every(k => !/facet/i.test(k)) &&
      props.every(k => /^(rubric_item_id|judgment|level_status|candidate_level_ids|boundary_condition|findings|evidence_refs|asset_refs|verification_refs|supplemental_quotes|rationale)$/.test(k));
  })(), true);
eq('★ L4 · 工具 schema：findings 是封闭极性 + 半开放宽类别 + 具体说明（三个维度分开，不混成一个）',
  (() => {
    const f = l4Tool().properties.findings.items;
    return f.additionalProperties === false &&
      JSON.stringify(Object.keys(f.properties).sort()) === JSON.stringify(['polarity', 'kind', 'note', 'severity', 'quote', 'entry_hint', 'check_id', 'warrant'].sort()) &&
      JSON.stringify(f.properties.polarity.enum) === JSON.stringify(L4.FINDING_POLARITIES) &&
      JSON.stringify(f.properties.kind.enum) === JSON.stringify(L4.FINDING_KINDS) &&
      JSON.stringify([...f.required].sort()) === JSON.stringify(['polarity', 'kind', 'note'].sort());
  })(), true);
// ★★ warrant（"有依据的内容错误候选"）：必须是**三要素结构化**，而不是一个自报布尔值
eq('★★ L4 · warrant 是三要素结构化（原话 + 错在哪 + 依据），不是自报布尔值',
  (() => {
    const w = l4Tool().properties.findings.items.properties.warrant;
    if (!w || !w.properties) return false;
    const keys = Object.keys(w.properties).sort();
    const want = ['student_quote', 'what_is_wrong', 'basis_kind', 'basis_detail', 'basis_check_id'].sort();
    // ① 字段集合固定 ② 三要素为必填 ③ **不存在**任何 boolean 型的自报开关
    const noBool = !Object.values(w.properties).some(p => p.type === 'boolean');
    return JSON.stringify(keys) === JSON.stringify(want)
      && JSON.stringify([...w.required].sort()) === JSON.stringify(['student_quote', 'what_is_wrong', 'basis_kind', 'basis_detail'].sort())
      && w.additionalProperties === false
      && noBool
      && JSON.stringify(w.properties.basis_kind.enum) === JSON.stringify(['rubric_requirement', 'self_contradiction', 'l3_check']);
  })(), true);
eq('★ L4 · 装配器只有一份（stub 与真实模型共用同一个导出）',
  Object.keys(L4).filter(k => /^assemble/i.test(k)).length === 1 && typeof L4.assembleAssessmentArtifact === 'function', true);
const L4_SCHEMA = JSON.parse(await fs.readFile(path.join(here, '..', 'design', 'rubric-assessment.schema.json'), 'utf8'));
eq('★ L4 · 审查/拒收原因码在 schema 与工具层同源（送审**只**由系统规则决定）',
  (() => {
    const rev = L4_SCHEMA.$defs.assessment.properties.review.properties;
    return JSON.stringify(rev.required_reason_codes.items.enum) === JSON.stringify(L4.SYSTEM_REVIEW_CODES) &&
      JSON.stringify(Object.keys(rev).sort()) === JSON.stringify(['required', 'required_reason_codes']) &&
      JSON.stringify(L4_SCHEMA.properties.diagnostics.properties.rejected_calls.items.properties.reason_code.enum) === JSON.stringify(L4.L4_REJECT_CODES);
  })(), true);
eq('★ L4 · 工具里没有"建议送审"的字段（模型不该猜系统路由），产物里也没有',
  (() => {
    const props = l4Tool();
    return !('review' in props) && Object.keys(props).every(k => !/suggest/i.test(k)) &&
      !JSON.stringify(L4_SCHEMA.$defs.assessment.properties.review).includes('suggest') &&
      !L4.SYSTEM_REVIEW_CODES.some(c => /^suggest/.test(c));
  })(), true);
eq('★ L4 · 产物 schema：契约按 strategy 分支（if/then），且**没有任何分数字段**',
  (() => {
    const a = L4_SCHEMA.$defs.assessment;
    const props = Object.keys(a.properties);
    return !props.includes('score') && !props.includes('awarded') && !props.includes('facet_id') &&
      Array.isArray(a.allOf) && a.allOf.length === 2 &&
      a.required.includes('strategy_type') && props.includes('judgment') && props.includes('level_status') &&
      props.includes('candidate_level_ids') && props.includes('boundary_condition') &&
      L4_SCHEMA.properties.assessments.items.$ref === '#/$defs/assessment';
  })(), true);
eq('★ L4 · 产物 schema 的 authority 声明：机器不产生分值（layer_produces_score=false）',
  L4_SCHEMA.properties.authority.properties.layer_produces_score.const === false, true);

log('');
log('--- 合并前后的块边界（正文 fixture）---');
for (const b of merged) log(`  [${String(b.type).padEnd(9)}] L${String(b.lines).padStart(2)} ${JSON.stringify(b.text.slice(0, 44))}`);
log('');
log(`==== ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'} ====`);

await fs.writeFile(path.join(here, '_selftest.out.txt'), out.join('\n') + '\n', 'utf8');
if (fail > 0) {
  process.stderr.write(`_selftest: ${fail} 项失败\n`);
  process.exitCode = 1;
}
