// realtime/app.js —— 实时评分页面前端逻辑
// ★ 纪律：这里**不含任何密钥**。上传与模型调用都在服务端进行；本页只负责选文件、看进度、看结果。
(function () {
  const $ = id => document.getElementById(id);
  const MAX_MB = 10;
  const MAX_RUBRIC_BYTES = 128 * 1024;
  const NL = String.fromCharCode(10);

  let picked = null;        // { name, size, kind }
  let fileDataB64 = null;   // 仅在需要上传时读取
  let rubrics = [];
  let rubricUpload = null;
  let rubricPreviewSeq = 0;
  let timer = null, t0 = 0;
  let jobToken = null;      // ★ 加固后：产物需带 job token 才能访问（不再匿名公开）
  let pdfRealtime = false;  // ★ 部署是否开启 PDF 实时分析（由 /api/cases 告知）

  // ★ 额度显示：初始化与**分析完成后**都要刷新（原来只在打开页面时拉一次，分析完仍显示旧数字）
  async function refreshQuota() {
    try {
      const q = await (await fetch('/api/quota')).json();
      if (q && q.remaining != null) {
        $('quota').textContent = '（本次演示配额：剩余 ' + q.remaining + ' / ' + q.limit + ' 次实时分析）';
      }
    } catch { /* 拿不到就不显示，不影响主流程 */ }
  }

  const fmtSize = n => n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  // ---------- 初始化：预置案例 & rubric 列表 ----------
  (async function init() {
    try {
      const r = await fetch('/api/cases');
      const j = await r.json();
      const sel = $('preset');
      (j.presets || []).forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.title + '（预置）';
        sel.appendChild(o);
      });
      rubrics = j.rubrics || [];
      // ★ 部署能力：未开启 PDF 实时分析时，选到 PDF 立即提示（不让评委白等几分钟）
      pdfRealtime = j.pdf_realtime === true;
      const cap = document.getElementById('pdfCap');
      if (cap) cap.textContent = pdfRealtime ? '（本部署内存充足，PDF 预期可跑完）' : '（本部署内存较小，PDF 有可能失败）';
      const et = document.getElementById('etaTxt'), ep = document.getElementById('etaPdf');
      if (et && j.eta_txt) et.textContent = j.eta_txt;
      if (ep && j.eta_pdf) ep.textContent = j.eta_pdf;
      const rs = $('rubric');
      rubrics.forEach(rb => {
        const o = document.createElement('option');
        o.value = rb; o.textContent = rb.split('/').pop().replace('canonical-rubric.', '').replace('.json', '');
        rs.appendChild(o);
      });
      const uploadOption = document.createElement('option');
      uploadOption.value = '__upload__'; uploadOption.textContent = '上传全新 TXT rubric（先预览确认）';
      rs.appendChild(uploadOption);
      // 预置案例选中时自动带出它的 rubric
      sel.onchange = () => {
        const p = (j.presets || []).find(x => x.id === sel.value);
        if (p) { $('rubric').value = p.rubric; updateInfo(); }
        $('picked').textContent = p ? '（已选预置：' + p.title + '）' : '';
      };
      rs.onchange = updateInfo;
      updateInfo();
    } catch (e) {
      $('hint').textContent = '⚠ 无法读取服务端配置：' + e.message;
    }
    refreshQuota();
  })();

  function updateInfo() {
    const v = $('rubric').value;
    $('rubricUploadBox').style.display = v === '__upload__' ? 'block' : 'none';
    if (v === '__upload__') {
      $('rubricInfo').textContent = '新 rubric：逐字解析条目与分值，需确认后才能分析';
      return;
    }
    const guess = /cs3223/i.test(v) ? 'points 型（8 个可评分叶子）' : 'levels + points 混合（R1–R4/R7 档位，R5/R6 计分点）';
    $('rubricInfo').textContent = v ? ('类型：' + guess) : '';
  }

  const readB64 = f => new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => resolve(String(rd.result).split(',')[1] || '');
    rd.onerror = () => reject(new Error('读取文件失败'));
    rd.readAsDataURL(f);
  });

  $('rubricFile').onchange = async function () {
    const f = this.files[0];
    const seq = ++rubricPreviewSeq;
    rubricUpload = null;
    $('rubricConfirm').checked = false;
    $('rubricConfirmRow').style.display = 'none';
    $('rubricPreview').replaceChildren();
    if (!f) return;
    $('rubric').value = '__upload__'; updateInfo();
    if (!/\.txt$/i.test(f.name) || !f.size || f.size > MAX_RUBRIC_BYTES) {
      $('rubricUploadStatus').textContent = '只支持非空 UTF-8 .txt，大小不超过 128 KB';
      return;
    }
    $('rubricUploadStatus').textContent = '正在解析预览…';
    try {
      const file_base64 = await readB64(f);
      const response = await fetch('/api/rubric/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_name: f.name, file_base64 }),
      });
      const result = await response.json();
      if (seq !== rubricPreviewSeq) return;
      const box = $('rubricPreview');
      const line = text => { const d = document.createElement('div'); d.textContent = text; box.appendChild(d); };
      if (result.preview) {
        const p = result.preview;
        line('原件 SHA-256：' + p.sha256 + '；条目 ' + p.items.length + ' 项、可评分叶子 ' + p.leaves + ' 项、叶子分值合计 ' + p.total_points + ' 分');
        line('归入条目行数：' + p.line_coverage + '（未归入行及问题见下方）');
        for (const it of p.items) line((it.parent ? '　↳ ' : '') + it.id + ' · ' + it.text + (it.scorable ? ' [教师给分项]' : ' [父项]'));
        for (const unparsed of p.unparsed_lines || []) line('未归入评分条目：' + unparsed);
      }
      for (const w of result.warnings || []) line('提醒：' + w);
      for (const e of result.errors || []) line('需修改：' + e);
      if (!response.ok || !result.ok) {
        $('rubricUploadStatus').textContent = result.error || '预览未通过；请修改原始 TXT 后重新上传';
        return;
      }
      rubricUpload = { file_name: f.name, file_base64, confirmed_sha256: result.preview.sha256 };
      $('rubricUploadStatus').textContent = '预览通过，待上传者核对确认';
      $('rubricConfirmRow').style.display = 'flex';
    } catch (e) {
      if (seq === rubricPreviewSeq) $('rubricUploadStatus').textContent = '预览失败：' + e.message;
    }
  };

  // ---------- 选文件 ----------
  const drop = $('drop'), fileInput = $('file');
  drop.onclick = () => fileInput.click();
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => {
    e.preventDefault(); drop.classList.remove('over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) takeFile(e.dataTransfer.files[0]);
  };
  fileInput.onchange = () => { if (fileInput.files[0]) takeFile(fileInput.files[0]); };

  function takeFile(f) {
    const okExt = /\.(pdf|txt)$/i.test(f.name);
    if (!okExt) { alert('只支持 .pdf / .txt'); return; }
    // ★ 不拦截 PDF：只是**说明等待时间**（建议 TXT，但 PDF 照样能提交）
    if (/\.pdf$/i.test(f.name)) {
      $('error').style.display = 'block';
      $('error').className = 'notice';
      const eta = ($('etaPdf') && $('etaPdf').textContent) || '约 6–10 分钟';
      $('error').innerHTML = '<b>已选 PDF</b>：需要把整页渲染成图，<b>等待时间更长（' + eta + '）</b>'
        + (pdfRealtime ? '' : '；本部署内存较小，PDF 有可能失败')
        + '。如果赶时间，建议改用 <b>.txt</b>（更快）。'
        + '<div class="tiny" style="margin-top:6px">仍想直接看 PDF 效果，也可用预置案例：'
        + '<a href="/cases/cs3223-writeup.pdf.html" target="_blank" rel="noopener">打开 PDF 预置案例</a></div>';
    } else {
      $('error').style.display = 'none';
    }
    if (f.size > MAX_MB * 1024 * 1024) { alert('文件超过 ' + MAX_MB + ' MB'); return; }
    picked = { name: f.name, size: f.size, kind: /\.pdf$/i.test(f.name) ? 'pdf' : 'text' };
    fileDataB64 = null;
    $('picked').textContent = '已选：' + f.name + '（' + fmtSize(f.size) + '，' + picked.kind + '）';
    $('preset').value = '';   // 上传优先于预置
    // 读成 base64（异步，不阻塞）
    const rd = new FileReader();
    rd.onload = () => { fileDataB64 = String(rd.result).split(',')[1] || null; };
    rd.readAsDataURL(f);
  }

  // ---------- 开始分析 ----------
  $('go').onclick = async function () {
    const preset = $('preset').value;
    const customRubric = $('rubric').value === '__upload__';
    if (!preset && !picked) { alert('请先选择或拖入一份报告'); return; }
    if (!preset && picked && !fileDataB64) { alert('文件还在读取中，请稍候一秒再点'); return; }
    if (customRubric && preset) { alert('新 rubric 请与新上传的报告一起分析，不用于预置案例'); return; }
    if (customRubric && (!rubricUpload || !$('rubricConfirm').checked)) {
      alert('请先上传 TXT rubric、核对预览并勾选确认'); return;
    }
    const body = { source: preset ? 'preset' : 'upload', case: preset || undefined,
      file_name: preset ? undefined : picked.name, file_base64: preset ? undefined : fileDataB64,
      ...(customRubric ? { rubric_upload: rubricUpload } : { rubric: $('rubric').value }) };
    $('go').disabled = true;
    $('error').style.display = 'none';
    $('resultCard').style.display = 'none';
    $('progress').style.display = 'block';
    $('steps').innerHTML = '';
    setStatus('已提交，等待服务端开始…');
    startTimer();

    let job;
    try {
      const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      job = await r.json();
      if (r.status !== 202) {
        const head = (job && job.error) || ('HTTP ' + r.status);
        const tail = (job && job.hint) ? job.hint : '';
        showError(head, tail);
        if (r.status === 429) showTip('配额/并发受限：稍后重试，或直接查看预置案例（右侧静态演示站链接）。');
        $('go').disabled = false; stopTimer('失败');
        return;
      }
    } catch (e) {
      showError('提交失败：' + e.message);
      $('go').disabled = false; stopTimer('失败');
      return;
    }
    jobToken = job.job_token || null;
    if (job.eta_note) setStatus(job.eta_note);
    poll(job.job_id);
  };

  async function poll(id) {
    const seen = new Set();
    for (let i = 0; i < 800; i++) {           // 最多约 40 分钟（每 3 秒一次）
      await new Promise(s => setTimeout(s, 3000));
      let j;
      try { j = await (await fetch('/api/job/' + id + '?token=' + encodeURIComponent(jobToken || ''))).json(); } catch { continue; }
      (j.steps || []).forEach(st => {
        const key = st.name + '|' + (j.steps.indexOf(st));
        if (seen.has(key)) return;
        seen.add(key);
        addStep(st.name, /完成|done/.test(st.name) ? 'done' : 'run');
      });
      setStatus(j.state === 'running' ? '分析中…' : j.state);
      if (j.log_tail) { $('logbox').style.display = 'block'; $('log').textContent = j.log_tail; }
      if (j.state === 'done') {
        stopTimer('完成');
        (j.steps || []).forEach(st => { /* 全部标完成 */ });
        addStep('全部完成', 'done');
        refreshQuota();   // ★ 完成后刷新额度显示（否则页面一直显示分析前的剩余次数）
        // ★ view_url 由服务端下发，含 job token；产物本身不走静态目录
        $('view').src = j.view_url;
        $('openNew').href = j.view_url;
        $('resultCard').style.display = 'block';
        $('resultCard').scrollIntoView({ behavior: 'smooth' });
        $('go').disabled = false;
        return;
      }
      if (j.state === 'failed') {
        stopTimer('失败');
        showError(j.error || '分析失败', (j.stderr_tail || '').slice(-600));
        $('go').disabled = false;
        return;
      }
    }
    showError('轮询超时（超过 40 分钟）—— 请稍后在服务器上查看产物');
    $('go').disabled = false;
  }

  function addStep(name, cls) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="dot ' + (cls || 'run') + '"></span>' + escapeHtml(name);
    $('steps').appendChild(li);
  }
  const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const setStatus = s => { $('status').textContent = s; };
  function showTip(msg) {
    const el = document.getElementById('extraTip');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function showError(a, b) {
    $('error').style.display = 'block';
    $('error').className = 'err';
    $('error').innerHTML = '<b>' + escapeHtml(a) + '</b>' + (b ? '<div class="mono" style="margin-top:8px">' + escapeHtml(b) + '</div>' : '');
  }
  function startTimer() { t0 = Date.now(); timer = setInterval(() => { $('elapsed').textContent = '已用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒'; }, 1000); }
  function stopTimer(word) { if (timer) clearInterval(timer); timer = null; $('elapsed').textContent = (word || '结束') + '，总用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒'; }
})();
