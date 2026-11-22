// The files the README's screenshots show: drawings, documents, a video and a recording for a made-up
// kitchen renovation, so the list looks like a graph somebody uses. Everything is drawn here, in the
// page: nothing is downloaded and nothing is anybody's real file.
//
// buildDemoFiles() runs inside Roam's window (it is passed to page.evaluate), so it can't use
// anything from outside its own body. It returns { name: File }.
export async function buildDemoFiles() {
  const FONT = '-apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
  const canvas = (w, h, bg = '#fff') => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, w, h);
    return [c, x];
  };
  const blob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
  const text = (x, s, px, py, { size = 22, color = '#30404d', weight = 400, align = 'left', spacing = 0 } = {}) => {
    x.font = `${weight} ${size}px ${FONT}`; x.fillStyle = color; x.textAlign = align; x.textBaseline = 'alphabetic';
    if (spacing) x.letterSpacing = `${spacing}px`;
    x.fillText(s, px, py);
    if (spacing) x.letterSpacing = '0px';
  };
  const rr = (x, px, py, w, h, r) => { x.beginPath(); x.roundRect(px, py, w, h, r); };
  // the same "random" every run, so the pictures don't change from release to release
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  // ---- floor plans ----
  function plan(x, v1 = false) {
    const W = 1600, H = 1100;
    x.strokeStyle = '#e6edf2'; x.lineWidth = 1;
    for (let i = 0; i <= W; i += 50) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, H); x.stroke(); }
    for (let j = 0; j <= H; j += 50) { x.beginPath(); x.moveTo(0, j); x.lineTo(W, j); x.stroke(); }
    const wall = (pts) => { x.strokeStyle = '#243240'; x.lineWidth = 14; x.lineJoin = 'miter'; x.lineCap = 'butt'; x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.stroke(); };
    const gap = (a, b, c, d) => { x.strokeStyle = '#fff'; x.lineWidth = 18; x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); };
    const door = (cx, cy, r, from, to) => { x.strokeStyle = '#5c7080'; x.lineWidth = 3; x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, r, from, to); x.closePath(); x.stroke(); };
    const win = (a, b, c, d) => { gap(a, b, c, d); x.strokeStyle = '#48aff0'; x.lineWidth = 6; x.beginPath(); x.moveTo(a, b); x.lineTo(c, d); x.stroke(); };
    const unit = (px, py, w, h, fill = '#ebf1f5') => { x.fillStyle = fill; x.strokeStyle = '#8a9ba8'; x.lineWidth = 2.5; x.fillRect(px, py, w, h); x.strokeRect(px, py, w, h); };
    wall([[150, 150], [1450, 150], [1450, 950], [150, 950], [150, 143]]);
    wall(v1 ? [[820, 150], [820, 560]] : [[980, 150], [980, 470]]);
    wall(v1 ? [[820, 700], [820, 950]] : [[980, 640], [980, 950]]);
    wall([[150, 640], [430, 640]]);
    win(420, 150, 720, 150); win(1120, 150, 1340, 150); win(1450, 380, 1450, 620);
    gap(150, 760, 150, 880); door(150, 880, 120, -Math.PI / 2, 0);
    gap(300, 640, 400, 640);
    // counters along the walls, the sink, the hob
    unit(160, 160, v1 ? 650 : 810, 90); unit(160, 250, 90, 380);
    x.strokeStyle = '#8a9ba8'; x.lineWidth = 2.5; rr(x, 500, 172, 150, 66, 10); x.stroke(); rr(x, 512, 182, 60, 46, 6); x.stroke(); rr(x, 580, 182, 60, 46, 6); x.stroke();
    unit(172, 330, 66, 130, '#fff'); for (const [a, b] of [[190, 355], [220, 355], [190, 400], [220, 400]]) { x.beginPath(); x.arc(a, b + 15, 11, 0, 7); x.stroke(); }
    unit(v1 ? 700 : 850, 160, 110, 90, '#d8e1e8'); // fridge
    if (!v1) { unit(470, 430, 360, 150, '#f5f8fa'); for (const sx of [520, 610, 700, 790]) { x.beginPath(); x.arc(sx - 10, 625, 22, 0, 7); x.stroke(); } }
    // the table
    const [tx, ty] = v1 ? [1130, 520] : [1215, 620];
    x.fillStyle = '#f5f8fa'; x.beginPath(); x.ellipse(tx, ty, 130, 90, 0, 0, 7); x.fill(); x.stroke();
    for (let i = 0; i < 6; i++) { const a = (i / 6) * 2 * Math.PI; rr(x, tx + Math.cos(a) * 165 - 22, ty + Math.sin(a) * 125 - 22, 44, 44, 8); x.stroke(); }
    text(x, 'KITCHEN', v1 ? 480 : 640, v1 ? 520 : 350, { size: 30, weight: 600, color: '#5c7080', align: 'center', spacing: 4 });
    text(x, v1 ? '3.3 × 4.0 m' : '4.1 × 4.0 m', v1 ? 480 : 640, v1 ? 556 : 386, { size: 20, color: '#8a9ba8', align: 'center' });
    text(x, 'DINING', v1 ? 1130 : 1215, v1 ? 760 : 830, { size: 30, weight: 600, color: '#5c7080', align: 'center', spacing: 4 });
    text(x, 'PANTRY', 330, 730, { size: 24, weight: 600, color: '#5c7080', align: 'center', spacing: 3 });
    // dimension line and title block
    x.strokeStyle = '#8a9ba8'; x.lineWidth = 2; x.beginPath(); x.moveTo(150, 1010); x.lineTo(1450, 1010); x.moveTo(150, 995); x.lineTo(150, 1025); x.moveTo(1450, 995); x.lineTo(1450, 1025); x.stroke();
    text(x, '6.50 m', 800, 1045, { size: 20, color: '#5c7080', align: 'center' });
    text(x, v1 ? 'Kitchen, first layout (v1)' : 'Kitchen and dining, proposed layout', 150, 95, { size: 34, weight: 600, color: '#182026' });
    text(x, 'Scale 1:50', 1450, 95, { size: 20, color: '#8a9ba8', align: 'right' });
  }

  // ---- the north wall, seen from the front ----
  function elevation(x) {
    const door = (px, py, w, h, handle = 'r') => {
      x.fillStyle = '#f5f8fa'; x.strokeStyle = '#5c7080'; x.lineWidth = 3; x.fillRect(px, py, w, h); x.strokeRect(px, py, w, h);
      x.strokeStyle = '#a7b6c2'; x.lineWidth = 2; x.strokeRect(px + 14, py + 14, w - 28, h - 28);
      x.strokeStyle = '#30404d'; x.lineWidth = 5; x.lineCap = 'round'; x.beginPath();
      if (handle === 't') { x.moveTo(px + w / 2 - 26, py + 30); x.lineTo(px + w / 2 + 26, py + 30); } else { const hx = handle === 'r' ? px + w - 28 : px + 28; x.moveTo(hx, py + h / 2 - 28); x.lineTo(hx, py + h / 2 + 28); }
      x.stroke();
    };
    text(x, 'North wall elevation', 100, 90, { size: 34, weight: 600, color: '#182026' });
    for (let i = 0; i < 4; i++) door(100 + i * 180, 170, 180, 260, i % 2 ? 'l' : 'r');
    x.fillStyle = '#d8e1e8'; x.strokeStyle = '#5c7080'; x.lineWidth = 3; x.beginPath(); x.moveTo(850, 300); x.lineTo(1010, 300); x.lineTo(1050, 430); x.lineTo(810, 430); x.closePath(); x.fill(); x.stroke(); x.fillRect(895, 170, 70, 130); x.strokeRect(895, 170, 70, 130);
    for (let i = 0; i < 2; i++) door(1080 + i * 180, 170, 180, 260, i % 2 ? 'l' : 'r');
    x.fillStyle = '#30404d'; x.fillRect(90, 540, 1360, 22); // worktop
    for (let i = 0; i < 2; i++) door(100 + i * 180, 562, 180, 240, i % 2 ? 'l' : 'r');
    for (let i = 0; i < 3; i++) door(460, 562 + i * 80, 320, 80, 't');
    x.fillStyle = '#ebf1f5'; x.strokeStyle = '#5c7080'; x.lineWidth = 3; x.fillRect(810, 562, 240, 240); x.strokeRect(810, 562, 240, 240); rr(x, 835, 640, 190, 140, 8); x.stroke(); // oven
    for (let i = 0; i < 4; i++) { x.beginPath(); x.arc(850 + i * 54, 600, 12, 0, 7); x.stroke(); }
    for (let i = 0; i < 2; i++) door(1080 + i * 180, 562, 180, 240, i % 2 ? 'l' : 'r');
    x.fillStyle = '#5c7080'; x.fillRect(100, 802, 1340, 26);
    x.strokeStyle = '#8a9ba8'; x.lineWidth = 2; x.beginPath(); x.moveTo(1500, 170); x.lineTo(1500, 828); x.moveTo(1485, 170); x.lineTo(1515, 170); x.moveTo(1485, 828); x.lineTo(1515, 828); x.stroke();
    text(x, '2.30 m', 1530, 505, { size: 20, color: '#5c7080' });
  }

  // ---- paint and worktop samples ----
  function swatches(x, title, items, cols) {
    text(x, title, 70, 95, { size: 36, weight: 600, color: '#182026' });
    const w = (1200 - 140 - (cols - 1) * 30) / cols;
    items.forEach(([name, code, color, speckle], i) => {
      const px = 70 + (i % cols) * (w + 30), py = 150 + Math.floor(i / cols) * 300;
      x.save(); rr(x, px, py, w, 200, 14); x.clip(); x.fillStyle = color; x.fillRect(px, py, w, 200);
      if (speckle) for (let k = 0; k < 900; k++) { x.fillStyle = speckle[Math.floor(rnd() * speckle.length)]; x.globalAlpha = 0.5; x.beginPath(); x.arc(px + rnd() * w, py + rnd() * 200, 1 + rnd() * 3.5, 0, 7); x.fill(); }
      x.restore(); x.globalAlpha = 1; x.strokeStyle = 'rgba(16,22,26,.15)'; x.lineWidth = 2; rr(x, px, py, w, 200, 14); x.stroke();
      text(x, name, px + 4, py + 238, { size: 24, weight: 600, color: '#182026' });
      text(x, code, px + 4, py + 268, { size: 19, color: '#8a9ba8' });
    });
  }

  // ---- four tile patterns ----
  function tiles(x) {
    const cell = (px, py, draw) => { x.save(); x.beginPath(); x.rect(px, py, 540, 540); x.clip(); x.translate(px, py); draw(); x.restore(); };
    cell(40, 40, () => { // herringbone
      x.fillStyle = '#e9e2d6'; x.fillRect(0, 0, 540, 540); x.strokeStyle = '#fff'; x.lineWidth = 4;
      for (let r = -2; r < 12; r++) for (let c = -2; c < 12; c++) { const px = c * 104 + (r % 2) * 52, py = r * 52; x.save(); x.translate(px, py); x.rotate(((r + c) % 2 ? 1 : -1) * Math.PI / 4); x.fillStyle = ['#d6c9b4', '#cbbda6', '#ddd2c0'][(r * 3 + c * 5 + 40) % 3]; x.fillRect(-52, -18, 104, 36); x.strokeRect(-52, -18, 104, 36); x.restore(); }
    });
    cell(620, 40, () => { // hexagons
      x.fillStyle = '#f5f8fa'; x.fillRect(0, 0, 540, 540);
      for (let r = -1; r < 9; r++) for (let c = -1; c < 8; c++) { const cx = c * 87 + (r % 2 ? 43 : 0), cy = r * 75; x.beginPath(); for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; x.lineTo(cx + 46 * Math.cos(a), cy + 46 * Math.sin(a)); } x.closePath(); x.fillStyle = ['#7d9c8c', '#94ae9f', '#6b8a7a', '#a9bfb2'][(r * 7 + c * 3 + 30) % 4]; x.fill(); x.strokeStyle = '#f5f8fa'; x.lineWidth = 5; x.stroke(); }
    });
    cell(40, 620, () => { // subway
      x.fillStyle = '#fff'; x.fillRect(0, 0, 540, 540);
      for (let r = 0; r < 9; r++) for (let c = -1; c < 5; c++) { x.fillStyle = ['#2f5d7c', '#356a8c', '#2a5470'][(r + c * 2 + 9) % 3]; x.fillRect(c * 140 + (r % 2) * 70 + 3, r * 64 + 3, 134, 58); }
    });
    cell(620, 620, () => { // checker
      for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) { x.fillStyle = (r + c) % 2 ? '#30404d' : '#f1ebe1'; x.fillRect(c * 90, r * 90, 90, 90); }
    });
  }

  // ---- budget chart ----
  const BUDGET = [['Cabinets', 6800, 7150], ['Worktops', 3200, 2950], ['Appliances', 4100, 4380], ['Labour', 5600, 3900], ['Lighting', 900, 640], ['Paint', 450, 310]];
  function chart(x) {
    text(x, 'Kitchen budget', 90, 95, { size: 36, weight: 600, color: '#182026' });
    x.fillStyle = '#a7b6c2'; x.fillRect(1010, 70, 26, 26); text(x, 'Planned', 1046, 92, { size: 22 });
    x.fillStyle = '#137cbd'; x.fillRect(1180, 70, 26, 26); text(x, 'Spent', 1216, 92, { size: 22 });
    const y0 = 760, k = 560 / 8000;
    for (let v = 0; v <= 8000; v += 2000) { x.strokeStyle = '#e1e8ed'; x.lineWidth = 2; x.beginPath(); x.moveTo(170, y0 - v * k); x.lineTo(1320, y0 - v * k); x.stroke(); text(x, v.toLocaleString('en-US'), 150, y0 - v * k + 7, { size: 20, color: '#8a9ba8', align: 'right' }); }
    BUDGET.forEach(([name, planned, spent], i) => {
      const px = 210 + i * 188;
      x.fillStyle = '#a7b6c2'; rr(x, px, y0 - planned * k, 62, planned * k, [6, 6, 0, 0]); x.fill();
      x.fillStyle = '#137cbd'; rr(x, px + 70, y0 - spent * k, 62, spent * k, [6, 6, 0, 0]); x.fill();
      text(x, name, px + 66, y0 + 40, { size: 22, color: '#30404d', align: 'center' });
    });
  }

  // ---- documents, drawn as a page and wrapped in a PDF ----
  function quotePage(x) {
    x.fillStyle = '#2f5d7c'; x.fillRect(0, 0, 1240, 150);
    text(x, 'Harbour & Pine Joinery', 90, 95, { size: 44, weight: 600, color: '#fff' });
    text(x, 'Quote 0417', 1150, 95, { size: 26, color: '#d8e1e8', align: 'right' });
    text(x, 'Kitchen refit: cabinets, worktops and fitting', 90, 240, { size: 30, weight: 600, color: '#182026' });
    text(x, 'Valid for 30 days. Prices include materials.', 90, 285, { size: 22, color: '#5c7080' });
    const lines = [['Base cabinets, oak veneer, 7 units', '3,150'], ['Wall cabinets, 6 units', '2,240'], ['Drawer stack, soft close', '680'], ['Worktop, composite stone, 5.2 m', '2,950'], ['Splashback tiling', '540'], ['Removal of old kitchen', '420'], ['Fitting, 6 days', '2,700']];
    x.fillStyle = '#ebf1f5'; x.fillRect(90, 340, 1060, 56); text(x, 'ITEM', 110, 377, { size: 20, weight: 600, color: '#5c7080', spacing: 2 }); text(x, 'PRICE', 1130, 377, { size: 20, weight: 600, color: '#5c7080', align: 'right', spacing: 2 });
    lines.forEach(([item, price], i) => { const py = 450 + i * 66; text(x, item, 110, py, { size: 24 }); text(x, price, 1130, py, { size: 24, align: 'right' }); x.strokeStyle = '#e1e8ed'; x.lineWidth = 2; x.beginPath(); x.moveTo(90, py + 24); x.lineTo(1150, py + 24); x.stroke(); });
    text(x, 'Total', 110, 960, { size: 28, weight: 600, color: '#182026' }); text(x, '12,680', 1130, 960, { size: 28, weight: 600, color: '#182026', align: 'right' });
    for (let i = 0; i < 5; i++) { x.fillStyle = '#e1e8ed'; x.fillRect(90, 1080 + i * 44, 1060 - (i === 4 ? 420 : (i * 97) % 180), 16); }
    text(x, 'Harbour & Pine Joinery · 12 Quay Lane', 620, 1680, { size: 20, color: '#8a9ba8', align: 'center' });
  }
  function specPage(x) {
    text(x, 'Appliance specifications', 90, 130, { size: 44, weight: 600, color: '#182026' });
    text(x, 'Sizes the cabinets have to leave room for', 90, 180, { size: 24, color: '#5c7080' });
    const rows = [['Oven', '595 × 595 × 548 mm', '3.5 kW'], ['Hob, induction', '590 × 520 × 56 mm', '7.4 kW'], ['Fridge freezer', '595 × 1860 × 655 mm', '0.15 kW'], ['Dishwasher', '598 × 815 × 550 mm', '2.0 kW'], ['Extractor', '598 × 250 × 480 mm', '0.25 kW']];
    x.fillStyle = '#ebf1f5'; x.fillRect(90, 250, 1060, 56);
    ['APPLIANCE', 'W × H × D', 'POWER'].forEach((t, i) => text(x, t, [110, 520, 960][i], 287, { size: 20, weight: 600, color: '#5c7080', spacing: 2 }));
    rows.forEach((r, i) => { const py = 362 + i * 66; r.forEach((t, k) => text(x, t, [110, 520, 960][k], py, { size: 24 })); x.strokeStyle = '#e1e8ed'; x.lineWidth = 2; x.beginPath(); x.moveTo(90, py + 24); x.lineTo(1150, py + 24); x.stroke(); });
    x.strokeStyle = '#5c7080'; x.lineWidth = 3; x.strokeRect(190, 800, 300, 300); rr(x, 220, 880, 240, 190, 8); x.stroke(); x.strokeRect(640, 780, 250, 480); x.beginPath(); x.moveTo(640, 960); x.lineTo(890, 960); x.stroke();
    text(x, 'Oven', 340, 1145, { size: 22, color: '#5c7080', align: 'center' }); text(x, 'Fridge freezer', 765, 1305, { size: 22, color: '#5c7080', align: 'center' });
    for (let i = 0; i < 4; i++) { x.fillStyle = '#e1e8ed'; x.fillRect(90, 1420 + i * 44, 1060 - (i * 131) % 260, 16); }
  }
  async function pdf(draw) {
    const [c, x] = canvas(1240, 1754); draw(x);
    const jpeg = new Uint8Array(await (await blob(c, 'image/jpeg', 0.9)).arrayBuffer());
    const enc = new TextEncoder(), parts = [], offsets = []; let at = 0;
    const put = (p) => { const b = typeof p === 'string' ? enc.encode(p) : p; parts.push(b); at += b.length; };
    const obj = (n, body) => { offsets[n] = at; put(`${n} 0 obj\n`); for (const p of body) put(p); put('\nendobj\n'); };
    const page = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    put('%PDF-1.4\n');
    obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
    obj(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>']);
    obj(4, [`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
    obj(5, [`<< /Length ${page.length} >>\nstream\n${page}\nendstream`]);
    const xref = at;
    put(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ---- a short video: the route through the new kitchen, drawn on the plan ----
  async function video() {
    const [pc, px] = canvas(1600, 1100); plan(px);
    const [c, x] = canvas(960, 540, '#fff');
    const route = [[150, 820], [420, 800], [620, 690], [900, 610], [1215, 480], [1215, 620]];
    const frame = (t) => {
      const zoom = 1.15 + 0.35 * t, cx = 500 + 500 * t, cy = 640 - 60 * t;
      x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = '#fff'; x.fillRect(0, 0, 960, 540);
      const k = (960 / 1600) * zoom; x.setTransform(k, 0, 0, k, 480 - cx * k, 270 - cy * k);
      x.drawImage(pc, 0, 0);
      const at = t * (route.length - 1), i = Math.min(route.length - 2, Math.floor(at)), f = at - i;
      x.strokeStyle = '#db3737'; x.lineWidth = 8; x.lineJoin = 'round'; x.lineCap = 'round'; x.setLineDash([4, 18]); x.beginPath();
      route.slice(0, i + 1).forEach(([a, b], n) => (n ? x.lineTo(a, b) : x.moveTo(a, b)));
      const hx = route[i][0] + (route[i + 1][0] - route[i][0]) * f, hy = route[i][1] + (route[i + 1][1] - route[i][1]) * f;
      x.lineTo(hx, hy); x.stroke(); x.setLineDash([]);
      x.fillStyle = '#db3737'; x.beginPath(); x.arc(hx, hy, 16, 0, 7); x.fill(); x.strokeStyle = '#fff'; x.lineWidth = 5; x.stroke();
    };
    frame(0.55); // the recording opens on a frame that shows something
    const type = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: type, videoBitsPerSecond: 1_500_000 });
    const chunks = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(200);
    const SECONDS = 4, t0 = performance.now();
    await new Promise((res) => { const tick = setInterval(() => { const t = (performance.now() - t0) / (SECONDS * 1000); frame((0.55 + t) % 1); if (t >= 1) { clearInterval(tick); res(); } }, 40); });
    rec.stop(); await stopped;
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    return new File(chunks, `walkthrough-route.${ext}`, { type: type.split(';')[0] });
  }

  // ---- a recording: a few seconds of sound, as a WAV file ----
  function wav() {
    const rate = 16000, n = rate * 9, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const t = i / rate, env = Math.max(0, Math.sin(t * 2.3)) ** 2; v.setInt16(44 + i * 2, (Math.sin(t * 2 * Math.PI * (180 + 40 * Math.sin(t * 5))) * 0.25 + (rnd() - 0.5) * 0.05) * env * 32767, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }

  const png = async (w, h, draw) => { const [c, x] = canvas(w, h); draw(x); return blob(c, 'image/png'); };
  const jpg = async (w, h, draw) => { const [c, x] = canvas(w, h, '#fbfaf7'); draw(x); return blob(c, 'image/jpeg', 0.92); };
  const csv = ['Category,Item,Planned,Spent,Paid on', ...BUDGET.flatMap(([cat, planned, spent]) => [1, 2, 3, 4].map((i) => `${cat},${cat} part ${i},${Math.round(planned / 4)},${Math.round(spent / 4)},2026-0${i + 2}-1${i}`))].join('\n');

  const files = {
    'kitchen-floor-plan.png': await png(1600, 1100, (x) => plan(x)),
    'north-wall-elevation.png': await png(1600, 900, elevation),
    'paint-shortlist.png': await png(1200, 780, (x) => swatches(x, 'Paint shortlist', [['Sea Salt', 'Walls · 2 coats', '#dfe7e1'], ['Oat Milk', 'Ceiling', '#efe6d6'], ['Sage Leaf', 'Cabinets', '#9db39f'], ['Clay Pot', 'Pantry door', '#c98b6b'], ['Ink Blue', 'Island', '#2f4a63'], ['Warm White', 'Trim', '#f7f3ea']], 3)),
    'worktop-samples.jpg': await jpg(1200, 480, (x) => swatches(x, 'Worktop samples', [['Composite stone', 'Pale grey', '#d9dcd9', ['#b9bdb9', '#f4f4f1', '#8f9591']], ['Oak block', 'Oiled', '#c79a63', ['#b48650', '#d6ad78']], ['Terrazzo', 'Charcoal', '#3d4449', ['#e9e2d6', '#c98b6b', '#9db39f', '#f5f8fa']]], 3)),
    'tile-samples.jpg': await jpg(1200, 1200, tiles),
    'budget-chart.png': await png(1400, 860, chart),
    'joinery-quote.pdf': await pdf(quotePage),
    'budget.csv': new Blob([csv], { type: 'text/csv' }),
    'site-visit-voice-memo.wav': wav(),
    // the two that end up in no block
    'kitchen-layout-v1.png': await png(1600, 1100, (x) => plan(x, true)),
    'appliance-specifications.pdf': await pdf(specPage),
  };
  const made = {};
  for (const [name, b] of Object.entries(files)) made[name] = new File([b], name, { type: b.type });
  const v = await video(); made[v.name] = v;
  // In the order they are uploaded. The list opens with the newest first, so it reads from the bottom up.
  const order = ['kitchen-layout-v1.png', 'appliance-specifications.pdf', 'kitchen-floor-plan.png', 'north-wall-elevation.png', 'budget-chart.png', 'budget.csv',
    'tile-samples.jpg', v.name, 'site-visit-voice-memo.wav', 'joinery-quote.pdf', 'worktop-samples.jpg', 'paint-shortlist.png'];
  return Object.fromEntries(order.map((name) => [name, made[name]]));
}
