// llm.mjs —— 真实模型的**最小**调用链（OpenAI 兼容的 chat completions + tool calling）
//
// 只做三件事：发消息、收 tool_calls、把工具结果喂回去。没有重试、没有流式、没有并发。
// fetch 是可注入的 —— 所以整条链可以在**不联网**的情况下被证明（见 `_llmrun.mjs --stub`）。
//
// 配置全部来自环境变量，缺了就抛错（fail-closed，不猜默认值）：
//   LLM_BASE_URL   如 https://api.deepseek.com/v1
//   LLM_API_KEY
//   LLM_MODEL      如 deepseek-chat
//
// ★ 初始消息里给的是**完整材料**（逐字正文 + 索引导航 + 候选证据 + rubric 条目），
//   之后每一轮喂回去的只有**结论**（stance + 原因码 + 算出的数），不再重复材料。
//
// ★ 已知风险，写明不遮盖：把结论喂回去，模型可能为了拿到 pass 而反复试探（"买一个通过"）。
//   对策不靠 prompt，靠两道机械约束：`maxCalls` 上限（撞上即 budget_exhausted）
//   与全量审计（重复调用、拒收调用都留痕）—— **试探行为本身可见**，而不指望它不发生。

import { llmTools } from './verify-tools.mjs';

export function llmConfigFromEnv(env = process.env) {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  const missing = Object.entries({ LLM_BASE_URL: baseUrl, LLM_API_KEY: apiKey, LLM_MODEL: model })
    .filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join(', ')}。真实调用链需要这三项（例如 `
      + `LLM_BASE_URL=https://api.deepseek.com/v1  LLM_API_KEY=sk-...  LLM_MODEL=deepseek-chat）。`
      + `不带凭据时可先用 --stub 跑通整条链。`);
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

// ★ L2 与 L3 的提示词必须**分开**：v1 里两份共用一条，往里面加 L3 的规则就会污染 L2（反之亦然）。
export const L2_SYSTEM_PROMPT = [
  '你是证据检索的执行者：只做两件事 —— 把 rubric 条目拆成**可在原文里查找的材料面**，以及**提交逐字引用串**。',
  '你不评分、不评价学生、不判断对错。',
  '',
  '硬约束：',
  '1. 只能通过工具提交（submit_retrieval_plan / submit_facet_candidates）。',
  '2. **每个非汇总条目都必须出现在 plan 里**（漏一个整次调用被拒）；汇总型父项不要给 facet。',
  '3. facet 是"可在原文里查找的材料面"，不是评分措辞；「充分」「合理」这类判断性措辞放进 blind_spots。',
  '4. 候选只给逐字引用串（quote）与 match_type —— 不要给偏移、不要给数字、不要写评价。',
  '5. 你给的 quote 会被逐字校验：原文里没有就如实报 no_candidate；**不许改写成"像原文"的句子**'
    + '（读起来合理但逐字不等的引用一律判废 —— 这条在真实数据上踩过）。',
].join('\n');

export const SYSTEM_PROMPT = [
  '你是机械验证的执行者，只做能机械判定的事，不评分、不评价学生。',
  '',
  '硬约束：',
  '1. 你**只能**通过工具提交检查。不要自己写数字运算结果 —— 数值一律由系统从材料里解析。',
  '2. 每次只提交**一次**工具调用。',
  '3. 指对象有两条通道：(a) span 通道给 bundle_id + span_index + quote + label；',
  '   (b) 表格通道给 table_id + row_label + column。表格查询三个字段都必须给，',
  '   row_label 与 column 必须逐字等于已解析的行标签 / 列头。',
  '4. ★ span 通道的**数值操作数必须给 dim_source_status**（表格通道不用给 —— 表格的单位由系统',
  '   按列头 / 行标签 / 整表 / 表注解析）：inline=这个数自己就带单位（写 "7.1 ms" 才算，写 "7.1" 不算）；',
  '   cited=另给 dim_evidence 指向原文里说明单位的那一处（如列头「验证准确率」）；',
  '   undeclared=确实找不到来源 —— **如实说 undeclared 是对的**，不会被算作错误。',
  '   系统会拿原文核对你的表态，填错则该操作数作废；漏填会被直接拒绝，不产生结论。',
  '5. 你给出的 quote / label 会被逐字校验。指错了地方不会得到"接近"的结果，只会被判为无法验证。',
  '6. 材料里没有的东西不要报。做完就停下，直接给出简短说明（不要复述数字）。',
].join('\n');

// 完整材料（只在这里出现一次）
export function materialsMessage({ full, idx, evidence, rubricItems, task }) {
  const nav = (idx.entries ?? []).map(e => `${e.id}\t${e.type}\tp${e.page ?? '-'}\t${e.start}-${e.end}\t${e.text.replace(/\n/g, '\\n').slice(0, 60)}`);
  const tables = (idx.tables ?? []).map(t => [
    `${t.id}  列数=${t.column_count}  可用于键值查询=${t.key_query_safe}  列边界来源=${t.cell_split_source}`,
    t.columns ? `  列头: ${t.columns.map(c => c.text).join(' | ')}` : '  （无列头）',
    ...t.rows.map(r => `  行: ${r.cells.map(c => c.text).join(' | ')}`),
  ].join('\n'));
  const spans = (evidence.evidence ?? []).map(e => [
    `${e.id}  rubric_item=${e.rubric_item_id}  facet=${e.facet_id}`,
    ...e.spans.map((s, i) => `  span[${i}] ${s.offset.start}-${s.offset.end}  ${JSON.stringify(s.quote)}  found_by=${JSON.stringify(s.found_by)}`),
  ].join('\n'));

  return [
    '## 任务',
    task ?? '下面是某个 rubric 条目与候选证据。请提交机械检查来验证候选证据里出现的数量关系。',
    '',
    '## rubric 条目（唯一评分权威，不可改）',
    ...(rubricItems ?? []).map(r => `- ${r.id}  ${r.text}`),
    '',
    '## 候选证据（L2 产出 —— 候选，不是已证明成立）',
    spans.join('\n') || '（无）',
    '',
    '## 索引导航（L1 产出，用于定位；表格可直接键值查询）',
    nav.join('\n'),
    '',
    '## 表格结构（L1 规则解析，可用于键值查询）',
    tables.join('\n') || '（本文档未还原出表格）',
    '',
    '## 完整原文（逐字，未经任何改写。所有的 quote 都必须能在这里找到）',
    '```',
    full,
    '```',
  ].join('\n');
}

// 成本核算用：包一层 fetch，累计 usage。拿不到 usage 不影响主流程（stub 就返回 0）。
export function countingFetch(impl = fetch, acc = { calls: 0, prompt_tokens: 0, completion_tokens: 0 }) {
  const wrapped = async (url, init) => {
    const res = await impl(url, init);
    acc.calls++;
    try {
      const b = await res.clone().json();
      if (b?.usage) {
        acc.prompt_tokens += b.usage.prompt_tokens ?? 0;
        acc.completion_tokens += b.usage.completion_tokens ?? 0;
      }
    } catch { /* 拿不到就算了 */ }
    return res;
  };
  wrapped.acc = acc;
  return wrapped;
}

// ★★ 重试 + 指数退避（2026-09-24 加）。
//   起因（实测）：holdout 跑 24 份时，前 4 份正常、之后**成批在 L2 挂掉**（exit=1），
//   而手动复现同样的样本又成功 —— 典型的**限流/网络抖动**。VerAs 单份 L2 的 prompt 就有
//   17 万–39 万 tokens，连续跑很容易撞上服务端的 TPM/RPM 窗口。
//   旧实现一次失败就 throw → 该样本白跑（钱花了、时间没了、指标还算不进去）。
//   现在：**429 / 5xx / 网络异常 / 超时** → 退避重试；其余 4xx（请求本身有问题）→ 立刻抛（重试无意义）。
// ★★ 请求超时（同日第二次修）：只重试"快速失败"是不够的 —— `fetch` 对
//   "服务端不响应、连接也不关闭"**没有默认超时**，会**永远挂着**。
//   实测：一份样本卡了 24 分钟，进程活着、CPU 不动、不写任何产物（内存仅 36MB）。
//   → 每次请求显式给 180s 超时；超时走同一条退避重试路径。
const RETRYABLE_STATUS = s => s === 429 || s >= 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const CHAT_RETRIES = 4;
export const CHAT_TIMEOUT_MS = 180000;

export async function chatWithTools({ messages, tools = llmTools(), cfg, fetchImpl = fetch, signal, retries = CHAT_RETRIES, onRetry = null, timeoutMs = CHAT_TIMEOUT_MS }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: 'auto', temperature: 0 }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = typeof res.text === 'function' ? await res.text() : '';
        const err = new Error(`LLM 返回 ${res.status}：${String(text).slice(0, 500)}`);
        if (RETRYABLE_STATUS(res.status) && attempt < retries) {
          lastErr = err;
          if (onRetry) onRetry({ attempt, status: res.status, message: err.message });
          await sleep(2 ** attempt * 1000 + Math.floor(Math.random() * 500));   // 1s, 2s, 4s, 8s（带抖动）
          continue;
        }
        throw err;
      }
      const body = await res.json();
      const msg = body?.choices?.[0]?.message;
      if (!msg) throw new Error('LLM 响应里没有 choices[0].message');
      return msg;
    } catch (e) {
      // 网络层异常（fetch reject / 连接被掐）→ 也退避重试；上面已判定的 HTTP 错误直接抛
      const isAlreadyJudged = /^LLM 返回 \d+/.test(e?.message ?? '') || /没有 choices\[0\]/.test(e?.message ?? '');
      if (!isAlreadyJudged && attempt < retries) {
        lastErr = e;
        if (onRetry) onRetry({ attempt, status: null, message: e?.message ?? String(e) });
        await sleep(2 ** attempt * 1000 + Math.floor(Math.random() * 500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error('LLM 调用失败（重试耗尽）');
}

// 喂回给模型的东西：只有结论，没有措辞、没有材料
export function toolResultFor(res) {
  if (!res.ok) return { ok: false, reason_code: res.reason_code };
  return {
    ok: true,
    id: res.id,
    stance: res.stance,
    reason_codes: res.reason_codes ?? [],
    computed: res.computed?.value ?? null,
    expected: res.expected?.value ?? null,
  };
}

export async function runToolLoop({ runner, messages, cfg, tools = llmTools(), maxTurns = 12, fetchImpl = fetch, onTurn = null, resultFor = toolResultFor }) {
  const convo = [...messages];
  for (let turn = 0; turn < maxTurns; turn++) {
    const msg = await chatWithTools({ messages: convo, tools, cfg, fetchImpl });
    convo.push(msg);
    const calls = msg.tool_calls ?? [];
    if (onTurn) onTurn({ turn, msg, calls });
    if (!calls.length) return { done: true, turns: turn + 1, messages: convo, final: msg.content ?? '' };
    for (const c of calls) {
      const res = runner.call(c);
      // resultFor 可注入：L4 的结论形状与 L3 不同（分数/判断/审查），但**喂回给模型的纪律一样** —— 只有结论，没有材料。
      convo.push({ role: 'tool', tool_call_id: c.id ?? `call_${turn}`, content: JSON.stringify(resultFor(res)) });
    }
  }
  return { done: false, turns: maxTurns, messages: convo, final: null };
}
