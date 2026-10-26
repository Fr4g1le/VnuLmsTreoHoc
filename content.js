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

  // Tắt tiếng bằng âm lượng 0 thay vì muted: trình duyệt có thể tự dừng video bị muted khi tab nằm nền,
  // mà LMS chỉ tính giờ cho video khi video thật sự đang chạy.
  function applyMute() {
    for (const m of document.querySelectorAll('video, audio')) {
      m.volume = cfg.muteVideo ? 0 : 1;
      if (!cfg.muteVideo) m.muted = false;
    }
  }
  function tickVideo() {
    for (const m of document.querySelectorAll('video, audio')) if (cfg.muteVideo && m.volume !== 0) m.volume = 0;
    for (const v of document.querySelectorAll('video')) {
      // Hết video thì thôi: xem lại đoạn cũ không được LMS tính thêm giờ
      if (!v.ended && cfg.resumeVideo && v.paused && v.readyState > 0) playVideo(v);
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
  const dayMonth = t => { const d = new Date(t); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const lockReason = l => (l.opensAt > Date.now() ? `mở từ ${dayMonth(l.opensAt)}`
    : l.closesAt && l.closesAt < Date.now() ? `đã hết hạn ${dayMonth(l.closesAt)}` : '');
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
        // Mục chưa tới ngày mở (hoặc đã hết hạn) thì LMS không cho xem: liệt kê với 🔒 nhưng không chạy
        l.opensAt = d.startDate ? new Date(d.startDate).getTime() : 0;
        l.closesAt = d.endDate ? new Date(d.endDate).getTime() : 0;
        Object.assign(l, { status: lockReason(l) ? 'locked' : 'pending', retries: 0, needMs: needMs(l) });
        queue.push(l);
      }
      const locked = queue.filter(q => q.status === 'locked');
      if (locked.length) {
        const next = Math.min(...locked.map(q => q.opensAt).filter(t => t > Date.now()));
        log(`Bỏ qua ${locked.length} mục chưa mở hoặc đã hết hạn` + (isFinite(next) ? ` (mục sớm nhất mở lúc ${new Date(next).toLocaleString('vi-VN')}).` : '.'));
      }

      // Mục đã xong, an toàn để mở (không phải bài kiểm tra): mở nó để rời mục cuối, giúp server lưu thời gian.
      S.parking = null;
      for (const l of leaves.filter(done)) {
        const k = kindOf(await detail(l.id));
        if (k === 'text' || k === 'pdf') { S.parking = l; break; }
      }

      S.course = { classId, folders, total: leaves.length, done: leaves.filter(done).length };
      S.queue = queue;
      log(`Quét xong: ${queue.filter(q => q.status === 'pending').length} mục cần học, ${S.course.done}/${leaves.length} mục đã hoàn thành.`);
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

  // Tab của bố cục rộng ("Nội dung", "Tiến trình học tập"…). Bố cục hẹp dùng link "#tab1" – bấm vào sẽ về trang chủ.
  const wideTab = re => [...document.querySelectorAll('a.nav-link')].find(e =>
    e.offsetParent && re.test(e.innerText.trim()) && !(e.getAttribute('href') || '').startsWith('#'));

  // Cây mục lục chỉ hiện ở tab "Nội dung": đang ở tab khác (ví dụ Tiến trình học tập) thì chuyển về trước.
  async function showContentTab() {
    if (document.querySelector('.__lesson-name > a, .__lesson-name-child') &&
        [...document.querySelectorAll('.__lesson-name > a, .__lesson-name-child')].some(e => e.offsetParent)) return;
    const tab = wideTab(/^nội dung$/i);
    if (!tab) return;
    tab.click();
    await sleep(2500);
  }

  async function openItem(item) {
    const want = norm(item.title);
    for (let attempt = 0; attempt < 3; attempt++) {
      await showContentTab();
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

  const hold = item => (item.kind === 'video' ? holdVideo(item) : holdClock(item));

  // PDF, bài đọc…: LMS tính theo thời gian mở mục, nên chỉ cần chờ đủ giờ.
  async function holdClock(item) {
    S.endsAt = Date.now() + item.needMs;
    while (Date.now() < S.endsAt) {
      if (!S.active) return false;
      render();
      await sleep(1000);
    }
    return true;
  }

  // Video: LMS chỉ cộng giờ khi video phát tới đoạn CHƯA XEM (thử thực tế: phát lại đoạn cũ 2 phút chỉ được
  // tính 0,4 phút; phát đoạn mới 2 phút được tính 2,1 phút). Nên giữ đến khi phần mới xem đủ số phút còn thiếu;
  // video đứng lại thì chờ chứ không rời mục. Mở lại thì tua tới chỗ đã xem xa nhất (không bao giờ tua quá đó).
  const LS_VIDEO = 'vnuTreoVideoMax';
  const contentVideo = () => document.querySelector('app-class-content-view video');

  async function holdVideo(item) {
    let v = null;
    for (let i = 0; i < 30 && !(v = contentVideo()); i++) await sleep(500);
    if (!v) return holdClock(item);
    for (let i = 0; i < 30 && !(v.readyState > 0); i++) await sleep(500);
    const maxes = readJSON(LS_VIDEO, {});
    const known = maxes[item.id] || 0;
    if (known > v.currentTime + 5 && (!v.duration || known < v.duration - 5)) {
      v.currentTime = known;
      log(`Tua tới ${fmt(known * 1000)}: đoạn trước đã xem rồi, xem lại không được tính.`);
    }
    const needSec = item.needMs / 1000;
    let maxPos = Math.max(known, v.currentTime), last = v.currentTime, gained = 0;
    let lastMove = Date.now(), stallLogged = false, lastSave = 0;
    while (gained < needSec) {
      if (!S.active) return false;
      await sleep(1000);
      v = contentVideo() || v;
      const pos = v.currentTime;
      if (pos > maxPos) {
        // Chỉ cộng khi phát liên tục (bước nhỏ); nhảy cóc thì không tính, giống LMS
        if (pos - last < 15) gained += pos - Math.max(last, maxPos);
        maxPos = pos;
      }
      if (pos !== last) { lastMove = Date.now(); stallLogged = false; }
      last = pos;
      if (Date.now() - lastSave > 10000) { maxes[item.id] = maxPos; writeJSON(LS_VIDEO, maxes); lastSave = Date.now(); }
      S.endsAt = Date.now() + Math.max(0, needSec - gained) * 1000;
      render();
      if (v.ended || (v.duration && pos >= v.duration - 1)) {
        if (gained < needSec) log('Video đã hết mà có thể chưa đủ giờ; sẽ kiểm tra với server.');
        break;
      }
      if (Date.now() - lastMove > 60000 && !stallLogged) {
        stallLogged = true;
        log('Video đứng yên hơn 1 phút (bị dừng?), đang chờ phát lại – chưa rời mục.');
        playVideo(v);
      }
    }
    maxes[item.id] = maxPos;
    writeJSON(LS_VIDEO, maxes);
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
  async function visitProgressTab() {
    const progress = wideTab(/^tiến trình học tập$/i);
    const content = wideTab(/^nội dung$/i);
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
        // Chạy qua đêm: mục vừa tới ngày mở thì đưa vào, mục vừa hết hạn thì khoá lại
        for (const q of S.queue) {
          if (q.status === 'locked' && !lockReason(q)) q.status = 'pending';
          else if (q.status === 'pending' && lockReason(q)) q.status = 'locked';
        }
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

  // Bài điền chỗ trống (thường là bài nghe): một khung đề (có thể kèm audio) rồi tới các câu 1.1, 1.2... mỗi câu một ô chữ.
  // Câu ô chữ thuộc khung đề gần nhất phía trên nó.
  function readFill() {
    const groups = [];
    let ctx = null;
    for (const item of document.querySelectorAll('.question-item')) {
      const input = item.querySelector('.question-title input[type=text], .question-title textarea');
      const title = item.querySelector('.question-title');
      if (!input) {
        if (title && clean(title.innerText)) ctx = { item, text: title.innerText.trim(), audio: item.querySelector('audio'), blanks: [] };
        continue;
      }
      if (!item.offsetParent) continue;
      if (!ctx) ctx = { item: null, text: '', audio: null, blanks: [] };
      if (!groups.includes(ctx)) groups.push(ctx);
      const num = item.querySelector('.question-num');
      const n = ((num && num.innerText.match(/\d+\s*\.\s*\d+/)) || [String(ctx.blanks.length + 1)])[0].replace(/\s+/g, '');
      ctx.blanks.push({ item, input, n, label: clean(title.innerText), key: norm(ctx.text) + '||' + n });
    }
    return groups;
  }
  const countBlanks = groups => groups.reduce((s, g) => s + g.blanks.length, 0);
  const wantsCaps = text => /IN HOA|CAPITAL/i.test(text);

  async function audioPayload(audio) {
    const src = audio && (audio.currentSrc || audio.src || (audio.querySelector('source') || {}).src);
    if (!src) return null;
    const blob = await (await fetch(src, { credentials: 'include' })).blob();
    if (blob.size > 18 * 1024 * 1024) throw new Error('File audio quá lớn (trên 18 MB), không gửi cho AI được.');
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(new Error('Không đọc được file audio.'));
      r.readAsDataURL(blob);
    });
    return { mime: blob.type && blob.type.startsWith('audio/') ? blob.type : 'audio/mpeg', data };
  }

  let aiSeq = 0;
  const aiWait = {};
  const askAI = (questions, task) => new Promise(resolve => {
    const id = ++aiSeq;
    aiWait[id] = resolve;
    window.postMessage(task ? { vnuTreo: 'ai-fill', id, task } : { vnuTreo: 'ai-suggest', id, questions }, location.origin);
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
      label.style.outline = hit ? '2px solid #5b46b0' : '';
      label.style.borderRadius = hit ? '4px' : '';
    });
    let note = q.item.querySelector('.vnu-ai-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'vnu-ai-note';
      note.style.cssText = 'clear:both;margin:8px 16px 0;padding:6px 10px;border-left:3px solid #5b46b0;border-radius:0 6px 6px 0;' +
        'background:#eeebfa;color:#1a2233;font-size:13px;';
      q.item.querySelector('.question-content').after(note);
    }
    const letters = s.picks.map(p => String.fromCharCode(65 + q.answers.indexOf(p))).join(', ');
    note.textContent = `🤖 Gợi ý: ${letters || '?'} (độ tin cậy ${s.confidence}) — ${s.why}`;
  }

  function annotateBlank(b, s) {
    let note = b.item.querySelector('.vnu-ai-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'vnu-ai-note';
      note.style.cssText = 'margin:8px 0 0;padding:6px 10px;border-left:3px solid #5b46b0;border-radius:0 6px 6px 0;' +
        'background:#eeebfa;color:#1a2233;font-size:13px;';
      b.input.closest('p, div').after(note);
    }
    note.textContent = `🤖 Gợi ý: ${s.text || '?'} (độ tin cậy ${s.confidence}) — ${s.why}`;
  }

  async function suggestFill(groups) {
    const bank = readJSON(LS_AI, {});
    const total = countBlanks(groups);
    Q.busy = true;
    let usedModel = '';
    try {
      for (const g of groups) {
        const todo = g.blanks.filter(b => !bank[b.key]);
        if (!todo.length) continue;
        quizStatus(g.audio ? 'Đang tải file audio của bài nghe…' : `Đang hỏi AI ${todo.length} ô…`);
        const audio = await audioPayload(g.audio);
        if (audio) quizStatus(`AI đang nghe audio và điền ${todo.length} ô (có thể mất 30-60 giây)…`);
        const res = await askAI(null, {
          context: g.text, caps: wantsCaps(g.text), audio,
          blanks: todo.map(b => ({ n: b.n, label: b.label })),
        });
        if (!res.ok) throw new Error(res.error);
        usedModel = res.model ? ` (dùng ${res.model})` : '';
        for (const a of res.answers) {
          const b = todo.find(x => x.n === String(a.n));
          const text = String(a.text || '').trim();
          if (b) bank[b.key] = { text: wantsCaps(g.text) ? text.toUpperCase() : text, why: a.why, confidence: a.confidence };
        }
        writeJSON(LS_AI, bank);
      }
      let shown = 0;
      for (const g of groups) for (const b of g.blanks) if (bank[b.key]) { annotateBlank(b, bank[b.key]); shown++; }
      Q.busy = false;
      quizStatus(`Đã gợi ý ${shown}/${total} ô${usedModel}. Xem lại, rồi bấm "Điền gợi ý" hoặc tự gõ.`);
    } catch (e) {
      Q.busy = false;
      quizStatus('Lỗi: ' + e.message);
    }
  }

  async function suggestQuiz() {
    const qs = readQuiz();
    const groups = readFill();
    if (!qs.length && countBlanks(groups)) return suggestFill(groups);
    if (!qs.length) return quizStatus('Không thấy câu hỏi trắc nghiệm trên trang.');
    const bank = readJSON(LS_AI, {});
    const todo = qs.filter(q => !bank[q.key]);
    Q.busy = true;
    quizStatus(todo.length ? `Đang hỏi AI ${todo.length} câu (model bận thì tự thử lại / đổi model)…` : 'Dùng gợi ý đã lưu…');
    let usedModel = '';
    try {
      if (todo.length) {
        const res = await askAI(todo.map(q => ({ n: q.n, question: q.title, answers: q.answers, multi: q.multi })));
        if (!res.ok) throw new Error(res.error);
        usedModel = res.model ? ` (dùng ${res.model})` : '';
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
      quizStatus(`Đã gợi ý ${shown}/${qs.length} câu${usedModel}. Xem lại, rồi bấm "Điền gợi ý" hoặc tự chọn.`);
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
    let blanks = 0;
    for (const g of readFill()) for (const b of g.blanks) {
      const s = bank[b.key];
      if (!s) continue;
      b.input.value = s.text;
      // Ô chữ của LMS ghi nhận giá trị trong oninput (bấm một nút ẩn), nên phát sự kiện như khi bạn tự gõ
      b.input.dispatchEvent(new Event('input', { bubbles: true }));
      b.input.dispatchEvent(new Event('change', { bubbles: true }));
      blanks++;
    }
    if (blanks) return quizStatus(`Đã điền ${blanks} ô. Kiểm tra lại, bấm "Lưu câu trả lời" ở từng câu rồi tự bấm "Nộp bài".`);
    quizStatus(n ? `Đã điền ${n} câu. Kiểm tra lại rồi tự bấm "Nộp bài".` : 'Chưa có gợi ý nào, bấm "Gợi ý đáp án" trước.');
  }

  // ---------- 4. Bảng điều khiển ----------
  const CSS = `
    :host { all: initial;
      --ink: #14213d; --navy: #1b3a6b; --blue: #2457a8; --paper: #ffffff; --wash: #f3f5f9; --line: #dfe4ec;
      --text: #1a2233; --sub: #5d6880; --go: #1d7a4e; --go-wash: #e3f3ea; --amber: #a86a12; --amber-wash: #fdf3dc;
      --red: #b8322a; --red-wash: #fbe9e7; --ai: #5b46b0; --ai-wash: #eeebfa; }
    @media (prefers-color-scheme: dark) {
      :host { --ink: #22355c; --navy: #2b4373; --paper: #171c26; --wash: #1f2531; --line: #2e3646; --text: #e4e8f0; --sub: #98a2b6;
        --go-wash: #183126; --amber-wash: #33291a; --red-wash: #3a1e1c; --ai-wash: #262040; --blue: #6f9be6; --ai: #a493ec; --go: #4cc287; }
    }
    * { box-sizing: border-box; font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, sans-serif; }
    button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

    .fab { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 9px 16px 9px 12px;
      font-size: 13px; font-weight: 600; color: #fff; background: var(--ink); cursor: pointer;
      box-shadow: 0 6px 18px rgba(20,33,61,.35); font-variant-numeric: tabular-nums; }
    .fab::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #8fa3c7; }
    .fab:hover { background: var(--navy); }
    .fab.run { background: var(--go); box-shadow: 0 6px 18px rgba(29,122,78,.4); }
    .fab.run::before { background: #b8f5d2; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) { .fab.run::before { animation: none; } }

    .panel { position: absolute; left: 0; bottom: 50px; width: 372px; max-width: calc(100vw - 24px); max-height: 78vh; overflow: auto;
      background: var(--paper); color: var(--text); border-radius: 14px; font-size: 13px; line-height: 1.45;
      box-shadow: 0 18px 48px rgba(10,20,40,.32), 0 0 0 1px rgba(20,33,61,.12); scrollbar-width: thin; }
    .panel[hidden] { display: none; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 12px 16px;
      position: sticky; top: 0; z-index: 2; background: var(--ink); color: #fff; }
    header b { font-size: 15px; font-weight: 700; letter-spacing: .01em; }
    .x { width: 28px; height: 28px; border: 0; border-radius: 8px; background: rgba(255,255,255,.08); color: #c9d4ea;
      font-size: 18px; line-height: 1; cursor: pointer; }
    .x:hover { background: rgba(255,255,255,.18); color: #fff; }

    /* Khối trạng thái: phần nổi bật nhất của bảng */
    .status { padding: 14px 16px 12px; display: grid; gap: 6px; background: var(--ink); color: #fff; }
    .status .muted { color: #a9b6d0; }
    .status .cur { font-weight: 600; font-size: 14px; }
    .status .time { font-size: 40px; font-weight: 300; line-height: 1.05; letter-spacing: -.02em;
      font-variant-numeric: tabular-nums; margin: 2px 0; }
    .status .warn { color: #5c3b06; }
    .muted { color: var(--sub); font-size: 12px; }
    .warn { color: var(--amber); background: var(--amber-wash); border-radius: 8px; padding: 7px 10px; font-size: 12px; }
    .bar { height: 6px; background: rgba(255,255,255,.14); border-radius: 3px; overflow: hidden; margin-top: 2px; }
    .bar i { display: block; height: 100%; background: #5fd49a; border-radius: 3px; transition: width .4s; }
    .status .warn { background: #fde7b0; }

    .row { display: flex; gap: 8px; padding: 12px 16px; background: var(--ink); }
    .row button { flex: 1; padding: 9px 8px; border-radius: 9px; border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.06); color: #dbe3f2; cursor: pointer; font-size: 13px; }
    .row button:hover:not(:disabled) { background: rgba(255,255,255,.14); }
    .row button.primary { flex: 1.6; background: #fff; border-color: #fff; color: var(--ink); font-weight: 700; }
    .row button.primary:hover { background: #e6edf9; }
    .row button.primary.stop { background: #e5544b; border-color: #e5544b; color: #fff; }
    .row button:disabled { opacity: .4; cursor: default; }
    .row button.mute { flex: 0 0 auto; white-space: nowrap; }
    .row button.mute.on { background: #fde7b0; border-color: #fde7b0; color: #5c3b06; }

    details { border-top: 1px solid var(--line); padding: 0 16px; }
    .row + details { border-top: 0; }
    summary { cursor: pointer; font-weight: 600; padding: 11px 0; list-style: none; display: flex; align-items: center; gap: 8px; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: ""; width: 6px; height: 6px; border-right: 1.5px solid var(--sub); border-bottom: 1.5px solid var(--sub);
      transform: rotate(-45deg); transition: transform .15s; flex: none; }
    details[open] > summary::before { transform: rotate(45deg); }
    details[open] { padding-bottom: 12px; }
    summary .muted { font-weight: 400; }
    label { display: flex; gap: 8px; align-items: flex-start; margin: 7px 0; cursor: pointer; }
    label.num { align-items: center; }
    input[type=checkbox] { accent-color: var(--blue); margin: 2px 0 0; width: 15px; height: 15px; flex: none; }
    input[type=number] { width: 60px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px;
      background: var(--paper); color: var(--text); font: inherit; }

    ol { margin: 0; padding: 0; list-style: none; max-height: 260px; overflow: auto; }
    li { margin: 0; padding: 6px 8px; border-radius: 7px; }
    li + li { margin-top: 2px; }
    li small { display: block; color: var(--sub); }
    li.holding { font-weight: 600; color: var(--blue); background: var(--wash); }
    li.done { color: var(--go); }
    li.done small { color: var(--go); opacity: .75; }
    li.fail, li.error { color: var(--red); background: var(--red-wash); }
    li.locked { color: var(--sub); opacity: .7; }
    pre { white-space: pre-wrap; font: 11px/1.5 Consolas, "Cascadia Mono", monospace; margin: 0; max-height: 170px; overflow: auto;
      background: var(--wash); border-radius: 8px; padding: 8px 10px; color: var(--sub); }
    hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }

    details.quiz { background: var(--ai-wash); border-top-color: transparent; }
    details.quiz summary { color: var(--ai); }
    details.quiz summary::before { border-color: var(--ai); }
    .qrow { display: flex; gap: 6px; margin: 8px 0; }
    .qrow button { flex: 1; padding: 8px 6px; border-radius: 8px; border: 1px solid var(--line); background: var(--paper);
      color: var(--text); cursor: pointer; font-size: 12px; white-space: nowrap; }
    .qrow button:hover:not(:disabled) { border-color: var(--ai); }
    .qrow button.qsuggest { background: var(--ai); border-color: var(--ai); color: #fff; font-weight: 600; }
    .qrow button.qkey { flex: 0 0 auto; }
    .qrow button:disabled { opacity: .45; cursor: default; }
    .qstatus { font-size: 12px; }

    .note:empty { display: none; }
    .note { padding: 12px 16px 0; background: var(--ink); }
    .note .tip { background: #24365c; color: #dbe5f7; border-radius: 10px; padding: 10px 12px; font-size: 12px; }
    .note .bad { background: #fbe1de; color: #7d1a14; }
    .update .tip { background: #1d5c41; color: #dcf6e8; }
    .note .links { margin: 6px 0; }
    .note a { color: inherit; font-weight: 700; }
    .note summary { font-size: 12px; padding: 6px 0 0; }
    .note summary::before { border-color: currentColor; }
    .note details { border: 0; padding: 0; }
    .note ol { max-height: none; margin: 6px 0 0; padding-left: 18px; list-style: decimal; }
    .note li { padding: 2px 0; }
    .note code { background: rgba(255,255,255,.14); border-radius: 4px; padding: 0 4px; font-family: Consolas, monospace; }
    .note .bad code { background: rgba(125,26,20,.1); }
    .note button { margin-top: 8px; padding: 5px 12px; border-radius: 7px; border: 0; background: rgba(255,255,255,.9);
      color: var(--ink); cursor: pointer; font-size: 12px; font-weight: 600; }
  `;
  const ICON = { pending: '○', holding: '▶', checking: '…', done: '✓', fail: '✗', error: '⚠', locked: '🔒' };

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
        <section class="note update"></section>
        <section class="note sleep"></section>
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
    $('.update').addEventListener('click', e => {
      if (!e.target.classList.contains('updlater')) return;
      writeJSON(LS_UPD_SKIP, U.latest);
      render();
    });
    $('.sleep').addEventListener('click', e => {
      if (!e.target.classList.contains('sleepok')) return;
      writeJSON(LS_SLEEP_OK, true);
      Z.reason = '';
      render();
    });

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
    ui.fab.textContent = (showUpdate() ? '⬆ ' : '') + (Z.reason ? '💤 ' : '') + (cfg.muteVideo ? '🔇 ' : '') +
      (S.active ? `Treo ▶ ${remaining > 0 ? fmt(remaining) : '…'}` : 'Treo học');
    ui.fab.classList.toggle('run', S.active);
    if (ui.panel.hidden) return;
    renderUpdate();
    renderSleep();

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
            <small>· ${esc(KIND_LABEL[q.kind])} · ${q.status === 'locked' ? esc(lockReason(q)) : Math.ceil(q.needMs / 60000) + ' phút'}</small></li>`).join('')
        : '<div class="muted">Chưa có. Bấm "Quét lại" hoặc "Bắt đầu tự học".</div>';
    }
    const fsig = c ? c.folders.map(f => f.id).join() + cfg.skipFolders.join() : '';
    if (c && fsig !== ui.foldSig) {
      ui.foldSig = fsig;
      $('.flist').innerHTML = c.folders.map(f => `<label><input type="checkbox" data-folder="${f.id}"
        ${cfg.skipFolders.includes(f.id) ? '' : 'checked'}><span>${esc(f.title)}</span></label>`).join('');
    }
    $('.logs').textContent = S.logs.join('\n');

    const fill = readFill();
    const nb = countBlanks(fill);
    const nmc = readQuiz().length;
    const nq = nmc || nb;
    if (!nq && !Q.busy) Q.status = '';
    $('.qstatus').textContent = Q.status || (nmc ? `Trang có ${nmc} câu hỏi.`
      : nb ? `Trang có ${nb} ô cần điền${fill.some(g => g.audio) ? ' (bài nghe, cần khoá Gemini)' : ''}.`
      : 'Mở một bài trắc nghiệm (bấm "LÀM BÀI") để dùng.');
    $('.qsuggest').disabled = Q.busy || !nq;
    $('.qfill').disabled = Q.busy || !nq;
  }

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    // Bấm biểu tượng extension trên thanh công cụ -> bridge.js gửi tin này
    if (e.data.vnuTreo === 'toggle-panel') { buildUI(); if (ui) ui.toggle(); }
    // Có bản mới trên GitHub Releases (background kiểm tra, bridge.js chuyển vào)
    if (e.data.vnuTreo === 'update') { U = e.data; render(); }
    // Extension vừa cập nhật xong: tải lại trang để dùng bản mới (chế độ tự học tự chạy tiếp sau khi tải lại).
    // Đang làm trắc nghiệm thì không tải lại, chỉ nhắc.
    if (e.data.vnuTreo === 'ext-reloaded') {
      if (readQuiz().length) log('Extension đã cập nhật. Làm bài xong hãy tải lại trang (F5) để dùng bản mới.');
      else { log('Extension đã cập nhật, đang tải lại trang…'); sleep(2000).then(() => location.reload()); }
    }
    // Kết quả gợi ý từ background (qua bridge.js)
    if (e.data.vnuTreo === 'ai-result' && aiWait[e.data.id]) {
      const done = aiWait[e.data.id];
      delete aiWait[e.data.id];
      done(e.data);
    }
  });

  // ---------- Thông báo bản mới ----------
  const LS_UPD_SKIP = 'vnuTreoUpdSkip';
  let U = null;
  const showUpdate = () => U && U.hasUpdate && readJSON(LS_UPD_SKIP, '') !== U.latest;

  function renderUpdate() {
    const sig = showUpdate() ? U.latest : '';
    if (sig === ui.updSig) return;
    ui.updSig = sig;
    ui.$('.update').innerHTML = sig ? `<div class="tip">⬆ Có bản mới <b>v${esc(U.latest)}</b> (bạn đang dùng v${esc(U.current)}).
        <div class="links"><a href="${esc(U.zip || U.url)}" target="_blank" rel="noopener">Tải bản mới</a>
        · <a href="${esc(U.url)}" target="_blank" rel="noopener">Xem có gì mới</a></div>
        <div>Cách cập nhật: mở thư mục extension, <b>nhấp đúp CapNhat.bat</b>. Extension tự khởi động lại sau khoảng 30 giây.
          (Bản cũ chưa có CapNhat.bat: giải nén zip đè lên thư mục cũ rồi bấm ⟳ ở trang quản lý extension.)</div>
        <button class="updlater">Để sau</button></div>` : '';
  }

  // ---------- Tab bị trình duyệt cho "ngủ" ----------
  // Trang web không biết được trình duyệt có bật Memory Saver / Sleeping tabs hay không, nên: nhắc trước một lần,
  // và phát hiện khi đã xảy ra (tab bị giải phóng rồi tải lại, bị đóng băng, hoặc đồng hồ bị ngắt quãng lâu).
  const LS_SLEEP_OK = 'vnuTreoSleepTipOk';
  const Z = { reason: '' };
  const browserName = () => (navigator.brave ? 'Brave' : /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome');

  function sleepFixSteps() {
    const keep = 'Nhập <code>lms.vnu.edu.vn</code> rồi bấm <b>Add</b>.';
    if (browserName() === 'Brave') return [
      'Mở tab mới, gõ <code>brave://settings/system</code> rồi Enter.',
      'Ở mục <b>Memory Saver</b> (Tiết kiệm bộ nhớ), phần "Always keep these sites active", bấm <b>Add</b>.', keep,
      'Cũng trong trang đó, tắt <b>Energy Saver</b> hoặc chọn chỉ bật khi pin yếu.'];
    if (browserName() === 'Edge') return [
      'Mở tab mới, gõ <code>edge://settings/system</code> rồi Enter.',
      'Ở mục <b>Sleeping tabs</b> (Tab ngủ), phần "Never put these sites to sleep", bấm <b>Add</b>.', keep,
      'Tắt <b>Efficiency mode</b> (Chế độ hiệu quả) hoặc chỉ bật khi pin yếu.'];
    return [
      'Mở tab mới, gõ <code>chrome://settings/performance</code> rồi Enter.',
      'Ở mục <b>Memory Saver</b> (Tiết kiệm bộ nhớ), phần "Always keep these sites active", bấm <b>Add</b>.', keep,
      'Tắt <b>Energy Saver</b> hoặc chọn chỉ bật khi pin yếu.'];
  }

  function sleepWarn(reason) {
    if (Z.reason !== reason) log('💤 ' + reason);
    Z.reason = reason;
    render();
  }
  document.addEventListener('resume', () => {
    if (S.active) sleepWarn('Trình duyệt vừa "đóng băng" tab LMS một lúc; thời gian đó có thể không được tính.');
  });

  function renderSleep() {
    const tipOk = readJSON(LS_SLEEP_OK, false);
    const sig = Z.reason + '|' + tipOk;
    if (sig === ui.sleepSig) return;
    ui.sleepSig = sig;
    const box = ui.$('.sleep');
    if (!Z.reason && tipOk) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="${Z.reason ? 'warn bad' : 'tip'}">
        ${Z.reason ? '💤 ' + esc(Z.reason) + ' Hãy sửa để không bị lặp lại:'
          : '💤 Trình duyệt có thể cho tab LMS "ngủ" khi bạn treo lâu ở tab khác hoặc thu nhỏ cửa sổ, làm việc học bị ngưng. Nên làm một lần:'}
        <details ${Z.reason ? 'open' : ''}><summary>Cách sửa trên ${browserName()}</summary>
          <ol>${sleepFixSteps().map(s => `<li>${s}</li>`).join('')}</ol></details>
        <button class="sleepok">${Z.reason ? 'Đã sửa, ẩn cảnh báo' : 'Đã làm, ẩn nhắc nhở'}</button></div>`;
  }

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

  const start = () => {
    buildUI();
    if (document.wasDiscarded && readJSON(LS_RUN, {}).active) {
      sleepWarn('Trình duyệt đã cho tab LMS ngủ (giải phóng tab). Extension đã tự chạy tiếp, nhưng lúc tab ngủ không được tính giờ.');
    }
    resumeIfNeeded();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  timer.every(3000, () => { buildUI(); tickVideo(); answerLmsAlert(); if (ui && !ui.panel.hidden && !S.active) render(); });
  timer.every(20000, () => cfg.keepAlive && pokeActivity());
  // Đồng hồ Worker nhịp 1 giây: nếu khựng lại lâu nghĩa là cả tab đã bị ngưng (tab ngủ hoặc máy ngủ)
  let lastBeat = Date.now();
  timer.every(1000, () => {
    const now = Date.now();
    if (S.active && now - lastBeat > 90000) {
      sleepWarn(`Tab LMS vừa bị ngưng khoảng ${Math.round((now - lastBeat) / 60000)} phút (trình duyệt cho tab ngủ hoặc máy ngủ).`);
    }
    lastBeat = now;
    if (S.active) render();
  });
})();
