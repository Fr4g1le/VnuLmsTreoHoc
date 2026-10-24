// Dựng trang LMS giả (không có thông tin cá nhân) và bảng "Treo học" giống hệt extension (CSS lấy từ content.js).
function lmsPage(main) {
  document.body.insertAdjacentHTML('beforeend', `
    <div class="lms-top"><b>ĐẠI HỌC QUỐC GIA HÀ NỘI</b> · Hệ thống đào tạo trực tuyến</div>
    <div class="lms-tabs"><span class="on">NỘI DUNG</span><span>GIỚI THIỆU</span><span>TIẾN TRÌNH HỌC TẬP</span><span>THẢO LUẬN</span><span>THÔNG BÁO</span></div>
    <div class="lms-body">
      <div class="lms-tree">
        <div class="f">📚 Bài 2. Bộ máy, chức năng, hình thức nhà nước</div>
        <div class="i done">✓ 2.1 Giới thiệu bài học</div>
        <div class="f2">2.2.1 Bài giảng</div>
        <div class="i done">✓ Video 1: Khái niệm, đặc điểm bộ máy nhà nước</div>
        <div class="i cur">○ Video 2: Bộ máy nhà nước CHXHCN Việt Nam</div>
        <div class="i">○ Video 3. Các nguyên tắc tổ chức và hoạt động…</div>
        <div class="i">○ Video 4: Chức năng của nhà nước</div>
        <div class="i">○ Bài giảng (PDF): Bộ máy, chức năng nhà nước…</div>
        <div class="f2">2.2.2 Bài đọc bắt buộc</div>
        <div class="i">○ Bài đọc 1: Giải pháp nâng cao hiệu lực…</div>
        <div class="i">○ 2.4 Trắc nghiệm kiểm tra kiến thức Bài 2</div>
      </div>
      <div class="lms-main">${main}</div>
    </div>`);
}

// Chạy fn sau khi trang và CSS trong shadow DOM đã áp dụng xong
function afterStyles(fn) {
  window.addEventListener('load', () => setTimeout(fn, 800));
}

function treoPanel(statusHtml, opts = {}) {
  const host = document.createElement('div');
  // Toạ độ cố định (không dùng position:fixed): Brave chạy ngầm đổi chiều cao cửa sổ giữa lúc chạy script và lúc chụp
  host.style.cssText = `position:absolute;left:12px;top:${opts.top || 700}px;z-index:50;`;
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const box = (t, on) => `<label><input type="checkbox" ${on ? 'checked' : ''}><span>${t}</span></label>`;
  root.innerHTML = `<style>${window.PANEL_CSS} .panel { max-height: none; }</style>
    <button class="fab">Treo học</button>
    <div class="panel">
      <header><b>Treo học VNU</b><button class="x">×</button></header>
      <section class="status">${statusHtml}</section>
      <div class="row"><button class="primary go">${opts.go || '▶ Bắt đầu tự học'}</button><button class="scan">↻ Quét lại</button><button class="mute">🔊 Tắt tiếng</button></div>
      <details class="quiz" ${opts.quizOpen ? 'open' : ''}><summary>Trợ lý trắc nghiệm (AI)</summary>
        <div class="qstatus">${opts.qstatus || 'Mở một bài trắc nghiệm (bấm "LÀM BÀI") để dùng.'}</div>
        <div class="qrow"><button class="qsuggest">🤖 Gợi ý đáp án</button><button class="qfill">✍ Điền gợi ý</button><button class="qkey">⚙ Khoá API</button></div>
      </details>
      <details class="cfg"><summary>Cài đặt</summary></details>
      <details class="fold" ${opts.foldOpen ? 'open' : ''}><summary>Chọn bài học</summary>
        ${box('📚 Bài 1. Nhà nước pháp quyền XHCN Việt Nam', true)}${box('📚 Bài 2. Bộ máy, chức năng, hình thức nhà nước', true)}${box('📚 Bài 3. Khái niệm, thuộc tính, nguồn của pháp luật', false)}
      </details>
      <details ${opts.queueOpen ? 'open' : ''}><summary>Danh sách cần học <span class="muted">(12 mục, ~58 phút)</span></summary>
        <ol class="queue">
          <li class="done">✓ Video 1: Khái niệm, đặc điểm bộ máy nhà nước <small>· Video · 7 phút</small></li>
          <li class="holding">▶ Video 2: Bộ máy nhà nước CHXHCN Việt Nam <small>· Video · 5 phút</small></li>
          <li class="pending">○ Video 3. Các nguyên tắc tổ chức… <small>· Video · 13 phút</small></li>
          <li class="pending">○ Bài giảng (PDF): Bộ máy, chức năng… <small>· PDF / tài liệu · 1 phút</small></li>
        </ol>
      </details>
    </div>`;
  return root;
}
