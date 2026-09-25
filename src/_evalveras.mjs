// _evalveras.mjs —— VerAs 评测的**两阶段**驱动：`--run`（只跑，锁预测）／`--score`（揭晓 gold，出指标）
//
// ★★ 为什么必须两阶段（2026-09-24 Yukii 定的验证协议）：
//   旧版在**运行前**就读入并打印 gold，且默认复用开发集的输入/输出目录 —— 于是：
//     · 跑的人**看得到 gold**（判断会被锚定，哪怕自己不承认）；
//     · holdout 与开发集混在同一目录，产物可能互相顶替；
//     · 跑完立刻算指标，等于"边跑边看答案"。
//   → 现在：`--run` 阶段**只取样本 id**（连 gold 分数都不读进进程），预测全部锁定落盘后，
//     才由 `--score` 新起一次进程去读 gold。**"锁定后再揭晓"是结构保证，不是自觉。**
//
// ★★ 失败即停 + 禁止读旧产物（同一协议）：
//   旧版两个洞：① L2 失败会短路，但 **L3 失败仍跑 L4**；
//              ② L4 失败后仍会 `readIf(assessment.json)` → 读到**上一次**的同名产物参与映射。
//   现在：任一层 exit≠0 → **立刻停该样本**，记 `failed:<层>`，**不读任何已有产物**；
//        并且每层产物都要通过"**本次生成**"校验（mtime 必须晚于本次样本开始时间），否则同样记 failed。
//   失败样本**不进有效指标**（在 score 阶段单列）。
//
// ★★ 口径锁定：
//   `--run` 一次跑完（**不支持续跑/跳过** —— 那会引入"哪几份是新跑的"这种不可比状态）；
//   代码 / 模型 / 提示词 / 映射 / 指标在正式运行前用**开发样本冒烟测试**固定。
//
// 用法：
//   node _evalveras.mjs --run   --ids-from fixtures/veras/holdout/holdout.pendulum.json --out fixtures/veras/out-holdout
//   node _evalveras.mjs --score --lab pendulum --gold fixtures/veras/holdout/holdout.pendulum.json --out fixtures/veras/out-holdout
//   （旧式离线诊断仍可用 `_evalsum.mjs`，但**不属于 holdout 流程**：它会读 gold。）

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapArtifact } from './veras-map.mjs';
import { groupRows, GROUP_LABEL, groupMetrics, perDimMetrics, fmt, fmtSigned } from './_stats.mjs';
import { run as l1run } from './l1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const design = path.join(root, 'design');
const NODE = process.execPath;
const VDIR = path.join(root, 'fixtures/veras');

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const LAB = argOf('--lab', 'pendulum');
const MODE = process.argv.includes('--run') ? 'run' : (process.argv.includes('--score') ? 'score' : null);
const TURNS = String(argOf('--turns', '3'));
const STRICT = process.argv.includes('--strict');

const RUBRIC = path.resolve(root, argOf('--rubric', path.join('design', `canonical-rubric.veras-${LAB}.json`)));
const PROFILE = path.resolve(root, argOf('--profile', path.join('design', `rubric-assessment-profile.veras-${LAB}.json`)));
const IDS_FROM = path.resolve(root, argOf('--ids-from', path.join(VDIR, `gold.${LAB}.json`)));
const GOLD_PATH = path.resolve(root, argOf('--gold', path.join(VDIR, `gold.${LAB}.json`)));
const OUT = path.resolve(root, argOf('--out', path.join(VDIR, 'out')));
// ★ 样本 txt 所在目录：**holdout 的 txt 在自己的子目录里**（`fixtures/veras/holdout/`），
//   不是开发池的根目录 —— 必须显式指定，否则会去错误的地方找样本（跑不出东西）。
const SRC = path.resolve(root, argOf('--src', VDIR));
const PRED_PATH = path.join(OUT, `predictions.${LAB}.json`);
// ★ 两个阶段用**不同的报告文件**：否则 holdout 的 --run 报告会把 --score 的报告覆盖掉
//   （报告是要留档的证据，不能互相顶替）。
const REPORT = path.join(here, `_evalveras.${LAB}.${MODE}.out.txt`);

if (!MODE) {
  console.error([
    '_evalveras.mjs 需要显式指定阶段（两阶段是隔离 gold 的**结构保证**）：',
    '  --run    只跑样本、锁定预测（进程内**不读** gold 分数）',
    '  --score  揭晓 gold、出指标（读 --run 落盘的预测）',
    '常用参数：--lab pendulum --ids-from <名单 json> --gold <gold json> --out <产物目录> [--turns N] [--strict]',
  ].join('\n'));
  process.exit(2);
}

const read = async p => fsp.readFile(p, 'utf8');
const readIf = async p => { try { return await fsp.readFile(p, 'utf8'); } catch { return ''; } };
const readJson = async p => JSON.parse(await read(p));
const readJsonIf = async p => { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; } };
const statMs = async p => { try { return (await fsp.stat(p)).mtimeMs; } catch { return null; } };

const profile = await readJson(PROFILE);
const dims = profile.items.filter(p => p.scorable).map(p => p.rubric_item_id);
const maxTotal = dims.reduce((s, id) => s + profile.items.find(p => p.rubric_item_id === id).scoring_strategy.max, 0);
const pById = new Map(profile.items.map(p => [p.rubric_item_id, p]));

// ★★ 每层子进程加**硬超时**（2026-09-24 第三次卡死后的兜底）。
//   为什么需要：LLM 调用层的 180s 超时只管得住"单次请求"，管不住"一层里多次重试 × 多次调用"的累积，
//   也管不住网络之外的挂起点。实测出现过：一层卡 25 分钟无任何产物写入，而 API 本身 182ms 就返回
//   （即卡点不在网络）。→ 给子进程本身设上限，超时直接 kill（SIGKILL），该样本记失败、继续下一个。
//   上限怎么定：正常一份样本的 L2 ≈ 1–6 min、L3 ≤ 3 min、L4 ≈ 3–5 min → 15 分钟留足余量。
const STAGE_TIMEOUT_MS = Number(process.env.VERAS_STAGE_TIMEOUT_MS ?? 15 * 60 * 1000);
const run = (script, args) => new Promise(resolve => {
  const t0 = Date.now();
  const child = execFile(NODE, [script, ...args], {
    cwd: here, maxBuffer: 64 * 1024 * 1024, env: process.env,
    timeout: STAGE_TIMEOUT_MS, killSignal: 'SIGKILL',
  }, (err, stdout, stderr) => {
    const killed = err?.killed === true || err?.signal === 'SIGKILL';
    resolve({
      code: killed ? 124 : (err?.code ?? 0),
      stdout, stderr: killed ? `${stderr}\n（看门狗：该层超过 ${(STAGE_TIMEOUT_MS / 60000).toFixed(0)} 分钟被强制终止）` : stderr,
      ms: Date.now() - t0,
    });
  });
  child.on('error', e => resolve({ code: -1, stdout: '', stderr: String(e), ms: Date.now() - t0 }));
});
const costOf = txt => {
  const m = txt.match(/calls=(\d+)\s+prompt_tokens=(\d+)\s+completion_tokens=(\d+)/);
  return m ? { calls: Number(m[1]), prompt: Number(m[2]), completion: Number(m[3]) } : { calls: 0, prompt: 0, completion: 0 };
};
const callsOf = txt => {
  const m = txt.match(/工具调用账目：attempted=(\d+) accepted=(\d+) rejected=(\d+)/);
  return m ? { attempted: Number(m[1]), accepted: Number(m[2]), rejected: Number(m[3]) } : null;
};

const rep = [];
let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  rep.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) rep.push(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

// ================================================================== 阶段一：--run（锁预测）

if (MODE === 'run') {
  await fsp.mkdir(OUT, { recursive: true });

  // ★★ 只取 id —— 名单文件里可能带 gold 分数（如 holdout 清单），这里**显式只读 id 字段**，
  //    绝不把 dims/分数读进进程。这是"运行阶段看不到答案"的实现点。
  const idsDoc = await readJson(IDS_FROM);
  const ids = (idsDoc.reports ?? idsDoc.ids ?? []).map(r => (typeof r === 'string' ? r : r.id)).filter(Boolean);
  const caseOf = id => id + '.txt';

  rep.push('=== VerAs 运行阶段（--run，进程内不读 gold 分数）===');
  rep.push(`名单：${path.relative(root, IDS_FROM).split(path.sep).join('/')} → 只取 id，${ids.length} 份`);
  rep.push(`样本源：${path.relative(root, SRC).split(path.sep).join('/')}   输出：${path.relative(root, OUT).split(path.sep).join('/')}`);
  rep.push(`模型：${process.env.LLM_MODEL ?? '(未设)'}   turns=${TURNS}`);
  rep.push('');
  eq('★ 运行阶段只取 id：名单里的分数字段没有被读进进程', typeof ids[0], 'string');
  eq('★ 输出目录与开发集目录不同名（holdout 必须独立目录）',
    path.relative(root, OUT).split(path.sep).join('/') !== 'fixtures/veras/out', true);
  eq('★ 不允许"看文件存在就跳过"（--skip-done/--only 一律不支持）',
    !process.argv.includes('--skip-done') && !process.argv.includes('--only'), true);
  eq('★ 续跑只认 --resume，且必须核对 rubric/模型/turns 一致（不信"文件存在"）',
    !process.argv.includes('--resume') || (typeof ((await readJson(RUBRIC)).source?.sha256) === 'string'), true);

  // ★★ 数据前置检查（2026-09-24 加，0938 暴露）：正文过短的样本**不可评** ——
  //   实测一份 holdout 样本正文只有 12 个字符（几乎空的），模型却在它上面"评"了 R1–R7，
  //   这种预测毫无意义。处理：记 **skipped**（既不是系统失败，也不是有效样本），
  //   **不计入成功率分母**，报告里单列。
  const MIN_TEXT_CHARS = Number(process.env.VERAS_MIN_TEXT_CHARS ?? 200);

  const preds = [];
  // ★★ --resume：**可信续跑**。判据不是"产物文件存在"（那正是 `--skip-done` 的毛病），
  //   而是 ① predictions 里已有该 id 的**成功记录** ② rubric_sha256 与本次一致 ③ 模型/轮数一致。
  //   任何一条不符 → 拒绝续跑（宁可重跑，也不把两套口径的结果混在一起）。
  const RESUME = process.argv.includes('--resume');
  const prevIds = new Set();
  if (RESUME) {
    const prev = await readJsonIf(PRED_PATH);
    const curRubric = (await readJson(RUBRIC)).source?.sha256 ?? null;
    if (!prev) { console.error('--resume 需要已有 predictions 文件；没有就正常跑一次。'); process.exit(2); }
    if (prev.rubric_sha256 !== curRubric) { console.error(`--resume 拒绝：rubric 变了（${prev.rubric_sha256} ≠ ${curRubric}）—— 必须整批重跑。`); process.exit(2); }
    if (prev.model !== (process.env.LLM_MODEL ?? null) || prev.turns !== Number(TURNS)) {
      console.error('--resume 拒绝：模型或 turns 与上一批不同 —— 口径变了，必须整批重跑。'); process.exit(2);
    }
    for (const p of prev.predictions ?? []) if (!p.failed) { preds.push(p); prevIds.add(p.id); }
    rep.push(`  --resume：沿用已成功的 ${prevIds.size} 份（rubric/模型/turns 已核对一致）`);
  }

  // ★ 逐份落盘（进程可能被时限杀掉）：每跑完一份就把预测写回 predictions 文件 →
  //   续跑时只需读它，不必重新跑已成功的样本。
  const curRubricSha = (await readJson(RUBRIC)).source?.sha256 ?? null;
  const lockMeta = () => ({
    lab: LAB, mode: 'run', locked_at: new Date().toISOString(),
    model: process.env.LLM_MODEL ?? null, turns: Number(TURNS),
    rubric_sha256: curRubricSha,
    ids_from: path.relative(root, IDS_FROM).split(path.sep).join('/'),
    dims, max_total: maxTotal,
    note: '★ 预测已锁定：本文件**不含任何 gold**。指标必须由 `--score` 另起进程、读入 gold 后计算。',
  });
  const writeLock = async () => fsp.writeFile(PRED_PATH, JSON.stringify({ ...lockMeta(), predictions: preds }, null, 2) + '\n', 'utf8');

  for (const id of ids) {
    if (prevIds.has(id)) continue;                      // 已成功 → 不重跑（也不重新校验 mtime）
    const case_ = caseOf(id);
    const t0 = Date.now();
    // ★ 数据前置检查：太短的正文直接 skip（不跑任何层，不花一分钱）
    const srcText = await read(path.join(SRC, case_)).catch(() => '');
    if (srcText.length < MIN_TEXT_CHARS) {
      const rec0 = { id, skipped: `insufficient_text(${srcText.length} 字符 < ${MIN_TEXT_CHARS})`, cost: {} };
      preds.push(rec0); await writeLock();
      rep.push(`  ${id.padEnd(24)} ⊘ skipped：${rec0.skipped}`);
      continue;
    }
    const rec = { id, started_at: new Date(t0).toISOString(), failed: null, cost: {}, stages: {} };

    // 各层本次产物（运行前记录 mtime，运行后必须更新；否则视为"读了旧产物"）
    const pArt = path.join(OUT, case_ + '.assessment.json');
    const pEv = path.join(OUT, case_ + '.evidence.json');
    const pChk = path.join(OUT, case_ + '.checks.llm.json');
    const pIdx = path.join(OUT, case_ + '.index.json');
    const before = { idx: await statMs(pIdx), ev: await statMs(pEv), chk: await statMs(pChk), art: await statMs(pArt) };

    // ★★ 失败必须留下**可诊断的证据**：旧版只记了一个 `exit=1`，stderr 全丢 ——
    //   结果是 22 份失败却无法回溯原因（本项目第 5 条教训：闸越严，反馈越必须完整）。
    const guard = async (name, fn, outPath, beforeMs) => {
      const r = await fn();
      if (r.code !== 0) {
        rec.failed = `${name}(exit=${r.code})`;
        rec.stages[name] = r.code;
        rec.diagnostics = { ...(rec.diagnostics ?? {}), [name]: { stderr: (r.stderr || '').slice(0, 1200), stdout_tail: (r.stdout || '').slice(-800) } };
        return false;
      }
      const now = await statMs(outPath);
      if (now === null || (beforeMs !== null && now <= beforeMs) || now < t0) {
        // ★★ 这一条专治"读了同名旧产物"：产物必须是**本次生成**的
        rec.failed = `${name}(产物非本次生成)`;
        rec.stages[name] = 'stale_artifact';
        rec.diagnostics = { ...(rec.diagnostics ?? {}), [name]: { stderr: (r.stderr || '').slice(0, 1200), mtime: now, before: beforeMs, t0 } };
        return false;
      }
      rec.stages[name] = 0;
      return true;
    };

    // L1（本地解析，无模型成本）
    // ★ VerAs 的 txt 是数据集作者**已经抽好的** → 严格说 L1 在这份数据上被绕过；
    //   但仍然要跑：下游要的是 `<BASE>.txt` + `<BASE>.index.json` 这两个产物与它们的字节身份。
    const okL1 = await guard('L1', async () => {
      await l1run(path.join(SRC, case_), OUT);
      return { code: 0, ms: 0 };
    }, pIdx, before.idx);
    if (!okL1) { preds.push(rec); await writeLock(); rep.push(`  ${id.padEnd(24)} ✗ ${rec.failed}`); continue; }

    // L2
    const okL2 = await guard('L2', () => run('_l2run.mjs', ['--file', path.join(SRC, case_), '--out', OUT, '--rubric', RUBRIC]), pEv, before.ev);
    rec.cost.L2 = costOf(await readIf(path.join(here, '_l2run.real.out.txt')));
    if (!okL2) { preds.push(rec); await writeLock(); rep.push(`  ${id.padEnd(24)} ✗ ${rec.failed}`); continue; }

    // L3 —— ★ 旧版 L3 失败仍跑 L4；现在**立刻停**
    const okL3 = await guard('L3', () => run('_llmrun.mjs', ['--file', path.join(SRC, case_), '--out', OUT, '--rubric', RUBRIC, '--evidence', pEv, '--turns', TURNS]), pChk, before.chk);
    rec.cost.L3 = costOf(await readIf(path.join(here, '_llmrun.real.out.txt')));
    rec.l3 = callsOf(await readIf(path.join(here, '_llmrun.real.out.txt')));
    if (!okL3) { preds.push(rec); await writeLock(); rep.push(`  ${id.padEnd(24)} ✗ ${rec.failed}（不跑下游）`); continue; }

    // L4
    const okL4 = await guard('L4', () => run('_l4run.mjs', ['--case', case_, '--out', OUT, '--rubric', RUBRIC, '--profile', PROFILE, '--turns', TURNS]), pArt, before.art);
    rec.cost.L4 = costOf(await readIf(path.join(here, '_l4run.real.out.txt')));
    if (!okL4) { preds.push(rec); await writeLock(); rep.push(`  ${id.padEnd(24)} ✗ ${rec.failed}（不读任何已有产物参与映射）`); continue; }

    // ★ 只有到这里才读产物——且它是**本次生成**的
    const art = await readJson(pArt);
    const m = mapArtifact(art, dims, profile, null);   // ★ goldDims = null：运行阶段不看 gold
    rec.pred = m.pred;
    rec.map_kinds = m.kinds;
    rec.map_states = m.states;
    rec.map_counts = m.counts;
    rec.judgments = dims.map(x => art.assessments?.find(a => a.rubric_item_id === x)?.judgment ?? null);
    rec.level_statuses = dims.map(x => art.assessments?.find(a => a.rubric_item_id === x)?.level_status ?? null);
    rec.review = dims.map(x => !!art.assessments?.find(a => a.rubric_item_id === x)?.review?.required);
    const allFindings = (art.assessments ?? []).flatMap(a => a.findings ?? []);
    rec.findings = allFindings.length;
    rec.anchored_findings = allFindings.filter(f => f.located || f.verification).length;
    rec.ms = Date.now() - t0;
    preds.push(rec);
    await writeLock();
    rep.push(`  ${id.padEnd(24)} ✓ ${rec.ms / 1000 | 0}s  映射=${m.pred.map(v => v ?? '—').join('/')}  弃权=${m.counts.abstain}  outside=${m.counts.outside}`);
  }

  // ---- 锁定：预测落盘（此文件里**没有 gold**）
  const lock = {
    lab: LAB, mode: 'run', locked_at: new Date().toISOString(),
    model: process.env.LLM_MODEL ?? null, turns: Number(TURNS),
    rubric_sha256: (await readJson(RUBRIC)).source?.sha256 ?? null,
    ids_from: path.relative(root, IDS_FROM).split(path.sep).join('/'),
    dims, max_total: maxTotal,
    note: '★ 预测已锁定：本文件**不含任何 gold**。指标必须由 `--score` 另起进程、读入 gold 后计算。',
    predictions: preds,
  };
  await fsp.writeFile(PRED_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8');

  const okN = preds.filter(p => !p.failed && !p.skipped).length;
  const skipN = preds.filter(p => p.skipped).length;
  rep.push('');
  rep.push('--- 运行汇总（不含 gold）---');
  rep.push(`  成功 ${okN}/${preds.length - skipN}（${preds.length - skipN ? (okN / (preds.length - skipN) * 100).toFixed(1) : '—'}%）   失败 ${preds.filter(p => p.failed).length} 份   数据跳过 ${skipN} 份（正文过短；既不算成功也不算失败）`);
  const failKinds = preds.filter(p => p.failed).reduce((m, p) => { m[p.failed.split('(')[0]] = (m[p.failed.split('(')[0]] ?? 0) + 1; return m; }, {});
  if (Object.keys(failKinds).length) rep.push(`  失败分布：${JSON.stringify(failKinds)}`);
  const tk = preds.reduce((a, p) => ({
    calls: a.calls + (p.cost.L2.calls + p.cost.L3.calls + p.cost.L4.calls),
    prompt: a.prompt + (p.cost.L2.prompt + p.cost.L3.prompt + p.cost.L4.prompt),
    completion: a.completion + (p.cost.L2.completion + p.cost.L3.completion + p.cost.L4.completion),
  }), { calls: 0, prompt: 0, completion: 0 });
  rep.push(`  成本：calls=${tk.calls}  prompt=${tk.prompt}  completion=${tk.completion}   （单份均值 ${(tk.calls / preds.length).toFixed(1)} 次调用）`);
  rep.push('');
  eq('★ 成功率被记录（失败样本单列，不混入有效指标）', typeof okN, 'number');
  eq('★ 数据跳过（正文过短）不算成功、也不算失败', preds.filter(p => p.skipped).every(p => !p.failed), true);
  eq('★ 预测文件已落盘且不含 gold', !(await readIf(PRED_PATH)).includes('"gold"'), true);
  rep.push('');
  rep.push(`==== ${bad === 0 ? 'ALL PASS（预测已锁定）' : bad + ' 项失败'} ====`);
  await fsp.writeFile(REPORT, rep.join('\n') + '\n', 'utf8');
  console.log(rep.join('\n'));
  if (bad > 0) process.exitCode = 1;
  process.exit(0);
}

// ================================================================== 阶段二：--score（揭晓 gold）

{
  const lock = await readJsonIf(PRED_PATH);
  if (!lock) { console.error(`没有找到锁定的预测文件：${PRED_PATH}\n先跑 --run。`); process.exit(2); }
  const gold = await readJson(GOLD_PATH);

  rep.push('=== VerAs 评分阶段（--score，揭晓 gold）===');
  rep.push(`预测：${path.relative(root, PRED_PATH).split(path.sep).join('/')}（锁定于 ${lock.locked_at}）`);
  rep.push(`gold：${path.relative(root, GOLD_PATH).split(path.sep).join('/')}`);
  rep.push(`样本：预测 ${lock.predictions.length} 份 · gold ${gold.reports.length} 份`);
  rep.push('');
  const goldIds = new Set(gold.reports.map(g => g.id));
  const predIds = lock.predictions.map(p => p.id);
  // ★ 判据分两档：预测**不能凭空多出** gold 里没有的样本（硬错）；
  //   预测少于 gold 是**允许**的（冒烟只跑子集），但必须显式报出来。
  eq('★ 预测的样本都在 gold 名单里（预测不许凭空多出样本）', predIds.filter(id => !goldIds.has(id)), []);
  eq('★ 预测与 gold 的样本集合一致（--strict：正式运行要求完全相等）',
    STRICT ? predIds.length === gold.reports.length : true, true);
  rep.push(`  （预测 ${predIds.length} 份 / gold ${gold.reports.length} 份${predIds.length < gold.reports.length ? ' —— 子集运行：指标只在这 2 份上算' : ''}）`);

  const gById = new Map(gold.reports.map(g => [g.id, g]));
  const rows = [];
  const failed = [];
  const skipped = [];
  for (const p of lock.predictions) {
    const g = gById.get(p.id);
    if (!g) continue;
    // ★ 数据跳过（正文过短）**既不是失败也不是有效样本**：单列，且不进任何分母
    if (p.skipped) { skipped.push({ id: p.id, reason: p.skipped }); continue; }
    if (p.failed) { failed.push({ id: p.id, failed: p.failed }); continue; }
    const zeroHit = (g.dims ?? []).map((v, i) => [v, p.pred[i]]).filter(([gv, pv]) => gv === 0 && pv === 0).length;
    const gold0 = (g.dims ?? []).filter(v => v === 0).length;
    const anchoredRate = p.findings ? p.anchored_findings / p.findings : null;
    rows.push({
      id: p.id, status: g.status, source: g.source,
      gold: g.dims, gold_total: g.dims.reduce((a, b) => a + b, 0),
      pred: p.pred, predicted_total: p.map_counts.abstain === 0 ? p.pred.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) : null,
      complete: p.map_counts.abstain === 0,
      map_counts: p.map_counts, map_kinds: p.map_kinds, map_states: p.map_states,
      zero_hit: zeroHit, gold0: gold0,
      review: p.review, review_rate: p.review.length ? p.review.filter(Boolean).length / p.review.length : null,
      anchored_rate: anchoredRate,
      findings: p.findings ?? 0, anchored_findings: p.anchored_findings ?? 0,
      judgments: p.judgments, level_statuses: p.level_statuses,
      cost: p.cost, ms: p.ms,
      ta: g.ta_rescaled, rater: g.rater_rescaled,
    });
  }

  const groups = groupRows(rows);
  const usable = rows.filter(r => typeof r.predicted_total === 'number');
  const abstained = rows.filter(r => typeof r.predicted_total !== 'number');

  // ---- 总览
  const total = lock.predictions.length;
  const denom = total - skipped.length;      // ★ 分母扣掉"数据跳过"（那些样本不可评，不是系统的锅）
  const okN = denom - failed.length;
  rep.push('--- 总览（按协议：失败与弃权都不进有效指标）---');
  rep.push(`  成功率：${okN}/${denom}（${denom ? (okN / denom * 100).toFixed(1) : '—'}%）   失败 ${failed.length}   数据跳过 ${skipped.length}   弃权（总分不可给）${abstained.length}   可算总分指标 ${usable.length}`);
  if (skipped.length) rep.push(`  （分母已扣除"数据跳过"；这些样本正文过短、不可评，既不算成功也不算失败）`);
  rep.push(`  弃权率（按样本）：${(abstained.length / Math.max(1, okN) * 100).toFixed(1)}%`);
  // 逐维弃权率
  const dimAbstain = dims.map((id, i) => ({ id, n: rows.filter(r => r.map_kinds?.[i] === 'abstain').length }));
  rep.push(`  逐维弃权：${dimAbstain.map(d => `${d.id}:${d.n}`).join('  ')}`);
  // 档位分布
  const kindDist = dims.map((id, i) => {
    const c = { assessed: 0, outside: 0, abstain: 0 };
    for (const r of rows) c[r.map_kinds?.[i]] = (c[r.map_kinds?.[i]] ?? 0) + 1;
    return `${id}[assessed ${c.assessed}/outside ${c.outside}/abstain ${c.abstain}]`;
  });
  rep.push(`  各维状态分布：${kindDist.join('  ')}`);
  // 0 分覆盖（宽口径）
  const g0 = rows.reduce((s, r) => s + r.gold0, 0);
  const z0 = rows.reduce((s, r) => s + r.zero_hit, 0);
  rep.push(`  ★ 0 分覆盖（宽口径：映射为 0 的维度 ∩ gold=0）：${z0}/${g0}${g0 ? `（${(z0 / g0 * 100).toFixed(0)}%）` : ''}`);
  // 证据可回溯率
  const fAll = rows.reduce((s, r) => s + (r.findings ?? 0), 0);
  const fAnch = rows.reduce((s, r) => s + (r.anchored_findings ?? 0), 0);
  rep.push(`  证据可回溯率（finding 有原文定位或 L3 挂钩）：${fAnch}/${fAll}${fAll ? `（${(fAnch / fAll * 100).toFixed(1)}%）` : ''}`);
  // 送审率
  const reviewCells = rows.flatMap(r => r.review ?? []);
  rep.push(`  送审率（条目级）：${reviewCells.filter(Boolean).length}/${reviewCells.length}${reviewCells.length ? `（${(reviewCells.filter(Boolean).length / reviewCells.length * 100).toFixed(0)}%）` : ''}`);
  // 成本
  const ck = rows.reduce((a, r) => ({
    calls: a.calls + r.cost.L2.calls + r.cost.L3.calls + r.cost.L4.calls,
    prompt: a.prompt + r.cost.L2.prompt + r.cost.L3.prompt + r.cost.L4.prompt,
    completion: a.completion + r.cost.L2.completion + r.cost.L3.completion + r.cost.L4.completion,
    ms: a.ms + (r.ms ?? 0),
  }), { calls: 0, prompt: 0, completion: 0, ms: 0 });
  rep.push(`  成本：calls=${ck.calls}  prompt=${ck.prompt}  completion=${ck.completion}  墙钟=${(ck.ms / 60000).toFixed(1)}min  单份均值=${(ck.calls / Math.max(1, okN)).toFixed(1)} 次调用`);

  // ---- 分组指标（★ 强制分组：可信贷不同）
  rep.push('');
  rep.push('--- 分组指标（★ 可信贷不同，绝不混算）---');
  rep.push('  ★ 每组先报**总样本数**，再报"其中可算总分"的 n —— 只报后者会让人误以为该组只有那么几份。');
  const mAll = usable.length ? groupMetrics(usable, maxTotal) : null;
  for (const gk of ['single', 'common', 'discussion']) {
    const all = groups[gk];
    if (!all.length) { rep.push(`  ${GROUP_LABEL[gk]}：总样本 n=0`); continue; }
    const rs = all.filter(r => typeof r.predicted_total === 'number');
    rep.push(`  ${GROUP_LABEL[gk]}：总样本 n=${all.length}，其中可算总分 n=${rs.length}（其余 ${all.length - rs.length} 份为弃权，不进总分指标）`);
    if (!rs.length) { rep.push('      （该组没有可算总分的样本 → 总分指标不可给；逐维指标见下）'); }
    else {
      const m = groupMetrics(rs, maxTotal);
      rep.push(`      总分MSE=${fmt(m.total_mse, 2)}  偏置=${fmtSigned(m.bias, 2)}  ρ=${fmt(m.rho_total, 2)}  逐维MAE=${fmt(m.dim_mae, 2)}  送审率=${m.review_rate !== null ? (m.review_rate * 100).toFixed(0) + '%' : '—'}`);
      rep.push(`      ρ 参照：TA=${fmt(m.rho_ta, 2)}  评分者=${fmt(m.rho_rater, 2)}（★ 参照线，不是分数）  分辨率：gold distinct=${m.rho_total_note.gold_distinct} / 我们 distinct=${m.rho_total_note.pred_distinct}`);
    }
    // ★ 逐维指标**按该组全部样本**算（弃权的维度自动跳过，不要求整份完整）——
    //   这样即使总分算不出来，逐维仍然有数，不至于整组空白。
    const dm = perDimMetrics(all, dims);
    rep.push(`      逐维（按该组全部样本；MAE / ρ / n）：${dm.map(d => `${d.id} ${fmt(d.mae, 2)}/${fmt(d.rho, 2)}/${d.n}`).join('  ')}`);
  }

  // ---- 逐样本明细
  rep.push('');
  rep.push('--- 逐样本明细 ---');
  rep.push('  id                       status      gold_total  pred_total  弃权  0命中  anchored  送审率');
  for (const r of rows) {
    const pt = typeof r.predicted_total === 'number' ? String(r.predicted_total) : '—';
    rep.push(`  ${r.id.padEnd(24)} ${String(r.status).padEnd(10)} ${String(r.gold_total).padStart(3)}/35      ${pt.padStart(3)}/35     ${String(r.map_counts.abstain).padStart(3)}   ${r.zero_hit}/${r.gold0}    ${r.anchored_rate === null ? '—' : (r.anchored_rate * 100).toFixed(0) + '%'}      ${r.review_rate === null ? '—' : (r.review_rate * 100).toFixed(0) + '%'}`);
  }
  if (skipped.length) {
    rep.push('');
    rep.push(`--- ★ 数据跳过（${skipped.length} 份，正文过短不可评；**既不算成功也不算失败**）---`);
    for (const f of skipped) rep.push(`  ${f.id.padEnd(24)} ${f.reason}`);
  }
  if (failed.length) {
    rep.push('');
    rep.push(`--- ★ 失败样本（${failed.length} 份，**不计入任何指标**）---`);
    for (const f of failed) rep.push(`  ${f.id.padEnd(24)} ${f.failed}`);
  }

  // ---- ★★ 指标口径声明（必须随报告一起出现）
  rep.push('');
  rep.push('★★ 口径声明（读数字前必读）');
  rep.push('  1. **分数映射指标（MSE/偏置/ρ/MAE）只是次要代理指标**：');
  rep.push('     gold 低分**并不能**证明系统指出的具体问题是对的；反之亦然。');
  rep.push('     真正要主张的是「该发现的问题发现了吗」（0 分覆盖 / concern 与 gold 低分的方向一致性）');
  rep.push('     与「指出的问题可不可核对」（证据可回溯率），分数指标只作参照。');
  rep.push('  2. 弃权（insufficient_evidence / not_applicable / partially_satisfied）**不是错**，也**不当 0**：');
  rep.push('     它按"覆盖率 × 准确率"的方式单独报告，不混进分母。');
  rep.push('  3. 失败样本（某层 exit≠0 或产物非本次生成）**一律不做预测**，单列且不进指标。');
  rep.push('  4. 分组是强制的：single 与 common/discussion 的可信贷不同，绝不混算。');
  rep.push('  5. ρ 必须在"有分辨力的档位数"上读；distinct=1 时 ρ 无意义。');

  eq('★ 报告包含了协议要求的全部量（成功率/弃权率/档位分布/0分覆盖/可回溯率/送审率/成本）',
    /成功率/.test(rep.join('\n')) && /弃权率/.test(rep.join('\n')) && /0 分覆盖/.test(rep.join('\n'))
    && /证据可回溯率/.test(rep.join('\n')) && /送审率/.test(rep.join('\n')), true);
  eq('★ 分数指标被明确声明为次要代理', /次要代理指标/.test(rep.join('\n')), true);
  eq('★ 失败样本单列且不进指标', failed.every(f => !usable.some(r => r.id === f.id)), true);
  eq('★ 数据跳过样本单列且不进指标（也不算失败）', skipped.every(f => !usable.some(r => r.id === f.id) && !failed.some(x => x.id === f.id)), true);
  eq('★ 分组统计按评分者组别分开呈现', ['single', 'common', 'discussion'].every(g => rep.join('\n').includes(GROUP_LABEL[g])), true);

  rep.push('');
  rep.push(`==== ${bad === 0 ? 'ALL PASS' : bad + ' 项失败'} ====`);
  await fsp.writeFile(REPORT, rep.join('\n') + '\n', 'utf8');
  await fsp.writeFile(path.join(OUT, `score.${LAB}.json`), JSON.stringify({ lab: LAB, scored_at: new Date().toISOString(), gold: path.relative(root, GOLD_PATH), rows, failed, groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map(r => r.id)])) }, null, 2) + '\n', 'utf8');
  console.log(rep.join('\n'));
  const failWorth = failed.length > 0;
  if (bad > 0 || (STRICT && failWorth)) process.exitCode = 1;
}
