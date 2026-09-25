// _l2run.mjs —— L2 走完整的两步（R 生成 plan → F 逐条定位），产出证据产物并自证
//
// 两种跑法：
//   node _l2run.mjs --stub    本地 stub 服务（不联网、不需要凭据）
//   node _l2run.mjs           打真实模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
//
// 模型负责的只有两件事：拆出检索面（R）、提交逐字引用串（F）。
// 编号（plan_id / facet id）、偏移、绑定、通道归因、硬规则、诊断统计**全部由系统做**。
//
// 用法: node _l2run.mjs [--stub]

import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { run as runL1 } from './l1.mjs';
import { renderPage } from './page.mjs';
import { validate } from './validator.mjs';
import { existsSync } from 'node:fs';
import { llmConfigFromEnv, chatWithTools, L2_SYSTEM_PROMPT, countingFetch } from './llm.mjs';
import {
  l2Tools, validatePlanArgs, planFromArgs, resolveCandidates, applyHardRule,
  coverageFor, assembleEvidence, L2_REJECT_CODES,
} from './l2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');
// 默认跑项目自带夹具；真实样本用 --file/--out/--rubric 指定
const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const STUB = argv.includes('--stub');
const FILE = argOf('--file') ?? path.join(root, 'fixtures', 'report.pdf');
const outDir = argOf('--out') ?? path.join(root, 'fixtures', 'out');
const RUBRIC_PATH = argOf('--rubric') ?? path.join(design, 'canonical-rubric.example.json');
const BASE = path.basename(FILE);

const TXT = path.join(outDir, BASE + '.txt');
const IDX = path.join(outDir, BASE + '.index.json');
// ★ plan 与证据的**运行产物**写到 out，不覆盖 design/ 下的契约样板
//   （契约样板由 _mkplan / _mkexample 生成，_selftest 会校验它们）
const PLAN_OUT = path.join(outDir, BASE + (STUB ? '.plan.stub.json' : '.plan.json'));
const EV_OUT = path.join(outDir, BASE + (STUB ? '.evidence.stub.json' : '.evidence.json'));
const REPORT = path.join(here, STUB ? '_l2run.out.txt' : '_l2run.real.out.txt');

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

function startStub(stepFn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      seen.push({ model: parsed?.model, tools: parsed?.tools?.length ?? 0, messages: parsed?.messages ?? [] });
      const msg = stepFn(seen.length - 1, parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', model: parsed?.model ?? 'stub',
        choices: [{ index: 0, finish_reason: msg.tool_calls?.length ? 'tool_calls' : 'stop', message: msg }] }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, seen })));
}

function toolCall(name, args, id) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

async function main() {
  const rep = [];
  await fsp.mkdir(outDir, { recursive: true });
  if (!(await exists(TXT)) || !(await exists(IDX))) await runL1(FILE, outDir);

  const full = await fsp.readFile(TXT, 'utf8');
  const idx = JSON.parse(await fsp.readFile(IDX, 'utf8'));
  const entries = idx.entries;
  const cr = JSON.parse(await fsp.readFile(RUBRIC_PATH, 'utf8'));
  const rubricSha = cr.source.sha256;
  const rubricRef = { rubric_id: cr.rubric_id, sha256: rubricSha, file: path.basename(RUBRIC_PATH), frozen_at: cr.frozen_at };
  const doc = { name: idx.doc.name, sha256: idx.doc.sha256, text_file: path.basename(TXT), index_file: path.basename(IDX), chars: idx.doc.chars };
  const scannedRange = `${entries[0].id}-${entries[entries.length - 1].id}`;
  const now = new Date().toISOString();

  const rejected = [];
  const decisions = [];
  const evidence = [];
  const assetsFailed = [];
  let calls = 0;
  let rAttempts = 0;
  const MAX_CALLS = 60;
  const PDF = FILE;

  // ---- R 阶段的"模型行为"（stub 用）：按 canonical rubric 逐条给检索面
  // 真实的检索面措辞来自模型；这里为了离线可证而写死，形状与模型输出完全一致。
  const R_PLAN = {
    items: cr.items.map(it => {
      if (it.id === 'R2.1') {
        return {
          rubric_item_id: 'R2.1',
          facets: [
            { text: '结果数值', form: 'value', modality: ['text', 'table'], channels: ['rule:numeric', 'structure:table', 'llm:semantic'] },
            { text: '趋势解释', form: 'narrative', modality: ['text', 'figure'], channels: ['rule:numbering', 'structure:figure', 'llm:semantic'] },
            { text: '误差来源', form: 'narrative', modality: ['text'], channels: ['llm:semantic'] },
          ],
          blind_spots: [
            { text: '充分', reason: '判断性措辞，原文里不存在一段叫「充分」的材料' },
            { text: '合理', reason: '判断性措辞' },
          ],
        };
      }
      if (it.id === 'R2.2') {
        return {
          rubric_item_id: 'R2.2',
          facets: [
            { text: '图注与表注', form: 'value', modality: ['figure', 'table'], channels: ['rule:numbering', 'structure:figure', 'structure:table', 'llm:semantic'] },
          ],
        };
      }
      return { rubric_item_id: it.id, facets: [] };
    }),
  };
  // ---- F 阶段的"模型行为"：按 facet 序号给候选
  const F_CANDIDATES = {
    'R2.1·F1': { candidates: [
      { quote: '0.812', match_type: 'verbatim' },
      { quote: '0.847', match_type: 'verbatim' },
      { quote: '3.5 个百分点', match_type: 'verbatim' },
    ], status: 'complete', outcome: 'located' },
    'R2.1·F2': { candidates: [
      { quote: '图 3 不同学习率下的验证损失曲线', match_type: 'implicit' },
      { quote: '三组学习率下验证损失的下降曲线如图所示。', match_type: 'implicit' },
    ], status: 'complete', outcome: 'located' },
    // 这两条故意做反例：一条是检索面转不出的盲点（无候选），
    // 一条**故意报错组合**（status=source_unavailable 却报 located）→ 必须被系统覆写成 undetermined
    'R2.1·F3': { candidates: [], status: 'source_unavailable', outcome: 'located', reason: '该模态的材料在原文里读不到' },
    'R2.2·F1': { candidates: [
      { quote: '图 3 不同学习率下的验证损失曲线', match_type: 'verbatim' },
      { quote: '表 4 各模块消融对比', match_type: 'verbatim' },
      { quote: '这段引用在原文里并不存在', match_type: 'verbatim' },   // 判废：绑不回原文
    ], status: 'complete', outcome: 'located' },
  };

  // 关键索引：按 (rubric_item_id, facet_id) 找 facet 对象
  let plan = null;
  const facetIndex = new Map();
  const orderedFacets = [];

  const cfg = STUB ? { baseUrl: '', apiKey: 'stub', model: 'stub-model' } : llmConfigFromEnv();
  let stub = null;
  const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  let fetchImpl = countingFetch(fetch, usage);
  if (STUB) {
    stub = await startStub((turn) => {
      // turn 0：**故意少报一个 rubric 条目** → 触发覆盖检查，整次调用被拒（演示 R 阶段的调用闸）
      if (turn === 0) {
        const partial = { items: R_PLAN.items.filter(it => it.rubric_item_id !== 'R3.2') };
        return { role: 'assistant', content: null, tool_calls: [toolCall('submit_retrieval_plan', partial, 'call_r_bad')] };
      }
      // turn 1：完整 plan
      if (turn === 1) return { role: 'assistant', content: null, tool_calls: [toolCall('submit_retrieval_plan', R_PLAN, 'call_r')] };
      const f = orderedFacets[turn - 2];
      if (!f) return { role: 'assistant', content: '候选已提交完毕。', tool_calls: [] };
      const callOf = (facet, id) => {
        const key = `${facet.rubric_item_id}·${facet.id}`;
        const body = F_CANDIDATES[key] ?? { candidates: [], status: 'complete', outcome: 'no_candidate', reason: null };
        return toolCall('submit_facet_candidates', { rubric_item_id: facet.rubric_item_id, facet_id: facet.id, ...body }, id);
      };
      // turn 2：**故意一轮提交两个检索面** → 逼出「每个 tool_call_id 都必须有回执」这条协议约束
      //（真实模型会这么干；少回一个，下一次请求直接 400 —— 实测踩到过）
      if (turn === 2 && orderedFacets[1]) {
        return { role: 'assistant', content: null, tool_calls: [callOf(f, 'call_f_2a'), callOf(orderedFacets[1], 'call_f_2b')] };
      }
      return { role: 'assistant', content: null, tool_calls: [callOf(f, `call_f_${turn}`)] };
    });
    fetchImpl = (url, init) => fetch(url, init);
    cfg.baseUrl = `http://127.0.0.1:${stub.port}`;
    cfg.apiKey = 'stub';
    cfg.model = 'stub-model';
  }

  const tools = l2Tools();
  const convo = [
    { role: 'system', content: L2_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        '## 第一步：R —— 拆检索面',
        '把下面每个**叶子** rubric 条目拆成检索面（facet）与检索盲点，用 submit_retrieval_plan 一次提交。',
        '标了「汇总型父项」的那些**不要给 facet** —— 它们由子项覆盖，给了只会产生重复证据；但它们必须出现在提交里。',
        'facet 是"可在原文里查找的材料面"，不是评分措辞；',
        '像「充分」「合理」这种判断性措辞属于**检索盲点**，放进 blind_spots。',
        '',
        '## rubric 条目（唯一评分权威，逐字，不可改）',
        ...cr.items.map(r => (r.children ?? []).length
          ? `- ${r.id}  ${r.text}   ← 汇总型父项（子项：${r.children.join('、')}）`
          : `- ${r.id}  ${r.text}`),
        '',
        '## 完整原文（逐字，未改写）',
        '```',
        full,
        '```',
      ].join('\n'),
    },
  ];

  // ---------------- R
  rep.push(`模式：${STUB ? '本地 stub 服务（离线）' : '真实 API'}   model=${cfg.model}`);
  for (let attempt = 0; !plan && attempt < 3; attempt++) {
    rAttempts++;
    const msg = await chatWithTools({ messages: convo, tools, cfg, fetchImpl });
    convo.push(msg);
    calls++;
    // ★★ 一轮里可能回来**多个** tool_call：每一个都必须有对应回执，否则下一次请求直接 400
    //    （真实 API：An assistant message with 'tool_calls' must be followed by tool messages
    //     responding to each 'tool_call_id'）。实测第一份样本就死在这里。
    const all = msg.tool_calls ?? [];
    const tc = all[0];
    const answerRest = detail => {
      for (const extra of all.slice(1)) {
        rejected.push({ stage: 'R', reason_code: 'one_plan_per_call', detail });
        convo.push({ role: 'tool', tool_call_id: extra.id ?? `call_r_extra_${attempt}`, content: JSON.stringify({ ok: false, reason_code: 'one_plan_per_call', detail }) });
      }
    };
    // ★ 拒收要**喂回给模型**（附上原因），让它自己修正 —— 否则模型无从知道哪里不合格
    const back = (reason_code, detail) => {
      rejected.push({ stage: 'R', reason_code, detail });
      convo.push({ role: 'tool', tool_call_id: tc?.id ?? `call_r_${attempt}`, content: JSON.stringify({ ok: false, reason_code, detail }) });
      answerRest('本轮已有一个 plan 提交，其余忽略（一次只接一个 plan）');
    };
    if (!tc) { rejected.push({ stage: 'R', reason_code: 'unknown_tool', detail: '模型这一轮没有提交工具调用' }); continue; }   // 没有 tool_call → 不能凭空造一条 tool 回执
    if (tc.function.name !== 'submit_retrieval_plan') { back('unknown_tool', tc.function.name); continue; }
    let args = null;
    try { args = JSON.parse(tc.function.arguments); }
    catch (e) { back('malformed_arguments_json', e.message); continue; }

    let vr;
    try { vr = validate(tools[0].function.parameters, args); }
    catch (e) { vr = { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; }
    if (!vr.ok) { back('arguments_failed_schema', vr.errors.slice(0, 3).map(e => `${e.path} ${e.msg}`).join('; ')); continue; }
    const cov = validatePlanArgs(args, cr.items);
    if (!cov.ok) { back('plan_incomplete', cov.errors.join('; ')); continue; }

    plan = planFromArgs(args, { rubric: cr, rubricSha256: rubricSha,
      planId: `rp_${rubricSha.slice(0, 12)}`, batchId: `batch_${rubricSha.slice(0, 12)}`, version: 1, now });
    for (const it of plan.items) for (const f of it.facets) { facetIndex.set(`${it.rubric_item_id}·${f.id}`, f); orderedFacets.push({ rubric_item_id: it.rubric_item_id, ...f }); }
    // ★ 每一个 tool_call 都必须有对应的 tool 回执 —— 即使它被接受了。
    //   否则下一轮请求就是"assistant 带 tool_calls 却没有 tool 消息跟随"，真实 API 直接 400。
    convo.push({
      role: 'tool', tool_call_id: tc.id ?? `call_r_${attempt}`,
      content: JSON.stringify({ ok: true, plan_id: plan.plan_id, items: plan.items.length, facets: orderedFacets.length }),
    });
    rep.push(`R 阶段：plan 建立成功 —— ${plan.items.length} 条条目 / ${orderedFacets.length} 个检索面（第 ${attempt + 1} 次尝试）`);
  }
  if (!plan) throw new Error('R 阶段没有产出 plan，后续无法进行');

  // ---------------- F：逐条独立定位（一个 facet 一次调用）
  for (const f of orderedFacets) {
    if (calls >= MAX_CALLS) { rejected.push({ stage: 'F', reason_code: 'budget_exhausted', detail: `${f.rubric_item_id}·${f.id}` }); break; }
    // 注意：**不再重复材料** —— 完整原文已经在第一条 user 消息里，历史里一直带着。
    // 每个 facet 只发一句指令，这也让"逐条独立定位"在调用形态上看得见。
    const userMsg = [
      `## 第二步：F —— 只针对这一个检索面提交候选`,
      `rubric 条目：${f.rubric_item_id}    检索面：${f.id}    语义形式：${f.form}    模态：${f.modality.join('/')}`,
      `检索面含义：${f.text}`,
      `声明的通道：${f.channels.join(', ')}`,
      '',
      '只给**逐字引用串**（quote）与强弱（match_type）；不要给偏移、不要给数字、不要写评价。',
      '原文里没有就如实报 no_candidate；材料读不到就报 source_unavailable（此时 outcome 必须是 undetermined）。',
    ].join('\n');
    convo.push({ role: 'user', content: userMsg });
    const msg = await chatWithTools({ messages: convo, tools, cfg, fetchImpl });
    convo.push(msg);
    calls++;
    const all = msg.tool_calls ?? [];
    const tc = all[0];
    // ★★ 一轮里回来多个 tool_call 时，**每一个都必须有回执**，否则下一次请求直接 400
    //    （实测第一份样本就是这么死的）。这里只处理第一个，其余明确拒绝并说明原因。
    const answerRest = () => {
      for (const extra of all.slice(1)) {
        const detail = `本轮已提交 ${f.rubric_item_id}·${f.id}，其余忽略（一次只接一个检索面）`;
        rejected.push({ stage: 'F', reason_code: 'one_facet_per_call', detail });
        convo.push({ role: 'tool', tool_call_id: extra.id ?? `call_f_extra_${calls}`, content: JSON.stringify({ ok: false, reason_code: 'one_facet_per_call', detail }) });
      }
    };
    // ★ 每个 tool_call 都要回执（含被拒的）：把原因喂回模型让它自己修正
    const back = (reason_code, detail) => {
      rejected.push({ stage: 'F', reason_code, detail });
      convo.push({ role: 'tool', tool_call_id: tc?.id ?? `call_f_${calls}`, content: JSON.stringify({ ok: false, reason_code, detail }) });
      answerRest();
    };
    if (!tc) { rejected.push({ stage: 'F', reason_code: 'unknown_tool', detail: `${f.rubric_item_id}·${f.id}：模型这一轮没提交工具调用` }); continue; }
    if (tc.function.name !== 'submit_facet_candidates') { back('unknown_tool', tc.function.name); continue; }
    let args = null;
    try { args = JSON.parse(tc.function.arguments); }
    catch (e) { back('malformed_arguments_json', e.message); continue; }
    const sc = tools[1].function.parameters;
    let vr;
    try { vr = validate(sc, args); } catch (e) { vr = { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; }
    if (!vr.ok) { back('arguments_failed_schema', vr.errors.slice(0, 3).map(e => `${e.path} ${e.msg}`).join('; ')); continue; }
    if (args.rubric_item_id !== f.rubric_item_id || args.facet_id !== f.id) {
      back('unknown_facet', `模型报了 ${args.rubric_item_id}·${args.facet_id}，本轮是 ${f.rubric_item_id}·${f.id}`);
      continue;
    }

    const r = resolveCandidates({ full, entries, facet: f, args, docRef: doc });
    // ★ 决策表里存模型的**原始声明** —— 硬规则只在 coverageFor 一处应用，
    //   这样既不会漏应用、也不会应用两次（两次会让覆写标记消失）。
    decisions.push({
      rubric_item_id: f.rubric_item_id, facet_id: f.id,
      status: args.status, outcome: args.outcome,
      reason: args.reason ?? null, dropped: r.dropped,
    });
    const hard = applyHardRule({ status: args.status, outcome: args.outcome, locatedCount: r.spans.length });
    if (r.spans.length) {
      // ★ 「必要时读取原始页面的能力」：图/表类 facet 的候选顺带附上整页渲染。
      //   要不要渲染由 facet 声明的模态机械决定，不是模型的决定；
      //   渲染失败不掩盖 —— 记进 assets_failed 并在报告里说出来。
      const assetRefs = [];
      for (const p of r.pages) {
        // ★ 只有 PDF 才有页面可渲染。纯文本输入去调 PDF 渲染器，只会白跑一遍 pdfjs 并报一堆
        //   "Indexing all PDF objects"，所以这里按输入类型机械决定，失败原因照样如实记下来。
        if (idx.doc.kind !== 'pdf') { assetsFailed.push({ page: p, error: `输入类型 ${idx.doc.kind}：没有页面可渲染` }); continue; }
        const png = path.join(outDir, `${path.basename(idx.doc.name)}.p${String(p).padStart(3, '0')}.png`);
        try {
          if (!(await exists(png))) await renderPage(PDF, p, png, 2);
          assetRefs.push({ kind: 'page_render', ref: path.relative(root, png).split(path.sep).join('/'), page: p, note: `第 ${p} 页整页渲染 —— 图形内容只能靠它来读` });
        } catch (e) {
          assetsFailed.push({ page: p, error: e.message });
        }
      }
      evidence.push({
        id: 'ev' + String(evidence.length + 1).padStart(4, '0'),
        rubric_item_id: f.rubric_item_id,
        facet_id: f.id,
        spans: r.spans,
        ...(assetRefs.length ? { asset_refs: assetRefs } : {}),
        ...(args.candidates.some(c => c.note) ? { note: args.candidates.map(c => c.note).filter(Boolean).join(' / ').slice(0, 120) } : {}),
      });
    }
    // 把结论喂回去（不含措辞、不重复材料）；bundle 只在 span 级记：这里只回报计数与判废
    convo.push({
      role: 'tool', tool_call_id: tc.id ?? `call_f_${calls}`,
      content: JSON.stringify({ ok: true, located: r.spans.length, dropped: r.dropped.length,
        status: hard.status, outcome: hard.outcome, ...(hard.overridden ? { outcome_overridden_from: hard.claimed_outcome } : {}) }),
    });
    answerRest();   // ★ 同一个 assistant 消息里的其余 tool_call 也必须被回应
  }

  // ---------------- 装配
  const coverage = coverageFor({ plan, decisions, evidence });
  const planBody = JSON.stringify(plan, null, 2);
  await fsp.writeFile(PLAN_OUT, planBody, 'utf8');
  const ref = assembleEvidence({
    doc,
    rubricRef,
    plan,
    planFile: path.basename(PLAN_OUT),
    planSha256: createHash('sha256').update(Buffer.from(planBody, 'utf8')).digest('hex'),
    evidence,
    coverage,
    scannedRange,
    notice: `★ 由 L2 实现产出（${STUB ? '本地 stub 服务' : '真实模型'}）。模型只提交逐字引用串，`
      + '偏移/绑定/通道归因/硬规则全部由系统做。facet coverage 只作诊断，不是 recall —— 产物不含 recall 字段。'
      + '判废的候选（绑不回原文）记在各 facet 的 dropped 里，不静默丢。',
  });
  const evBody = JSON.stringify(ref, null, 2);
  await fsp.writeFile(EV_OUT, evBody, 'utf8');

  // ---------------- 自证
  const es = JSON.parse(await fsp.readFile(path.join(design, 'evidence-candidates.schema.json'), 'utf8'));
  const ps = JSON.parse(await fsp.readFile(path.join(design, 'retrieval-plan.schema.json'), 'utf8'));
  const safe = (s, d) => { try { return validate(s, d); } catch (e) { return { ok: false, errors: [{ path: '(throw)', msg: e.message }] }; } };
  const vrEv = safe(es, ref);
  const vrPlan = safe(ps, plan);
  const allKeys = (o, acc = []) => {
    if (Array.isArray(o)) { for (const v of o) allKeys(v, acc); }
    else if (o && typeof o === 'object') { for (const k of Object.keys(o)) { acc.push(k); allKeys(o[k], acc); } }
    return acc;
  };
  const allSpans = evidence.flatMap(e => e.spans);
  const droppedAll = coverage.flatMap(c => c.dropped ?? []);
  const overridden = coverage.filter(c => c.hard_rule_overridden);
  const blindSpots = plan.items.flatMap(i => (i.blind_spots ?? []).map(b => `${i.rubric_item_id}·${b.text}`));

  const list = [
    ['plan 通过 retrieval-plan schema 校验', vrPlan.ok, true],
    ['证据产物通过 evidence-candidates schema 校验', vrEv.ok, true],
    ['★ plan 覆盖 canonical rubric 的全部条目（含汇总型父项）',
      cr.items.every(it => plan.items.some(p => p.rubric_item_id === it.id)) &&
      plan.items.length === cr.items.length, true],
    ['★ plan 与 rubric 强绑定（rubric_sha256 等于原件哈希）', plan.rubric_sha256 === rubricSha, true],
    ['★ plan 已版本化并批内固定', plan.version >= 1 && plan.pinned === true && plan.revision_log.length >= 1 && !!plan.batch_id, true],
    ['★ facet 三维度齐备（form / modality / channels），且 id 由系统编号',
      plan.items.every(it => it.facets.every(f => /^F[0-9]{1,3}$/.test(f.id) && f.form && f.modality.length && f.channels.length)), true],

    ['★ 每条 span 的 quote 都能按 offset 逐字切回原文',
      allSpans.every(s => full.slice(s.offset.start, s.offset.end) === s.quote), true],
    ['★ source_ref 指向的就是这份原件，且 entry 覆盖该 span',
      allSpans.every(s => s.source_ref.sha256 === idx.doc.sha256 &&
        (() => { const e = entries.find(x => x.id === s.source_ref.entry); return !!e && s.offset.start >= e.start && s.offset.end <= e.end; })()), true],
    ['每条证据都带原始上下文（before/after 确实切自原文）',
      allSpans.every(s => full.slice(Math.max(0, s.offset.start - s.context.before.length), s.offset.start) === s.context.before &&
        full.slice(s.offset.end, s.offset.end + s.context.after.length) === s.context.after), true],
    ['★ 判废的候选可见（凡是被提交但绑不回原文的 quote，都在 dropped 里，不静默丢）',
      droppedAll.every(d => typeof d.quote === 'string' && typeof d.reason === 'string') &&
      coverage.every(c => !c.dropped?.length || c.dropped.every(d => typeof d.occurrences !== 'undefined')), true],
    ['★ 判废只挂在它所属的 facet 上，不牵连别处',
      coverage.every(c => c.dropped === undefined || Array.isArray(c.dropped)), true],

    ['★ 硬规则：如果有「健康度异常却报 located」的声明，就必须已被覆写成 undetermined 且可见',
      overridden.length === 0 || overridden.every(c => c.outcome === 'undetermined' &&
        c.outcome_claimed !== 'undetermined' && c.hard_rule_overridden === true), true],
    ['★ 硬规则：不存在「健康度异常却报 located/no_candidate」的记录',
      coverage.every(c => !['source_unavailable', 'channel_error'].includes(c.status) || c.outcome === 'undetermined'), true],
    ['★ 每个 facet 都有诊断记录（含 0 命中的）',
      coverage.length === plan.items.reduce((n, i) => n + i.facets.length, 0), true],
    ['★ 0 命中的 facet 记为 no_candidate / undetermined，不是「学生没写」',
      coverage.filter(c => c.hits === 0).every(c => c.outcome !== 'located'), true],
    ['★ 检索盲点在 R 阶段暴露（不混进 facet）',
      !STUB || (blindSpots.length >= 2 && blindSpots.some(b => b.includes('充分'))), true],
    // ★★ 协议不变量（真实 API 的硬要求）：**每个 tool_call_id 都必须有回执**。
    //    真实模型会一轮给多个 tool_call；少回一个，下一次请求就被拒 400（实测踩到，整份样本作废）。
    ['★ 协议不变量：每个 tool_call_id 都有回执（一轮多调用也不能漏）',
      (() => (stub?.seen ?? []).every(s => s.messages.every((m, i) => {
        if (m.role !== 'assistant' || !(m.tool_calls ?? []).length) return true;
        const pending = new Set(m.tool_calls.map(c => c.id));
        let j = i + 1;
        while (j < s.messages.length && s.messages[j].role === 'tool') { pending.delete(s.messages[j].tool_call_id); j++; }
        return pending.size === 0;
      })))(), true],
    // ★ 以下两条是 **stub 专属**：真实模型的返回不可控，"它一定会一轮多给"不是不变量。
    //   我第一版忘了加 !STUB 守卫 → 真实跑必 FAIL（stub 为 null）→ 整份样本被自证拦下，
    //   连带 L3/L4 白跑。**教训：凡"某个具体输入才成立"的断言，必须写清作用域。**
    ['★ stub · 造出了「一轮多调用」的样本（否则上面那条断言是空跑）',
      !STUB || (stub?.seen ?? []).some(s => s.messages.some(m => m.role === 'assistant' && (m.tool_calls ?? []).length >= 2)), true],
    ['★ stub · 一轮多提交被明确拒绝并留痕（one_facet_per_call）',
      !STUB || rejected.some(r => r.reason_code === 'one_facet_per_call'), true],
    ['★ 盲点措辞不出现在任何 facet 的 text 里（facet 是材料面，不是评分措辞）',
      plan.items.every(i => i.facets.every(f => !/^(充分|合理)$/.test(f.text))), true],
    ['★ 语义通道归属：模型提交的引用若该面声明了 llm:semantic，就必须记为命中',
      coverage.filter(c => c.hits > 0).every(c => {
        const f = plan.items.find(i => i.rubric_item_id === c.rubric_item_id)?.facets.find(x => x.id === c.facet_id);
        return !f?.channels.includes('llm:semantic') || Object.prototype.hasOwnProperty.call(c.channels, 'llm:semantic');
      }), true],
    ['★ 每条 span 的 found_by ⊆ 该 facet 声明的通道（系统归因不越界）',
      (() => {
        for (const e of evidence) {
          const f = plan.items.find(i => i.rubric_item_id === e.rubric_item_id)?.facets.find(x => x.id === e.facet_id);
          for (const s of e.spans) if (!s.found_by.every(ch => f.channels.includes(ch))) return false;
        }
        return true;
      })(), true],

    ['产物任何层级都不存在 recall 字段', allKeys(ref).every(k => !/recall/i.test(k)), true],
    ['诊断被显式标记为 diagnostic_only', ref.diagnostics.diagnostic_only === true, true],
    ['plan 只引用不复制（retrieval_plan 字段集合固定）',
      Object.keys(ref.retrieval_plan).sort().join(','), 'batch_id,file,pinned,plan_id,sha256,version'],
    ['rubric 块只引用不复制', Object.keys(ref.rubric).sort().join(','), 'file,frozen_at,rubric_id,sha256'],
    ['权威声明里写明 plan 不参与评分', ref.authority.plan_participates_in_scoring === false, true],
    ['★ 图/表类 facet 附上整页渲染（asset_refs）—— 只在输入是 PDF 时有意义；'
      + '纯文本输入没有页面可渲染，此时必须是「没有 asset_refs + 失败原因如实记进 assets_failed」',
      (() => {
        const refs = evidence.flatMap(e => e.asset_refs ?? []);
        if (idx.doc.kind !== 'pdf') return refs.length === 0;
        return refs.length >= 1 && refs.every(a => existsSync(path.join(root, a.ref)));
      })(), true],
    ['★ 渲染失败不掩盖（要么成功、要么在 assets_failed 里说出来）',
      assetsFailed.length === 0 ||
      evidence.flatMap(e => e.asset_refs ?? []).length + assetsFailed.length > 0, true],
    ['★ 拒收的调用全部可见且码在枚举内（结构不合格的调用不产生 check，但必须留痕）',      rejected.every(r => L2_REJECT_CODES.includes(r.reason_code)), true],
    ['★ 账目：调用次数 = R 的尝试次数 + F 每面一次',
      calls, rAttempts + orderedFacets.length],
    ['证据条目的字段集合固定（结构上无法产生评分字段）',
      evidence.every(e => Object.keys(e).every(k => ['id', 'rubric_item_id', 'facet_id', 'spans', 'asset_refs', 'note'].includes(k))), true],
  ];

  rep.push('');
  rep.push(`调用成本：calls=${usage.calls} prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens}${STUB ? '（stub 模式，token 为 0）' : ''}`);
  rep.push('--- R 阶段产出的 plan ---');
  for (const it of plan.items) {
    rep.push(`  ${it.rubric_item_id}  facets=${it.facets.length}${it.summary ? `  ★ 汇总父项 → 跳过检索（子项：${(it.children ?? []).join('、')}）` : ''}${it.blind_spots ? `  blind_spots=${it.blind_spots.length}` : ''}`);
    for (const f of it.facets) rep.push(`      ${f.id} [${f.form}/${f.modality.join('+')}] ${JSON.stringify(f.text)}  通道=${f.channels.join(',')}`);
    for (const b of it.blind_spots ?? []) rep.push(`      ⚠ 盲点 ${JSON.stringify(b.text)} —— ${b.reason}`);
  }
  rep.push('');
  rep.push('--- F 阶段逐面结果 ---');
  for (const c of coverage) {
    rep.push(`  ${c.rubric_item_id}·${c.facet_id} [${c.form}] hits=${c.hits} status=${c.status} outcome=${c.outcome}${c.hard_rule_overridden ? `  ⚠ 硬规则覆写（模型报 ${c.outcome_claimed}）` : ''}`);
    rep.push(`      通道命中=${JSON.stringify(c.channels)}`);
    if (c.dropped?.length) for (const d of c.dropped) rep.push(`      ✗ 判废 ${JSON.stringify(d.quote).slice(0, 40)} —— ${d.reason}（原文出现 ${d.occurrences} 次）`);
  }
  rep.push('');
  rep.push('--- ★ 真实模型的行为统计（同温度下两轮会不一样，这是模型的非确定性，不是流水线的）---');
  rep.push(`  R 尝试 ${rAttempts} 次 · 检索面 ${orderedFacets.length} 个 · 证据 bundle ${evidence.length} 条 · span ${allSpans.length} 个`);
  rep.push(`  提交候选被判废 ${droppedAll.length} 条 · 调用被拒 ${rejected.length} 次 · 整份文档共 ${calls} 次模型调用`);
  rep.push(`  逐面：located ${coverage.filter(c => c.outcome === 'located').length} · no_candidate ${coverage.filter(c => c.outcome === 'no_candidate').length} · undetermined ${coverage.filter(c => c.outcome === 'undetermined').length}`);
  rep.push('');
  rep.push('--- ★ 拒收的调用（结构不合格 → 不产生 check，但必须可见）---');
  if (!rejected.length) rep.push('  （无）');
  for (const r of rejected) rep.push(`  [${r.stage}] ${r.reason_code.padEnd(26)} ${String(r.detail ?? '').slice(0, 130)}`);
  rep.push('');
  rep.push(`--- 通道使用诊断（声明了什么 vs 真正命中什么）---`);
  {
    const declared = new Map();
    for (const it of plan.items) for (const f of it.facets) for (const ch of f.channels) declared.set(ch, (declared.get(ch) || 0) + 1);
    const hit = new Map();
    for (const c of coverage) for (const [ch, n] of Object.entries(c.channels)) if (n > 0) hit.set(ch, (hit.get(ch) || 0) + 1);
    for (const ch of [...declared.keys()].sort()) {
      rep.push(`  ${ch.padEnd(18)} 被 ${String(declared.get(ch)).padStart(2)} 个面声明，其中 ${String(hit.get(ch) ?? 0).padStart(2)} 个面真的命中`);
    }
  }
  rep.push('');
  rep.push('--- 证据 bundle ---');
  for (const e of evidence) {
    rep.push(`  ${e.id} ${e.rubric_item_id}·${e.facet_id} spans=${e.spans.length}${e.asset_refs ? ` assets=${e.asset_refs.length}` : ''}`);
    for (const s of e.spans) rep.push(`      [${String(s.offset.start).padStart(5)}-${String(s.offset.end).padStart(5)}] ${s.source_ref.entry} ${s.match_type.padEnd(9)} 通道=${JSON.stringify(s.found_by)} 绑定=${s.binding.mode}/${s.binding.occurrences}次`);
    for (const a of e.asset_refs ?? []) rep.push(`      asset ${a.kind}: ${a.ref}（第 ${a.page} 页）`);
  }
  if (assetsFailed.length) {
    rep.push('');
    rep.push('--- ⚠ 渲染失败（没有掩盖）---');
    for (const a of assetsFailed) rep.push(`  第 ${a.page} 页：${a.error}`);
  }
  rep.push('');
  rep.push(`产出 ${path.relative(root, PLAN_OUT).split(path.sep).join('/')}（plan）与 ${path.relative(root, EV_OUT).split(path.sep).join('/')}（证据）`);
  rep.push('');
  rep.push('--- 自证 ---');
  let bad = 0;
  for (const [name, got, want] of list) {
    const ok = got === want;
    if (!ok) bad++;
    rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) {
      if (name.includes('schema')) {
        const errs = name.includes('plan') ? vrPlan.errors : vrEv.errors;
        for (const e of errs.slice(0, 8)) rep.push(`        ${e.path} ${e.msg}`);
      } else rep.push(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    }
  }
  rep.push('');
  rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' FAILED'} ====`);

  if (stub) stub.server.close();
  // ★ 报告是**诊断输出**，不是产物：写失败（沙箱偶发 EPERM 等）**不该让整份样本作废**。
  //   实测踩过：一份 VerAs 样本 L4 全部调用成功、产物已写，却在最后写报告时 EPERM → 整份被判失败。
  try { await fsp.writeFile(REPORT, rep.join('\n') + '\n', 'utf8'); }
  catch (e) { process.stderr.write(`（报告写入失败，不影响产物：${e?.code ?? e?.message}）\n`); }
  if (bad > 0) {
    process.stderr.write(`_l2run: ${bad} 项自证失败\n`);
    process.exitCode = 1;
  }
}

main().catch(e => {
  process.stderr.write(`_l2run 失败：${e.message}\n`);
  if (/LLM_/.test(e.message)) process.stderr.write('提示：没有凭据时先用 --stub。\n');
  process.exitCode = 1;
});
