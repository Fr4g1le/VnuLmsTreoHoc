// ==UserScript==
// @name         VNU LMS - Treo học
// @namespace    vnu-lms-keepalive
// @version      2.5
// @description  Tự học lần lượt các mục trên LMS VNU cho đến khi đạt yêu cầu, giữ video chạy khi treo máy.
// @match        https://lms.vnu.edu.vn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// VNU LMS - Treo học. Chạy trong trang (world MAIN) để dùng chung phiên đăng nhập và sự kiện của trang.
//
// Cách LMS tính "đã học":
// - Mỗi mục có "Phải học tối thiểu N phút" (mincore). Server cộng thời gian mở mục vào learnTime
//   khi rời khỏi mục, rồi tự đánh dấu isFinish khi learnTime >= mincore.
// - Mục không có yêu cầu thời gian (PDF, tài liệu...) chỉ cần mở một lúc rồi rời đi.
// - Định kỳ trang hiện SweetAlert "Bạn có đang học tập không ?" chờ 10 giây, không bấm thì bị đẩy về trang chủ.
(function () {
  'use strict';
  if (window.top !== window) return;

  const API = '/dhqg.lms.api/api/v1/';
  const LS_CFG = 'vnuTreoCfg';
  const LS_RUN = 'vnuTreoRun';
  const LS_PANEL = 'vnuTreoPanel';
  const TYPES = {
    'c2a2e16a-a364-42b6-804e-66eb96905304': 'video',
    '22f7f46e-acc2-4259-899a-950c3cd69efb': 'pdf',
    'b196bfc0-591d-497d-9128-87e2746b9494': 'text',
    'b6421bc8-2324-4510-9217-68babde82313': 'test',
  };
  const KIND_LABEL = { video: 'Video', pdf: 'PDF / tài liệu', text: 'Bài đọc', other: 'Khác', test: 'Bài kiểm tra' };
  const DEFAULTS = {
    keepAlive: true,
    resumeVideo: true,
    loopVideo: true,
    muteVideo: false,
    refreshProgress: true,
    kinds: { video: true, pdf: true, text: true, other: false },
    onlyRequired: false,
    extraMin: 1,     // treo thêm sau khi đủ thời gian yêu cầu
    noReqMin: 1,     // thời gian treo mục không có yêu cầu (PDF...)
    skipFolders: [], // id các bài lớn không học
  };

  const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const stored = readJSON(LS_CFG, {});
  const cfg = Object.assign({}, DEFAULTS, stored, { kinds: Object.assign({}, DEFAULTS.kinds, stored.kinds) });
  const saveCfg = () => writeJSON(LS_CFG, cfg);

  // Đếm giờ trong Web Worker: khi tab nằm nền, trình duyệt làm chậm setTimeout/setInterval của trang
  // (tới 1 lần/phút) nhưng không làm chậm timer của worker. Không tạo được worker thì dùng timer thường.
  const timer = (() => {
    let worker = null, seq = 0;
    const callbacks = {};
    try {
      const src = 'const t={};onmessage=e=>{const d=e.data;t[d.id]=(d.repeat?setInterval:setTimeout)(()=>postMessage(d.id),d.ms)}';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = e => { const fn = callbacks[e.data]; if (fn) fn(); };
    } catch (e) {}
    const start = (ms, fn, repeat) => {
      const id = ++seq;
      callbacks[id] = repeat ? fn : () => { delete callbacks[id]; fn(); };
      worker.postMessage({ id, ms, repeat });
    };
    return {
      after: (ms, fn) => (worker ? start(ms, fn, false) : setTimeout(fn, ms)),
      every: (ms, fn) => (worker ? start(ms, fn, true) : setInterval(fn, ms)),
    };
  })();
  const sleep = ms => new Promise(r => timer.after(ms, r));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const classIdFromUrl = () => (location.pathname.match(/\/learn\/lop-hoc\/chi-tiet\/([0-9a-f-]{36})/i) || [])[1];
  const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // ---------- 1. Chống treo: trang luôn tưởng tab đang được xem ----------
  const realHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const realState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  try {
    Object.defineProperty(Document.prototype, 'hidden', {
      get() { return cfg.keepAlive ? false : realHidden.get.call(this); }, configurable: true,
    });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      get() { return cfg.keepAlive ? 'visible' : realState.get.call(this); }, configurable: true,
    });
  } catch (e) {}
  const realHasFocus = Document.prototype.hasFocus;
  Document.prototype.hasFocus = function () { return cfg.keepAlive || realHasFocus.call(this); };
  const swallow = e => { if (cfg.keepAlive && (e.target === window || e.target === document)) e.stopImmediatePropagation(); };
  for (const t of ['visibilitychange', 'webkitvisibilitychange']) document.addEventListener(t, swallow, true);
  for (const t of ['blur', 'focusout']) window.addEventListener(t, swallow, true);

  // SweetAlert "Bạn có đang học tập không ?" chỉ chờ 10 giây. MutationObserver bấm ngay khi nó hiện,
  // kể cả khi Chrome làm chậm setInterval của tab nền.
  function answerLmsAlert() {
    if (!cfg.keepAlive) return;
    const popup = document.querySelector('.swal2-popup');
    if (!popup || !/đang học/i.test(popup.innerText)) return;
    const ok = popup.querySelector('.swal2-confirm');
    if (ok && !ok.dataset.vnuClicked) {
      ok.dataset.vnuClicked = '1';
      log('Đã xác nhận "Bạn có đang học tập không ?"');
      ok.click();
    }
  }
  new MutationObserver(answerLmsAlert).observe(document, { childList: true, subtree: true });

  function applyMute() {
    for (const m of document.querySelectorAll('video, audio')) m.muted = cfg.muteVideo;
  }
  function tickVideo() {
    if (cfg.muteVideo) for (const a of document.querySelectorAll('audio')) a.muted = true;
    for (const v of document.querySelectorAll('video')) {
      if (cfg.muteVideo) v.muted = true;
      if (v.ended) {
        if (S.active && cfg.loopVideo) { v.currentTime = 0; playVideo(v); }
        continue;
      }
      if (cfg.resumeVideo && v.paused && v.readyState > 0) playVideo(v);
    }
  }
  function playVideo(v) {
    // Trình duyệt chặn tự phát có tiếng -> tắt tiếng rồi phát
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
  }
  function pokeActivity() {
    const x = 200 + Math.random() * 400, y = 150 + Math.random() * 300;
    const target = document.elementFromPoint(x, y) || document.body;
    if (target) target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  }

  // ---------- 2. Tự học theo mục lục ----------
  const S = { active: false, phase: '', course: null, queue: [], parking: null, current: null, endsAt: 0, logs: [] };

  function log(msg) {
    S.logs.unshift(new Date().toLocaleTimeString('vi-VN') + '  ' + msg);
    S.logs.length = Math.min(S.logs.length, 40);
    console.log('[Treo học]', msg);
    render();
  }

  async function api(path) {
    const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + localStorage.getItem('access_token') } });
    if (r.status === 401) throw new Error('Phiên đăng nhập hết hạn, hãy đăng nhập lại');
    const j = await r.json();
    if (j.status === false || !('data' in j)) throw new Error(j.message || 'API trả lỗi: ' + path);
    return j.data;
  }

  const details = {};
  const detail = async id => details[id] || (details[id] = await api('LmsClassContent/FrGetById/' + id));

  async function loadLearning(classId) {
    const map = {};
    for (const l of (await api('LmsClass/FrUserJoinClassNew/' + classId)).lmsClassUserLearning || []) map[l.classContentId] = l;
    return map;
  }

  function kindOf(d) {
    const k = TYPES[String(d.typeId).toLowerCase()];
    if (k) return k;
    const f = (d.fileId || '').toLowerCase();
    if (/\.(mp4|mov|webm|m4v)$/.test(f)) return 'video';
    if (/\.(pdf|docx?|pptx?|xlsx?)$/.test(f)) return 'pdf';
    return 'other';
  }
  const needMs = l => 60000 * (l.mincore > 0 ? Math.max(0, l.mincore - l.learnTime) + cfg.extraMin : cfg.noReqMin);

  async function scan() {
    const classId = classIdFromUrl();
    if (!classId) throw new Error('Hãy mở trang lớp học trước (Lớp học → chi tiết).');
    if (S.phase) return; // đang quét rồi
    S.phase = 'Đang đọc mục lục…'; render();
    try {
      const [tree, learning] = await Promise.all([
        api('LmsClassTopic/searchFrTop1?classId=' + classId + '&key='), loadLearning(classId)]);

      const leaves = [], folders = [], seen = {};
      const walk = (nodes, top) => {
        for (const n of nodes || []) {
          if (n.isFolder) {
            if (!top) folders.push({ id: n.id, title: n.title });
            walk(n.childs, top || n.id);
            continue;
          }
          const key = norm(n.title);
          seen[key] = key in seen ? seen[key] + 1 : 0;
          leaves.push({ id: n.id, title: n.title, topId: top, dup: seen[key] });
        }
      };
      walk(tree, null);
      const done = l => learning[l.id] && learning[l.id].isFinish;

      const queue = [];
      const todo = leaves.filter(l => !done(l) && !cfg.skipFolders.includes(l.topId));
      for (let i = 0; i < todo.length; i++) {
        const l = todo[i];
        S.phase = `Đang đọc thông tin mục ${i + 1}/${todo.length}…`; render();
        const d = await detail(l.id);
        l.kind = kindOf(d);
        l.mincore = Number(d.mincore) || 0;
        l.required = !!d.isRequired;
        l.learnTime = (learning[l.id] && learning[l.id].learnTime) || 0;
        if (l.kind === 'test' || !cfg.kinds[l.kind] || (cfg.onlyRequired && !l.required)) continue;
        Object.assign(l, { status: 'pending', retries: 0, needMs: needMs(l) });
        queue.push(l);
      }

      // Mục đã xong, an toàn để mở (không phải bài kiểm tra): mở nó để rời mục cuối, giúp server lưu thời gian.
      S.parking = null;
      for (const l of leaves.filter(done)) {
        const k = kindOf(await detail(l.id));
        if (k === 'text' || k === 'pdf') { S.parking = l; break; }
      }

      S.course = { classId, folders, total: leaves.length, done: leaves.filter(done).length };
      S.queue = queue;
      log(`Quét xong: ${queue.length} mục cần học, ${S.course.done}/${leaves.length} mục đã hoàn thành.`);
    } finally {
      S.phase = '';
      render();
    }
  }

  async function expandTree() {
    for (let round = 0; round < 12; round++) {
      const closed = [...document.querySelectorAll('.__lesson-name-child i.fa-chevron-down')].filter(i => i.offsetParent);
      if (!closed.length) return;
      closed.forEach(i => i.click());
      await sleep(700);
    }
  }

  async function openItem(item) {
    const want = norm(item.title);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expandTree();
      const anchors = [...document.querySelectorAll('.__lesson-name > a')].filter(a => a.offsetParent);
      let hits = anchors.filter(a => norm(a.textContent) === want);
      if (!hits.length) hits = anchors.filter(a => norm(a.textContent).startsWith(want));
      const a = hits[Math.min(item.dup || 0, hits.length - 1)];
      if (a) {
        a.scrollIntoView({ block: 'center' });
        a.click();
        for (let t = 0; t < 30; t++) {
          await sleep(500);
          const view = document.querySelector('app-class-content-view');
          if (view && norm(view.innerText).includes(want.slice(0, 40))) return true;
        }
      }
      await sleep(2000);
    }
    return false;
  }

  async function hold(item) {
    S.endsAt = Date.now() + item.needMs;
    while (Date.now() < S.endsAt) {
      if (!S.active) return false;
      render();
      await sleep(1000);
    }
    return true;
  }

  async function verify(item) {
    const l = (await loadLearning(S.course.classId))[item.id];
    item.learnTime = (l && l.learnTime) || 0;
    if (l && l.isFinish) {
      item.status = 'done';
      S.course.done++;
      log('✓ Hoàn thành: ' + item.title);
    } else if (item.retries < 2) {
      item.retries++;
      item.needMs = Math.max(60000, needMs(item));
      item.status = 'pending';
      log(`Chưa đạt (${item.learnTime.toFixed(1)}/${item.mincore || '?'} phút), học thêm: ${item.title}`);
    } else {
      item.status = 'fail';
      log('✗ Không đạt sau 3 lần, bỏ qua: ' + item.title);
    }
  }

  // Thầy cô dặn học xong mỗi bài phải mở tab "Tiến trình học tập". Thử nghiệm: server đã lưu hoàn thành
  // ngay khi rời mục, còn tab này tải lại tiến trình để cây mục lục hiện dấu ✓. Vẫn làm cho chắc.
  // Chỉ bấm tab của bố cục rộng: ở bố cục hẹp (< 992px) tab là link "#tab1"/"#tab2", bấm vào sẽ về trang chủ.
  async function visitProgressTab() {
    const tab = re => [...document.querySelectorAll('a.nav-link')].find(e =>
      e.offsetParent && re.test(e.innerText.trim()) && !(e.getAttribute('href') || '').startsWith('#'));
    const progress = tab(/^tiến trình học tập$/i);
    const content = tab(/^nội dung$/i);
    if (!progress || !content) return;
    progress.click();
    await sleep(4000);
    content.click();
    await sleep(2500);
    log('Đã mở tab "Tiến trình học tập" để cập nhật.');
  }

  const saveRun = active => writeJSON(LS_RUN, active ? { active: true, classId: S.course && S.course.classId, url: location.href } : {});

  async function runLoop() {
    if (S.active) return;
    S.active = true;
    render();
    try {
      while (S.phase) await sleep(500); // chờ lần quét đang chạy
      if (!S.course || S.course.classId !== classIdFromUrl()) await scan();
      saveRun(true);
      log('Bắt đầu tự học.');
      let toCheck = null;
      while (S.active) {
        if (classIdFromUrl() !== S.course.classId) {
          // Bị đẩy khỏi lớp (ví dụ lỡ hộp thoại kiểm tra): quay lại, sau khi tải lại trang sẽ tự chạy tiếp
          log('Bị chuyển khỏi trang lớp, đang quay lại…');
          location.href = readJSON(LS_RUN, {}).url;
          return;
        }
        if (window.innerWidth < 992) {
          // Bố cục hẹp ẩn cây mục lục: chờ cửa sổ được mở rộng rồi chạy tiếp
          if (!S.narrow) log('Cửa sổ hẹp quá, tạm chờ đến khi mở rộng (≥ 992px)…');
          S.narrow = true;
          await sleep(5000);
          continue;
        }
        S.narrow = false;
        const item = S.queue.find(q => q.status === 'pending');
        const target = item || (toCheck && S.parking);
        if (!target) break;
        S.current = target;
        S.endsAt = 0;
        log((item ? 'Mở: ' : 'Mở mục đã xong để lưu thời gian mục cuối: ') + target.title);
        const ok = await openItem(target);
        if (toCheck) {
          await sleep(4000);
          await verify(toCheck);
          toCheck = null;
          if (cfg.refreshProgress) await visitProgressTab();
        }
        if (!item) continue;
        if (!ok) { item.status = 'error'; log('Không tìm thấy/mở được mục: ' + item.title); continue; }
        item.status = 'holding';
        if (!(await hold(item))) { item.status = 'pending'; break; }
        item.status = 'checking';
        toCheck = item;
      }
      if (toCheck) log('Rời khỏi mục hiện tại (mở mục khác) để server lưu thời gian của: ' + toCheck.title);
      if (S.active) log('Đã chạy hết danh sách 🎉');
    } catch (e) {
      log('Lỗi: ' + e.message);
    }
    S.active = false;
    S.current = null;
    saveRun(false);
    render();
  }

  function stop() {
    S.active = false;
    saveRun(false);
    log('Đã dừng.');
  }

  // ---------- 3. Trợ lý trắc nghiệm (AI) ----------
  // Trang làm bài: mỗi câu là .question-item, đề bài ở .question-title, đáp án là radio/checkbox trong
  // .question-content label. Gợi ý được lưu theo nội dung câu hỏi (LS_AI) để lần sau gặp lại không phải hỏi AI.
  // Chỉ gợi ý và điền khi bạn bấm; không bao giờ tự nộp bài.
  const LS_AI = 'vnuTreoAi';
  const Q = { busy: false, status: '' };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  function readQuiz() {
    const out = [];
    for (const item of document.querySelectorAll('.question-item')) {
      const inputs = [...item.querySelectorAll('.question-content input[type=radio], .question-content input[type=checkbox]')];
      if (!inputs.length || !item.offsetParent) continue;
      const title = clean(item.querySelector('.question-title') && item.querySelector('.question-title').innerText);
      const answers = inputs.map(i => clean(i.closest('label') && i.closest('label').innerText));
      const num = item.querySelector('.question-num');
      const n = ((num && num.textContent.match(/\d+/)) || [String(out.length + 1)])[0];
      out.push({ item, inputs, n, title, answers, multi: inputs.some(i => i.type === 'checkbox'),
        key: norm(title) + '||' + answers.map(norm).sort().join('|') });
    }
    return out;
  }

  let aiSeq = 0;
  const aiWait = {};
  const askAI = questions => new Promise(resolve => {
    const id = ++aiSeq;
    aiWait[id] = resolve;
    window.postMessage({ vnuTreo: 'ai-suggest', id, questions }, location.origin);
    setTimeout(() => {
      if (!aiWait[id]) return;
      delete aiWait[id];
      resolve({ ok: false, error: 'Không nhận được phản hồi. Hãy chắc chắn đã nạp extension (bản Tampermonkey không có AI).' });
    }, 180000);
  });

  function quizStatus(msg) { Q.status = msg; render(); }

  function annotate(q, s) {
    q.inputs.forEach((inp, i) => {
      const label = inp.closest('label');
      const hit = s.picks.includes(q.answers[i]);
      label.style.outline = hit ? '2px solid #1f6feb' : '';
      label.style.borderRadius = hit ? '4px' : '';
    });
    let note = q.item.querySelector('.vnu-ai-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'vnu-ai-note';
      note.style.cssText = 'clear:both;margin:8px 16px 0;padding:6px 10px;border-left:3px solid #1f6feb;' +
        'background:#f0f6ff;color:#1f2328;font-size:13px;';
      q.item.querySelector('.question-content').after(note);
    }
    const letters = s.picks.map(p => String.fromCharCode(65 + q.answers.indexOf(p))).join(', ');
    note.textContent = `🤖 Gợi ý: ${letters || '?'} (độ tin cậy ${s.confidence}) — ${s.why}`;
  }

  async function suggestQuiz() {
    const qs = readQuiz();
    if (!qs.length) return quizStatus('Không thấy câu hỏi trắc nghiệm trên trang.');
    const bank = readJSON(LS_AI, {});
    const todo = qs.filter(q => !bank[q.key]);
    Q.busy = true;
    quizStatus(todo.length ? `Đang hỏi Claude ${todo.length} câu…` : 'Dùng gợi ý đã lưu…');
    try {
      if (todo.length) {
        const res = await askAI(todo.map(q => ({ n: q.n, question: q.title, answers: q.answers, multi: q.multi })));
        if (!res.ok) throw new Error(res.error);
        for (const a of res.answers) {
          const q = todo.find(x => x.n === String(a.n));
          if (!q) continue;
          bank[q.key] = { picks: a.choices.filter(i => q.answers[i] != null).map(i => q.answers[i]), why: a.why, confidence: a.confidence };
        }
        writeJSON(LS_AI, bank);
      }
      let shown = 0;
      for (const q of qs) if (bank[q.key]) { annotate(q, bank[q.key]); shown++; }
      Q.busy = false;
      quizStatus(`Đã gợi ý ${shown}/${qs.length} câu. Xem lại, rồi bấm "Điền gợi ý" hoặc tự chọn.`);
    } catch (e) {
      Q.busy = false;
      quizStatus('Lỗi: ' + e.message);
    }
  }

  function fillQuiz() {
    const bank = readJSON(LS_AI, {});
    let n = 0;
    for (const q of readQuiz()) {
      const s = bank[q.key];
      if (!s) continue;
      q.inputs.forEach((inp, i) => {
        const want = s.picks.includes(q.answers[i]);
        // click() để trang ghi nhận đáp án như khi bạn tự bấm
        if (want !== inp.checked && (want || inp.type === 'checkbox')) inp.click();
      });
      n++;
    }
    quizStatus(n ? `Đã điền ${n} câu. Kiểm tra lại rồi tự bấm "Nộp bài".` : 'Chưa có gợi ý nào, bấm "Gợi ý đáp án" trước.');
  }

  // ---------- 4. Bảng điều khiển ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, "Segoe UI", Roboto, sans-serif; }
    .fab { border: 0; border-radius: 20px; padding: 8px 14px; font-size: 13px; font-weight: 600; color: #fff;
      background: #1f6feb; box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; }
    .fab.run { background: #1a7f37; }
    .panel { position: absolute; left: 0; bottom: 44px; width: 360px; max-height: 75vh; overflow: auto;
      background: #fff; color: #1f2328; border: 1px solid #d0d7de; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.25); font-size: 13px; }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
      border-bottom: 1px solid #d0d7de; position: sticky; top: 0; background: #fff; }
    header b { font-size: 14px; }
    .x { border: 0; background: none; font-size: 20px; line-height: 1; cursor: pointer; color: #57606a; }
    .status { padding: 10px 12px; display: grid; gap: 4px; }
    .status .cur { font-weight: 600; }
    .status .time { font-size: 22px; font-variant-numeric: tabular-nums; }
    .muted { color: #57606a; font-size: 12px; }
    .warn { color: #9a6700; background: #fff8c5; border-radius: 6px; padding: 6px 8px; font-size: 12px; }
    .bar { height: 6px; background: #eaeef2; border-radius: 3px; overflow: hidden; }
    .bar i { display: block; height: 100%; background: #1a7f37; }
    .row { display: flex; gap: 8px; padding: 0 12px 10px; }
    .row button { flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa;
      cursor: pointer; font-size: 13px; }
    .row button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
    .row button.primary.stop { background: #cf222e; border-color: #cf222e; }
    .row button:disabled { opacity: .5; cursor: default; }
    .row button.mute { flex: 0 0 auto; white-space: nowrap; }
    .row button.mute.on { background: #fff8c5; border-color: #d4a72c; }
    details { border-top: 1px solid #d0d7de; padding: 8px 12px; }
    summary { cursor: pointer; font-weight: 600; }
    label { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0; }
    label.num { align-items: center; }
    input[type=number] { width: 56px; padding: 2px 4px; }
    ol { margin: 6px 0 0; padding-left: 20px; max-height: 260px; overflow: auto; }
    li { margin: 3px 0; }
    li small { color: #57606a; }
    li.holding { font-weight: 600; color: #1f6feb; }
    li.done { color: #1a7f37; }
    li.fail, li.error { color: #cf222e; }
    pre { white-space: pre-wrap; font-size: 11px; margin: 6px 0 0; max-height: 160px; overflow: auto; }
    hr { border: 0; border-top: 1px solid #eaeef2; }
    .qrow { display: flex; gap: 6px; margin: 8px 0; }
    .qrow button { flex: 1; padding: 6px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa;
      cursor: pointer; font-size: 12px; white-space: nowrap; }
    .qrow button.qsuggest { background: #8250df; border-color: #8250df; color: #fff; font-weight: 600; }
    .qrow button:disabled { opacity: .5; cursor: default; }
    .qstatus { font-size: 12px; }
  `;
  const ICON = { pending: '○', holding: '▶', checking: '…', done: '✓', fail: '✗', error: '⚠' };

  let ui = null;
  function buildUI() {
    if (ui || !document.body) return;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const box = (k, text) => `<label><input type="checkbox" data-k="${k}"><span>${text}</span></label>`;
    root.innerHTML = `<style>${CSS}</style>
      <button class="fab"></button>
      <div class="panel" hidden>
        <header><b>Treo học VNU</b><button class="x" title="Thu gọn">×</button></header>
        <section class="status"></section>
        <div class="row"><button class="primary go"></button><button class="scan">↻ Quét lại</button><button class="mute"></button></div>
        <details class="quiz" open><summary>Trợ lý trắc nghiệm (AI)</summary>
          <div class="qstatus"></div>
          <div class="qrow"><button class="qsuggest">🤖 Gợi ý đáp án</button><button class="qfill">✍ Điền gợi ý</button><button class="qkey">⚙ Khoá API</button></div>
          <div class="muted">Không tự nộp bài. Gợi ý được lưu lại: lần sau gặp câu giống hệt sẽ dùng luôn, không tốn tiền API.</div>
        </details>
        <details class="cfg"><summary>Cài đặt</summary>
          <div class="muted">Loại mục cần học:</div>
          ${box('kinds.video', 'Video')}${box('kinds.pdf', 'PDF / tài liệu (treo theo thời gian bên dưới)')}
          ${box('kinds.text', 'Bài đọc (văn bản)')}${box('kinds.other', 'Loại khác (thảo luận, bài tập…)')}
          ${box('onlyRequired', 'Chỉ học mục bắt buộc (*)')}
          <label class="num">Treo thêm sau khi đủ giờ <input type="number" min="0" max="30" step="0.5" data-k="extraMin"> phút</label>
          <label class="num">Mục không yêu cầu thời gian treo <input type="number" min="0.5" max="60" step="0.5" data-k="noReqMin"> phút</label>
          <hr>
          ${box('refreshProgress', 'Mở tab "Tiến trình học tập" sau mỗi mục để cập nhật')}
          ${box('keepAlive', 'Tự xác nhận "Bạn có đang học tập không ?" và chống dừng khi đổi tab')}
          ${box('resumeVideo', 'Tự phát lại video khi bị dừng')}
          ${box('loopVideo', 'Video ngắn hơn thời gian yêu cầu thì phát lại từ đầu')}
          ${box('muteVideo', 'Tắt tiếng video')}
          <div class="muted">Đổi loại mục hoặc chọn bài xong, bấm "Quét lại".</div>
        </details>
        <details class="fold"><summary>Chọn bài học</summary><div class="flist muted">Bấm "Quét lại" để tải danh sách bài.</div></details>
        <details open><summary>Danh sách cần học <span class="qcount muted"></span></summary><ol class="queue"></ol></details>
        <details><summary>Nhật ký</summary><pre class="logs"></pre></details>
      </div>`;
    document.body.appendChild(host);

    const $ = s => root.querySelector(s);
    ui = { root, $, fab: $('.fab'), panel: $('.panel'), queueSig: '', foldSig: '' };

    const togglePanel = open => {
      ui.panel.hidden = !(open === undefined ? ui.panel.hidden : open);
      writeJSON(LS_PANEL, !ui.panel.hidden);
      if (!ui.panel.hidden && !S.course && !S.active && !S.phase && classIdFromUrl()) scan().catch(e => log('Lỗi: ' + e.message));
      render();
    };
    ui.toggle = togglePanel;
    ui.fab.addEventListener('click', () => togglePanel());
    $('.x').addEventListener('click', () => togglePanel(false));
    $('.go').addEventListener('click', () => (S.active ? stop() : runLoop()));
    $('.scan').addEventListener('click', () => scan().catch(e => log('Lỗi: ' + e.message)));
    $('.mute').addEventListener('click', () => {
      cfg.muteVideo = !cfg.muteVideo;
      saveCfg();
      applyMute();
      root.querySelector('[data-k="muteVideo"]').checked = cfg.muteVideo;
      render();
    });
    $('.qsuggest').addEventListener('click', () => suggestQuiz());
    $('.qfill').addEventListener('click', () => fillQuiz());
    $('.qkey').addEventListener('click', () => window.postMessage({ vnuTreo: 'open-options' }, location.origin));

    const getK = k => k.split('.').reduce((o, p) => o[p], cfg);
    const setK = (k, v) => { const p = k.split('.'); const last = p.pop(); p.reduce((o, q) => o[q], cfg)[last] = v; };
    for (const input of root.querySelectorAll('[data-k]')) {
      const k = input.dataset.k;
      if (input.type === 'checkbox') input.checked = !!getK(k); else input.value = getK(k);
      input.addEventListener('change', () => {
        setK(k, input.type === 'checkbox' ? input.checked : Math.max(0, Number(input.value) || 0));
        saveCfg();
        if (k === 'extraMin' || k === 'noReqMin') for (const q of S.queue) if (q.status === 'pending') q.needMs = needMs(q);
        if (k === 'muteVideo') applyMute();
        render();
      });
    }
    $('.flist').addEventListener('change', e => {
      const id = e.target.dataset.folder;
      if (!id) return;
      cfg.skipFolders = cfg.skipFolders.filter(x => x !== id);
      if (!e.target.checked) cfg.skipFolders.push(id);
      saveCfg();
    });

    if (readJSON(LS_PANEL, false)) togglePanel(true);
    render();
  }

  function render() {
    if (!ui) return;
    const { $ } = ui;
    const remaining = S.active && S.endsAt ? S.endsAt - Date.now() : 0;
    ui.fab.textContent = (cfg.muteVideo ? '🔇 ' : '') +
      (S.active ? `Treo ▶ ${remaining > 0 ? fmt(remaining) : '…'}` : 'Treo học');
    ui.fab.classList.toggle('run', S.active);
    if (ui.panel.hidden) return;

    const go = $('.go');
    go.textContent = S.active ? '■ Dừng' : '▶ Bắt đầu tự học';
    go.classList.toggle('stop', S.active);
    $('.scan').disabled = S.active || !!S.phase;
    const mute = $('.mute');
    mute.textContent = cfg.muteVideo ? '🔇 Đã tắt tiếng' : '🔊 Tắt tiếng';
    mute.title = cfg.muteVideo ? 'Bấm để bật lại tiếng video' : 'Bấm để tắt tiếng video';
    mute.classList.toggle('on', cfg.muteVideo);

    const c = S.course;
    const warn = [];
    if (!classIdFromUrl()) warn.push('Hãy mở trang chi tiết một lớp học.');
    if (window.innerWidth < 992) warn.push('Cửa sổ hẹp: hãy mở rộng (≥ 992px) để trang hiện cây mục lục bên trái.');
    const cur = S.current;
    $('.status').innerHTML = `
      ${warn.map(w => `<div class="warn">${esc(w)}</div>`).join('')}
      <div class="muted">${S.active ? '● Đang chạy' : 'Đã dừng'}${S.phase ? ' · ' + esc(S.phase) : ''}</div>
      ${cur ? `<div class="cur">${esc(cur.title)}</div>
        <div class="muted">${esc(KIND_LABEL[cur.kind] || '')}${cur.mincore ? ` · yêu cầu ${cur.mincore} phút, đã có ${(cur.learnTime || 0).toFixed(1)}` : ''}</div>
        ${remaining > 0 ? `<div class="time">còn ${fmt(remaining)}</div>` : ''}` : ''}
      ${c ? `<div class="muted">Lớp: ${c.done}/${c.total} mục hoàn thành</div>
        <div class="bar"><i style="width:${c.total ? (100 * c.done / c.total).toFixed(1) : 0}%"></i></div>` : ''}`;

    const sig = S.queue.map(q => q.id + q.status + q.needMs).join();
    if (sig !== ui.queueSig) {
      ui.queueSig = sig;
      const left = S.queue.filter(q => q.status === 'pending' || q.status === 'holding' || q.status === 'checking');
      const totalMs = left.reduce((s, q) => s + q.needMs, 0);
      $('.qcount').textContent = S.queue.length ? `(${left.length} mục, ~${Math.ceil(totalMs / 60000)} phút)` : '';
      $('.queue').innerHTML = S.queue.length
        ? S.queue.map(q => `<li class="${q.status}">${ICON[q.status] || ''} ${esc(q.title)}
            <small>· ${esc(KIND_LABEL[q.kind])} · ${Math.ceil(q.needMs / 60000)} phút</small></li>`).join('')
        : '<div class="muted">Chưa có. Bấm "Quét lại" hoặc "Bắt đầu tự học".</div>';
    }
    const fsig = c ? c.folders.map(f => f.id).join() + cfg.skipFolders.join() : '';
    if (c && fsig !== ui.foldSig) {
      ui.foldSig = fsig;
      $('.flist').innerHTML = c.folders.map(f => `<label><input type="checkbox" data-folder="${f.id}"
        ${cfg.skipFolders.includes(f.id) ? '' : 'checked'}><span>${esc(f.title)}</span></label>`).join('');
    }
    $('.logs').textContent = S.logs.join('\n');

    const nq = readQuiz().length;
    if (!nq && !Q.busy) Q.status = '';
    $('.qstatus').textContent = Q.status || (nq ? `Trang có ${nq} câu hỏi.` : 'Mở một bài trắc nghiệm (bấm "LÀM BÀI") để dùng.');
    $('.qsuggest').disabled = Q.busy || !nq;
    $('.qfill').disabled = Q.busy || !nq;
  }

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    // Bấm biểu tượng extension trên thanh công cụ -> bridge.js gửi tin này
    if (e.data.vnuTreo === 'toggle-panel') { buildUI(); if (ui) ui.toggle(); }
    // Kết quả gợi ý từ background (qua bridge.js)
    if (e.data.vnuTreo === 'ai-result' && aiWait[e.data.id]) {
      const done = aiWait[e.data.id];
      delete aiWait[e.data.id];
      done(e.data);
    }
  });

  // ---------- 5. Khởi động ----------
  async function resumeIfNeeded() {
    const run = readJSON(LS_RUN, {});
    if (!run.active) return;
    if (classIdFromUrl() && classIdFromUrl() === run.classId) {
      for (let i = 0; i < 60 && !document.querySelector('.__lesson-name'); i++) await sleep(1000);
      log('Tiếp tục tự học sau khi tải lại trang.');
      runLoop();
    } else if (run.url) {
      log('Đang quay lại lớp học để tiếp tục…');
      await sleep(5000);
      if (readJSON(LS_RUN, {}).active) location.href = run.url;
    }
  }

  const start = () => { buildUI(); resumeIfNeeded(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  timer.every(3000, () => { buildUI(); tickVideo(); answerLmsAlert(); if (ui && !ui.panel.hidden && !S.active) render(); });
  timer.every(20000, () => cfg.keepAlive && pokeActivity());
  timer.every(1000, () => S.active && render());
})();
