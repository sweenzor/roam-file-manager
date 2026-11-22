// Quick look at the built extension in Roam's public help graph, in a headless browser. No sign-in.
// The help graph is read-only and has several hundred uploaded files, so it shows the list, sorting,
// search and sizes. Deleting is covered by the real-Roam run (test/real-roam.mjs), on a test graph.
//
//   npm run build && node test/help-graph.mjs [out-dir]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();

const OUT = path.resolve(process.argv[2] || 'real-roam-out/help');
fs.mkdirSync(OUT, { recursive: true });
const code = fs.readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.text().includes('roam-file-manager')) console.log('[page]', m.text().slice(0, 300)); });
await page.goto('https://roamresearch.com/#/app/help', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.roamAlphaAPI && document.querySelector('.rm-title-display, .roam-log-container'), null, { timeout: 90000 });
await page.waitForTimeout(3000);
// the help graph's own warning toast, which stays; the extension's toast is not in Roam's portal
await page.addStyleTag({ content: '.bp3-portal .bp3-toast-container{display:none!important}' });
await page.evaluate(async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  window.__ext = (await import(url)).default;
  window.__ext.onload({ extensionAPI: {} });
  await window.roamAlphaAPI.ui.leftSidebar.open();
}, code);
await page.waitForSelector('.rm-left-sidebar__files');
check('Files row sits under All Pages', await page.evaluate(() => document.querySelector('.rm-left-sidebar__all-pages').nextElementSibling?.classList.contains('rm-left-sidebar__files')));
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)', { timeout: 30000 });
const t0 = Date.now();
await page.waitForFunction(() => [...document.querySelectorAll('.rfm-view .rfm-col-size')].slice(1, 12).every((e) => e.textContent), null, { timeout: 60000 });
console.log('sizes on the first screen after', Date.now() - t0, 'ms');
// several hundred files to fetch sizes for: a progress box in the middle of the view, and the list waits under it
const loader = () => page.evaluate(() => {
  const box = document.querySelector('.rfm-view .rfm-loader-box'), view = document.querySelector('.rfm-view');
  if (!box) return null;
  const b = box.getBoundingClientRect(), v = view.getBoundingClientRect();
  const hit = document.elementFromPoint(v.left + 80, v.top + 200);
  return {
    pct: parseInt(box.querySelector('.bp3-progress-meter').style.width, 10),
    dx: Math.round(b.left + b.width / 2 - (v.left + v.width / 2)), dy: Math.round(b.top + b.height / 2 - (v.top + innerHeight) / 2),
    text: box.textContent, striped: !!box.querySelector('.bp3-progress-bar.bp3-intent-primary:not(.bp3-no-stripes)'),
    locked: [...view.querySelectorAll(':scope > .rm-pages-toolbar, :scope > .table')].every((e) => e.inert && getComputedStyle(e).pointerEvents === 'none'),
    dimmed: +getComputedStyle(view.querySelector(':scope > .table')).opacity < 0.6, onTop: !!hit?.closest('.rfm-loader'),
  };
});
const early = await loader();
check('a first load with many files shows a progress box at once', early !== null && Date.now() - t0 < 1500, `${Date.now() - t0} ms, ${early?.pct}%`);
check('the box is in the middle of the view: a striped bar, no text', early && early.dx === 0 && Math.abs(early.dy) <= 1 && early.text === '' && early.striped, JSON.stringify(early));
check('the list under it is dimmed and takes no clicks or keys', early && early.locked && early.dimmed && early.onTop);
const sortedBy = () => page.evaluate(() => document.querySelector('.rfm-view .sort-button.focused')?.closest('[data-col]')?.dataset.col);
await page.mouse.click(...(await page.evaluate(() => { const r = document.querySelector('.rfm-view [data-col="size"] .sort-button.desc').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })));
check('a click on a sort arrow does nothing while it loads', (await loader()) !== null && (await sortedBy()) === 'added', await sortedBy());
await page.waitForTimeout(1500);
const later = await loader();
check('the bar moves on', early && (later === null || later.pct > early.pct), `${early?.pct}% then ${later?.pct}%`);
await page.screenshot({ path: path.join(OUT, '0-first-load.png') });
await page.waitForFunction(() => !document.querySelector('.rfm-view .rfm-loader'), null, { timeout: 60000 }).catch(() => {});
check('when every file has its size the box goes and the list can be used', await page.evaluate(() => {
  const view = document.querySelector('.rfm-view');
  return !view.querySelector('.rfm-loader') && !view.classList.contains('rfm-loading') && !view.querySelector('[inert]');
}));
const info = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')];
  const sc = document.querySelector('.rfm-scroller');
  return { dom: rows.length, total: Math.round(sc.firstElementChild.offsetHeight / 39), first: rows.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim()) };
});
let i = await info();
check('lists the graph\'s files', i.total > 100, `${i.total} files`);
const count = () => page.evaluate(() => { const c = document.querySelector('.rfm-view .rm-pages-toolbar .toolbar-action-button-group .rfm-count'); return c ? c.textContent : null; });
const ALL = i.total;
check('the toolbar counts every file', (await count()) === `${ALL} Files`, await count());
// reading the graph: the same files as one query for everything, in pieces that each hold Roam up only briefly
const read = await page.evaluate(async () => {
  const d = window.roamAlphaAPI.data;
  const all = d.q('[:find ?uid :where [?b :block/string ?s] [(clojure.string/includes? ?s "firebasestorage.googleapis.com")] [?b :block/uid ?uid] [?b :block/page ?p] [?p :block/uid] [?p :node/title]]').length;
  const keys = new Set();
  for (const [s] of d.q('[:find ?s :where [?b :block/string ?s] [(clojure.string/includes? ?s "firebasestorage.googleapis.com")] [?b :block/page ?p] [?p :node/title]]')) for (const m of s.matchAll(/\/o\/([^?#\s)}\]"'<>`]+)/g)) keys.add(m[1]);
  return { blocks: all, files: keys.size };
});
check('every file a query for all of it finds is listed', read.files === i.total, `${read.files} in ${read.blocks} blocks, ${i.total} listed`);
check('draws only the rows in view', i.dom < 60, `${i.dom} rows in the DOM`);
check('sorted by date added, newest first', await page.evaluate(() => document.querySelector('[data-col="added"] .sort-button.desc').classList.contains('focused')));
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, '1-all-files.png') });

// scroll far: rows are swapped, not added
const fps = await page.evaluate(async () => {
  const sc = document.querySelector('.rfm-scroller'); let frames = 0; const t0 = performance.now();
  await new Promise((res) => { const step = () => { sc.scrollTop += 120; frames++; if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 || frames > 600) res(); else requestAnimationFrame(step); }; step(); });
  return { frames, ms: Math.round(performance.now() - t0) };
});
i = await info();
check('still few rows after scrolling to the end', i.dom < 60, `${i.dom} rows, ${fps.frames} frames in ${fps.ms} ms`);

// sort by size, biggest first
await page.click('.rfm-view [data-col="size"] .sort-button.desc');
await page.waitForTimeout(500);
const sizes = await page.evaluate(() => [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header) .rfm-col-size')].slice(0, 5).map((e) => e.textContent));
check('sorts by size', /MB|GB/.test(sizes[0]), sizes.join(', '));
await page.screenshot({ path: path.join(OUT, '2-by-size.png') });

// search
await page.fill('.rfm-view .search-input', 'pdf');
await page.waitForTimeout(400);
i = await info();
check('search narrows the list', i.total > 0 && i.total < 100, `${i.total} match "pdf"`);
check('while a search narrows it the count reads shown / all', (await count()) === `${i.total} / ${ALL} Files`, await count());
await page.fill('.rfm-view .search-input', '');

// filter: nothing unused in a graph just scanned; trash stays off
await page.click('.rfm-view .bp3-icon-filter');
await page.evaluate(() => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === 'Unused').querySelector('input').click());
await page.waitForTimeout(400);
i = await info();
check('Unused filter shows nothing when every file is in use', i.total === 0);
await page.screenshot({ path: path.join(OUT, '3-filter.png') });
await page.evaluate(() => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === 'Unused').querySelector('input').click());
await page.mouse.click(700, 700);
await page.evaluate(() => document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header) input:not([disabled])').click());
check('a file stored under another graph cannot be ticked', await page.evaluate(() => document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header) input[disabled]').length > 0));
check('trash is on for a ticked file', await page.evaluate(() => !document.querySelector('.rfm-view .bp3-icon-trash').disabled));
// the confirmation for a file that is in use. Nothing is ever confirmed here: this is Roam's own help graph.
await page.click('.rfm-view .bp3-icon-trash');
await page.waitForSelector('.confirmation-content-dialog');
const warn = await page.evaluate(() => document.querySelector('.rfm-delete-warning')?.innerText.replace(/\s+/g, ' ') ?? '');
check('deleting a file in use warns about broken blocks', /can't be undone/.test(warn) && /This file is still referenced in \d+ blocks?, which will be left with (a )?broken (image|link)s?\./.test(warn), warn);
check('the confirmation shows the file\'s picture or icon, and no Enter shortcut', await page.evaluate(() => document.querySelectorAll('.confirmation-content-dialog .rfm-delete-thumb').length === 1 && !document.querySelector('.confirmation-content-dialog .confirm-button .bp3-icon-key-enter')));
await page.screenshot({ path: path.join(OUT, '3b-delete-in-use.png') });
await page.click('.confirmation-content-dialog .cancel-button');
await page.waitForTimeout(300);
check('Cancel closes the confirmation', await page.evaluate(() => !document.querySelector('.confirmation-content-dialog')));
// the mentions count in the confirmation: a click shows the blocks, the dialog goes away and the tick stays
await page.click('.rfm-view .bp3-icon-trash');
await page.waitForSelector('.confirmation-content-dialog');
const chip = await page.evaluate(() => document.querySelector('.confirmation-content-dialog .rfm-delete-item .rm-clickable-pill')?.textContent);
check('the confirmation shows each file\'s mentions count', +chip > 0, chip);
await page.click('.confirmation-content-dialog .rfm-delete-item .rm-clickable-pill');
await page.waitForFunction((n) => window.roamAlphaAPI.ui.rightSidebar.getWindows().filter((w) => w.type === 'block').length === n, +chip, { timeout: 10000 }).catch(() => {});
check('a click on it opens the blocks, closes the confirmation and keeps the tick', await page.evaluate((n) => window.roamAlphaAPI.ui.rightSidebar.getWindows().filter((w) => w.type === 'block').length === n
  && !document.querySelector('.confirmation-content-dialog') && document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header) input:checked').length === 1, +chip));
await page.evaluate(async () => { const s = window.roamAlphaAPI.ui.rightSidebar; for (const w of s.getWindows()) await s.removeWindow({ window: { type: w.type, 'block-uid': w['block-uid'] } }); await s.close(); });
await page.waitForTimeout(800);

// a file in several blocks: one count, the pages in grey after the name, and a click opens the blocks in the right sidebar
await page.evaluate(() => document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header) input:not([disabled])').click());
await page.click('.rfm-view [data-col="mentions"] .sort-button.desc');
await page.waitForTimeout(500);
const multi = await page.evaluate(() => { const r = document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)'); return { mentions: +r.querySelector('.rfm-col-mentions').textContent, pages: r.querySelector('.title-children-text')?.textContent ?? '' }; });
check('a file in several blocks counts its mentions and names its pages', multi.mentions > 1 && multi.pages.length > 0, `${multi.mentions} mentions on ${multi.pages}`);
check('the columns are Type, Size, Mentions and Added', await page.evaluate(() => [...document.querySelectorAll('.rfm-view .rm-pages-row-header .rm-pages-col')].map((c) => c.textContent).join(' ') === 'TYPE SIZE MENTIONS ADDED'));
// each column can be hidden, as in All Pages
await page.click('.rfm-view .bp3-icon-eye-open');
for (const name of ['Type', 'Size', 'Mentions', 'Added']) {
  const sw = () => page.evaluate((name) => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === name).querySelector('input').click(), name);
  await sw();
  const hidden = await page.evaluate(() => [...document.querySelectorAll('.rfm-view .rm-pages-row-header .rm-pages-col')].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent).join(' '));
  check(`the ${name} column can be hidden`, !hidden.includes(name.toUpperCase()), hidden);
  await sw();
}
await page.mouse.click(700, 760);
await page.waitForTimeout(300);
await page.click('.rfm-view .rm-pages-row:not(.rm-pages-row-header) .rm-clickable-pill');
await page.waitForFunction((n) => window.roamAlphaAPI.ui.rightSidebar.getWindows().filter((w) => w.type === 'block').length === n && !!document.querySelector('#right-sidebar .rm-sidebar-window'), multi.mentions, { timeout: 10000 })
  .then(() => check('its count opens every block that holds it in the right sidebar', true), () => check('its count opens every block that holds it in the right sidebar', false));
check('the list stays open', await page.evaluate(() => !!document.querySelector('.rfm-view')));
await page.waitForTimeout(1500);
// next to the right sidebar the columns close up: nothing runs off the edge, and names keep their room
await page.evaluate(() => window.roamAlphaAPI.ui.leftSidebar.close());
await page.waitForTimeout(1000);
const fit = await page.evaluate(() => {
  const sc = document.querySelector('.rfm-scroller'), head = document.querySelector('.rfm-view .rm-pages-row-header');
  return { view: document.querySelector('.rfm-view').clientWidth, over: Math.max(sc.scrollWidth - sc.clientWidth, head.scrollWidth - head.clientWidth), name: Math.round(document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header) .rm-pages-title-col').getBoundingClientRect().width) };
});
check('with the right sidebar open the columns fit and names keep their room', fit.view < 1000 && fit.over <= 0 && fit.name >= 200, JSON.stringify(fit));
await page.evaluate(() => window.roamAlphaAPI.ui.leftSidebar.open());
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, '4-mentions-in-sidebar.png') });
await page.evaluate(async () => { const s = window.roamAlphaAPI.ui.rightSidebar; for (const w of s.getWindows()) await s.removeWindow({ window: { type: w.type, 'block-uid': w['block-uid'] } }); await s.close(); });
await page.waitForTimeout(800);

// hovering a picture's thumbnail or icon shows the picture
await page.click('.rfm-view [data-col="size"] .sort-button.desc');
await page.fill('.rfm-view .search-input', 'png');
await page.waitForTimeout(500);
await page.hover('.rfm-view .rm-pages-row:not(.rm-pages-row-header) .rfm-thumb-icon');
await page.waitForFunction(() => { const i = document.querySelector('.rfm-preview-img'); return i && i.complete && i.naturalWidth > 0 && i.closest('.bp3-transition-container').style.visibility !== 'hidden'; }, null, { timeout: 30000 })
  .then(() => check('hovering an image\'s icon shows the image', true), () => check('hovering an image\'s icon shows the image', false));
await page.screenshot({ path: path.join(OUT, '5-hover-preview.png') });
await page.mouse.move(700, 60);
await page.waitForTimeout(300);
check('the preview goes away with the pointer', await page.evaluate(() => !document.querySelector('.rfm-preview-img')));
// hovering a video's icon plays it, and the preview stays while the pointer is on it
await page.fill('.rfm-view .search-input', 'mp4');
await page.click('.rfm-view [data-col="size"] .sort-button:not(.desc)');
await page.waitForTimeout(500);
// a video's row shows a frame of the video, decoded once and kept on the device
await page.waitForFunction(() => { const r = [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')]; return r.length > 0 && r.every((e) => { const i = e.querySelector('.rfm-still img'); return i && i.naturalWidth > 0; }); }, null, { timeout: 60000 })
  .then(() => check('every MP4 in view shows a frame of the video', true), () => check('every MP4 in view shows a frame of the video', false));
check('the frames are kept on the device', await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('roam-file-manager'); r.onsuccess = () => { const q = r.result.transaction('meta').objectStore('meta').getAllKeys(); q.onsuccess = () => res(q.result.filter((k) => String(k).startsWith('still|')).length > 0); }; r.onerror = () => res(false); })));
await page.screenshot({ path: path.join(OUT, '5a-video-stills.png') });
await page.hover('.rfm-view .rm-pages-row:not(.rm-pages-row-header) .rfm-still');
await page.waitForFunction(() => { const v = document.querySelector('video.rfm-preview-video'); return v && v.readyState >= 2 && v.currentTime > 0.2 && !v.paused && v.muted && v.controls; }, null, { timeout: 30000 })
  .then(() => check('hovering a video\'s icon plays the video, without sound', true), () => check('hovering a video\'s icon plays the video, without sound', false));
await page.screenshot({ path: path.join(OUT, '5b-video-preview.png') });
const onVideo = await page.evaluate(() => { const r = document.querySelector('video.rfm-preview-video')?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
if (onVideo) await page.mouse.move(onVideo.x, onVideo.y, { steps: 5 });
await page.waitForTimeout(800);
check('the video stays while the pointer is on it', await page.evaluate(() => !!document.querySelector('video.rfm-preview-video')));
await page.mouse.move(1250, 780, { steps: 3 });
await page.waitForTimeout(600);
check('and goes away with the pointer', await page.evaluate(() => !document.querySelector('video.rfm-preview-video')));
await page.fill('.rfm-view .search-input', '');
await page.click('.rfm-view [data-col="added"] .sort-button.desc');

// thumbnail view: the button beside the filter swaps the rows for tiles, and the header keeps sorting them
await page.click('.rfm-view .rfm-grid-button');
await page.waitForSelector('.rfm-view .rfm-tile');
const grid = await page.evaluate(() => {
  const tiles = [...document.querySelectorAll('.rfm-view .rfm-tile')];
  const tops = new Set(tiles.map((t) => t.style.top));
  return { tiles: tiles.length, perLine: tiles.filter((t) => t.style.top === '0px').length, lines: tops.size, rows: document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)').length,
    pressed: document.querySelector('.rfm-view .rfm-grid-button').classList.contains('bp3-active') };
});
check('the thumbnail button shows tiles, several to a line, in place of the rows', grid.perLine > 1 && grid.rows === 0 && grid.pressed, `${grid.perLine} to a line`);
check('draws only the tiles in view', grid.tiles < 80, `${grid.tiles} tiles in the DOM`);
await page.waitForFunction(() => [...document.querySelectorAll('.rfm-view .rfm-tile img')].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 })
  .then(() => check('a tile shows its picture', true), () => check('a tile shows its picture', false));
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(OUT, '6-thumbnails.png') });
check('thumbnails have no column header', await page.evaluate(() => getComputedStyle(document.querySelector('.rfm-view .rm-pages-row-header')).display === 'none'));
await page.click('.rfm-view .rfm-sort-button');
check('the sort button beside the search opens a menu with what is in use marked', await page.evaluate(() => {
  const items = [...document.querySelectorAll('.rfm-sort-menu .bp3-menu-item')];
  return items.length === 10 && items.filter((e) => e.classList.contains('bp3-active')).map((e) => e.innerText.trim()).join() === 'Added (newest first)';
}));
await page.screenshot({ path: path.join(OUT, '6b-sort-menu.png') });
await page.click('.rfm-sort-menu [data-sort="size-desc"]');
await page.waitForTimeout(500);
const tileSizes = await page.evaluate(() => [...document.querySelectorAll('.rfm-view .rfm-tile .rfm-col-size')].slice(0, 3).map((e) => e.textContent));
const mb = (t) => parseFloat(t) * ({ KB: 1 / 1024, MB: 1, GB: 1024 }[t.split(' ')[1]] ?? 0);
check('the menu sorts the tiles', tileSizes.length === 3 && mb(tileSizes[0]) >= mb(tileSizes[1]) && mb(tileSizes[1]) >= mb(tileSizes[2]) && mb(tileSizes[0]) > 1, `${tileSizes.join(', ')} (list had ${sizes.slice(0, 3).join(', ')})`);
// a video plays in its tile
await page.fill('.rfm-view .search-input', 'mp4');
await page.waitForSelector('.rfm-view .rfm-tile video', { timeout: 30000 }).catch(() => {});
const atRest = await page.evaluate(() => { const v = document.querySelector('.rfm-view .rfm-tile video'); return v ? `${v.controls} ${v.preload} ${v.readyState}` : 'no video'; });
check('a video tile at rest is its still alone: no controls, nothing fetched', atRest === 'false none 0', atRest);
await page.hover('.rfm-view .rfm-tile video');
const played = await page.evaluate(async () => {
  const v = document.querySelector('.rfm-view .rfm-tile video');
  if (!v || !v.controls) return 'no video with controls';
  const t = v.currentTime; v.muted = true;
  try { await v.play(); } catch (e) { return String(e); }
  await new Promise((r) => setTimeout(r, 1500));
  const moved = v.currentTime > t; v.pause();
  return moved ? 'ok' : 'did not advance';
});
check('a video plays in its tile', played === 'ok', played);
await page.screenshot({ path: path.join(OUT, '7-video-tile.png') });
await page.fill('.rfm-view .search-input', '');
await page.waitForTimeout(300);
await page.click('.rfm-view .rfm-sort-button');
await page.click('.rfm-sort-menu [data-sort="size-asc"]');
await page.waitForTimeout(500);
const smallest = await page.evaluate(() => document.querySelector('.rfm-view .rfm-tile .rfm-col-size').textContent);
check('the menu sorts the other way round too', smallest !== tileSizes[0], smallest);
await page.click('.rfm-view .rfm-sort-button');
await page.click('.rfm-sort-menu [data-sort="size-desc"]');
await page.evaluate(() => document.querySelector('.rfm-view .rfm-grid-all').click());
check('the box by the trash ticks every tile', await page.evaluate(() => [...document.querySelectorAll('.rfm-view .rfm-tile input:not([disabled])')].every((c) => c.checked) && !document.querySelector('.rfm-view .bp3-icon-trash').disabled));
await page.evaluate(() => document.querySelector('.rfm-view .rfm-grid-all').click());
await page.evaluate(() => document.querySelector('.rfm-view .rfm-tile input:not([disabled])').click());
check('trash is on for a ticked tile', await page.evaluate(() => !document.querySelector('.rfm-view .bp3-icon-trash').disabled));
await page.evaluate(() => document.querySelector('.rfm-view .rfm-tile input:not([disabled])').click());
check('the thumbnail view is remembered', await page.evaluate(() => JSON.parse(localStorage.getItem('roam-file-manager:view')).grid === true));
await page.click('.rfm-view .rfm-grid-button');
check('the button goes back to the list', await page.evaluate(() => !document.querySelector('.rfm-view .rfm-tile') && document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)').length > 0));
await page.click('.rfm-view [data-col="added"] .sort-button.desc');

// the last check before a delete reads every text in the graph
const wide = await page.evaluate(async () => {
  const q = (s) => window.roamAlphaAPI.data.async.q(s);
  const t = performance.now();
  const n = (await q('[:find ?s :where [_ ?a ?v] [(not= ?a :block/props)] [(str ?v) ?s] [(clojure.string/includes? ?s "firebasestorage.googleapis.com")]]')).length;
  return { n, ms: Math.round(performance.now() - t) };
});
check('the whole-graph check before a delete runs', wide.n > 100, `${wide.n} texts in ${wide.ms} ms`);

// Roam's own navigation closes the list
await page.click('.rm-left-sidebar__daily-notes');
await page.waitForTimeout(1500);
check('Daily Notes closes the list', await page.evaluate(() => !document.querySelector('.rfm-view')));
// from Daily Notes, back to Daily Notes: no route change, and the list still closes
// (and a list opened a second time has its rows from the start: still only those in view are drawn)
await page.evaluate(() => {
  window.__most = 0;
  window.__mo = new MutationObserver(() => { window.__most = Math.max(window.__most, document.querySelectorAll('.rfm-view .rfm-scroller .rm-pages-row').length); });
  window.__mo.observe(document.body, { childList: true, subtree: true });
});
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view .rfm-scroller .rm-pages-row');
await page.waitForTimeout(800);
const most = await page.evaluate(() => { window.__mo.disconnect(); return window.__most; });
check('opened again, the list draws only the rows in view', most > 0 && most < 60, `${most} rows at most`);
await page.click('.rm-left-sidebar__daily-notes');
await page.waitForTimeout(1500);
check('Daily Notes closes the list when Roam was already on Daily Notes', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('.roam-log-container')));
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view');
// the header row is Roam's own: same height, same cells, as the one of All Pages
const headerOf = () => page.evaluate(() => { const hd = document.querySelector('.rm-all-pages .rm-pages-row-header'); return [hd.offsetHeight, ...[...hd.children].map((c) => `${c.offsetHeight} ${getComputedStyle(c).display}`)].join(', '); });
const ownHeader = await headerOf();
await page.click('.rm-left-sidebar__all-pages');
await page.waitForTimeout(1500);
check('the header row measures the same as the one of All Pages', ownHeader === await headerOf(), ownHeader);
check('All Pages closes the list', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('#all-pages-search')));

// A sort that takes a while (tens of thousands of files; here: made slow) puts the same box up while it runs.
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)');
await page.waitForTimeout(800); // the list is drawn again once the graph has been read: after that, only the clicks below sort it
await page.evaluate(() => {
  const sort = Array.prototype.sort;
  window.__realSort = sort;
  Array.prototype.sort = function (...a) { if (this.length > 100 && this[0]?.uses) { const t = performance.now(); while (performance.now() - t < 400); } return sort.apply(this, a); };
  window.__box = [];
  new MutationObserver(() => {
    const view = document.querySelector('.rfm-view'), on = !!view?.querySelector('.rfm-loader');
    if (on !== (window.__box.at(-1)?.on ?? false)) window.__box.push({ on, pct: view?.querySelector('.rfm-loader .bp3-progress-meter')?.style.width, inert: !!view?.querySelector('[inert]'), first: view?.querySelector('.rfm-scroller .rm-pages-title-text')?.textContent });
  }).observe(document.body, { childList: true, subtree: true });
});
const firstName = () => page.evaluate(() => document.querySelector('.rfm-view .rfm-scroller .rm-pages-title-text')?.textContent);
await page.click('.rfm-view [data-col="name"] .sort-button:not(.desc)'); // this one is timed: 400 ms
await page.waitForTimeout(700);
const before = await firstName();
check('a first slow sort is not announced: nothing told it would be slow', await page.evaluate(() => window.__box.length === 0));
await page.click('.rfm-view [data-col="name"] .sort-button.desc');
await page.waitForTimeout(1200);
const seen = await page.evaluate(() => window.__box);
check('the next sort of that kind shows the box while it runs, then the sorted list',
  seen.length === 2 && seen[0].on && seen[0].pct === '100%' && !seen[0].inert && seen[0].first === before && !seen[1].on && (await firstName()) !== before, JSON.stringify(seen));
await page.evaluate(() => { Array.prototype.sort = window.__realSort; window.__box.length = 0; });
await page.click('.rfm-view [data-col="name"] .sort-button:not(.desc)'); // expected slow, turns out fast: corrected
await page.waitForTimeout(600);
await page.evaluate(() => { window.__box.length = 0; });
await page.click('.rfm-view [data-col="name"] .sort-button.desc');
await page.waitForTimeout(600);
check('a fast sort shows no box', await page.evaluate(() => window.__box.length === 0), JSON.stringify(await page.evaluate(() => window.__box)));
await page.click('.rfm-view [data-col="added"] .sort-button.desc');
await page.click('.rm-left-sidebar__daily-notes');
await page.waitForTimeout(800);

// unload leaves nothing behind
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view');
await page.evaluate(() => window.__ext.onunload());
await page.waitForTimeout(800);
check('unload removes the row, the view and the styles', await page.evaluate(() => !document.querySelector('.rm-left-sidebar__files, .rfm-view, style[data-roam-file-manager]')));

// Clicking away while the list loads (a new browser profile has nothing kept, so it is a first load again).
{
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [], fetches = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  page.on('console', (m) => { if (m.text().includes('roam-file-manager')) errors.push(m.text().slice(0, 200)); });
  // a file's size and date: its storage URL without the query (Roam itself fetches graph snapshots from the same host)
  page.on('request', (r) => { if (r.resourceType() === 'fetch' && /firebasestorage\.googleapis\.com\/.*\/o\/imgs%2F[^?]*$/.test(r.url())) fetches.push(r.url()); });
  await page.goto('https://roamresearch.com/#/app/help', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.roamAlphaAPI && document.querySelector('.rm-title-display, .roam-log-container'), null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: '.bp3-portal .bp3-toast-container{display:none!important}' });
  await page.evaluate(async (code) => {
    // the look through the graph for files takes a while on a big graph: here, 700 ms
    const d = window.roamAlphaAPI.data, q = d.async.q.bind(d.async);
    window.__slowScan = true;
    d.async.q = async (query, ...a) => { if (window.__slowScan && String(query).includes('firebasestorage')) await new Promise((r) => setTimeout(r, 700)); return q(query, ...a); };
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    window.__ext = (await import(url)).default;
    window.__ext.onload({ extensionAPI: {} });
    await window.roamAlphaAPI.ui.leftSidebar.open();
  }, code);
  const left = () => page.evaluate(() => !document.querySelector('.rfm-view, .rfm-loader, [inert]'));

  // away before the files have even been found
  await page.click('.rm-left-sidebar__files');
  await page.waitForSelector('.rfm-view');
  await page.click('.rm-left-sidebar__daily-notes');
  await page.waitForTimeout(2500);
  check('leaving before the files are found fetches nothing afterwards', (await left()) && fetches.length === 0 && errors.length === 0, `${fetches.length} requests, ${errors.join(' | ')}`);

  // away in the middle of the sizes
  await page.evaluate(() => { window.__slowScan = false; });
  await page.click('.rm-left-sidebar__files');
  await page.waitForFunction(() => parseInt(document.querySelector('.rfm-loader .bp3-progress-meter')?.style.width ?? '0', 10) >= 25, null, { timeout: 30000 });
  const files = await page.evaluate(() => Math.round(document.querySelector('.rfm-scroller').firstElementChild.offsetHeight / 39));
  await page.click('.rm-left-sidebar__daily-notes');
  await page.waitForTimeout(400);
  const atLeave = fetches.length;
  await page.waitForTimeout(2000);
  check('leaving while sizes load stops the requests and leaves nothing behind', (await left()) && fetches.length === atLeave && atLeave > 50 && atLeave < files && errors.length === 0,
    `${atLeave} of ${files} files asked for, ${fetches.length - atLeave} more after leaving, ${errors.join(' | ')}`);

  // back again: only what is still missing is fetched, and the list opens up when it is in
  await page.click('.rm-left-sidebar__files');
  await page.waitForSelector('.rfm-view .rfm-loader', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.rfm-view .rfm-loader'), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);
  const again = fetches.length - atLeave, twice = fetches.length - new Set(fetches).size;
  check('coming back fetches only what was still missing, then the list can be used',
    (await page.evaluate(() => { const v = document.querySelector('.rfm-view'); return !!v && !v.querySelector('.rfm-loader, [inert]') && !v.classList.contains('rfm-loading'); }))
    && again > 0 && fetches.length <= files + 12 && twice <= 12 && errors.length === 0, `${again} more requests, ${fetches.length} in all for ${files} files, ${twice} asked twice, ${errors.join(' | ')}`);

  // and after a restart of Roam nothing is fetched again: what had arrived before leaving was kept
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.roamAlphaAPI && document.querySelector('.rm-title-display, .roam-log-container'), null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.evaluate(async (code) => {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    window.__ext = (await import(url)).default;
    window.__ext.onload({ extensionAPI: {} });
    await window.roamAlphaAPI.ui.leftSidebar.open();
  }, code);
  const before = fetches.length;
  await page.click('.rm-left-sidebar__files');
  await page.waitForSelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)');
  await page.waitForTimeout(2500);
  check('after a restart almost nothing is fetched again', fetches.length - before <= 12 && !(await page.evaluate(() => !!document.querySelector('.rfm-loader'))), `${fetches.length - before} requests`);

}

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `${failed.length} of ${checks.length} checks FAILED` : `all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
