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
await page.addStyleTag({ content: '.bp3-toast-container{display:none!important}' });
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
// several hundred files to fetch sizes for: past a second, a bar shows how far that has got
const bar = () => page.evaluate(() => { const m = document.querySelector('.rfm-view .rfm-progress .bp3-progress-meter'); return m ? parseInt(m.style.width, 10) : null; });
check('nothing shows progress in the first second', (await bar()) === null && Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
await page.waitForFunction(() => !!document.querySelector('.rfm-view .rfm-progress'), null, { timeout: 5000 }).catch(() => {});
const early = await bar();
await page.waitForTimeout(1500);
const later = await bar();
check('a long first load shows a progress bar that moves on', early !== null && early > 0 && (later === null || later > early), `${early}% then ${later}%`);
await page.screenshot({ path: path.join(OUT, '0-first-load.png') });
await page.waitForFunction(() => !document.querySelector('.rfm-view .rfm-progress'), null, { timeout: 60000 })
  .then(() => check('the bar goes away when every file has its size', true), () => check('the bar goes away when every file has its size', false));
const info = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')];
  const sc = document.querySelector('.rfm-scroller');
  return { dom: rows.length, total: Math.round(sc.firstElementChild.offsetHeight / 39), first: rows.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' ').trim()) };
});
let i = await info();
check('lists the graph\'s files', i.total > 100, `${i.total} files`);
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
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view');
await page.click('.rm-left-sidebar__daily-notes');
await page.waitForTimeout(1500);
check('Daily Notes closes the list when Roam was already on Daily Notes', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('.roam-log-container')));
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view');
await page.click('.rm-left-sidebar__all-pages');
await page.waitForTimeout(1500);
check('All Pages closes the list', await page.evaluate(() => !document.querySelector('.rfm-view') && !!document.querySelector('#all-pages-search')));

// unload leaves nothing behind
await page.click('.rm-left-sidebar__files');
await page.waitForSelector('.rfm-view');
await page.evaluate(() => window.__ext.onunload());
await page.waitForTimeout(800);
check('unload removes the row, the view and the styles', await page.evaluate(() => !document.querySelector('.rm-left-sidebar__files, .rfm-view, style[data-roam-file-manager]')));

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `${failed.length} of ${checks.length} checks FAILED` : `all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
