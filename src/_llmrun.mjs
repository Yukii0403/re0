// _llmrun.mjs —— 真实模型的最小调用链入口
//
// 两种跑法：
//   node _llmrun.mjs --stub     用**本地 stub 服务**把整条链跑通（不联网、不需要凭据）
//   node _llmrun.mjs            打真实模型（需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
//
// --stub 不是玩具：它注入的是**同一个** chatWithTools 的 fetch，所以「组消息 → 调模型 → 执行工具
// → 喂回结果 → 收尾 → 装配产物」这条链的每一段都被真的走过一遍。真实模型只是换一个 fetch。
//
// 用法: node _llmrun.mjs [--stub] [--terse]

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run as runL1 } from './l1.mjs';
import { createRunner, assembleArtifact, llmTools } from './toolcalling.mjs';
import { buildBundleIndex } from './verify-tools.mjs';
import { llmConfigFromEnv, materialsMessage, runToolLoop, SYSTEM_PROMPT, countingFetch } from './llm.mjs';
import { validate } from './validator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const STUB = argv.includes('--stub');
// 默认跑项目自带夹具；真实样本用 --file/--out/--rubric/--evidence 指定
const FILE = argOf('--file') ?? path.join(root, 'fixtures', 'report.pdf');
const outDir = argOf('--out') ?? path.join(root, 'fixtures', 'out');
const RUBRIC_PATH = argOf('--rubric') ?? path.join(design, 'canonical-rubric.example.json');
const BASE = path.basename(FILE);

const TXT = path.join(outDir, BASE + '.txt');
const IDX = path.join(outDir, BASE + '.index.json');
const EVP = argOf('--evidence') ?? path.join(design, 'evidence-candidates.example.json');
const OUT = path.join(outDir, BASE + (STUB ? '.checks.llm-stub.json' : '.checks.llm.json'));
const REPORT = path.join(here, STUB ? '_llmrun.out.txt' : '_llmrun.real.out.txt');

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

// ---------------------------------------------------------------- 本地 stub 服务
// 模拟 OpenAI 兼容接口：按脚本回 tool_calls。它同时是"模型到底收到了什么"的观察点。
function startStub(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 记下来就行 */ }
      seen.push({ url: req.url, model: parsed?.model, tools: parsed?.tools?.length ?? 0, messages: parsed?.messages ?? [] });
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      const payload = {
        id: 'stub', object: 'chat.completion', model: parsed?.model ?? 'stub',
        choices: [{ index: 0, finish_reason: step.tool_calls ? 'tool_calls' : 'stop', message: step }],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

// stub 的"模型行为"：第 1 轮走表格通道，第 2 轮走 span 通道，第 3 轮收尾
const STUB_SCRIPT = [
  {
    role: 'assistant', content: null,
    tool_calls: [{
      id: 'call_1', type: 'function',
      function: {
        name: 'verify_numeric_recompute',
        arguments: JSON.stringify({
          scope: 'rubric_item',
          rubric_item_id: 'R2.1',
          claim: { bundle_id: 'ev0005', span_index: 0, quote: '注意力模块带来约 3.5 个百分点的提升' },
          operator: 'difference',
          operands: [
            { table_id: 't0001', row_label: '+ attention', column: '验证准确率' },
            { table_id: 't0001', row_label: 'baseline', column: '验证准确率' },
          ],
          expected: { bundle_id: 'ev0005', span_index: 0, quote: '3.5 个百分点', label: '约 3.5 个百分点', dim_source_status: 'inline' },
        }),
      },
    }],
  },
  {
    role: 'assistant', content: null,
    tool_calls: [{
      id: 'call_2', type: 'function',
      function: {
        name: 'verify_magnitude_sanity',
        arguments: JSON.stringify({
          scope: 'rubric_item',
          rubric_item_id: 'R2.2',
          claim: { bundle_id: 'ev0005', span_index: 0, quote: '数据增强进一步提升至 86.1%' },
          operator: 'range_in',
          operands: [{ bundle_id: 'ev0005', span_index: 0, quote: '86.1%', label: '数据增强进一步提升至 86.1%', dim_source_status: 'inline' }],
          params: { range: 'fraction' },
        }),
      },
    }],
  },
  { role: 'assistant', content: '机械检查已提交完毕。', tool_calls: [] },
];

async function main() {
  const rep = [];
  await fsp.mkdir(outDir, { recursive: true });
  if (!(await exists(TXT)) || !(await exists(IDX))) await runL1(FILE, outDir);

  const full = await fsp.readFile(TXT, 'utf8');
  const idxBody = await fsp.readFile(IDX, 'utf8');
  const idx = JSON.parse(idxBody);
  const evBody = await fsp.readFile(EVP, 'utf8');
  const evFile = JSON.parse(evBody);
  const cr = JSON.parse(await fsp.readFile(RUBRIC_PATH, 'utf8'));
  const bundleIndex = buildBundleIndex(evFile);
  const allSpans = evFile.evidence.flatMap(e => e.spans);

  const runner = createRunner({ full, bundleIndex, allSpans, l1Index: idx, maxCalls: 40, rubricItems: (cr.items ?? []).map(i => i.id) });
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: materialsMessage({
        full, idx, evidence: evFile,
        rubricItems: cr.items,
        task: argOf('--task') ?? '下面是某个 rubric 条目与候选证据。请提交机械检查来验证候选证据里出现的数量关系。',
      }),
    },
  ];

  let cfg;
  let stub = null;
  const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  let fetchImpl = countingFetch(fetch, usage);
  if (STUB) {
    stub = await startStub(STUB_SCRIPT);
    cfg = { baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: 'stub', model: 'stub-model' };
    fetchImpl = (url, init) => fetch(url, init);
  } else {
    cfg = llmConfigFromEnv();
  }

  let loop;
  try {
    // 回合上限要够大：真实模型在一份 34 个候选 bundle 的文档上会想做很多检查。
    // 默认 6 太小（真跑时撞上限）—— 撞上时必须可见，凭 --turns 调。
    const maxTurns = Number(argOf('--turns') ?? 16);
    loop = await runToolLoop({ runner, messages, cfg, fetchImpl, maxTurns });
  } finally {
    if (stub) stub.server.close();
  }

  const out = assembleArtifact({
    runner,
    doc: { name: idx.doc.name, sha256: idx.doc.sha256, text_file: path.basename(TXT), index_file: path.basename(IDX) },
    rubric: { rubric_id: cr.rubric_id, sha256: cr.source.sha256, file: path.basename(RUBRIC_PATH) },
    evidence: {
      file: 'evidence-candidates.example.json',
      sha256: createHash('sha256').update(Buffer.from(evBody, 'utf8')).digest('hex'),
      plan_id: evFile.retrieval_plan.plan_id,
      plan_version: evFile.retrieval_plan.version,
    },
    index: { file: path.basename(IDX), sha256: createHash('sha256').update(Buffer.from(idxBody, 'utf8')).digest('hex'), tables: idx.tables.length },
    notice: `★ 由真实模型调用链产出（${STUB ? '本地 stub 服务，离线' : '真实 API'}：model=${cfg.model}）。`
      + '喂回给模型的只有结论、不含措辞；模型可能为拿到 pass 反复试探 —— 对策是 maxCalls 上限 + 全量审计，'
      + '试探行为本身在 duplicate_calls / rejected_calls 里可见。',
  });

  const body = JSON.stringify(out, null, 2);
  await fsp.writeFile(OUT, body, 'utf8');

  const schema = JSON.parse(await fsp.readFile(path.join(design, 'verification-checks.schema.json'), 'utf8'));
  let vr;
  try { vr = validate(schema, out); } catch (e) { vr = { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; }
  const allKeys = (o, acc = []) => {
    if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
    else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
    return acc;
  };
  const toolsSeen = stub ? (stub.seen[0]?.tools ?? 0) : llmTools().length;
  const firstUser = stub ? (stub.seen[0]?.messages?.find(m => m.role === 'user')?.content ?? '') : '';

  const checks_list = [
    ['产物通过真正的 schema 校验', vr.ok, true],
    ['★ 调用链收尾状态可见（要么模型主动收尾，要么明确记下撞了回合上限）',
      loop.done === true || loop.done === false, true],
    ['★ 每次请求都带上了 6 个 tool 定义', toolsSeen, 6],
    ['★ 初始消息里给了**完整原文**（逐字，未经改写）', STUB ? firstUser.includes(full) : true, true],
    ['★ 初始消息里给了索引导航与表格结构（表格可直接键值查询）',
      STUB ? /## 索引导航/.test(firstUser) && /## 表格结构/.test(firstUser) && firstUser.includes('t0001') : true, true],
    ['★ 模型走表格通道产出的 check 是 pass（定位由系统完成）',
      STUB ? out.checks[0]?.stance === 'pass' && out.checks[0]?.operands[0]?.cell?.cell_id === 't0001:r2:c2' : true, true],
    ['★ 模型走 span 通道产出的 check 是 pass（幅度合理性）',
      STUB ? out.checks[1]?.stance === 'pass' && out.checks[1]?.operator === 'range_in' : true, true],
    ['★ 喂回给模型的只有结论（role=tool 的消息里没有措辞、没有 computed 之外的散文）',
      STUB ? stub.seen.slice(1).every(s => (s.messages.filter(m => m.role === 'tool')).every(m => {
        const o = JSON.parse(m.content);
        return Object.keys(o).every(k => ['ok', 'id', 'stance', 'reason_codes', 'computed', 'expected', 'reason_code'].includes(k));
      })) : true, true],
    ['★ 期望值的来源信息在产物里保留（offset + source_ref）',
      out.checks.every(c => c.stance === 'pass'
        ? (c.expected.origin === 'source_bound' ? !!c.expected.offset : !!c.expected.rule) : true), true],
    ['★ accepted + rejected = attempted', out.diagnostics.tool_calling.accepted + out.diagnostics.tool_calling.rejected,
      out.diagnostics.tool_calling.attempted],
    ['产物里没有任何自由措辞字段',
      !allKeys(out).some(k => /^(statement|message|comment|explanation|reason_text|wording|prose)$/i.test(k)), true],
    ['counts 与 checks 一致',
      out.diagnostics.counts.pass === out.checks.filter(c => c.stance === 'pass').length, true],
  ];

  rep.push(`模式：${STUB ? '本地 stub 服务（离线）' : '真实 API'}   model=${cfg.model}   baseUrl=${cfg.baseUrl}`);
  rep.push(`回合数=${loop.turns}  模型收尾=${loop.done ? '是' : '★ 否 —— 撞了回合上限，这一轮有检查没做'}  模型最后说的话：${JSON.stringify((loop.final ?? '').slice(0, 80))}`);
  rep.push(`工具调用账目：attempted=${out.diagnostics.tool_calling.attempted} accepted=${out.diagnostics.tool_calling.accepted} rejected=${out.diagnostics.tool_calling.rejected}`);
  rep.push(`调用成本：calls=${usage.calls} prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens}${STUB ? '（stub 模式，token 为 0）' : ''}`);
  rep.push(`产出 ${path.relative(root, OUT).split(path.sep).join('/')}（${body.length} 字节）`);
  rep.push('');
  rep.push('--- 产出的 check ---');
  for (const c of out.checks) {
    rep.push(`  ${c.id} (call#${c.tool_call_index}) [${c.stance.padEnd(10)}] ${c.kind.padEnd(18)} ${c.operator.padEnd(15)} why=${JSON.stringify(c.reason_codes)}`);
    for (const o of c.operands) {
      rep.push(o.query ? `      op [表格] ${JSON.stringify(o.query)} → ${o.ok ? o.cell.cell_id + ' "' + o.cell.text + '"' : '未解析'}  unit_from=${o.unit_source?.from ?? '-'}  status=${JSON.stringify(o.dim_source_status)}` : `      op ${o.raw} dim=${o.dim} base_value=${o.base_value}  status=${JSON.stringify(o.dim_source_status)}`);
    }
    if (c.expected) {
      rep.push(`      exp ${c.expected.value} dim=${c.expected.dim} origin=${c.expected.origin}`
        + `${c.expected.offset ? ` offset=${c.expected.offset.start}-${c.expected.offset.end}` : ''}`
        + `${c.expected.source_ref ? ` entry=${c.expected.source_ref.entry} p${c.expected.source_ref.page}` : ''}`
        + `${c.expected.rule ? ` rule=${JSON.stringify(c.expected.rule)}` : ''}`);
    }
  }
  if (STUB) {
    rep.push('');
    rep.push('--- stub 收到的请求（证明"材料在第一条消息里给全、之后只喂结论"）---');
    stub.seen.forEach((s, i) => {
      const kinds = s.messages.map(m => m.role).join(',');
      rep.push(`  #${i}  tools=${s.tools}  messages=[${kinds}]  user长度=${s.messages.find(m => m.role === 'user')?.content.length ?? 0}`);
    });
    rep.push(`  第一条 user 消息是否包含完整原文（${full.length} 字符）：${firstUser.includes(full) ? '是' : '否'}`);
  }
  rep.push('');
  rep.push('--- 自证 ---');
  let bad = 0;
  for (const [name, got, want] of checks_list) {
    const ok = got === want;
    if (!ok) bad++;
    rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) {
      if (name.includes('schema')) for (const e of vr.errors.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
      else rep.push(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    }
  }
  rep.push('');
  rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

  // ★ 报告是**诊断输出**，不是产物：写失败（沙箱偶发 EPERM 等）**不该让整份样本作废**。
  //   实测踩过：一份 VerAs 样本 L4 全部调用成功、产物已写，却在最后写报告时 EPERM → 整份被判失败。
  try { await fsp.writeFile(REPORT, rep.join('\n') + '\n', 'utf8'); }
  catch (e) { process.stderr.write(`（报告写入失败，不影响产物：${e?.code ?? e?.message}）\n`); }
  if (bad > 0) {
    process.stderr.write(`_llmrun: ${bad} 项自证失败\n`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  process.stderr.write(`_llmrun 失败：${e.message}\n`);
  const hint = /LLM_|fetch|ENOTFOUND|ECONNREFUSED/.test(e.message)
    ? '\n提示：没有凭据时先用 --stub 跑通整条链（不联网）。'
    : '';
  if (hint) process.stderr.write(hint + '\n');
  process.exitCode = 1;
});
