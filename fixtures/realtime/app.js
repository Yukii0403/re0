// realtime/app.js —— 实时评分页面前端逻辑
// ★ 纪律：这里**不含任何密钥**。上传与模型调用都在服务端进行；本页只负责选文件、看进度、看结果。
(function () {
  const $ = id => document.getElementById(id);
  const MAX_MB = 10;
  const NL = String.fromCharCode(10);

  let picked = null;        // { name, size, kind }
  let fileDataB64 = null;   // 仅在需要上传时读取
  let rubrics = [];
  let timer = null, t0 = 0;
  let jobToken = null;      // ★ 加固后：产物需带 job token 才能访问（不再匿名公开）
  let pdfRealtime = false;  // ★ 部署是否开启 PDF 实时分析（由 /api/cases 告知）

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
      if (cap) cap.textContent = pdfRealtime ? '（本部署已开启 PDF 实时分析）' : '（本部署未开启 PDF 实时分析）';
      const rs = $('rubric');
      rubrics.forEach(rb => {
        const o = document.createElement('option');
        o.value = rb; o.textContent = rb.split('/').pop().replace('canonical-rubric.', '').replace('.json', '');
        rs.appendChild(o);
      });
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
    try {
      const q = await (await fetch('/api/quota')).json();
      $('quota').textContent = q && q.remaining != null
        ? '（本次演示配额：剩余 ' + q.remaining + ' / ' + q.limit + ' 次实时分析）' : '';
    } catch {}
  })();

  function updateInfo() {
    const v = $('rubric').value;
    const guess = /cs3223/i.test(v) ? 'points 型（8 个可评分叶子）' : 'levels + points 混合（R1–R4/R7 档位，R5/R6 计分点）';
    $('rubricInfo').textContent = v ? ('类型：' + guess) : '';
  }

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
    if (/\.pdf$/i.test(f.name) && !pdfRealtime) {
      $('error').style.display = 'block';
      $('error').className = 'err';
      $('error').innerHTML = '<b>本部署未开启 PDF 实时分析</b>'
        + '<div class="tiny" style="margin-top:6px">PDF 需要整页渲染（内存峰值可达 GB 级），免费档会失败。'
        + '请改用 <b>.txt</b> 报告；想看 PDF 的完整效果请用预置案例。'
        + '<div style="margin-top:8px"><a href="/cases/cs3223-writeup.pdf.html" target="_blank" rel="noopener"><button>打开 PDF 预置案例</button></a></div></div>';
      picked = null; fileDataB64 = null;
      $('picked').textContent = '（已拒绝 PDF：本部署未开启 PDF 实时分析）';
      return;
    }
    $('error').style.display = 'none';
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
    if (!preset && !picked) { alert('请先选择或拖入一份报告'); return; }
    if (!preset && picked && !fileDataB64) { alert('文件还在读取中，请稍候一秒再点'); return; }
    const body = { source: preset ? 'preset' : 'upload', case: preset || undefined,
      file_name: preset ? undefined : picked.name, file_base64: preset ? undefined : fileDataB64,
      rubric: $('rubric').value };
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
