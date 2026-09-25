// toolcalling.mjs —— L3 的 LLM tool calling 适配层与调用循环
//
// 一次调用 = 一条 check。模型能做的决策只有三件：选哪个 kind、用哪个算子、指哪里（span 或表格键值）。
// 其余全由系统决定：**id 由系统分配**（模型不能自报，否则是自由度也会撞号）、
// **容差由服务端按算子定**、**数值由系统从材料解析**、**展示句由程序生成**。
//
// ★ 两道闸，位置不同、后果不同：
//   ① **调用闸**（本文件）：工具名在不在枚举、arguments 是不是合法 JSON、参数是否过该 tool 的 schema。
//      结构不合格 → **不产生 check**，落进 `rejected_calls`（必须可见，不静默丢）。
//   ② **语义闸**（verify-tools）：参数结构合法但指错了地方（零匹配 / 多匹配 / 量纲不明…）
//      → **照样产生一条 check**，stance=unverified。这才有审计价值。
//
// 为什么调用闸也必须是"拒绝"而不是"降级成 unverified"：
// 契约要求 checks[] 里的 kind / operator 都在枚举内。工具名都不认识，就表达不出一条合法 check。
// 硬塞进去会污染产物；丢掉不说则会掩盖模型的错误。所以单开一张可见的拒绝表。

import { CHECK_KINDS, CALL_REJECT_CODES, llmTools, runCheck, L3_VERSION } from './verify-tools.mjs';
import { validate } from './validator.mjs';

const TOOL_TO_KIND = new Map(CHECK_KINDS.map(k => [`verify_${k}`, k]));

export { llmTools };

// 规范化后的参数串：用于查重（键序无关）
function canon(o) {
  if (Array.isArray(o)) return '[' + o.map(canon).join(',') + ']';
  if (o && typeof o === 'object') {
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}

export function createRunner({ full, bundleIndex, allSpans, l1Index = null, maxCalls = 200, idPrefix = 'ck', rubricItems = null }) {
  const specs = new Map(llmTools().map(t => [t.function.name, t.function.parameters]));
  // ★ v0.2：scope=rubric_item 的 id 必须真的存在于 canonical rubric（"必填且必须存在"）
  const rubricSet = rubricItems ? new Set(rubricItems) : null;
  const checks = [];
  const rejected = [];
  const duplicateCalls = [];
  const firstSight = new Map();
  let attempted = 0;

  const reject = (index, tool, reasonCode, detail) => {
    rejected.push({ index, tool: typeof tool === 'string' ? tool : null, reason_code: reasonCode, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
  };

  function call(toolCall) {
    const index = attempted++;
    const name = toolCall?.function?.name;
    if (attempted > maxCalls) {
      reject(index, name, 'budget_exhausted', `超过上限 ${maxCalls}`);
      return { ok: false, reason_code: 'budget_exhausted', index };
    }
    const params = specs.get(name);
    if (!params) { reject(index, name, 'unknown_tool'); return { ok: false, reason_code: 'unknown_tool', index }; }

    let args;
    try { args = JSON.parse(toolCall.function.arguments ?? '{}'); }
    catch (e) { reject(index, name, 'malformed_arguments_json', e.message); return { ok: false, reason_code: 'malformed_arguments_json', index }; }

    let v;
    try { v = validate(params, args); }
    catch (e) { reject(index, name, 'internal_tool_error', e.message); return { ok: false, reason_code: 'internal_tool_error', index }; }
    if (!v.ok) {
      reject(index, name, 'arguments_failed_schema', v.errors.slice(0, 3).map(e => `${e.path} ${e.msg}`).join('; '));
      return { ok: false, reason_code: 'arguments_failed_schema', index };
    }

    // ★ v0.2：作用域与条目 id 的一致性（结构合法之后、产生 check 之前）
    if (args.scope === 'rubric_item' && rubricSet && !rubricSet.has(args.rubric_item_id)) {
      reject(index, name, 'unknown_rubric_item', `rubric_item_id=${JSON.stringify(args.rubric_item_id)} 不在 canonical rubric 里`);
      return { ok: false, reason_code: 'unknown_rubric_item', index };
    }

    const key = name + '|' + canon(args);
    const dupOf = firstSight.has(key) ? firstSight.get(key) : null;
    if (dupOf === null) firstSight.set(key, index); else duplicateCalls.push({ index, of_index: dupOf });

    // kind 由**工具名**决定 —— 模型无法把算子与 kind 拆开组合
    const kind = TOOL_TO_KIND.get(name);
    // id 由系统分配 —— 模型不产生标识
    const id = idPrefix + String(checks.length + 1).padStart(4, '0');
    let result;
    try { result = runCheck(full, bundleIndex, allSpans, { ...args, id, kind }, l1Index); }
    catch (e) { reject(index, name, 'internal_tool_error', e.message); return { ok: false, reason_code: 'internal_tool_error', index }; }

    result.tool_call_index = index;
    checks.push(result);
    return { ok: true, index, id, stance: result.stance, reason_codes: result.reason_codes };
  }

  return {
    call,
    get checks() { return checks; },
    summary() {
      return {
        attempted,
        accepted: checks.length,
        rejected: rejected.length,
        duplicate: duplicateCalls.length,
        max_calls: maxCalls,
        budget_exhausted: rejected.some(r => r.reason_code === 'budget_exhausted'),
        duplicate_calls: duplicateCalls,
      };
    },
    rejected() { return rejected; },
  };
}

export { CALL_REJECT_CODES };

// ★ 产物装配只有**一份**：假模型与真实模型走同一条路，否则两条路会各自漂移。
export function assembleArtifact({ runner, doc, rubric, evidence, index, notice, authorityNotes }) {
  const checks = runner.checks;
  const count = s => checks.filter(c => c.stance === s).length;
  const reasons = new Map();
  for (const c of checks) if (c.stance === 'unverified') for (const r of c.reason_codes) reasons.set(r, (reasons.get(r) || 0) + 1);
  const byKind = {};
  for (const c of checks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;

  return {
    authority: {
      scoring_authority: 'rubric',
      rubric_sha256: rubric.sha256,
      layer_produces_score: false,
      layer_version: L3_VERSION,
      notes: authorityNotes ?? ('本产物由 tool calling 通路产生：模型的每次工具调用要么变成一条 check，'
        + '要么出现在 rejected_calls 里。id 由系统分配；容差由服务端按算子登记；数值由系统从材料解析；展示句由程序生成。'),
    },
    doc,
    rubric,
    evidence,
    index,
    checks,
    diagnostics: {
      diagnostic_only: true,
      notice,
      counts: { pass: count('pass'), fail: count('fail'), unverified: count('unverified') },
      by_kind: byKind,
      unverified_reasons: [...reasons].sort().map(([reason, c]) => ({ reason, count: c })),
      fail_precondition_status: checks.filter(c => c.stance === 'fail')
        .map(c => ({ check_id: c.id, all_true: Object.values(c.basis.preconditions).every(Boolean) })),
      tool_calling: runner.summary(),
      rejected_calls: runner.rejected(),
      not_scoring: 'L3 不评分。验证结论只描述「机械检查成立与否」，不描述学生表现。',
    },
  };
}
