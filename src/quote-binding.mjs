// quote-binding.mjs —— 把模型给出的逐字引用绑定回原文
//
// 为什么单独成模块：这是 L2 与 rubric 适配层共用的核心原语。
// 模型擅长照抄、不擅长数字符 —— 所以「引用串」由模型给，「偏移」由系统算。
//
// ★ 这里修的是一个真 bug：早期实现用 full.indexOf(quote) 取**首次出现**，
//   一旦同一句话在原文里出现多次（重复的页眉、多段重复的套话），
//   所有候选都会被绑到第一处 —— 证据指向了错误的位置，而且不会报错。
//
// 绑定优先级（三级，逐级回退）：
//   1. entry_hint —— 模型/上游给出的 L1 条目提示，在该条目区间内找（最可信）
//   2. cursor     —— 同一 (rubric_item, facet) 内按出现顺序推进游标（保证同批引用不互相抢位）
//   3. first      —— 兜底取首次出现，并标记 ambiguous
// 无论走哪一级，都把「一共出现几次、用了哪一级」记进 binding，让歧义可见而不是被默默吞掉。

export function allOccurrences(full, quote) {
  const out = [];
  if (!quote) return out;
  let i = full.indexOf(quote);
  while (i >= 0) {
    out.push(i);
    i = full.indexOf(quote, i + 1);
  }
  return out;
}

export function bindQuote(full, quote, { entryHint = null, entries = [], cursor = 0 } = {}) {
  const occ = allOccurrences(full, quote);
  if (!occ.length) {
    return { ok: false, reason: 'not_found', occurrences: 0 };
  }

  let start = null;
  let mode = null;

  if (entryHint) {
    const e = entries.find(x => x.id === entryHint);
    if (e) {
      const hit = occ.find(o => o >= e.start && o + quote.length <= e.end);
      if (hit != null) { start = hit; mode = 'entry_hint'; }
    }
  }
  if (start == null && cursor > 0) {
    const hit = occ.find(o => o >= cursor);
    if (hit != null) { start = hit; mode = 'cursor'; }
  }
  if (start == null) {
    start = occ[0];
    mode = 'first';
  }

  return {
    ok: true,
    start,
    end: start + quote.length,
    mode,
    occurrences: occ.length,
    // 只在没有可信提示、又确实有多次出现时才算歧义
    ambiguous: occ.length > 1 && mode === 'first',
  };
}

// 给一个区间找覆盖它的条目（用于把偏移反查成 source_ref.entry）
export function entryCovering(entries, start, end) {
  return entries.find(e => start >= e.start && end <= e.end) || null;
}
