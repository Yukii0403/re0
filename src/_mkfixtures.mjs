// _mkfixtures.mjs —— 造真实测试夹具（PDF 由 Edge 无头模式打印，docx 由 fflate 打包）
// 用法: node _mkfixtures.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(here, '..', 'fixtures');
await fs.mkdir(fx, { recursive: true });

const BODY = `
<h2>1 实验目的</h2>
<p>本实验旨在验证不同学习率对模型收敛速度的影响，并观察注意力模块在消融实验中的作用。
实验基于 PyTorch 2.1 完成，训练集为 CIFAR-10 的子集，共 10000 张图像。</p>
<p>为控制变量，除学习率外其余超参数保持一致：批大小 64，优化器 Adam，训练 300 轮，
权重衰减 1e-4。评价指标采用验证集准确率与验证损失。</p>
<h2>2 实验方法</h2>
<p>本实验采用交叉熵损失衡量模型收敛情况，损失函数定义如下。</p>
<p>L = -1/N * sum(y_i * log(y_hat_i))    (1)</p>
<p>其中 N 为批内样本数，y_i 为真实标签的独热编码，y_hat_i 为模型输出的预测概率。
训练过程的核心循环如下所示。</p>
<pre>def train(model, loader, lr):
    opt = Adam(model.parameters(), lr=lr)
    for x, y in loader:
        loss = criterion(model(x), y)
        loss.backward()
        opt.step()
        opt.zero_grad()</pre>
<h2>3 实验结果</h2>
<p>三组学习率下验证损失的下降曲线如图所示。</p>
<div style="text-align:center;margin:12px 0">
<svg width="320" height="130" viewBox="0 0 320 130" xmlns="http://www.w3.org/2000/svg">
<rect x="30" y="5" width="280" height="100" fill="none" stroke="#333" stroke-width="1"/>
<polyline points="30,20 80,45 130,60 180,68 230,72 280,74" fill="none" stroke="#c00" stroke-width="2"/>
<polyline points="30,20 80,60 130,80 180,88 230,90 280,91" fill="none" stroke="#06c" stroke-width="2"/>
</svg>
</div>
<div style="text-align:center;font-size:9pt">图 3 不同学习率下的验证损失曲线</div>
<p>如图 3 所示，学习率取 0.01 时模型在前 200 轮收敛速度明显优于其他设置，
但后期出现轻微振荡；学习率取 0.001 时曲线更为平滑，但收敛显著更慢。</p>
<h2>4 消融实验</h2>
<p>为验证各模块的贡献，我们逐一移除组件并记录准确率变化，结果如表 4 所示。</p>
<table>
<tr><th>配置</th><th>验证准确率</th><th>训练时长(min)</th></tr>
<tr><td>baseline</td><td>0.812</td><td>6.4</td></tr>
<tr><td>+ attention</td><td>0.847</td><td>7.1</td></tr>
<tr><td>+ attention + 数据增强</td><td>0.861</td><td>9.8</td></tr>
</table>
<div style="text-align:center;font-size:9pt">表 4 各模块消融对比</div>
<p>可以看出注意力模块带来约 3.5 个百分点的提升，而数据增强进一步提升至 86.1%，
但训练时长增加约 53%，需要在精度与成本之间权衡。</p>
`;

// 让文档跨多页，以便观察页眉页脚是否被重复写入文本层
const FILLER = Array.from({ length: 6 }, (_, i) => `
<h2>5.${i + 1} 补充讨论</h2>
<p>本节进一步讨论第 ${i + 1} 组超参数组合的敏感性。实验表明，批大小从 32 增加到 128 时，
验证准确率的变化幅度小于 0.4 个百分点，说明模型对该超参数并不敏感。
这一结论与既往工作在中小规模数据集上的观察一致，但需要更多实验加以确认。</p>
<p>此外，学习率预热策略在训练初期带来了更稳定的梯度范数，但对最终精度影响有限。
我们建议在算力受限时优先保证训练轮数，而非引入更复杂的调度策略。</p>`).join('');

function html({ columns = false, title }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
@page { size: A4; margin: 16mm 16mm 18mm 16mm; }
body { font-family: "SimSun", serif; font-size: 10.5pt; line-height: 1.75; margin: 0;
  ${columns ? 'column-count: 2; column-gap: 8mm;' : ''} }
h1 { font-family: "SimHei", sans-serif; font-size: 16pt; margin: 8px 0; }
h2 { font-family: "SimHei", sans-serif; font-size: 12pt; margin: 12px 0 6px; }
p { margin: 6px 0; text-align: justify; }
pre { font-family: "Consolas", monospace; font-size: 9pt; line-height: 1.45;
  background: #f4f4f4; padding: 6px 8px; }
table { border-collapse: collapse; font-size: 9pt; width: 100%; }
td, th { border: 1px solid #444; padding: 2px 6px; }
.head { position: fixed; top: 0; left: 0; font-size: 8pt; color: #666; }
.foot { position: fixed; bottom: 0; left: 0; font-size: 8pt; color: #666; }
</style></head>
<body>
<div class="head">人工智能实验报告 · 2021150xxx · 张同学</div>
<div class="foot">深圳大学 计算机与软件学院</div>
<h1>实验二 模型调参与分析</h1>
${BODY}
${FILLER}
${FILLER}
</body></html>`;
}

await fs.writeFile(path.join(fx, 'report.html'), html({ title: 'report' }), 'utf8');
await fs.writeFile(path.join(fx, 'report-2col.html'), html({ columns: true, title: 'report2col' }), 'utf8');

// ---------------------------------------------------------------- 真 docx
// 刻意做得「不友好」：有 Heading 样式段，也有只靠加粗+字号直接排版的段；
// 有 w:drawing、m:oMath、等宽字体段、真表格。
const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第1章 引言</w:t></w:r></w:p>
<w:p><w:r><w:t>本文研究多模态作业评分中的证据对齐问题，重点关注可寻址证据图的构建。</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:sz w:val="30"/></w:rPr><w:t>1.1 研究背景</w:t></w:r></w:p>
<w:p><w:r><w:t>现有自动评分系统普遍缺乏证据链，评分理由无法回溯到学生原文。</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t>for x, y in loader:</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr><w:t xml:space="preserve">    loss = criterion(model(x), y)</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline distT="0" distB="0"><wp:extent cx="3000000" cy="1200000"/></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>图 1 系统总体架构</w:t></w:r></w:p>
<w:p><w:r><m:oMath><m:r><m:t>E = m c^2</m:t></m:r></m:oMath></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>配置</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>准确率</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>时长</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>baseline</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0.812</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>6.4</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>+attention</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0.847</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>7.1</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>表 1 各模块对比</w:t></w:r></w:p>
<w:p><w:r><w:t>综上，引入注意力模块可带来稳定提升。</w:t></w:r></w:p>
</w:body></w:document>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const zip = zipSync({
  '[Content_Types].xml': strToU8(contentTypes),
  '_rels/.rels': strToU8(rels),
  'word/document.xml': strToU8(docXml),
});
await fs.writeFile(path.join(fx, 'report.docx'), zip);

console.log('fixtures written to ' + fx);
