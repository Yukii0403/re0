// teacherui.app.js —— 教师操作界面的前端逻辑（独立文件；生成时内联进 HTML）
// ★ 不要把它写进模板字符串：\n 与正则转义会被模板吞掉（踩过三次）。
/* global DATA, TeacherUIExport */
(function () {
  const V = DATA.view;
  const FULL = DATA.fullText || '';
  const NL = String.fromCharCode(10);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 教师状态：每条目 { verdict, score, note }
  const ST = {};
  for (const it of V.items) ST[it.rubric_item_id] = { verdict: null, score: null, note: '' };

  const quoteOf = f => (f && (f.quote || (f.warrant && f.warrant.student_quote))) || '';

  // ★★ 原始页面查看器：用 L2 已渲染的整页图（内联），页码/缩放完全可控。
  //   为什么不用 <embed src="#page=N">：每次导航都会**重载 PDF → 把教师调好的缩放重置**，做不到"保持缩放"。
  const PAGES = {};
  const PAGE_LIST = [];
  for (const pg of (DATA.pages || [])) { PAGES[pg.page] = 'data:image/png;base64,' + pg.b64; PAGE_LIST.push(pg.page); }
  PAGE_LIST.sort(function (a, c) { return a - c; });
  let curPage = PAGE_LIST.length ? PAGE_LIST[0] : null;
  let zoom = 'fit';          // 'fit' | 像素宽度（教师手动调过就一直是数值，**不因切换评价而重置**）
  let lastManual = null;     // 记住教师最近一次的缩放值，便于"恢复适应宽度"后再调回来

  const pageOf = f => {
    const pg = f && f.located && f.located.source_ref ? f.located.source_ref.page : null;
    return (typeof pg === 'number') ? pg : null;
  };
  function pageChip(f) {
    const pg = pageOf(f);
    if (pg == null) return '<span class="chip w">页码未知（该观察未定位到页）</span>';
    if (!PAGES[pg]) return '<span class="chip w">第 ' + pg + ' 页（无该页图片）</span>';
    return '<span class="chip p pagechip" data-page="' + pg + '">第 ' + pg + ' 页</span>';
  }

  function quoteHtml(f) {
    if (!f) return '';
    const q = quoteOf(f);
    if (!q) return '<div class="tiny">（这条观察没有引文，无法回原文核对）</div>';
    return '<div class="quote">⟨' + esc(q) + '⟩</div>';
  }
  function anchorChip(f) {
    if (f.located) return '<span class="chip g">已定位到原文</span>';
    if (f.verification) return '<span class="chip w">无原文定位，有 L3 挂钩</span>';
    return '<span class="chip w">⚠ 无定位无挂钩：请勿当作确定结论</span>';
  }

  // ★★ 查看原文 = **跳到原件的对应页**（可视化），并在查看器下方显示该页引文。
  //   没有页码 / 没有该页图时，回退到"抽取文本 + 高亮"（并说清回退原因）。
  function showInFull(f) {
    const q = quoteOf(f);
    const pg = pageOf(f);
    const bar = document.getElementById('pageQuote');
    if (pg != null && PAGES[pg]) {
      goToPage(pg);
      if (bar) {
        bar.style.display = 'block';
        bar.textContent = q ? ('第 ' + pg + ' 页 · 该观察的引文：⟨' + q + '⟩') : ('第 ' + pg + ' 页（这条观察没有引文）');
      }
      return;
    }
    const box = document.getElementById('full');
    if (!box) return;
    box.textContent = FULL;
    const note = document.getElementById('srcnote');
    if (note) {
      note.textContent = (pg == null)
        ? '（这条观察没有定位到页码 —— 下面只能在抽取文本里找）'
        : ('（第 ' + pg + ' 页没有对应的页面图，下面只能在抽取文本里找）');
    }
    if (!q) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const i = FULL.indexOf(q);
    if (i < 0) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    box.innerHTML = esc(FULL.slice(0, i)) + '<mark id="hit">' + esc(FULL.slice(i, i + q.length)) + '</mark>' + esc(FULL.slice(i + q.length));
    const m = document.getElementById('hit');
    if (m) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- 查看器：跳页 + 缩放（**缩放由教师掌控，切换评价不会重置**）----
  function applyZoom() {
    const img = document.getElementById('pageImg');
    const lbl = document.getElementById('zoomLabel');
    const fit = document.getElementById('zoomFit');
    if (!img) return;
    if (zoom === 'fit') {
      img.style.width = '100%'; img.style.maxWidth = '100%';
      if (lbl) lbl.textContent = '适应宽度';
      if (fit) fit.classList.add('on');
    } else {
      img.style.width = zoom + 'px'; img.style.maxWidth = 'none';
      const nat = img.naturalWidth || 1;
      if (lbl) lbl.textContent = Math.round(zoom / nat * 100) + '%';
      if (fit) fit.classList.remove('on');
    }
  }
  function stepZoom(dir) {
    const img = document.getElementById('pageImg');
    if (!img) return;
    const base = (zoom === 'fit') ? (img.clientWidth || 800) : zoom;
    let next = Math.round(base * (dir > 0 ? 1.25 : 0.8));
    next = Math.max(160, Math.min(6000, next));
    zoom = next; lastManual = next;
    applyZoom();
  }
  function goToPage(n, opts) {
    if (!PAGES[n]) return false;
    curPage = n;
    const img = document.getElementById('pageImg');
    if (img) {
      img.src = PAGES[n];
      img.onload = applyZoom;              // 图换了以后按**当前缩放**重排（不重置）
      if (img.complete) applyZoom();
    }
    const lbl = document.getElementById('pgLabel');
    const idx = PAGE_LIST.indexOf(n);
    if (lbl) lbl.textContent = '第 ' + n + ' 页（' + (idx + 1) + ' / ' + PAGE_LIST.length + '）';
    if (!opts || opts.scroll !== false) {
      const sec = document.getElementById('secpages');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return true;
  }

  function mkCard(f, cls) {
    const ids = f.rubric_item_ids || [f.rubric_item_id];
    const d = document.createElement('div');
    d.className = 'card' + (cls ? ' ' + cls : '');
    let h = '<div class="meta-row"><span class="chip p">' + esc(ids.join(' / ')) + '</span>'
      + '<span class="chip">' + esc(f.kind) + (f.severity ? ' · ' + esc(f.severity) : '') + '</span>' + anchorChip(f) + '</div>';
    h += '<div class="note">' + esc(f.note) + '</div>' + quoteHtml(f);
    // ★ 依据必须说清"是哪一类、结论是什么" —— 不能只丢一个 `→ fail` 让人读成"验证成功"
    if (f.verification) {
      const st = f.verification.stance;
      const label = st === 'fail'
        ? '<b>未通过</b>（客观检查未满足）'
        : st === 'pass'
          ? '通过'
          : '<b>未能自动核实</b>（不足以当作"机械验证"结论）';
      h += '<div class="tiny">L3 机械验证：' + label + '　<span class="mono">' + esc(f.verification.check_id) + '</span></div>';
    }
    // ★ 合并后的观察：把全部依据列出来（其中 L3 结论按上面同样的口径解释）
    const eb = f.evidence_basis;
    if (eb && (eb.warrant_kinds || []).length) {
      const KN = { l3_check: 'L3 机械检查结论', self_contradiction: '报告自相矛盾（两处原文互斥）',
        rubric_requirement: 'rubric 条文（对照评分标准原文）', calculation: '计算不自洽' };
      const ds = (eb.warrant_kinds || []).map(k => KN[k] || k).join('、');
      h += '<div class="tiny">本条依据：' + esc(ds) + (eb.l3 ? '；另有 L3 检查 ' + esc(eb.l3.check_id) + '（' + (eb.l3.stance === 'fail' ? '<b>未通过</b>' : eb.l3.stance === 'pass' ? '通过' : '<b>未能自动核实</b>') + '）' : '') + '</div>';
    }
    if (f.warrant && f.warrant.bound) {
      h += '<div class="basis"><div><b>内容错误候选（依据已绑定，内容待核对）</b>'
        + '<span class="tiny"> —— 系统只核对了「原话能定位、解释与依据成文、引用的 check 存在」，<b>未做语义核验</b></span></div>'
        + '<div>① 学生原话：' + esc(f.warrant.student_quote) + '</div>'
        + '<div>② 错在哪：' + esc(f.warrant.what_is_wrong) + '</div>'
        + '<div>③ 依据（' + esc(f.warrant.basis_kind) + '）：' + esc(f.warrant.basis_detail) + '</div></div>';
    }
    if (f.importance_hint === 'secondary') h += '<div class="tiny">★ 次要问题：无绑定依据、也非“较严重” —— 若无更重要的问题需先看，可略过</div>';
    if (f.rank_reason) h += '<div class="tiny">排序依据：' + esc(f.rank_reason) + '</div>';
    h += '<div class="row"><button data-act="show">查看原文</button></div>';
    d.innerHTML = h;
    d.querySelector('[data-act=show]').onclick = function () { showInFull(f); };
    return d;
  }

  // ① 整篇
  const topBox = document.getElementById('top');
  if (!V.whole_report.top_concerns.length) {
    topBox.innerHTML = '<div class="card">（没有需要优先提示的问题 —— 合格观察不足时不凑满，0 条也可以）</div>';
  }
  V.whole_report.top_concerns.forEach(function (f) { topBox.appendChild(mkCard(f, 'primary')); });
  document.getElementById('topfold').textContent =
    '（另有 ' + V.whole_report.folded_count + ' 条已折叠；本视图只把过门槛的观察放第一屏）';

  // 待核查：可能缺少的关键内容
  const mBox = document.getElementById('missing');
  const pm = V.whole_report.possibly_missing;
  if (!pm || !pm.entries.length) mBox.innerHTML = '<div class="card">（无）</div>';
  else pm.entries.forEach(function (e) {
    const d = document.createElement('div');
    d.className = 'card pending';
    d.innerHTML = '<div class="meta-row"><span class="chip p">' + esc(e.rubric_item_id) + '</span>'
      + '<span class="chip w">' + esc(e.status) + '</span></div>'
      + '<div class="note">' + esc(e.statement) + '</div>'
      + '<div class="tiny">依据：' + esc(e.basis) + '</div>'
      + '<div class="tiny">检查范围：已解析 ' + esc(e.check_scope.parsed_chars) + ' 字 / '
      + esc(e.check_scope.parsed_entries) + ' 条结构条目 / 解析警告 ' + esc(e.check_scope.parse_warnings) + ' 条</div>'
      + '<div class="row"><button data-act="show">查看原文</button></div>';
    d.querySelector('[data-act=show]').onclick = function () { showInFull(null); };
    mBox.appendChild(d);
  });

  // ② 逐条 rubric
  const iBox = document.getElementById('items');
  V.items.forEach(function (it) {
    const d = document.createElement('div');
    d.className = 'card';
    const max = DATA.maxByItem ? DATA.maxByItem[it.rubric_item_id] : null;
    let h = '<div class="meta-row"><span class="chip p">' + esc(it.rubric_item_id) + '</span>'
      + '<span class="chip">' + esc(it.strategy_type) + '</span>'
      + (max != null ? '<span class="chip">满分 ' + esc(max) + '</span>' : '') + '</div>';
    h += '<div class="note"><b>' + esc(DATA.rubricItems[it.rubric_item_id] || it.rubric_text || '') + '</b></div>';
    if (it.level_reference && it.level_reference.length) {
      h += '<div class="level">档位参考（rubric 定义，非 AI 建议）：'
        + it.level_reference.map(function (l) {
          return '<span>' + esc(l.level_id) + '（' + esc(l.level_score) + '）' + esc(String(l.text).slice(0, 120)) + '</span>';
        }).join('') + '</div>';
    }
    const pc = it.primary_concern, ps = it.primary_strength;
    h += '<div style="margin-top:8px"><b>关键问题</b>';
    h += pc ? '<div class="note">' + esc(pc.note) + '</div>' + quoteHtml(pc)
      + '<div class="meta-row">' + pageChip(pc) + anchorChip(pc) + '</div>'
      : '<div class="tiny">（无）</div>';
    h += '</div><div style="margin-top:8px"><b>做得好的</b>';
    h += ps ? '<div class="note">' + esc(ps.note) + '</div>' + quoteHtml(ps) + '<div class="meta-row">' + pageChip(ps) + '</div>'
      : '<div class="tiny">（无）</div>';
    h += '</div>';

    // ★ 修正 3：展开要显示**真实折叠观察**（原来只显示一个 JSON 文件名）
    const folded = (DATA.foldedByItem && DATA.foldedByItem[it.rubric_item_id]) || [];
    h += '<div class="fold" data-act="fold">⋯ 另有 ' + it.folded.folded_count + ' 条（问题 ' + it.folded.concern
      + ' / 优点 ' + it.folded.strength + ' / 中性 ' + it.folded.neutral + '）—— 点开查看</div>';
    h += '<div class="hidden-box">';
    if (!folded.length) h += '<div class="tiny">（没有可展开的折叠观察）</div>';
    else folded.forEach(function (f) {
      const tag = f.polarity === 'concern' ? '问题' : f.polarity === 'strength' ? '优点' : '中性';
      h += '<div style="margin:6px 0 8px"><div class="tiny">' + tag + ' · ' + esc(f.kind)
        + (f.severity ? ' · ' + esc(f.severity) : '') + (f.anchored ? '' : ' · ⚠无法回原文核对') + '</div>'
        + '<div>' + esc(f.note) + '</div>'
        + (f.quote ? '<div class="quote">⟨' + esc(f.quote) + '⟩</div>' : '')
        + '<div class="row"><button data-act="showone">查看原文</button></div></div>';
    });
    h += '<div class="tiny">完整报告（含系统内部字段）：' + esc(V.source_assessment.file || '') + '</div></div>';

    h += '<div class="row"><span class="tiny">这条评价：</span>'
      + '<button data-v="accurate">准确</button>'
      + '<button data-v="partially_accurate">部分准确</button>'
      + '<button data-v="inaccurate">不准确</button>'
      + '<span class="tiny" style="margin-left:8px">给分</span>'
      + '<input type="number" step="1" min="0" data-s placeholder="—">'
      + '<span class="tiny" data-max></span></div>';
    h += '<div style="margin-top:6px"><textarea data-n placeholder="教师备注（可选）"></textarea></div>';
    d.innerHTML = h;

    const fold = d.querySelector('[data-act=fold]'), hb = d.querySelector('.hidden-box');
    fold.onclick = function () { hb.style.display = hb.style.display === 'block' ? 'none' : 'block'; };
    d.querySelectorAll('button[data-act=showone]').forEach(function (b, i) {
      const item = folded[i];
      b.onclick = function () { showInFull(item); };
    });
    d.querySelectorAll('button[data-v]').forEach(function (b) {
      b.onclick = function () {
        ST[it.rubric_item_id].verdict = b.dataset.v;
        d.querySelectorAll('button[data-v]').forEach(function (x) { x.classList.toggle('on', x === b); });
        refresh();
      };
    });
    const sc = d.querySelector('input[data-s]');
    // ★ 修正 2：分数必须是**整数**（校验器要求），越界立即标红
    sc.oninput = function () {
      const v = sc.value === '' ? null : Number(sc.value);
      const okInt = v != null && Number.isInteger(v) && v >= 0 && (max == null || v <= max);
      if (v != null && !okInt) sc.classList.add('bad'); else sc.classList.remove('bad');
      ST[it.rubric_item_id].score = okInt ? v : null;
      sc.classList.toggle('on', okInt);
      refresh();
    };
    d.querySelector('textarea[data-n]').oninput = function (e) { ST[it.rubric_item_id].note = e.target.value; };
    d.querySelector('[data-max]').textContent = (max == null) ? '' : ('/ ' + max + '（整数）');
    iBox.appendChild(d);
  });

  // ③ 草稿：★ 被否定的评价不得作为"确认内容"进入评语；总分未形成时不报 0
  function scored() { return Object.keys(ST).filter(function (k) { return Number.isInteger(ST[k].score); }); }
  function refresh() {
    const n = scored().length;
    const all = n === V.items.length && n > 0;
    document.getElementById('stat').textContent = all
      ? ('已给分 ' + n + '/' + V.items.length)
      : (n === 0 ? '尚不给分（0/' + V.items.length + '）' : '已给分 ' + n + '/' + V.items.length + '（未完成）');
  }
  document.getElementById('btnDraft').onclick = function () {
    const lines = V.items.map(function (it) {
      const s = ST[it.rubric_item_id];
      const isScored = Number.isInteger(s.score);
      let t = '· ' + it.rubric_item_id + '：' + (isScored ? s.score + ' 分' : '未给分');
      // ★ 只有 accurate 才算"内容已确认"，此条 AI 评价才可以作为已确认内容写入
      if (s.verdict === 'accurate') {
        t += '（教师已确认该条评价准确）' + NL;
        if (it.primary_concern) t += '    问题：' + it.primary_concern.note + NL;
        if (it.primary_strength) t += '    做得好：' + it.primary_strength.note + NL;
      } else if (s.verdict === 'inaccurate') {
        t += '（教师标注：**不准确**）' + NL + '    → 该条 AI 评价**不采纳**，不作为确认内容进入评语' + NL;
      } else if (s.verdict === 'partially_accurate') {
        t += '（教师标注：部分准确）' + NL + '    → 内容未完全确认，AI 评价不作为确认内容写入' + NL;
      } else {
        t += '（教师未标注）' + NL + '    → 内容未获教师确认，AI 评价不作为确认内容写入' + NL;
      }
      if (s.note) t += '    教师备注：' + s.note + NL;
      return t;
    }).join(NL);

    const n = scored().length, all = n === V.items.length && n > 0;
    const total = V.items.reduce(function (a, it) { const s = ST[it.rubric_item_id].score; return a + (Number.isInteger(s) ? s : 0); }, 0);
    const confirmedCount = V.items.filter(function (it) { return ST[it.rubric_item_id].verdict === 'accurate'; }).length;
    const negated = V.items.filter(function (it) { return ST[it.rubric_item_id].verdict === 'inaccurate'; }).length;

    const head = '【本报告评价草稿】' + NL + NL;
    const foot = NL
      + (all ? ('合计：' + total + ' 分（教师给分，' + n + '/' + V.items.length + ' 条已给分）' + NL)
        : ('**总分未形成**：' + n + '/' + V.items.length + ' 条已给分 —— 未完成时不报合计（避免被读成"教师给了 0 分"）' + NL))
      + '内容确认情况：教师确认准确 ' + confirmedCount + ' 条 · 否定 ' + negated + ' 条 · 其余未确认' + NL
      + '说明：页面上的评价由 AI 提出、供教师核对；**只有标注"准确"的条目其内容被视为已确认**，'
      + '否定与未标注的条目均不作为确认内容进入评语。' + NL
      + '★ 本段为本地模板拼装；正式版措辞由评语层生成。';
    document.getElementById('draft').textContent = head + lines + foot;
  };

  // 导出：★ 用共用的纯函数拼装，字段与校验链对齐（doc / rubric / max / 整数分）
  document.getElementById('btnExport').onclick = function () {
    const out = TeacherUIExport.buildTeacherScores({
      view: V,
      states: ST,
      maxByItem: DATA.maxByItem || {},
      opts: {
        sourceReport: DATA.sourceReport,
        rubricId: DATA.rubricId,
        confirmed: document.getElementById('chkConfirmed').checked,
        teacherName: document.getElementById('teacherName').value || null,
        approvalAt: new Date().toISOString(),
      },
    });
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = DATA.sourceReport + '.teacher-scores.work.json';
    a.click();
  };

  // 原文区：说明 + 打开原件（PDF）
  const note = document.getElementById('srcnote');
  if (note) {
    note.textContent = (DATA.source && DATA.source.text_note ? DATA.source.text_note : '')
      + '；图表、加粗、下划线的判断请打开原件核对。';
  }
  const srow = document.getElementById('srcrow');
  if (srow) {
    if (DATA.source) {
      const t = document.createElement('span');
      t.className = 'tiny';
      // ★ 按**输入类型**分别措辞：纯文本输入本来就没有页面图，不能说成"原件（PDF）不可用"（措辞不适配）
      const isTextInput = /\.txt$/i.test(String(DATA.doc?.name ?? ''));
      t.textContent = DATA.source.pdf_available
        ? '（原件已内联在本页下方「原件（PDF）」区；原件与抽取文本可能不一致 —— 以原件为准）'
        : isTextInput
          ? '（本报告是**纯文本输入**：没有页面图，定位与引文都以抽取文本为准 —— 这是输入本身的形态，不是提取失败）'
          : '⚠ 原件未能内联到本页（可能是解析或体积原因），当前只能核对抽取文本 —— 请以原件为准';
      srow.appendChild(t);
    }
  }

  // ★ 原件区：展开 / 在新标签页打开（用 Blob URL —— data: 作顶层导航会被浏览器拦）
  const embed = document.getElementById('pdfembed');
  const box = document.getElementById('pdfbox');
  const tg = document.getElementById('btnPdfToggle');
  if (tg && box) {
    tg.onclick = function () {
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : 'block';
      tg.textContent = open ? '展开原件' : '收起原件';
      if (!open) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
  function pdfBytesFromEmbed() {
    const src = (embed && embed.getAttribute('src')) || '';
    const b64 = src.split(',')[1] || '';
    if (!b64) return null;
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  const op = document.getElementById('btnPdfOpen');
  if (op && embed) {
    op.onclick = function () {
      try {
        const arr = pdfBytesFromEmbed();
        if (!arr) throw new Error('内联原件不可用');
        const url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
        const w = window.open(url, '_blank');
        if (!w) alert('浏览器拦下了新标签页 —— 请允许弹窗，或改用右侧「下载原件」/「展开原件」在页内查看。');
      } catch (e) {
        alert('打开原件失败：' + e.message + '（请改用「下载原件」或「展开原件」）');
      }
    };
  }
  // ★ 最可靠的一条路：下载原件（<a download>，不受弹窗与顶层导航策略影响）
  const dl = document.getElementById('btnPdfDownload');
  if (dl && embed) {
    dl.onclick = function () {
      try {
        const arr = pdfBytesFromEmbed();
        if (!arr) throw new Error('内联原件不可用');
        const url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = (DATA.source && DATA.source.pdf_name) || 'original.pdf';
        a.click();
      } catch (e) {
        alert('下载原件失败：' + e.message);
      }
    };
  }
  // ★ 深链：#pdf 时自动展开原件（便于分享链接与自动化核对）
  if (box && tg && /(^|[#&])pdf\b/.test(location.hash)) {
    box.style.display = 'block';
    tg.textContent = '收起原件';
  }

  // 查看器绑定
  const bPrev = document.getElementById('pgPrev'), bNext = document.getElementById('pgNext');
  if (bPrev) bPrev.onclick = function () { const i = PAGE_LIST.indexOf(curPage); if (i > 0) goToPage(PAGE_LIST[i - 1]); };
  if (bNext) bNext.onclick = function () { const i = PAGE_LIST.indexOf(curPage); if (i >= 0 && i < PAGE_LIST.length - 1) goToPage(PAGE_LIST[i + 1]); };
  const zf = document.getElementById('zoomFit');
  if (zf) zf.onclick = function () { zoom = 'fit'; applyZoom(); };
  const zo = document.getElementById('zoomOut'); if (zo) zo.onclick = function () { stepZoom(-1); };
  const zi = document.getElementById('zoomIn'); if (zi) zi.onclick = function () { stepZoom(1); };
  const zr = document.getElementById('zoomReset');
  if (zr) zr.onclick = function () { zoom = lastManual || 'fit'; applyZoom(); };
  // 页码 chip 可点：直接跳到该页（不滚走，便于连续核对）
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest ? ev.target.closest('.pagechip') : null;
    if (t) { goToPage(Number(t.dataset.page)); }
  });
  if (PAGE_LIST.length) goToPage(PAGE_LIST[0], { scroll: false });

  document.getElementById('full').textContent = FULL;
  refresh();
})();
