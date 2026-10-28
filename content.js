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
    theme: 'navy',   // giao diện bảng: navy (theo sáng/tối của máy), white, dark
    autoNextTest: true, // vừa nộp bài kiểm tra và Đạt thì mở bài kiểm tra tiếp theo chưa đạt
    corner: 'bl',    // góc đặt bảng: bl, br, tl, tr (dưới/trên + trái/phải)
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

  // ---------- Bài tập (bài kiểm tra) tiếp theo ----------
  // Danh sách bài kiểm tra theo thứ tự mục lục được lưu lại theo lớp (đọc loại của từng mục tốn nhiều lượt gọi API);
  // trạng thái đạt thì lấy mới mỗi lần từ tiến trình học, cộng với các bài đã thấy "Đạt" trên trang.
  const LS_TESTS = 'vnuTreoTests', LS_PASSED = 'vnuTreoTestPassed', SS_ROWS = 'vnuTreoTestRows';
  // Bản trước 3.9 có thể đã nhớ nhầm (đọc bảng Kết quả của bài trước): xoá một lần
  if (readJSON('vnuTreoTestPassedV', 0) < 2) { writeJSON(LS_PASSED, {}); writeJSON('vnuTreoTestPassedV', 2); }
  const T = { busy: false };

  async function loadTests(classId) {
    const cache = readJSON(LS_TESTS, {});
    let tests = cache[classId];
    if (!tests) {
      const tree = await api('LmsClassTopic/searchFrTop1?classId=' + classId + '&key=');
      const leaves = [], seen = {};
      const walk = nodes => {
        for (const n of nodes || []) {
          if (n.isFolder) { walk(n.childs); continue; }
          const key = norm(n.title);
          seen[key] = key in seen ? seen[key] + 1 : 0;
          leaves.push({ id: n.id, title: n.title, dup: seen[key] });
        }
      };
      walk(tree);
      tests = [];
      for (let i = 0; i < leaves.length; i += 8) {
        quizStatus(`Đang tìm các bài tập trong lớp (${Math.min(i + 8, leaves.length)}/${leaves.length} mục)…`);
        const ds = await Promise.all(leaves.slice(i, i + 8).map(l => detail(l.id)));
        ds.forEach((d, j) => {
          if (kindOf(d) !== 'test') return;
          tests.push(Object.assign(leaves[i + j], {
            opensAt: d.startDate ? new Date(d.startDate).getTime() : 0,
            closesAt: d.endDate ? new Date(d.endDate).getTime() : 0,
          }));
        });
      }
      cache[classId] = tests;
      writeJSON(LS_TESTS, cache);
    }
    // "Đã đạt" lấy theo bảng Kết quả trên trang bài (dòng "Đạt"), không theo dấu ✓ của mục lục: có bài LMS đánh ✓
    // mà bảng Kết quả vẫn trống. Bài đã thấy "Đạt" được nhớ lại để lần sau không phải mở lại.
    const heads = Object.keys(readJSON(LS_PASSED, {})).filter(k => k.startsWith('head:')).map(k => k.slice(5));
    const learning = await loadLearning(classId);
    return tests.map(t => Object.assign({}, t, {
      done: heads.some(h => h.startsWith(norm(t.title))),
      lmsPassed: !!(learning[t.id] && (learning[t.id].isPassed || learning[t.id].isFinish)),
    }));
  }

  // ---------- Bài hết hạn mà chưa đạt (để báo giảng viên) ----------
  // Lấy từ danh sách bài của lớp: đã quá hạn nộp mà LMS chưa ghi nhận đạt và chưa thấy dòng "Đạt" trên trang.
  // Bài mở ra thấy "Ca thi đã kết thúc" thì ghi thêm điểm cao nhất đọc được từ bảng Kết quả (LS_EXPIRED).
  const LS_EXPIRED = 'vnuTreoExpired';
  const fmtDate = t => new Date(t).toLocaleDateString('vi-VN');
  const expiredOf = tests => tests.filter(t => t.closesAt && t.closesAt < Date.now() && !t.done && !t.lmsPassed);
  const viewHeadRaw = () => {
    const view = document.querySelector('app-class-content-view');
    return view ? (view.innerText.split('\n').find(x => x.trim()) || '').trim() : '';
  };
  // Tên lớp nằm trong ngoặc ở cuối tiêu đề mục, ví dụ "(Tiếng anh B1 FLF1107-07-UET-HKI2627)"
  const classTitle = () => ((viewHeadRaw().match(/\(([^()]+)\)\s*$/) || [])[1] || '').trim();

  async function showExpired() {
    const classId = classIdFromUrl();
    if (!classId || T.busy) return;
    T.busy = true;
    render();
    try {
      const tests = await loadTests(classId);
      const seen = readJSON(LS_EXPIRED, {});
      const list = expiredOf(tests).map(t => {
        const known = Object.values(seen).find(e => norm(e.head).startsWith(norm(t.title)));
        return { title: t.title, closes: fmtDate(t.closesAt), score: known && known.score };
      });
      const box = ui.$('.expired');
      if (!list.length) {
        box.innerHTML = '<div class="muted">Không có bài kiểm tra nào đã hết hạn mà chưa đạt. 🎉</div>';
      } else {
        const lop = classTitle() || readJSON('vnuTreoClassTitle', '');
        const text = `Kính gửi thầy/cô,\nEm xin báo các bài kiểm tra đã hết hạn mà em chưa đạt${lop ? ` (lớp ${lop})` : ''}:\n` +
          list.map((x, i) => `${i + 1}. ${x.title} — hạn ${x.closes}${x.score ? `, điểm cao nhất ${x.score}` : ''}`).join('\n') +
          '\nEm mong thầy/cô xem xét mở lại giúp em. Em cảm ơn ạ.';
        box.innerHTML = `<div class="muted">${list.length} bài đã hết hạn mà chưa đạt:</div>
          <ol>${list.map(x => `<li>${esc(x.title)} <small>· hạn ${esc(x.closes)}${x.score ? ` · điểm cao nhất ${esc(x.score)}` : ''}</small></li>`).join('')}</ol>
          <textarea class="exptext" rows="5" readonly></textarea>
          <div class="qrow"><button class="expcopy">📋 Sao chép để gửi giảng viên</button></div>`;
        box.querySelector('.exptext').value = text;
        box.querySelector('.expcopy').addEventListener('click', async () => {
          const ta = box.querySelector('.exptext');
          try { await navigator.clipboard.writeText(ta.value); } catch (e) { ta.select(); document.execCommand('copy'); }
          box.querySelector('.expcopy').textContent = '✓ Đã sao chép';
        });
      }
      box.hidden = false;
      quizStatus(list.length ? `Có ${list.length} bài đã hết hạn mà chưa đạt (xem danh sách bên dưới).` : 'Không có bài nào hết hạn mà chưa đạt.', true);
    } catch (e) {
      quizStatus('Lỗi: ' + e.message, true);
    } finally {
      T.busy = false;
      render();
    }
  }

  // Đang mở một bài "Ca thi đã kết thúc" mà bảng Kết quả không có dòng Đạt: báo ngay và ghi lại điểm cao nhất.
  // Chờ tiêu đề đứng yên 3 giây (watchTestPass ghi T.head/T.headSince) để không đọc nhầm bảng của bài trước.
  function watchExpiredPage() {
    const view = document.querySelector('app-class-content-view');
    if (!view || T.busy || !/Ca thi đã kết thúc/i.test(view.innerText)) return;
    const r = testResults();
    if (!r || r.pass > 0 || r.head !== T.head || Date.now() - (T.headSince || 0) < 3000 || T.expiredHead === r.head) return;
    T.expiredHead = r.head;
    const scores = r.rows.map(row => clean(row.cells[1] && row.cells[1].innerText)).filter(x => /\d/.test(x));
    const best = scores.sort((a, b) => parseFloat(b) - parseFloat(a))[0] || '';
    const seen = readJSON(LS_EXPIRED, {});
    seen[r.head] = { head: viewHeadRaw(), score: best, at: Date.now() };
    writeJSON(LS_EXPIRED, seen);
    if (classTitle()) writeJSON('vnuTreoClassTitle', classTitle());
    log('⚠ Bài đã hết hạn mà chưa đạt: ' + viewHeadRaw() + (best ? ` (điểm cao nhất ${best})` : ''));
    quizStatus(`⚠ Bài này đã hết hạn ("Ca thi đã kết thúc") mà chưa đạt${best ? `, điểm cao nhất ${best}` : ''}. Bấm "📋 Bài hết hạn chưa đạt" để lấy danh sách báo giảng viên.`, true);
  }

  // Mục đang mở: tiêu đề nằm ở đầu khung nội dung. Lấy bài có tiêu đề dài nhất khớp với dòng đầu đó.
  const viewHead = () => {
    const view = document.querySelector('app-class-content-view');
    return view ? norm(view.innerText.split('\n').find(s => s.trim()) || '') : '';
  };
  const currentTest = tests => {
    const head = viewHead();
    return tests.filter(t => head.startsWith(norm(t.title))).sort((a, b) => b.title.length - a.title.length)[0];
  };

  async function goNextTest(reason) {
    const classId = classIdFromUrl();
    if (!classId || T.busy || S.active) return;
    T.busy = true;
    render();
    try {
      const tests = await loadTests(classId);
      // Luôn tìm từ đầu mục lục (bài chưa đạt đầu tiên), chỉ bỏ qua bài đang mở
      const cur = currentTest(tests);
      const order = tests.filter(t => t !== cur && !t.done && !lockReason(t));
      // Mở lần lượt từng bài và đọc bảng Kết quả: đã có dòng "Đạt" thì ghi nhớ và mở bài sau
      for (const [i, next] of order.slice(0, 40).entries()) {
        quizStatus(`${reason || ''}Đang tìm bài chưa đạt từ đầu mục lục (${i + 1}): ${next.title}`, true);
        const before = testResults();
        const prevRows = new Set(before ? before.rows : []);
        if (!(await openItem(next))) return quizStatus('Không mở được bài: ' + next.title + '. Hãy mở mục lục rồi bấm lại.', true);
        const r = await stableResults(next, prevRows);
        if (r && r.pass > 0) {
          log('Bài này đã có lần Đạt, bỏ qua: ' + next.title);
          const passed = readJSON(LS_PASSED, {});
          passed['head:' + r.head] = true;
          writeJSON(LS_PASSED, passed);
          continue;
        }
        log('⏭ Mở bài tập chưa đạt: ' + next.title);
        const expired = expiredOf(tests).length;
        return quizStatus(`Đã mở: ${next.title} (chưa có lần Đạt). Bấm "LÀM BÀI" khi sẵn sàng.` +
          (expired ? ` (Có ${expired} bài đã hết hạn mà chưa đạt: xem "📋 Bài hết hạn chưa đạt".)` : ''), true);
      }
      const expired = expiredOf(tests).length;
      quizStatus((order.length > 40 ? 'Đã kiểm tra 40 bài liền đều Đạt. Bấm lại để tìm tiếp.' : `Không còn bài tập nào khác chưa đạt (lớp có ${tests.length} bài tập) 🎉`) +
        (expired ? ` Có ${expired} bài đã hết hạn mà chưa đạt: bấm "📋 Bài hết hạn chưa đạt".` : ''), true);
    } catch (e) {
      quizStatus('Lỗi: ' + e.message, true);
    } finally {
      T.busy = false;
      render();
    }
  }

  // Vừa chuyển bài thì LMS đổi tiêu đề ngay nhưng bảng Kết quả vẫn là của bài trước một lúc rồi mới tải lại.
  // Nên chờ ít nhất 2 giây và đọc đến khi bảng không đổi qua 3 lần đọc liên tiếp (tối đa khoảng 10 giây).
  // prevRows: các dòng của bảng trước khi chuyển bài; còn thấy dòng cũ nào thì bảng chưa tải lại, không tính.
  // Không chắc chắn thì trả null: bài đó được coi là chưa đạt (dừng lại cho bạn xem, không bỏ qua nhầm).
  async function stableResults(test, prevRows) {
    await sleep(2000);
    let last = '', same = 0;
    for (let k = 0; k < 16; k++) {
      const r = testResults();
      const fresh = r && r.head.startsWith(norm(test.title)) && !r.rows.some(row => prevRows.has(row));
      const sig = fresh ? r.total + '|' + r.pass : '';
      same = sig && sig === last ? same + 1 : 0;
      last = sig;
      if (same >= 2) return r;
      await sleep(500);
    }
    return null;
  }

  // Bảng "Kết quả" của bài kiểm tra: mỗi lần nộp thêm một dòng, cột cuối là "Đạt" / "Không đạt".
  // Nhớ số dòng đã thấy (trong phiên này) để biết khi nào có lần nộp mới.
  function testResults() {
    const view = document.querySelector('app-class-content-view');
    const table = view && [...view.querySelectorAll('table')].find(t => /Trạng thái/.test(t.innerText) && /Nộp bài/.test(t.innerText));
    if (!table) return null;
    const rows = [...table.querySelectorAll('tr')].filter(r => r.querySelector('td'));
    return { head: viewHead(), rows, total: rows.length, pass: rows.filter(r => /^đạt$/i.test(clean(r.cells[r.cells.length - 1].innerText))).length };
  }

  function watchTestPass() {
    if (S.active || T.busy) return;
    const r = testResults();
    if (!r || !r.head) return;
    // Vừa đổi bài: bảng có thể còn là của bài trước, chờ tiêu đề đứng yên 3 giây
    if (r.head !== T.head) { T.head = r.head; T.headSince = Date.now(); return; }
    if (Date.now() - T.headSince < 3000) return;
    let seen = {};
    try { seen = JSON.parse(sessionStorage.getItem(SS_ROWS)) || {}; } catch (e) {}
    const before = seen[r.head];
    if (!before || before.total !== r.total || before.pass !== r.pass) {
      seen[r.head] = { total: r.total, pass: r.pass };
      try { sessionStorage.setItem(SS_ROWS, JSON.stringify(seen)); } catch (e) {}
    }
    if (!before || r.total <= before.total) return;
    // Có lần nộp mới
    if (r.pass <= before.pass) return log('Bài vừa nộp chưa Đạt, ở lại để bạn làm lại.');
    log('Bài vừa nộp đã Đạt.');
    // Nhớ theo tiêu đề (danh sách bài có thể chưa tải), để nút "Bài tập tiếp theo" bỏ qua bài này
    const passed = readJSON(LS_PASSED, {});
    passed['head:' + r.head] = true;
    writeJSON(LS_PASSED, passed);
    if (cfg.autoNextTest) goNextTest('Bài vừa nộp đã Đạt. ');
  }

  // ---------- 3. Trợ lý làm bài (AI) ----------
  // Trang làm bài: mỗi câu là .question-item, đề bài ở .question-title. Có các dạng: trắc nghiệm (radio/checkbox trong
  // .question-content label), điền ô chữ (có thể kèm audio), nối cặp kéo thả; ngoài ra bài tập viết và thảo luận dùng CKEditor.
  // Gợi ý được lưu theo nội dung câu hỏi (LS_AI) để lần sau gặp lại không phải hỏi AI.
  // Chỉ gợi ý và điền khi bạn bấm; không bao giờ tự nộp bài hay đăng bài.
  const LS_AI = 'vnuTreoAi';
  const Q = { busy: false, status: '' };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  // Trắc nghiệm: nút chọn (radio/checkbox) hoặc danh sách thả xuống (p-dropdown, lựa chọn nằm trong select ẩn).
  // Câu con (1.1, 1.2…) nằm dưới khung đề chung thì kèm đề chung và audio của khung đó; ảnh trong đề câu cũng gửi cho AI.
  function readQuiz() {
    const out = [];
    let ctx = null;
    for (const item of document.querySelectorAll('.question-item')) {
      const hc = item.querySelector('app-client-question-hc');
      if (hc) {
        const t = hc.querySelector('.question-title');
        ctx = { text: t ? t.innerText.trim() : '', audio: hc.querySelector('audio') };
        continue;
      }
      const select = item.querySelector('.question-content p-dropdown select');
      const inputs = select ? [] : [...item.querySelectorAll('.question-content input[type=radio], .question-content input[type=checkbox]')];
      if ((!select && !inputs.length) || !item.offsetParent) continue;
      const titleEl = item.querySelector('.question-title');
      const title = clean(titleEl && titleEl.innerText);
      const answers = select ? [...select.options].slice(1).map(o => clean(o.text))
        : inputs.map(i => clean(i.closest('label') && i.closest('label').innerText));
      const images = titleEl ? [...titleEl.querySelectorAll('img')].map(im => im.currentSrc || im.src).filter(Boolean) : [];
      const num = item.querySelector('.question-num');
      const n = ((num && num.innerText.match(/\d+\s*\.\s*\d+|\d+/)) || [String(out.length + 1)])[0].replace(/\s+/g, '');
      const qctx = n.includes('.') ? ctx : null;
      out.push({ item, inputs, select, n, title, answers, images, ctx: qctx, multi: inputs.some(i => i.type === 'checkbox'),
        key: norm((qctx ? qctx.text.slice(0, 300) + '||' : '') + title) + '||' + images.join('|') + '||' + answers.map(norm).sort().join('|') });
    }
    return out;
  }

  // Ảnh trong đề (tối đa 8 ảnh, mỗi ảnh dưới 4 MB). Ảnh không tải được thì bỏ qua.
  async function imagesPayload(qs) {
    const out = [];
    for (const q of qs) {
      q.imageIds = [];
      for (const src of q.images) {
        if (out.length >= 8) break;
        try {
          const blob = await (await fetch(src, { credentials: 'include' })).blob();
          if (!blob.type.startsWith('image/') || blob.size > 4 * 1024 * 1024) continue;
          const data = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',')[1]);
            r.onerror = reject;
            r.readAsDataURL(blob);
          });
          const id = 'img' + (out.length + 1);
          out.push({ id, mime: blob.type, data });
          q.imageIds.push(id);
        } catch (e) {}
      }
    }
    return out;
  }

  // Chọn một mục của danh sách thả xuống PrimeNG như khi bấm chuột: mở danh sách rồi bấm mục (danh sách gắn vào cuối trang)
  async function pickDropdown(item, text) {
    const dd = item.querySelector('.question-content .ui-dropdown');
    if (!dd) return false;
    dd.click();
    await sleep(300);
    const li = [...document.querySelectorAll('.ui-dropdown-items li')].filter(l => l.offsetParent).find(l => clean(l.innerText) === text);
    if (li) { li.click(); await sleep(150); return true; }
    dd.click();
    return false;
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
  // Background báo tiến độ ít nhất 15 giây một lần; im lặng quá 60 giây mới coi là mất kết nối.
  const askAI = (questions, task) => new Promise(resolve => {
    const id = ++aiSeq;
    const w = aiWait[id] = { resolve, heard: false };
    w.arm = () => {
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        if (aiWait[id] !== w) return;
        delete aiWait[id];
        resolve({ ok: false, error: w.heard ? 'Extension ngừng phản hồi giữa chừng. Tải lại trang (F5) rồi bấm lại.'
          : 'Không nhận được phản hồi. Hãy chắc chắn đã nạp extension (bản Tampermonkey không có AI), rồi tải lại trang.' });
      }, 60000);
    };
    w.arm();
    window.postMessage(task ? { vnuTreo: 'ai-task', id, task } : { vnuTreo: 'ai-suggest', id, questions }, location.origin);
  });

  // sticky: giữ dòng trạng thái kể cả khi trang không có câu hỏi (thông báo chuyển bài tập)
  function quizStatus(msg, sticky) { Q.status = msg; Q.sticky = !!sticky; render(); }

  function annotate(q, s) {
    q.inputs.forEach((inp, i) => {
      const label = inp.closest('label');
      const hit = s.picks.includes(q.answers[i]);
      label.style.outline = hit ? '2px solid #5b46b0' : '';
      label.style.borderRadius = hit ? '4px' : '';
    });
    // Danh sách thả xuống: ghi luôn chữ của đáp án; nút chọn: ghi chữ cái A, B, C…
    const pick = q.select ? s.picks.join(', ') : s.picks.map(p => String.fromCharCode(65 + q.answers.indexOf(p))).join(', ');
    aiNote(q.item, q.item.querySelector('.question-content'), `🤖 Gợi ý: ${pick || '?'} (độ tin cậy ${s.confidence}) — ${s.why}`);
  }

  // Kéo thả nối cặp: bên trái là các mục để kéo, bên phải là các ô đích (thẻ có tiêu đề).
  // Dùng cho cả bài nối câu hỏi với câu trả lời lẫn bài sắp xếp từ (mục là số vị trí, ô đích là từ).
  function readMatch() {
    const out = [];
    let ctx = '';
    for (const item of document.querySelectorAll('.question-item')) {
      const m = item.querySelector('app-client-question-mtc');
      if (!m) {
        const hc = item.querySelector('app-client-question-hc .question-title');
        if (hc) ctx = hc.innerText.trim();
        continue;
      }
      if (!item.offsetParent) continue;
      const cards = [...m.querySelectorAll('.card[droppable]')];
      const items = [...m.querySelectorAll('li[draggable]')].map(li => clean(li.innerText));
      if (!cards.length || !items.length) continue;
      const targets = cards.map(c => clean((c.querySelector('.card-header') || c).innerText));
      const title = clean(m.querySelector('.question-title') && m.querySelector('.question-title').innerText);
      const num = m.querySelector('.question-num');
      const n = ((num && num.innerText.match(/\d+\s*\.\s*\d+|\d+/)) || [String(out.length + 1)])[0].replace(/\s+/g, '');
      out.push({ item, m, cards, n, ctx, title, items, targets,
        key: 'mtc||' + norm(ctx + title) + '||' + items.map(norm).sort().join('|') + '||' + targets.map(norm).sort().join('|') });
    }
    return out;
  }

  // Mục "Topic - Thảo luận nhóm": đề chỉ có một câu hướng dẫn (câu hỏi nằm trong video của mục trước), bên dưới là
  // bài trả lời của các bạn (li có dòng "Đăng bởi"). Gửi cho AI câu hướng dẫn và nội dung các bài đó (bỏ tên, mã sinh viên)
  // để AI suy ra các câu hỏi. Không có bài nào thì vẫn là mục thảo luận nếu tiêu đề có "Topic"/"Thảo luận".
  function readTopic() {
    const view = document.querySelector('app-class-content-view');
    if (!view) return null;
    const posts = [...view.querySelectorAll('li.list-group-item')].filter(li => /Đăng bởi/.test(li.innerText));
    const head = view.innerText.split('\n').find(s => s.trim()) || '';
    if (!posts.length && !/topic|thảo luận nhóm/i.test(head)) return null;
    // Đề = nội dung mục, bỏ các bài đăng, nút "+ THẢO LUẬN" và phần chuyển mục / tệp đính kèm
    const copy = view.cloneNode(true);
    copy.querySelectorAll('li.list-group-item, .panel-heading').forEach(e => e.remove());
    const intro = copy.textContent.replace(/\s+/g, ' ').replace(/(Tệp đính kèm|Mục trước)[\s\S]*$/, '').trim();
    const bodies = posts.slice(0, 8).map(li => li.innerText.split('\n').map(s => s.trim())
      .filter(s => s && !/^Đăng bởi|^Thảo [lL]uận$|^Phản hồi/.test(s)).join('\n')).filter(Boolean);
    const addBtn = [...view.querySelectorAll('.panel-heading')].find(e => /THẢO LUẬN/.test(e.innerText));
    return { addBtn, prompt: (intro + (bodies.length ? '\n\nBài trả lời của các bạn khác (chỉ để biết đề hỏi gì, không chép):\n\n' +
      bodies.map((b, i) => `--- Bài ${i + 1} ---\n${b}`).join('\n\n') : '')).slice(0, 8000) };
  }

  // Khung viết: hộp thoại "Thêm thảo luận" đang mở, hoặc khung "Bài làm" của bài tập nộp bằng bài viết. Cả hai đều là CKEditor 4.
  // Ở mục Topic mà hộp thoại chưa mở thì trả về openTopic (nút "+ THẢO LUẬN") để Viết nháp tự mở hộp thoại.
  function readWrite() {
    const C = window.CKEDITOR;
    const topic = readTopic();
    if (!C) return topic && topic.addBtn ? { kind: 'topic', openTopic: topic.addBtn } : null;
    const editors = Object.values(C.instances);
    const inside = el => editors.find(e => e.container && el.contains(e.container.$));
    const modal = [...document.querySelectorAll('.modal-dialog')].find(d => d.offsetParent && /Thêm thảo luận/.test(d.innerText));
    if (modal && inside(modal)) {
      const titleInput = modal.querySelector('input.form-control:not([disabled])');
      if (topic) return { kind: 'topic', editor: inside(modal), titleInput, prompt: topic.prompt };
      const name = modal.querySelector('input[disabled]');
      const lesson = document.querySelector('app-class-content-view') || document.querySelector('.class-lesson-container');
      return { kind: 'discussion', editor: inside(modal), titleInput,
        prompt: ((name && name.value ? 'Bài học: ' + name.value + '\n\n' : '') + (lesson ? lesson.innerText : '')).trim().slice(0, 8000) };
    }
    if (topic && topic.addBtn) return { kind: 'topic', openTopic: topic.addBtn };
    const box = document.querySelector('.exercise-teacher-box');
    const info = box && [...box.querySelectorAll('.exercise-content-box')].find(b => !b.querySelector('ck-editor'));
    if (box && info && inside(box)) {
      return { kind: 'assignment', editor: inside(box), prompt: info.innerText.replace(/^\s*Thông tin bài tập/, '').trim().slice(0, 8000) };
    }
    return null;
  }

  function aiNote(host, after, text) {
    let note = host.querySelector('.vnu-ai-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'vnu-ai-note';
      note.style.cssText = 'clear:both;margin:8px 0 0;padding:6px 10px;border-left:3px solid #5b46b0;border-radius:0 6px 6px 0;' +
        'background:#eeebfa;color:#1a2233;font-size:13px;';
      after.after(note);
    }
    note.textContent = text;
  }

  const modelNote = res => (res.model ? ` (dùng ${res.model})` : '');

  async function suggestChoice(qs, bank) {
    const todo = qs.filter(q => !bank[q.key]);
    let used = '';
    const save = (part, res) => {
      if (!res.ok) throw new Error(res.error);
      used = modelNote(res);
      for (const a of res.answers) {
        const q = part.find(x => x.n === String(a.n));
        if (!q) continue;
        bank[q.key] = { picks: a.choices.filter(i => q.answers[i] != null).map(i => q.answers[i]), why: a.why, confidence: a.confidence };
      }
      writeJSON(LS_AI, bank);
    };
    // Câu chỉ có chữ: gửi như trước. Câu có đề chung, audio hoặc ảnh: gửi theo từng đề chung, kèm audio và ảnh.
    const plain = todo.filter(q => !q.ctx && !q.images.length);
    if (plain.length) {
      quizStatus(`Đang hỏi AI ${plain.length} câu trắc nghiệm (model bận thì tự thử lại / đổi model)…`);
      save(plain, await askAI(plain.map(q => ({ n: q.n, question: q.title, answers: q.answers, multi: q.multi }))));
    }
    const rich = todo.filter(q => q.ctx || q.images.length);
    for (const ctx of [...new Set(rich.map(q => q.ctx))]) {
      const part = rich.filter(q => q.ctx === ctx);
      quizStatus(ctx && ctx.audio ? 'Đang tải file audio của bài…' : `Đang chuẩn bị ${part.length} câu…`);
      const audio = ctx && ctx.audio ? await audioPayload(ctx.audio) : null;
      const images = await imagesPayload(part);
      quizStatus(`Đang hỏi AI ${part.length} câu${audio ? ' (AI nghe audio, có thể mất 30-60 giây)' : ''}${images.length ? `, kèm ${images.length} ảnh` : ''}…`);
      save(part, await askAI(null, {
        kind: 'choose', context: ctx ? ctx.text : '', audio, images,
        questions: part.map(q => ({ n: q.n, question: q.title, answers: q.answers, multi: q.multi, images: q.imageIds })),
      }));
    }
    let shown = 0;
    for (const q of qs) if (bank[q.key]) { annotate(q, bank[q.key]); shown++; }
    return `${shown}/${qs.length} câu trắc nghiệm${used}`;
  }

  async function suggestFill(groups, bank) {
    let used = '';
    for (const g of groups) {
      const todo = g.blanks.filter(b => !bank[b.key]);
      if (!todo.length) continue;
      quizStatus(g.audio ? 'Đang tải file audio của bài nghe…' : `Đang hỏi AI ${todo.length} ô…`);
      const audio = await audioPayload(g.audio);
      if (audio) quizStatus(`AI đang nghe audio và điền ${todo.length} ô (có thể mất 30-60 giây)…`);
      const res = await askAI(null, {
        kind: 'fill', context: g.text, caps: wantsCaps(g.text), audio,
        blanks: todo.map(b => ({ n: b.n, label: b.label })),
      });
      if (!res.ok) throw new Error(res.error);
      used = modelNote(res);
      for (const a of res.answers) {
        const b = todo.find(x => x.n === String(a.n));
        const text = String(a.text || '').trim();
        if (b) bank[b.key] = { text: wantsCaps(g.text) ? text.toUpperCase() : text, why: a.why, confidence: a.confidence };
      }
      writeJSON(LS_AI, bank);
    }
    let shown = 0;
    for (const g of groups) for (const b of g.blanks) {
      const s = bank[b.key];
      if (!s) continue;
      aiNote(b.item, b.input.closest('p, div'), `🤖 Gợi ý: ${s.text || '?'} (độ tin cậy ${s.confidence}) — ${s.why}`);
      shown++;
    }
    return `${shown}/${countBlanks(groups)} ô${used}`;
  }

  async function suggestMatch(ms, bank) {
    const todo = ms.filter(q => !bank[q.key]);
    let used = '';
    if (todo.length) {
      quizStatus(`Đang hỏi AI ${todo.length} câu nối cặp…`);
      // Các câu cùng đề chung gửi một lần
      for (const ctx of [...new Set(todo.map(q => q.ctx))]) {
        const part = todo.filter(q => q.ctx === ctx);
        const res = await askAI(null, {
          kind: 'match', context: ctx,
          questions: part.map(q => ({ n: q.n, title: q.title, items: q.items, targets: q.targets })),
        });
        if (!res.ok) throw new Error(res.error);
        used = modelNote(res);
        for (const a of res.answers) {
          const q = part.find(x => x.n === String(a.n));
          if (!q) continue;
          const pairs = a.pairs.filter(p => q.items[p.item] != null && q.targets[p.target] != null)
            .map(p => ({ item: q.items[p.item], target: q.targets[p.target] }));
          bank[q.key] = { pairs, why: a.why, confidence: a.confidence };
        }
        writeJSON(LS_AI, bank);
      }
    }
    let shown = 0;
    for (const q of ms) {
      const s = bank[q.key];
      if (!s) continue;
      const cut = t => (t.length > 40 ? t.slice(0, 40) + '…' : t);
      aiNote(q.m, q.m.querySelector('.question-content'),
        `🤖 Gợi ý (độ tin cậy ${s.confidence}): ${s.pairs.map(p => `${cut(p.item)} → ${cut(p.target)}`).join(' · ')} — ${s.why}`);
      shown++;
    }
    return `${shown}/${ms.length} câu nối cặp${used}`;
  }

  async function suggestQuiz() {
    const qs = readQuiz(), groups = readFill(), ms = readMatch();
    if (!qs.length && !countBlanks(groups) && !ms.length) return quizStatus('Không thấy câu hỏi trên trang.');
    const bank = readJSON(LS_AI, {});
    const done = [];
    Q.busy = true;
    try {
      if (qs.length) done.push(await suggestChoice(qs, bank));
      if (countBlanks(groups)) done.push(await suggestFill(groups, bank));
      if (ms.length) done.push(await suggestMatch(ms, bank));
      Q.busy = false;
      quizStatus(`Đã gợi ý ${done.join(', ')}. Xem lại, rồi bấm "Điền gợi ý" hoặc tự làm.`);
    } catch (e) {
      Q.busy = false;
      quizStatus('Lỗi: ' + e.message);
    }
  }

  // Thư viện kéo thả của LMS nghe sự kiện kéo thả HTML5, nên giả lập đúng chuỗi sự kiện như khi bạn kéo bằng chuột
  function dragTo(el, target) {
    const dt = new DataTransfer();
    const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(el, 'dragstart');
    fire(target, 'dragenter');
    fire(target, 'dragover');
    fire(target, 'drop');
    fire(el, 'dragend');
  }

  async function fillQuiz() {
    const bank = readJSON(LS_AI, {});
    const done = [];
    let n = 0;
    for (const q of readQuiz()) {
      const s = bank[q.key];
      if (!s) continue;
      if (q.select) {
        if (s.picks[0] && clean(q.select.options[q.select.selectedIndex].text) !== s.picks[0]) await pickDropdown(q.item, s.picks[0]);
        n++;
        continue;
      }
      q.inputs.forEach((inp, i) => {
        const want = s.picks.includes(q.answers[i]);
        // click() để trang ghi nhận đáp án như khi bạn tự bấm
        if (want !== inp.checked && (want || inp.type === 'checkbox')) inp.click();
      });
      n++;
    }
    if (n) done.push(`${n} câu trắc nghiệm`);
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
    if (blanks) done.push(`${blanks} ô (nhớ bấm "Lưu câu trả lời" ở từng câu)`);
    let matched = 0;
    for (const q of readMatch()) {
      const s = bank[q.key];
      if (!s) continue;
      for (const p of s.pairs) {
        const card = q.cards.find(c => clean((c.querySelector('.card-header') || c).innerText) === p.target);
        const li = [...q.m.querySelectorAll('li[draggable]')].find(x => clean(x.innerText) === p.item);
        if (!card || !li || card.contains(li)) continue;
        dragTo(li, card);
        await sleep(120);
      }
      matched++;
    }
    if (matched) done.push(`${matched} câu nối cặp`);
    quizStatus(done.length ? `Đã điền ${done.join(', ')}. Kiểm tra lại rồi tự bấm "Nộp bài".` : 'Chưa có gợi ý nào, bấm "Gợi ý đáp án" trước.');
  }

  const toHtml = text => text.trim().split(/\n\s*\n/).map(p => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

  async function writeDraft() {
    let w = readWrite();
    if (w && w.openTopic) {
      // Mục Topic: tự mở hộp thoại "Thêm thảo luận" (chỉ mở khung viết, không đăng gì)
      (w.openTopic.querySelector('a, span, b') || w.openTopic).click();
      for (let i = 0; i < 10 && (!w || w.openTopic); i++) { await sleep(400); w = readWrite(); }
      if (!w || w.openTopic) return quizStatus('Không mở được khung "+ THẢO LUẬN". Bấm nút đó rồi bấm lại "Viết nháp".');
    }
    if (!w) return quizStatus('Mở khung "Bài làm" của bài tập viết, hoặc bấm "+ THẢO LUẬN" dưới bài học, rồi bấm lại.');
    const current = clean(w.editor.document ? w.editor.document.getBody().getText() : w.editor.getData().replace(/<[^>]+>/g, ' '));
    if (current && !window.confirm('Khung viết đang có nội dung. Thay bằng bản nháp AI?')) return;
    const idea = ui ? ui.$('.qidea').value.trim() : '';
    Q.busy = true;
    quizStatus(w.kind === 'assignment' ? 'AI đang viết nháp bài làm…' : 'AI đang viết nháp bài thảo luận…');
    try {
      const res = await askAI(null, { kind: 'write', type: w.kind, prompt: w.prompt, idea });
      if (!res.ok) throw new Error(res.error);
      // setData rồi báo "change" để trang cập nhật nội dung (và bật nút nộp/lưu)
      w.editor.setData(toHtml(res.body), { callback: () => w.editor.fire('change') });
      if (w.titleInput && res.title && !w.titleInput.value.trim()) {
        w.titleInput.value = res.title.slice(0, 500);
        w.titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      Q.busy = false;
      quizStatus(`Đã viết nháp${modelNote(res)}. ${res.note || ''} Đọc và sửa theo ý bạn, rồi tự bấm "${w.kind === 'assignment' ? 'Xác nhận nộp bài' : 'Lưu lại'}".`);
    } catch (e) {
      Q.busy = false;
      quizStatus('Lỗi: ' + e.message);
    }
  }

  // ---------- 4. Bảng điều khiển ----------
  const CSS = `
    :host { all: initial;
      --ink: #14213d; --navy: #1b3a6b; --blue: #2457a8; --paper: #ffffff; --wash: #f3f5f9; --line: #dfe4ec;
      --text: #1a2233; --sub: #5d6880; --go: #1d7a4e; --go-wash: #e3f3ea; --amber: #a86a12; --amber-wash: #fdf3dc;
      --red: #b8322a; --red-wash: #fbe9e7; --ai: #5b46b0; --ai-wash: #eeebfa;
      --hd: var(--ink); --hd-text: #fff; --hd-sub: #a9b6d0; --hd-rule: transparent; --hd-x: #c9d4ea; --hd-x-bg: rgba(255,255,255,.08);
      --hd-btn: rgba(255,255,255,.06); --hd-btn-hover: rgba(255,255,255,.14); --hd-btn-line: rgba(255,255,255,.16); --hd-btn-text: #dbe3f2;
      --hd-primary: #fff; --hd-primary-hover: #e6edf9; --hd-primary-text: var(--ink); --hd-track: rgba(255,255,255,.14); --hd-fill: #5fd49a;
      --hd-tip: #24365c; --hd-tip-text: #dbe5f7; --hd-upd: #1d5c41; --hd-upd-text: #dcf6e8; --hd-code: rgba(255,255,255,.14);
      --hd-note-btn: rgba(255,255,255,.9); --fab: var(--ink); --fab-hover: var(--navy); --fab-text: #fff; --fab-dot: #8fa3c7; --fab-line: transparent; }
    /* Giao diện tối: theo máy khi chọn "Xanh đậm", hoặc luôn tối khi chọn "Tối" */
    @media (prefers-color-scheme: dark) {
      :host(:not([data-theme=white]):not([data-theme=dark])) { --ink: #22355c; --navy: #2b4373; --paper: #171c26; --wash: #1f2531; --line: #2e3646; --text: #e4e8f0; --sub: #98a2b6;
        --go-wash: #183126; --amber-wash: #33291a; --red-wash: #3a1e1c; --ai-wash: #262040; --blue: #6f9be6; --ai: #a493ec; --go: #4cc287; }
    }
    :host([data-theme=dark]) { --ink: #22355c; --navy: #2b4373; --paper: #171c26; --wash: #1f2531; --line: #2e3646; --text: #e4e8f0; --sub: #98a2b6;
        --go-wash: #183126; --amber-wash: #33291a; --red-wash: #3a1e1c; --ai-wash: #262040; --blue: #6f9be6; --ai: #a493ec; --go: #4cc287; }
    /* Giao diện trắng: phần đầu bảng cũng nền trắng, luôn sáng */
    :host([data-theme=white]) {
      --hd: #ffffff; --hd-text: #1a2233; --hd-sub: #5d6880; --hd-rule: #dfe4ec; --hd-x: #5d6880; --hd-x-bg: #f3f5f9;
      --hd-btn: #f3f5f9; --hd-btn-hover: #e7ebf2; --hd-btn-line: #dfe4ec; --hd-btn-text: #1a2233;
      --hd-primary: #2457a8; --hd-primary-hover: #1b3a6b; --hd-primary-text: #fff; --hd-track: #e6eaf1; --hd-fill: #1d7a4e;
      --hd-tip: #eef3fb; --hd-tip-text: #1b3a6b; --hd-upd: #e3f3ea; --hd-upd-text: #14532d; --hd-code: rgba(20,33,61,.08);
      --hd-note-btn: #fff; --fab: #fff; --fab-hover: #f3f5f9; --fab-text: #14213d; --fab-dot: #2457a8; --fab-line: #dfe4ec; }
    * { box-sizing: border-box; font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, Roboto, sans-serif; }
    button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

    .fab { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 9px 16px 9px 12px;
      font-size: 13px; font-weight: 600; color: var(--fab-text); background: var(--fab); cursor: pointer;
      border: 1px solid var(--fab-line); box-shadow: 0 6px 18px rgba(20,33,61,.35); font-variant-numeric: tabular-nums; }
    .fab::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--fab-dot); }
    .fab:hover { background: var(--fab-hover); }
    .fab.run { color: #fff; border-color: var(--go); background: var(--go); box-shadow: 0 6px 18px rgba(29,122,78,.4); }
    .fab.run::before { background: #b8f5d2; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) { .fab.run::before { animation: none; } }

    .panel { position: absolute; left: 0; bottom: 50px; width: 372px; max-width: calc(100vw - 24px); max-height: 78vh; overflow: auto;
      background: var(--paper); color: var(--text); border-radius: 14px; font-size: 13px; line-height: 1.45;
      box-shadow: 0 18px 48px rgba(10,20,40,.32), 0 0 0 1px rgba(20,33,61,.12); scrollbar-width: thin; }
    .panel[hidden] { display: none; }
    /* Góc đặt bảng: nút ở góc, bảng mở về phía giữa màn hình */
    :host([data-corner^=t]) .panel { bottom: auto; top: 50px; }
    :host([data-corner$=r]) .panel { left: auto; right: 0; }
    .fab, header { touch-action: none; }
    header { cursor: grab; }
    :host([data-dragging]) .fab, :host([data-dragging]) header { cursor: grabbing; }
    :host([data-dragging]) .panel { opacity: .85; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 12px 16px;
      position: sticky; top: 0; z-index: 2; background: var(--hd); color: var(--hd-text); border-bottom: 1px solid var(--hd-rule); }
    header b { font-size: 15px; font-weight: 700; letter-spacing: .01em; }
    .x { width: 28px; height: 28px; border: 0; border-radius: 8px; background: var(--hd-x-bg); color: var(--hd-x);
      font-size: 18px; line-height: 1; cursor: pointer; }
    .x:hover { background: var(--hd-btn-hover); color: var(--hd-text); }

    /* Khối trạng thái: phần nổi bật nhất của bảng */
    .status { padding: 14px 16px 12px; display: grid; gap: 6px; background: var(--hd); color: var(--hd-text); }
    .status .muted { color: var(--hd-sub); }
    .status .cur { font-weight: 600; font-size: 14px; }
    .status .time { font-size: 40px; font-weight: 300; line-height: 1.05; letter-spacing: -.02em;
      font-variant-numeric: tabular-nums; margin: 2px 0; }
    .status .warn { color: #5c3b06; }
    .muted { color: var(--sub); font-size: 12px; }
    .warn { color: var(--amber); background: var(--amber-wash); border-radius: 8px; padding: 7px 10px; font-size: 12px; }
    .bar { height: 6px; background: var(--hd-track); border-radius: 3px; overflow: hidden; margin-top: 2px; }
    .bar i { display: block; height: 100%; background: var(--hd-fill); border-radius: 3px; transition: width .4s; }
    .status .warn { background: #fde7b0; }

    .row { display: flex; gap: 8px; padding: 12px 16px; background: var(--hd); border-bottom: 1px solid var(--hd-rule); }
    .row button { flex: 1; padding: 9px 8px; border-radius: 9px; border: 1px solid var(--hd-btn-line);
      background: var(--hd-btn); color: var(--hd-btn-text); cursor: pointer; font-size: 13px; }
    .row button:hover:not(:disabled) { background: var(--hd-btn-hover); }
    .row button.primary { flex: 1.6; background: var(--hd-primary); border-color: var(--hd-primary); color: var(--hd-primary-text); font-weight: 700; }
    .row button.primary:hover:not(:disabled) { background: var(--hd-primary-hover); }
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
    .expired[hidden] { display: none; }
    .expired { margin: 4px 0 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); }
    .expired ol { max-height: 180px; padding-left: 18px; list-style: decimal; }
    .expired li { padding: 2px 0; }
    .expired textarea { width: 100%; margin-top: 6px; font-family: inherit; font-size: 12px; line-height: 1.4; color: var(--text);
      background: var(--wash); border: 1px solid var(--line); border-radius: 6px; padding: 6px; resize: vertical; }
    .wrow[hidden] { display: none; }
    .wrow { display: flex; gap: 6px; margin: 0 0 8px; }
    .wrow input { flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px;
      background: var(--paper); color: var(--text); font-size: 12px; }
    .wrow button.qwrite { flex: 0 0 auto; background: var(--ai); border-color: var(--ai); color: #fff; font-weight: 600; }
    .qrow button:disabled { opacity: .45; cursor: default; }
    .qstatus { font-size: 12px; }

    .note:empty { display: none; }
    .note { padding: 12px 16px 0; background: var(--hd); }
    .note .tip { background: var(--hd-tip); color: var(--hd-tip-text); border-radius: 10px; padding: 10px 12px; font-size: 12px; }
    .note .bad { background: #fbe1de; color: #7d1a14; }
    .update .tip { background: var(--hd-upd); color: var(--hd-upd-text); }
    .note .links { margin: 6px 0; }
    .note a { color: inherit; font-weight: 700; }
    .note summary { font-size: 12px; padding: 6px 0 0; }
    .note summary::before { border-color: currentColor; }
    .note details { border: 0; padding: 0; }
    .note ol { max-height: none; margin: 6px 0 0; padding-left: 18px; list-style: decimal; }
    .note li { padding: 2px 0; }
    .note code { background: var(--hd-code); border-radius: 4px; padding: 0 4px; font-family: Consolas, monospace; }
    .note .bad code { background: rgba(125,26,20,.1); }
    .note button { margin-top: 8px; padding: 5px 12px; border-radius: 7px; border: 1px solid var(--hd-btn-line); background: var(--hd-note-btn);
      color: var(--ink); cursor: pointer; font-size: 12px; font-weight: 600; }
    select { padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: var(--text); font: inherit; font-size: 12px; }
  `;
  const ICON = { pending: '○', holding: '▶', checking: '…', done: '✓', fail: '✗', error: '⚠', locked: '🔒' };

  let ui = null;
  function buildUI() {
    if (ui || !document.body) return;
    const host = document.createElement('div');
    const place = () => {
      const c = /^[bt][lr]$/.test(cfg.corner) ? cfg.corner : 'bl';
      host.dataset.corner = c;
      host.style.cssText = 'position:fixed;z-index:2147483647;' +
        (c[0] === 't' ? 'top:12px;' : 'bottom:12px;') + (c[1] === 'r' ? 'right:12px;' : 'left:12px;');
    };
    place();
    host.dataset.theme = cfg.theme;
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
        <details class="quiz" open><summary>Trợ lý làm bài (AI)</summary>
          <div class="qstatus"></div>
          <div class="qrow"><button class="qsuggest">🤖 Gợi ý đáp án</button><button class="qfill">✍ Điền gợi ý</button><button class="qkey">⚙ Khoá API</button></div>
          <div class="qrow wrow" hidden><input class="qidea" placeholder="Ý bạn muốn viết (không bắt buộc)"><button class="qwrite">📝 Viết nháp</button></div>
          <div class="qrow"><button class="qnext" title="Mở bài kiểm tra đầu tiên (tính từ đầu mục lục) mà bảng Kết quả chưa có dòng Đạt">⏭ Bài tập chưa đạt đầu tiên</button></div>
          <div class="qrow"><button class="qexp" title="Liệt kê bài kiểm tra đã quá hạn mà chưa đạt, để báo giảng viên">📋 Bài hết hạn chưa đạt</button></div>
          <div class="expired" hidden></div>
          ${box('autoNextTest', 'Nộp bài xong mà Đạt thì tự mở bài tập chưa đạt đầu tiên')}
          <div class="muted">Không tự nộp bài hay đăng bài. Gợi ý được lưu lại: lần sau gặp câu giống hệt sẽ dùng luôn, không tốn tiền API.</div>
        </details>
        <details class="cfg"><summary>Cài đặt</summary>
          <div class="muted">Loại mục cần học:</div>
          ${box('kinds.video', 'Video')}${box('kinds.pdf', 'PDF / tài liệu (treo theo thời gian bên dưới)')}
          ${box('kinds.text', 'Bài đọc (văn bản)')}${box('kinds.other', 'Loại khác (thảo luận, bài tập…)')}
          ${box('onlyRequired', 'Chỉ học mục bắt buộc (*)')}
          <label class="num">Treo thêm sau khi đủ giờ <input type="number" min="0" max="30" step="0.5" data-k="extraMin"> phút</label>
          <label class="num">Mục không yêu cầu thời gian treo <input type="number" min="0.5" max="60" step="0.5" data-k="noReqMin"> phút</label>
          <label class="num">Giao diện bảng <select data-k="theme"><option value="navy">Xanh đậm (theo sáng/tối của máy)</option>
            <option value="white">Trắng</option><option value="dark">Tối</option></select></label>
          <label class="num">Vị trí bảng <select data-k="corner"><option value="bl">Góc dưới bên trái</option>
            <option value="br">Góc dưới bên phải</option><option value="tl">Góc trên bên trái</option>
            <option value="tr">Góc trên bên phải</option></select></label>
          <div class="muted">Hoặc kéo nút "Treo học" / đầu bảng sang góc khác.</div>
          <hr>
          ${box('refreshProgress', 'Mở tab "Tiến trình học tập" sau mỗi mục để cập nhật')}
          ${box('keepAlive', 'Tự xác nhận "Bạn có đang học tập không ?" và chống dừng khi đổi tab')}
          ${box('resumeVideo', 'Tự phát lại video khi bị dừng')}
          ${box('muteVideo', 'Tắt tiếng video')}
          <div class="muted">Đổi loại mục hoặc chọn bài xong, bấm "Quét lại".</div>
          <hr>
          <div class="qrow"><button class="updcheck">⟳ Kiểm tra bản mới</button></div>
          <div class="muted updres"></div>
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
    ui.fab.title = 'Bấm để mở/đóng bảng, kéo để đổi góc';
    ui.fab.addEventListener('click', () => {
      if (ui.dragged) { ui.dragged = false; return; } // vừa kéo xong, không tính là bấm
      togglePanel();
    });

    // Kéo nút hoặc đầu bảng: bảng đi theo chuột, thả ra thì dính vào góc gần nhất
    const startDrag = (e, el) => {
      if (e.button !== 0 || e.target.closest('.x')) return;
      const r = host.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top, sx = e.clientX, sy = e.clientY;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const move = ev => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        moved = true;
        host.dataset.dragging = '';
        const x = Math.min(Math.max(0, ev.clientX - dx), innerWidth - r.width);
        const y = Math.min(Math.max(0, ev.clientY - dy), innerHeight - r.height);
        host.style.cssText = `position:fixed;z-index:2147483647;left:${x}px;top:${y}px;`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        delete host.dataset.dragging;
        if (!moved) return;
        if (el === ui.fab) ui.dragged = true;
        const b = host.getBoundingClientRect();
        cfg.corner = (b.top + b.height / 2 < innerHeight / 2 ? 't' : 'b') + (b.left + b.width / 2 < innerWidth / 2 ? 'l' : 'r');
        saveCfg();
        place();
        const sel = root.querySelector('[data-k="corner"]');
        if (sel) sel.value = cfg.corner;
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    ui.fab.addEventListener('pointerdown', e => startDrag(e, ui.fab));
    $('header').addEventListener('pointerdown', e => startDrag(e, $('header')));
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
    $('.qwrite').addEventListener('click', () => writeDraft());
    $('.qnext').addEventListener('click', () => goNextTest());
    $('.qexp').addEventListener('click', () => showExpired());
    $('.updcheck').addEventListener('click', () => {
      $('.updcheck').disabled = true;
      $('.updres').textContent = 'Đang hỏi GitHub…';
      window.postMessage({ vnuTreo: 'check-update-now' }, location.origin);
      // Bản Tampermonkey không có background để hỏi
      setTimeout(() => { if ($('.updcheck').disabled) { $('.updcheck').disabled = false; $('.updres').textContent = 'Không kiểm tra được (bản Tampermonkey không có tính năng này).'; } }, 20000);
    });
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
        setK(k, input.type === 'checkbox' ? input.checked : input.tagName === 'SELECT' ? input.value : Math.max(0, Number(input.value) || 0));
        saveCfg();
        if (k === 'theme') host.dataset.theme = cfg.theme;
        if (k === 'corner') place();
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
    const nm = readMatch().length;
    const w = readWrite();
    const found = [nmc && `${nmc} câu trắc nghiệm`, nb && `${nb} ô cần điền${fill.some(g => g.audio) ? ' (bài nghe, cần khoá Gemini)' : ''}`,
      nm && `${nm} câu nối cặp`].filter(Boolean);
    if (!found.length && !w && !Q.busy && !Q.sticky) Q.status = '';
    if ((found.length || w) && Q.sticky && !Q.busy) { Q.status = ''; Q.sticky = false; } // đã vào trang làm bài
    $('.qstatus').textContent = Q.status || (found.length ? `Trang có ${found.join(', ')}.`
      : w ? (w.kind === 'topic' ? 'Mục thảo luận nhóm: bấm "Viết nháp" để AI trả lời các câu hỏi của chủ đề.'
        : w.kind === 'discussion' ? 'Đang mở khung viết thảo luận.' : 'Trang có khung "Bài làm" để viết.')
      : 'Mở một bài làm (bấm "LÀM BÀI"), bài tập viết, hoặc "+ THẢO LUẬN" dưới bài học để dùng.');
    $('.qsuggest').disabled = Q.busy || !found.length;
    $('.qfill').disabled = Q.busy || !found.length;
    $('.wrow').hidden = !w;
    $('.qwrite').disabled = Q.busy;
    $('.qnext').disabled = T.busy || S.active || !classIdFromUrl();
    $('.qexp').disabled = T.busy || !classIdFromUrl();
  }

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;
    // Bấm biểu tượng extension trên thanh công cụ -> bridge.js gửi tin này
    if (e.data.vnuTreo === 'toggle-panel') { buildUI(); if (ui) ui.toggle(); }
    // Có bản mới trên GitHub Releases (background kiểm tra, bridge.js chuyển vào)
    if (e.data.vnuTreo === 'update') {
      U = e.data;
      if (U.manual && ui) {
        ui.$('.updcheck').disabled = false;
        const at = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        // Tự bấm kiểm tra thì hiện lại thông báo bản mới kể cả khi trước đó đã chọn "Để sau"
        if (U.hasUpdate) writeJSON(LS_UPD_SKIP, '');
        ui.$('.updres').textContent = U.failed ? `Không hỏi được GitHub lúc ${at}. Kiểm tra mạng rồi thử lại.`
          : U.hasUpdate ? `Có bản mới v${U.latest} (bạn đang dùng v${U.current}), xem ô thông báo ở đầu bảng.`
          : `Bạn đang dùng bản mới nhất v${U.current} (kiểm tra lúc ${at}).`;
      }
      render();
    }
    // Extension vừa cập nhật xong: tải lại trang để dùng bản mới (chế độ tự học tự chạy tiếp sau khi tải lại).
    // Đang làm trắc nghiệm thì không tải lại, chỉ nhắc.
    if (e.data.vnuTreo === 'ext-reloaded') {
      if (readQuiz().length) log('Extension đã cập nhật. Làm bài xong hãy tải lại trang (F5) để dùng bản mới.');
      else { log('Extension đã cập nhật, đang tải lại trang…'); sleep(2000).then(() => location.reload()); }
    }
    // Kết quả gợi ý từ background (qua bridge.js)
    if (e.data.vnuTreo === 'ai-progress' && aiWait[e.data.id]) {
      const w = aiWait[e.data.id];
      w.heard = true;
      w.arm();
      if (Q.busy) quizStatus('AI: ' + e.data.text);
      if (e.data.text !== w.lastText) { w.lastText = e.data.text; log('AI: ' + e.data.text); }
    }
    if (e.data.vnuTreo === 'ai-result' && aiWait[e.data.id]) {
      const w = aiWait[e.data.id];
      delete aiWait[e.data.id];
      clearTimeout(w.timer);
      w.resolve(e.data);
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
  timer.every(3000, () => { buildUI(); tickVideo(); answerLmsAlert(); watchTestPass(); watchExpiredPage(); if (ui && !ui.panel.hidden && !S.active) render(); });
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
