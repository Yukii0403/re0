// l1.mjs —— AutoGrader L1：极简文本索引器
//
// 输入: 纯文本作业（.pdf / .docx）。不做手写、不做扫描件。
// 输出: <name>.txt（原文逐字 + 结构性分隔符）与 <name>.index.json（目录）
//
// 两条设计约束：
//   1. 不调用任何模型。索引由规则生成 —— 零幻觉，因此不需要置信度/审阅队列/兜底机制。
//   2. 索引里每条 entry.text 必须是 .txt 的逐字子串 —— 由 verify() 机械保证。
//
// .txt 只引入两种分隔符，都是原文的结构边界，不引入任何原文之外的文字内容：
//   \n  行 / 块边界
//   \t  表格单元格边界
//
// 依赖（纯 JS，无原生模块）：pdfjs-dist、fflate
// 用法: node l1.mjs <file.pdf|file.docx> [outDir]

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = 'l1/1.3.1';

// ------------------------------------------------------------------ 规则

export const RULES = {
  figCap: /^图\s*([0-9]+(?:[-.][0-9]+)*)/,
  tabCap: /^表\s*([0-9]+(?:[-.][0-9]+)*)/,
  eqNo: /^[(（]\s*([0-9]+)\s*[)）]$/,
  // 编号只认 1~2 位的章节号，且后面必须跟分隔符而不是数字/小数点 ——
  // 否则表格里的 "0.861 9.8" 会被当成 "0." 号标题
  headNo: /^(?:第\s*([0-9一二三四五六七八九十]{1,3})\s*[章节]|([0-9]{1,2}(?:\.[0-9]{1,2})*)(?![0-9.])[\s、．])/,
  styleH: /^heading\s*([1-6])$/i,
  mono: /(mono|courier|consol|menlo|inconsolata|jetbrains|cascadia|fira\s?code|source\s?code)/i,
  notMono: /monotype/i,
  mathFont: /(math|stix|cmmi|cmsy|symbola?)/i,
  code: /^(?:(?:def|class|import|from|function|const|let|var|return|print|elif|else|try|except|finally|with|lambda|async|await|yield)\b|(?:if|for|while|switch|catch)\s*\(|#include|#define|console\.|export\s|public\s|private\s|SELECT\b|INSERT\b|UPDATE\b|DELETE\b|CREATE\b)/,
  math: /[=+\-−×÷·*/()^_{}∑∏∫√≈≤≥≠∈∀∃∂⋅±∓∞→⊂⊆∪∩]/g,
  cjk: /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/,
  endPunct: /[。；;]$/,
};

// 字号阈值：真实文档里 h2/正文 常是 1.14~1.2，1.15 会漏判
const HEAD_RATIO = 1.1;
const MATH_DENSITY = 0.3;

function headNum(t) {
  const m = t.match(RULES.headNo);
  return m ? (m[2] ?? m[1] ?? null) : null;
}

function guessLevel(size, body) {
  const r = body ? size / body : 1;
  if (r >= 1.45) return 1;
  if (r >= 1.13) return 2;
  return 3;
}

// 靠字号判层级时，字号没比正文大就退回到 2 级 —— 不硬猜
function rank(size, body) {
  return size && body && size > body ? guessLevel(size, body) : 2;
}

function zoneOf(l) {
  if (typeof l.y !== 'number' || typeof l.pageH !== 'number' || !l.pageH) return 'body';
  if (l.y > l.pageH * 0.92) return 'header';
  if (l.y < l.pageH * 0.08) return 'footer';
  return 'body';
}

// 页眉页脚：位置在页顶/页底，且同一文本（数字归一化后）出现在多页。
// 只打标签，不删除 —— 保住「一个字都不动」。
export function detectRepeats(lines, pageCount) {
  const reps = new Set();
  if (!pageCount || pageCount < 3) return reps;
  const keyOf = l => {
    const z = zoneOf(l);
    if (z === 'body') return null;
    return `${l.text.trim().replace(/[0-9]+/g, '#')}|${Math.round((l.x || 0) / 12)}|${z}`;
  };
  const pages = new Map();
  for (const l of lines) {
    const k = keyOf(l);
    if (!k) continue;
    if (!pages.has(k)) pages.set(k, new Set());
    pages.get(k).add(l.page);
  }
  const need = Math.max(2, Math.ceil(pageCount * 0.5));
  lines.forEach((l, i) => {
    const k = keyOf(l);
    if (k && pages.get(k).size >= need) reps.add(i);
  });
  return reps;
}

// PDF 文本层拿不到可靠的字体名（pdfjs 给的是内部 id），所以主要靠文本特征 +
// x 坐标反推缩进 —— 空格字符在文本层里往往根本不保留。
function looksLikeCode(l, ctx) {
  const t = l.text.trim();
  if (RULES.code.test(t)) return true;
  if (RULES.cjk.test(t)) return false;
  if (typeof l.x !== 'number') return false;
  const size = l.size || ctx.bodySize || 10;
  const indent = l.x - ctx.bodyLeft;
  return indent >= Math.max(8, size * 0.8) && indent <= size * 6;
}

// 正文字号：按「字符数加权众数」估计，而不是取中位数 ——
// 代码块、表格、页眉这些小字号行数量多但字数少，会把中位数带偏。
export function bodySizeOf(lines) {
  const weight = new Map();
  for (const l of lines) {
    if (typeof l.size !== 'number' || !l.size) continue;
    const n = (l.text || '').trim().length;
    if (!n) continue;
    weight.set(l.size, (weight.get(l.size) || 0) + n);
  }
  let best = 0;
  let bestN = -1;
  for (const [s, n] of weight) if (n > bestN) { bestN = n; best = s; }
  return best;
}

// -------------------------------------------------- 步骤 2 · 打标（纯函数，逐行）

export function classify(lines, opts = {}) {
  const bodySize = opts.bodySize ?? bodySizeOf(lines);

  const hist = new Map();
  for (const l of lines) {
    if (typeof l.x !== 'number') continue;
    const k = Math.round(l.x);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let bodyLeft = opts.bodyLeft ?? 0;
  if (opts.bodyLeft == null) {
    let best = 0;
    for (const [k, n] of hist) if (n > best) { best = n; bodyLeft = k; }
  }
  const ctx = { bodySize, bodyLeft };
  const reps = opts.repeats || new Set();

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const text = l.text ?? '';
    const t = text.trim();
    const base = { ...l, text, num: null, level: null };

    if (reps.has(i)) {
      const z = zoneOf(l);
      out.push({ ...base, type: z === 'header' ? 'header' : 'footer', repeat: true });
      continue;
    }
    // 结构标记优先级最高，且放在空文本判断之前 —— 空文本的表格/图不能被丢掉
    if (l.hasDrawing) { out.push({ ...base, type: 'figure' }); continue; }
    if (l.hasTbl) { out.push({ ...base, type: 'table' }); continue; }
    if (l.hasMath) { out.push({ ...base, type: 'formula' }); continue; }
    if (!t) { out.push({ ...base, type: 'skip' }); continue; }

    let m;
    if ((m = t.match(RULES.figCap))) { out.push({ ...base, type: 'figure', num: m[1] }); continue; }
    if ((m = t.match(RULES.tabCap))) { out.push({ ...base, type: 'table', num: m[1] }); continue; }

    const font = l.font || '';
    const mono = RULES.mono.test(font) && !RULES.notMono.test(font);
    if (RULES.mathFont.test(font) && !mono) { out.push({ ...base, type: 'formula' }); continue; }

    const prev = out[out.length - 1];
    // 代码延续：上一行是代码、同字体、无中日韩、不以句末标点结尾
    const chain = prev && prev.type === 'code' && !RULES.cjk.test(t) &&
      !RULES.endPunct.test(t) && prev.font && prev.font === font;
    if (mono || chain || looksLikeCode(l, ctx)) { out.push({ ...base, type: 'code' }); continue; }

    if ((m = (l.style || '').match(RULES.styleH))) {
      out.push({ ...base, type: 'heading', level: Number(m[1]), num: headNum(t) });
      continue;
    }
    if (bodySize && l.size && l.size >= bodySize * HEAD_RATIO && !RULES.endPunct.test(t)) {
      out.push({ ...base, type: 'heading', level: guessLevel(l.size, bodySize), num: headNum(t) });
      continue;
    }
    // 编号标题：真实文档里 h2 常常只比正文大一点点，字号不可靠，编号反而可靠
    if (t.length <= 40 && headNum(t) !== null && !RULES.endPunct.test(t)) {
      out.push({ ...base, type: 'heading', level: rank(l.size, bodySize), num: headNum(t) });
      continue;
    }
    if (l.bold && t.length <= 40 && !RULES.endPunct.test(t)) {
      out.push({ ...base, type: 'heading', level: rank(l.size, bodySize), num: headNum(t) });
      continue;
    }

    if ((m = t.match(RULES.eqNo))) { out.push({ ...base, type: 'formula', num: m[1] }); continue; }
    if (t.length >= 6 && (t.match(RULES.math) || []).length / t.length >= MATH_DENSITY) {
      out.push({ ...base, type: 'formula' });
      continue;
    }
    out.push({ ...base, type: 'paragraph' });
  }
  return out;
}

// ------------------------------------- 段落合并：把同一段的视觉行合成一个块
// .txt 的字节完全不变（full 始终等于各行以 \n 相连），只改变索引粒度。

// 行距采样只取「同类块之间」的间距。否则页眉→标题、标题→正文这些跨类间距会把
// 最小值压低，导致段内该合并的行合不上。
function spacingTable(blocks) {
  const byKey = new Map();
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1], b = blocks[i];
    if (a.type !== b.type) continue;
    if (a.type !== 'paragraph' && a.type !== 'code') continue;
    if (a.page !== b.page) continue;
    if (typeof a.y !== 'number' || typeof b.y !== 'number') continue;
    const gap = a.y - b.y;
    if (gap <= 6 || gap > 60) continue;
    const k = `${a.font}|${Math.round((a.x || 0) / 12)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(gap);
  }
  const out = new Map();
  for (const [k, arr] of byKey) out.set(k, Math.min(...arr));
  return out;
}

export function mergeRuns(blocks, opts = {}) {
  const bodySize = opts.bodySize || 10;
  const spacing = spacingTable(blocks);
  const out = [];
  for (const l of blocks) {
    const p = out.length ? out[out.length - 1] : null;
    let canMerge = false;
    if (p && p.type === l.type && p.page === l.page &&
        (l.type === 'paragraph' || l.type === 'code')) {
      const k = `${p.font}|${Math.round((p.x || 0) / 12)}`;
      const gap = (p.y ?? 0) - (l.y ?? 0);
      const limit = (spacing.get(k) ?? bodySize * 1.6) * 1.15;
      const xTol = (l.type === 'code' ? 6 : 2.5) * (l.size || bodySize);
      canMerge = gap > 0 && gap <= limit && Math.abs((p.x ?? 0) - (l.x ?? 0)) <= xTol;
    }
    if (canMerge) {
      const shift = p.text.length + 1;                       // 合并处插入了一个 \n
      p.text = p.text + '\n' + l.text;
      if (l.cellBreaks?.length) {
        p.cellBreaks = [...(p.cellBreaks || []), ...l.cellBreaks.map(x => ({ start: x.start + shift, end: x.end + shift }))];
      }
      p.y = l.y;
      p.lines = (p.lines || 1) + 1;
    } else {
      out.push({ ...l, lines: 1 });
    }
  }
  return out;
}

// 行覆盖完整性：块里包含的行数必须等于非空原文行数。
// 这是「什么都没丢」的在线探针 —— 光靠 substring 断言只能证明没改字，证明不了没丢行。
export function coverageOf(raw, blocks) {
  const total = raw.filter(l => (l.text || '').trim()).length;
  const kept = blocks.reduce((n, b) => n + (b.lines || 1), 0);
  return { kept, total, complete: kept === total };
}

// -------------------------------------------------- 步骤 3b · 最小表格行列适配器（纯函数）
//
// 目标：把「表格行」还原成**可机械查询的对象**，让下游能用 (行标签, 列头) 唯一确定一个值。
// 纪律：**正文 .txt 一个字符都不动** —— 结构只写进索引。索引是导航层，不是内容层。
//
// 列边界的两个来源，优先级从高到低：
//   ① PDF：抽取阶段按几何记下的「宽空白区间」（见 WIDE_SPACE_EM）—— 文本层里的空格数不可信
//   ② 回退：制表符（docx 的 w:tc 就是真单元格）或文本里 2 个以上空格（手工/示例文本）
//
// 表判据（全部机械）：
//   · 把每个条目拆成「行单元」（一个条目可能含多行，如 docx 整张表是一个条目）
//   · 连续且**真正相邻**（上一行末尾 +1 就是下一行开头）的行单元，列数 ≥2 且一致 → 成表
//   · 首行不含数字 → 判为列头；含数字 → 不设列头（不猜）
//   · 紧接其后若还有 ≥2 列但列数不同的行 → 记 `truncated`，**把丢掉的那一行指出来**，不静默截断
//
// 已知还原不出的：合并单元格、跨行单元格、列间没有可识别间隙的列。
// 宁可不认，也不猜错。

const CELL_SPLIT = /\t|[ ]{2,}/g;

// 列边界是**怎么来的** —— 这是派生来源，必须随单元格一起存下来：
//   pdf_geometry     几何实测（宽空白 item）—— 规则推出，可复现
//   docx_cell        制表符，来自 docx 的真单元格
//   text_wide_space  文本里 2 个以上空格 —— 最弱的依据，只适用于自己造的文本/示例
export function cellSplitOrigin(text, breaks = []) {
  if (breaks.length) return 'pdf_geometry';
  if (/\t/.test(text)) return 'docx_cell';
  if (/[ ]{2,}/.test(text)) return 'text_wide_space';
  return null;
}

// breaks: 绝对偏移区间（列分隔符所在处）。为空则回退到文本判据。
export function splitCells(lineStart, text, breaks = [], opts = {}) {
  const textFallback = opts.textFallback !== false;
  const seps = [];
  for (const b of breaks) {
    const s = b.start - lineStart;
    const e = b.end - lineStart;
    if (s >= 0 && e <= text.length && e > s) seps.push({ start: s, end: e });
  }
  // ★ 有几何信息时**不用文本回退** —— PDF 上一行里有几个空格与"有几列"无关，
  //   用文本猜列会在真实文件上悄悄错位（内边距 ≠ 列分隔）。
  if (!seps.length && textFallback) {
    CELL_SPLIT.lastIndex = 0;
    let m;
    while ((m = CELL_SPLIT.exec(text))) seps.push({ start: m.index, end: m.index + m[0].length });
  }
  seps.sort((a, b) => a.start - b.start);

  const out = [];
  const push = (from, to) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) return;                                        // 空单元格跳过：宁少不错
    const start = lineStart + from + lead;
    out.push({ text: t, start, end: start + t.length });    // slice(start,end) === text
  };
  let from = 0;
  for (const s of seps) { push(from, s.start); from = s.end; }
  push(from, text.length);
  return out;
}

function lineRanges(e) {
  const out = [];
  let off = 0;
  for (const part of String(e.text).split('\n')) {
    out.push({ start: e.start + off, end: e.start + off + part.length, text: part });
    off += part.length + 1;
  }
  return out;
}

function cellsOfLines(e) {
  // entry 上有 cell_breaks（含空数组）= 该行来自几何抽取 → 禁用文本回退
  const textFallback = !Array.isArray(e.cell_breaks);
  return lineRanges(e).map(ln => ({ line: ln, cells: splitCells(ln.start, ln.text, e.cell_breaks ?? [], { textFallback }) }));
}

export function detectTables(full, entries) {
  const units = [];
  for (const e of entries) for (const u of cellsOfLines(e)) units.push({ entry: e, ...u });

  const idxOf = new Map(entries.map((e, i) => [e.id, i]));
  const tables = [];
  const owner = new Map();
  let i = 0;
  while (i < units.length) {
    const head = units[i];
    if (head.cells.length < 2) { i++; continue; }

    let j = i;
    while (j + 1 < units.length) {
      const a = units[j];
      const b = units[j + 1];
      if (a.line.end + 1 !== b.line.start) break;            // 必须真的相邻
      if (b.cells.length !== head.cells.length) break;
      j++;
    }
    if (j - i + 1 < 2) { i++; continue; }                    // 一行不成表

    const region = units.slice(i, j + 1);
    // 表头可能在表体**之外**：真实文档里表头常居中/跨列，与表体的列位置不对齐，
    // 于是它进不了对齐行段。取紧邻其前的那一行（真正相邻 + 无数字 + ≥2 格）当表头。
    const regionHasHeader = !/\d/.test(region[0].line.text);
    const prevUnit = i > 0 ? units[i - 1] : null;
    const externalHeader = (!regionHasHeader && prevUnit &&
      prevUnit.line.end + 1 === region[0].line.start &&
      !/\d/.test(prevUnit.line.text) && prevUnit.cells.length >= 2) ? prevUnit : null;
    const headerDetected = regionHasHeader || !!externalHeader;
    const body = (regionHasHeader && !externalHeader) ? region.slice(1) : region;
    if (!body.length) { i = j + 1; continue; }                // 只有列头没有数据行 → 不认

    // 紧跟其后还有多列的行，但列数不同 → 被截断了，要指出来
    const next = units[j + 1];
    const truncated = !!next && next.cells.length >= 2 && next.cells.length !== head.cells.length;

    const first = (externalHeader ?? region[0]).entry;
    const last = region[region.length - 1].entry;
    // 图注在表上方还是下方都要认：中文报告里「表 N …」放在表下方很常见（本项目的真实夹具就是）
    const before = entries[idxOf.get(first.id) - 1];
    const after = entries[idxOf.get(last.id) + 1];
    const caption = [before, after].find(e => e && e.type === 'table') ?? null;
    const id = 't' + String(tables.length + 1).padStart(4, '0');
    const orgs = new Set(region.map(u => cellSplitOrigin(u.line.text, u.entry.cell_breaks ?? [])).filter(Boolean));
    tables.push({
      id,
      caption_entry: caption ? caption.id : null,
      entry_range: `${first.id}-${last.id}`,
      header_detected: headerDetected,
      column_count: head.cells.length,
      columns: headerDetected ? (externalHeader ? externalHeader.cells : region[0].cells) : null,
      rows: body.map(u => ({ label: u.cells[0]?.text ?? null, cells: u.cells })),
      truncated,
      truncated_at: truncated ? (idxOf.has(next.entry.id) ? next.entry.id : null) : null,
      // ★ 允许用于键值查询的机械条件：有列头（否则没有列名可查）且没有截断（否则行不全）
      key_query_safe: headerDetected && !truncated,
      // ★ 列边界的派生来源 —— 下游可据此决定信不信，而不是把"结构化"当成同一种确定事实
      cell_split_source: orgs.size === 1 ? [...orgs][0] : 'mixed',
    });
    for (const u of region) owner.set(u.entry.id, id);
    if (externalHeader) owner.set(externalHeader.entry.id, id);
    i = j + 1;
  }
  return { tables, owner };
}

export function verifyTables(full, tables) {
  const bad = [];
  for (const t of tables) {
    for (const c of (t.columns ?? [])) if (full.slice(c.start, c.end) !== c.text) bad.push(`${t.id}:col:${c.text}`);
    for (const r of t.rows) for (const c of r.cells) {
      if (full.slice(c.start, c.end) !== c.text) bad.push(`${t.id}:cell:${c.text}`);
    }
  }
  return { ok: bad.length === 0, bad };
}

// -------------------------------------------------- 步骤 3 · 出索引（纯函数）

export function buildIndex(full, blocks) {
  const entries = [];
  let cursor = 0;
  for (const b of blocks) {
    const text = b.text ?? '';
    if (!text) continue;
    // 按顺序推进游标查找，重复行也不会错位
    const start = full.indexOf(text, cursor);
    if (start < 0) throw new Error(`块文本在原文中找不到（游标 ${cursor}）: ${JSON.stringify(text.slice(0, 40))}`);
    const end = start + text.length;
    cursor = end;
    entries.push({
      id: 'e' + String(entries.length + 1).padStart(4, '0'),
      type: b.type,
      num: b.num ?? null,
      level: b.level ?? null,
      page: b.page ?? null,
      lines: b.lines ?? 1,
      // 列分隔区间（绝对偏移）。**来自几何抽取的行一定写这个字段**（哪怕是空数组）——
      // 空数组的含义是"这是几何行、没有列"，据此禁用文本回退。非几何行不写，允许文本回退。
      ...(b.geo ? { cell_breaks: (b.cellBreaks ?? []).map(x => ({ start: start + x.start, end: start + x.end })) } : {}),
      start,
      end,
      text,
    });
  }
  return entries;
}

export function verify(full, entries) {
  const bad = entries.filter(e => full.slice(e.start, e.end) !== e.text).map(e => e.id);
  let monotonic = true;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].start < entries[i - 1].end) { monotonic = false; break; }
  }
  const inBounds = entries.every(e => e.start >= 0 && e.end <= full.length);
  return { total: entries.length, substringOk: bad.length === 0, bad, monotonic, inBounds };
}

// -------------------------------------------------- 步骤 1 · 抽取（PDF）

const GAP_SPLIT = 1.8; // 同一 y 上 item 间隙超过 1.8 倍字号 → 认为不是同一行（两栏/两列）

// ★★ 列边界判据的第二次标定（被真实 LaTeX PDF 推翻后重定的）
//
// 第一版用「文本里 2 个以上空格」——在真文件上认不出任何表。
// 第二版用「宽空白 item 的 width/size ≥ 3」——在 Chromium 打的 PDF 上成立，
//   但在真实 LaTeX PDF 上**方向错了**：那里的宽空白（98 / 120pt）是**单元格内边距**，
//   真正的列分隔只是一个 1.4em 的空白。于是列被切在了错误的位置（行标签被并进第一个数据格）。
//
// 第三版只看几何结构本身，两个都机械：
//   ① **行间 x 对齐**：连续 ≥2 行在 ≥2 个相同 x 上都有单元格起点 → 这是一张表的行。
//      （真实样本里数据列严格对齐：0.25 永远在 x=260.3；行标签列右对齐所以起点会变，
//        因此只要求"所有行都有的位置"，不要求每列都在第一列上。）
//   ② **item 边界切格**：单元格 = 一串非空白 item；夹在中间的空白 item（内边距）算分隔。
//      item 边界比文本空格可靠：'Average Time (ms)' 是一个 item，而 '+ attention + 数据增强' 也是。
//
// 对齐这道闸只用在**抽取阶段**：没有对齐的行（正文段落）根本不会带上 cell_breaks，
// 于是它永远不会被切成多格 —— 段落里恰好有个空格不会变成"两列"。
const COL_TOL = 1.0;      // 视为"同一个 x"的容差（pt）

function partsOf(items) {
  const parts = [];
  let acc = 0;
  for (const it of items) {
    const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
    const str = it.str;
    parts.push({ str, start: acc, end: acc + str.length, x: it.transform[4], size, space: !str.trim() });
    acc += str.length;
  }
  return parts;
}

// 这些行共有的单元格起点 x（所有行都必须有，否则不算"共有列"）
function sharedStarts(rows) {
  let acc = rows[0].parts.filter(p => !p.space).map(p => p.x);
  for (let i = 1; i < rows.length && acc.length; i++) {
    const xs = rows[i].parts.filter(p => !p.space).map(p => p.x);
    acc = acc.filter(a => xs.some(x => Math.abs(x - a) <= COL_TOL));
  }
  return acc;
}

// 一段空白 item（单元格内边距）→ 一个列分隔区间
function breaksOf(row) {
  const out = [];
  for (let i = 0; i < row.parts.length; i++) {
    if (!row.parts[i].space) continue;
    let k = i;
    while (k < row.parts.length && row.parts[k].space) k++;
    if (i > 0 && !row.parts[i - 1].space && k < row.parts.length) {
      out.push({ start: row.parts[i].start, end: row.parts[k - 1].end });
    }
    i = k - 1;
  }
  return out;
}

function pdfLinesFromItems(items, pageNo, pageH) {
  const byY = new Map();
  for (const it of items) {
    if (!it || !it.str || !it.transform) continue;
    const y = Math.round(it.transform[5] / 2) * 2;
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(it);
  }

  // ---- 第一遍：按 y 聚成行（同一 y 上水平间隙过大就断开，避免把两栏拼成一行）
  const rows = [];
  for (const key of [...byY.keys()].sort((a, b) => b - a)) {
    const seq = byY.get(key).sort((a, b) => a.transform[4] - b.transform[4]);
    let cur = [];
    let prevEnd = null;
    const flush = () => {
      if (!cur.length) return;
      const text = cur.map(i => i.str).join('');
      if (text.trim()) {
        const f = cur[0];
        rows.push({
          text,
          parts: partsOf(cur),
          page: pageNo,
          pageH,
          x: f.transform[4],
          y: f.transform[5],
          size: Math.round(Math.hypot(f.transform[2], f.transform[3]) * 10) / 10,
          font: f.fontName || '',
        });
      }
      cur = [];
    };
    for (const it of seq) {
      const x = it.transform[4];
      const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
      if (prevEnd != null && x - prevEnd > Math.max(size * GAP_SPLIT, 14)) flush();
      cur.push(it);
      prevEnd = x + (it.width || 0);
    }
    flush();
  }

  // ---- 第二遍：找列对齐的行段，只给这些行（及其紧邻的无数字行）标列分隔
  const splittable = new Set();
  let i = 0;
  while (i < rows.length) {
    let j = i;
    let cols = rows[i].parts.filter(p => !p.space).map(p => p.x);
    while (j + 1 < rows.length) {
      const xs = rows[j + 1].parts.filter(p => !p.space).map(p => p.x);
      const next = cols.filter(a => xs.some(x => Math.abs(x - a) <= COL_TOL));
      if (next.length < 2) break;                       // 对齐断了
      cols = next;
      j++;
    }
    if (j - i + 1 >= 2 && cols.length >= 2) {
      for (let k = i; k <= j; k++) splittable.add(k);
      // 表头行常常与表体不对齐（居中/跨列），但它是紧邻的无数字行 → 也允许切
      for (const k of [i - 1, j + 1]) {
        if (k >= 0 && k < rows.length && !/\d/.test(rows[k].text) && splittable.has(k) === false) {
          if (k === i - 1 || k === j + 1) splittable.add(k);
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  // ---- 输出：几何行一定带 cellBreaks（可能是空数组，含义是"几何行、无列"）
  return rows.map((r, k) => {
    const geo = true;
    const breaks = splittable.has(k) ? breaksOf(r) : [];
    return {
      text: r.text, page: r.page, pageH: r.pageH, x: r.x, y: r.y, size: r.size, font: r.font,
      geo, ...(breaks.length ? { cellBreaks: breaks } : {}),
    };
  });
}

async function extractPdf(file, warnings) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(file));
  const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;

  const all = [];
  let textless = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const lines = pdfLinesFromItems(tc.items, p, vp.height);
    if (!lines.length) textless++;
    all.push(...lines);
  }
  if (textless) warnings.add('no_text_layer');
  if (detectTwoColumn(all, doc.numPages)) warnings.add('possible_two_column');
  return { lines: all, pageCount: doc.numPages };
}

function detectTwoColumn(lines, pageCount) {
  if (lines.length < 40) return false;
  let hits = 0;
  let pages = 0;
  for (let p = 1; p <= pageCount; p++) {
    const xs = lines.filter(l => l.page === p).map(l => Math.round(l.x / 20) * 20);
    if (!xs.length) continue;
    pages++;
    const hist = new Map();
    for (const x of xs) hist.set(x, (hist.get(x) || 0) + 1);
    const top = [...hist.values()].sort((a, b) => b - a);
    if (top.length >= 2 && top[1] >= xs.length * 0.2) hits++;
  }
  return pages > 0 && hits >= Math.max(1, Math.ceil(pages * 0.5));
}

// -------------------------------------------------- 步骤 1 · 抽取（docx）

// 自写的极简 XML 走查：docx 的 XML 很规整（无 CDATA、无 DTD），
// 自己写反而能原生保证「按文档顺序」—— 通用解析器会把同名兄弟节点合并成数组，
// 顺序会被静默打乱。产出结构：[{ tag: [...children], ':@': {...} }, { '#text': '...' }]
function decodeXml(s) {
  if (s.indexOf('&') < 0) return s;
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[e] !== undefined ? named[e] : m;
  });
}

function tagEnd(src, lt) {
  let q = null;
  for (let j = lt + 1; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  return src.length;
}

export function parseXml(src) {
  const root = [];
  const stack = [{ kids: root }];
  const pushText = s => {
    if (s) stack[stack.length - 1].kids.push({ '#text': decodeXml(s) });
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    if (src.startsWith('</', lt)) { const e = src.indexOf('>', lt); stack.pop(); i = e < 0 ? src.length : e + 1; continue; }
    const gt = tagEnd(src, lt);
    let body = src.slice(lt + 1, gt);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const nm = body.match(/^([^\s/>]+)/);
    const tag = nm ? nm[1] : '';
    const attrs = {};
    const are = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = are.exec(body))) attrs['@_' + am[1]] = decodeXml(am[2] ?? am[3] ?? '');
    const node = { [tag]: [], ':@': attrs };
    stack[stack.length - 1].kids.push(node);
    if (!selfClose) stack.push({ kids: node[tag] });
    i = gt + 1;
  }
  return root;
}

export function tagOf(node) {
  for (const k of Object.keys(node)) if (k !== ':@') return k;
  return null;
}

export function findAll(node, tag, out = []) {
  for (const item of node) {
    const k = tagOf(item);
    if (k === tag) out.push(item[k]);
    if (k && Array.isArray(item[k])) findAll(item[k], tag, out);
  }
  return out;
}

export function findFirst(node, tag) {
  const hit = findAll(node, tag);
  return hit.length ? hit[0] : null;
}

export function has(node, tag) {
  return findAll(node, tag).length > 0;
}

export function attrOf(node, tag, attr) {
  for (const item of node) {
    const k = tagOf(item);
    if (k === tag && item[':@'] && item[':@']['@_' + attr] != null) return item[':@']['@_' + attr];
    if (k && Array.isArray(item[k])) {
      const hit = attrOf(item[k], tag, attr);
      if (hit != null) return hit;
    }
  }
  return null;
}

export function textOf(node, buf = []) {
  for (const item of node) {
    const k = tagOf(item);
    if (k === '#text') buf.push(String(item['#text']));
    else if (k && Array.isArray(item[k])) textOf(item[k], buf);
  }
  return buf.join('');
}

function tableText(tbl) {
  return findAll(tbl, 'w:tr')
    .map(row => findAll(row, 'w:tc').map(cell => textOf(cell)).join('\t'))
    .join('\n');
}

// 纯函数：从 document.xml 文本得到有序行。顺序完全按 w:body 子节点顺序 —— 不重排。
export function docxLines(xml) {
  const tree = parseXml(xml);
  const body = findFirst(tree, 'w:body') || tree;
  const lines = [];
  let skipped = 0;
  for (const child of body) {
    const tag = tagOf(child);
    if (tag === 'w:p') {
      const p = child[tag];
      const sz = attrOf(p, 'w:sz', 'w:val');
      lines.push({
        text: textOf(p),
        page: null,
        size: sz ? Number(sz) / 2 : null, // w:sz 是半磅
        x: undefined,
        font: attrOf(p, 'w:rFonts', 'w:ascii') || attrOf(p, 'w:rFonts', 'w:hAnsi') || '',
        style: attrOf(p, 'w:pStyle', 'w:val') || '',
        bold: has(p, 'w:b'),
        hasDrawing: has(p, 'w:drawing') || has(p, 'w:pict'),
        hasMath: has(p, 'm:oMath') || has(p, 'm:oMathPara'),
      });
    } else if (tag === 'w:tbl') {
      lines.push({ text: tableText(child[tag]), page: null, x: undefined, font: '', hasTbl: true });
    } else if (tag) {
      skipped++;
    }
  }
  return { lines, skipped };
}

async function extractDocx(file, warnings) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const zip = unzipSync(new Uint8Array(await fs.readFile(file)));
  if (!zip['word/document.xml']) throw new Error('word/document.xml 缺失，不是有效的 docx');
  const { lines, skipped } = docxLines(strFromU8(zip['word/document.xml']));
  if (skipped) warnings.add('docx_other_nodes_skipped');
  return { lines, pageCount: 1 };
}

// 纯文本输入（v1.3.1 新增）。为什么加：VerAs 那类公开数据集给的是**已经抽好的 txt**，
// 要在它上面评 L2/L3/L4 就必须能把这层文本喂进同一条流水线。
// ★ 这里**不假装在解析**：没有版式可推，所以逐行给中性几何（同一 x、同一字号、y 按行序），
//   分类只看文本形态，表格只走制表符 / 宽空白回退。正文一个字都不动。
function textLines(txt) {
  const lines = txt.split(/\r?\n/).map((t, i) => ({ text: t, page: 1, pageH: 841.92, x: 0, y: i * 12, size: 10.5, font: 'text' }));
  return { lines, pageCount: 1 };
}

// ------------------------------------------------------------------ 主流程

export async function run(file, outDir) {
  const ext = path.extname(file).toLowerCase();
  if (!['.pdf', '.docx', '.txt'].includes(ext)) throw new Error('只支持 .pdf / .docx / .txt');
  const kind = ext === '.txt' ? 'text' : ext.slice(1);

  const warnings = new Set();
  const { lines: raw, pageCount } = kind === 'pdf'
    ? await extractPdf(file, warnings)
    : kind === 'docx'
      ? await extractDocx(file, warnings)
      : textLines(await fs.readFile(file, 'utf8'));

  const repeats = detectRepeats(raw, pageCount);
  const tagged = classify(raw, { repeats }).filter(b => b.type !== 'skip' && b.text);

  const blocks = mergeRuns(tagged, { bodySize: bodySizeOf(tagged) || 10 });

  const full = blocks.map(b => b.text).join('\n');
  const entries = buildIndex(full, blocks);

  const check = verify(full, entries);
  if (!check.substringOk || !check.inBounds) {
    throw new Error(`索引与原文不一致: ${check.bad.join(',')} | inBounds=${check.inBounds}`);
  }
  const coverage = coverageOf(raw, blocks);
  if (!coverage.complete) {
    throw new Error(`行覆盖不完整：保留 ${coverage.kept} / 共 ${coverage.total} 行 —— 有内容被静默丢弃`);
  }

  // 最小表格行列还原：只写索引，不动正文
  const { tables, owner } = detectTables(full, entries);
  const tcheck = verifyTables(full, tables);
  if (!tcheck.ok) throw new Error(`表格单元格与原文不一致: ${tcheck.bad.slice(0, 3).join(',')}`);

  // 输出名带上原始扩展名：report.pdf → report.pdf.txt / report.pdf.index.json。
  // 若只用 basename 去掉扩展名，同目录下的 report.pdf 与 report.docx 会互相覆盖。
  const stem = path.join(outDir ?? path.dirname(file), path.basename(file));
  // 输出目录可能还不存在 —— 自己建，别把 ENOENT 甩给调用方（真实样本上踩过）
  await fs.mkdir(path.dirname(stem), { recursive: true });
  const bytes = await fs.readFile(file);
  const index = {
    doc: {
      name: path.basename(file),
      kind,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      chars: full.length,
      text_file: path.basename(stem) + '.txt',
      generator: VERSION,
      warnings: [...warnings],
      line_coverage: `${coverage.kept}/${coverage.total}`,
      tables: tables.length,
    },
    tables,
    entries: entries.map(({ lines: ln, ...e }) => ({ ...e, lines: ln, table_id: owner.get(e.id) ?? null })),
  };

  await fs.writeFile(stem + '.txt', full, 'utf8');
  await fs.writeFile(stem + '.index.json', JSON.stringify(index, null, 2), 'utf8');
  return {
    indexFile: stem + '.index.json',
    textFile: stem + '.txt',
    chars: full.length,
    entries: entries.length,
    tables: tables.length,
    warnings: [...warnings],
    check,
    coverage,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [, , file, outDir] = process.argv;
  if (!file) {
    console.error('用法: node l1.mjs <file.pdf|file.docx> [outDir]');
    process.exit(2);
  }
  run(file, outDir)
    .then(r => console.log(JSON.stringify({ ok: true, ...r }, null, 2)))
    .catch(e => { console.error('失败:', e.message); process.exit(1); });
}
