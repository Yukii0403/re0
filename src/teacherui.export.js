// teacherui.export.js —— 教师提交工作表的**纯函数**拼装（浏览器与 node 共用一份逻辑）
//
// ★ 为什么要独立成文件：导出物必须能**直接接上现有校验链**（`summary.mjs` 的 verifySummaryInputs）。
//   把逻辑抽成纯函数，浏览器内联它、node 也能 require 它来**实测**导出的 JSON 是否通过校验 ——
//   一份逻辑两处用，不会出现"界面导出的和校验器要的不是一回事"。
// ★ 字段要求（来自 verifySummaryInputs）：
//   顶层：doc / rubric{rubric_id, source_sha256} / assessment_ref / status / approval / entries
//   每条：rubric_item_id（唯一、在可评分叶子里）、**score 整数**、**max 整数且等于 profile 满分**、verdict∈枚举 或 null
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.TeacherUIExport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERDICTS = ['accurate', 'partially_accurate', 'inaccurate'];

  /**
   * @param {object} args
   * @param {object} args.view     教师视图产物（含 doc / rubric / source_assessment）
   * @param {object} args.states   每条目的教师状态 { [itemId]: {verdict, score, note} }
   * @param {object} args.maxByItem 每条目的满分（来自 profile，权威值）
   * @param {object} args.opts     { sourceReport, rubricId, confirmed, teacherName, approvalAt }
   */
  function buildTeacherScores(args) {
    const { view, states, maxByItem } = args;
    const opts = args.opts || {};
    const entries = (view.items || []).map(function (it) {
      const s = states[it.rubric_item_id] || {};
      const raw = s.score;
      // ★ 分数必须是整数（校验器要求）—— 界面侧也只允许整数，这里再兜一次
      const score = Number.isFinite(raw) ? Math.round(raw) : null;
      return {
        rubric_item_id: it.rubric_item_id,
        rubric_text: (it.rubric_text || '').slice(0, 400),
        verdict: VERDICTS.includes(s.verdict) ? s.verdict : null,
        score: score,
        max: Number.isInteger(maxByItem[it.rubric_item_id]) ? maxByItem[it.rubric_item_id] : null,
        note: s.note ? String(s.note) : null,
        final_level_id: null,
      };
    });
    const total = entries.filter(function (e) { return Number.isInteger(e.score); })
      .reduce(function (a, e) { return a + e.score; }, 0);
    const allScored = entries.length > 0 && entries.every(function (e) { return Number.isInteger(e.score); });
    const confirmed = opts.confirmed === true;

    return {
      teacher_scores_id: (opts.sourceReport || 'report') + '_ui',
      version: 1,
      // ★ 只有教师显式勾选"核对完毕"才写 teacher_confirmed（否则保持模板态，不冒充满分完成）
      status: confirmed ? 'teacher_confirmed' : 'needs_teacher_input',
      doc: view.doc || null,
      rubric: {
        rubric_id: view.rubric && view.rubric.rubric_id != null ? view.rubric.rubric_id : (opts.rubricId != null ? opts.rubricId : null),
        source_sha256: view.rubric ? view.rubric.source_sha256 : null,
      },
      assessment_ref: {
        file: (view.source_assessment && view.source_assessment.file) || null,
        layer_version: (view.authority && view.authority.layer_produced_by) || null,
      },
      approval: confirmed ? {
        approved_by: opts.teacherName || null,
        approved_at: opts.approvalAt || new Date().toISOString(),
        scope: 'summary_release',
      } : null,
      ui_export: {
        total_score: allScored ? total : null,
        total_note: allScored ? null : '总分未形成（尚有条目未给分）',
        scored_entries: entries.filter(function (e) { return Number.isInteger(e.score); }).length,
        entries_total: entries.length,
        verdicts: {
          accurate: entries.filter(function (e) { return e.verdict === 'accurate'; }).map(function (e) { return e.rubric_item_id; }),
          partially_accurate: entries.filter(function (e) { return e.verdict === 'partially_accurate'; }).map(function (e) { return e.rubric_item_id; }),
          inaccurate: entries.filter(function (e) { return e.verdict === 'inaccurate'; }).map(function (e) { return e.rubric_item_id; }),
          unconfirmed: entries.filter(function (e) { return e.verdict === null; }).map(function (e) { return e.rubric_item_id; }),
        },
      },
      entries: entries,
    };
  }

  return { buildTeacherScores: buildTeacherScores, VERDICTS: VERDICTS };
});
