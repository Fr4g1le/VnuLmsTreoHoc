// mark(phần tử, số, nhãn, phía, tuỳ chọn): khung đỏ quanh nút + nhãn đánh số + mũi tên từ nhãn chỉ vào nút.
// phía: 'right' | 'left' | 'top' | 'bottom' (nhãn nằm ở phía đó của nút).
let svg;
function arrowLayer() {
  if (svg) return svg;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'g-arrows');
  svg.setAttribute('width', document.documentElement.scrollWidth);
  svg.setAttribute('height', document.documentElement.scrollHeight);
  svg.innerHTML = '<defs><marker id="g-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" fill="#e5383b"/></marker></defs>';
  document.body.appendChild(svg);
  return svg;
}

function drawArrow(x1, y1, x2, y2) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  Object.entries({ x1, y1, x2, y2, stroke: '#e5383b', 'stroke-width': 4, 'stroke-linecap': 'round', 'marker-end': 'url(#g-head)' })
    .forEach(([k, v]) => line.setAttribute(k, v));
  arrowLayer().appendChild(line);
}

function mark(sel, n, text, side = 'right', opts = {}) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) throw new Error('Không thấy ' + sel);
  const r = el.getBoundingClientRect();
  const pad = opts.pad ?? 5, gap = opts.gap ?? 56;
  const L = r.left + scrollX - pad, T = r.top + scrollY - pad, W = r.width + 2 * pad, H = r.height + 2 * pad;
  if (!opts.noBox) {
    const box = document.createElement('div');
    box.className = 'g-box';
    Object.assign(box.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
    document.body.appendChild(box);
  }
  const label = document.createElement('div');
  label.className = 'g-label';
  label.innerHTML = `<span class="g-num">${n}</span>${text}`;
  document.body.appendChild(label);
  const lw = label.offsetWidth, lh = label.offsetHeight;
  const cx = L + W / 2, cy = T + H / 2;
  let lx, ly, ax, ay;
  if (side === 'right') { lx = L + W + gap; ly = cy - lh / 2; ax = L + W; ay = cy; }
  if (side === 'left') { lx = L - gap - lw; ly = cy - lh / 2; ax = L; ay = cy; }
  if (side === 'top') { lx = cx - lw / 2; ly = T - gap - lh; ax = cx; ay = T; }
  if (side === 'bottom') { lx = cx - lw / 2; ly = T + H + gap; ax = cx; ay = T + H; }
  lx += opts.dx || 0;
  ly += opts.dy || 0;
  label.style.left = lx + 'px';
  label.style.top = ly + 'px';
  const sx = side === 'right' ? lx : side === 'left' ? lx + lw : lx + lw / 2;
  const sy = side === 'top' ? ly + lh : side === 'bottom' ? ly : ly + lh / 2;
  drawArrow(sx, sy, ax, ay);
}
