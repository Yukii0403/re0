// _apiprobe.mjs —— 探真实模型：能不能通、有哪些模型、一次最小调用的用法与用量
// 用法: node _apiprobe.mjs
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = [];
const key = process.env.DEEPSEEK_API_KEY;
if (!key) { console.error('没有 DEEPSEEK_API_KEY'); process.exit(1); }

const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const model = process.env.LLM_MODEL || 'deepseek-flash';

const r1 = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
out.push(`GET /models → ${r1.status}`);
const j1 = await r1.json();
for (const m of j1.data ?? []) out.push(`  ${m.id}  name=${m.name}  ctx=${m.context_window}  in=${JSON.stringify(m.input_modalities)}`);

const t0 = Date.now();
const r2 = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：收到' }], max_tokens: 16, temperature: 0 }),
});
out.push(`POST /chat/completions → ${r2.status}  ${Date.now() - t0}ms  model=${model}`);
const txt = await r2.text();
out.push(txt.slice(0, 1200));

// 工具调用能力（本项目真正依赖的）
const t1 = Date.now();
const r3 = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: '用工具提交一个检查：差值 3 减去 1。' }],
    tools: [{
      type: 'function',
      function: {
        name: 'submit_difference', description: '提交一个差值检查',
        parameters: { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } },
      },
    }],
    tool_choice: 'auto', temperature: 0, max_tokens: 200,
  }),
});
out.push(`POST tool-calling → ${r3.status}  ${Date.now() - t1}ms`);
out.push((await r3.text()).slice(0, 1500));

await fsp.writeFile(path.join(here, '_apiprobe.out.txt'), out.join('\n') + '\n', 'utf8');
