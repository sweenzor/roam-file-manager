// Takes the README's screenshots in Roam's real desktop app (the Linux build, under Xvfb), signed in to
// the hosted test graph with the build loaded through Roam Depot's developer mode.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… OUT=docs/images node test/real-roam/screenshots.mjs
//
// Every picture shows the real extension at work on real uploads: it uploads the made-up files of
// demo-files.mjs (a kitchen renovation) to a few pages, takes the pictures, and then deletes those
// files and pages again. Nothing is deleted through the extension: both confirmations are cancelled.
// Credentials are handled as in run.mjs. See .github/workflows/screenshots.yml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, signIn, openGraph,
  dismissDialogs, loadDevExtension, extensionLoaded,
} from './roam.mjs';
import { buildDemoFiles } from './demo-files.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;
const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'docs/images');
const WIDTH = 1280, HEIGHT = 800;
const VIEW = '.rfm-view', ROW = `${VIEW} .rm-pages-row:not(.rm-pages-row-header)`, DIALOG = '.confirmation-content-dialog';

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.startsWith('debug-')) fs.rmSync(path.join(OUT, f)); // from an earlier run
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-'));
roam.logDir = WORK; // Roam's own log stays there: it isn't ours to publish
const DIST = path.join(WORK, 'dist');
fs.mkdirSync(DIST);
for (const f of ['extension.js', 'README.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

// The pages, top to bottom. {name} stands for the upload of that name, in the form Roam writes it.
// The last page is where the two files that end up unused start out.
const PAGES = {
  'Kitchen renovation': [
    'Plan we agreed on with the architect {kitchen-floor-plan.png}',
    'Cabinets on the north wall {north-wall-elevation.png}',
    'How you walk through it {walkthrough-route}',
    'Where the money has gone so far {budget-chart.png} {budget.csv}',
  ],
  'Paint and finishes': [
    'Shortlist after the sample pots {paint-shortlist.png}',
    'Worktop samples from the showroom {worktop-samples.jpg}',
    'Tiles for the splashback {tile-samples.jpg}',
    'Colours have to work with the plan {kitchen-floor-plan.png}',
  ],
  'Joinery quotes': [
    'Harbour & Pine sent theirs {joinery-quote.pdf}',
    'They priced it from this plan {kitchen-floor-plan.png}',
    'and this elevation {north-wall-elevation.png}',
  ],
  'Site visit': [
    'Notes to self on the way home {site-visit-voice-memo.wav}',
  ],
  'Kitchen ideas, early': [
    'First go at the layout {kitchen-layout-v1.png}',
    'Appliance sizes {appliance-specifications.pdf}',
  ],
};
const UNUSED_PAGE = 'Kitchen ideas, early';
const UNUSED = ['kitchen-layout-v1.png', 'appliance-specifications.pdf'];
const PLAN = 'kitchen-floor-plan.png';

/** Removes the demo pages, and the uploads their blocks hold, that an earlier run left behind. */
const removeLeftovers = () => evalIn(async (titles) => {
  const api = window.roamAlphaAPI; let n = 0;
  for (const title of titles) {
    const uid = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title);
    if (!uid) continue;
    const strings = api.data.q('[:find [?s ...] :in $ ?t :where [?p :node/title ?t] [?b :block/page ?p] [?b :block/string ?s]]', title) ?? [];
    for (const url of new Set(strings.flatMap((s) => s.match(/https:\/\/firebasestorage[^\s)}]+/g) ?? []))) { try { await api.file.delete({ url }); n++; } catch { /* gone already */ } }
    await api.data.page.delete({ page: { uid } });
  }
  return n;
}, Object.keys(PAGES));

/** Uploads the demo files and writes the pages. Returns { urls: {name: url}, blocks: {name: [uid]}, pages: [uid] }. */
const makeDemo = async () => {
  // as an expression, so that Roam's page needs no eval of its own
  await roam.page.evaluate(`window.__rfmDemoFiles = ${buildDemoFiles.toString()}; undefined`);
  return evalIn(makeDemoInPage, PAGES);
};
const makeDemoInPage = async (PAGES) => {
  const api = window.roamAlphaAPI;
  const files = await window.__rfmDemoFiles();
  delete window.__rfmDemoFiles;
  const out = { urls: {}, blocks: {}, pages: [], names: Object.keys(files), sizes: {} };
  const md = {};
  for (const [name, file] of Object.entries(files)) {
    const text = await api.file.upload({ file, toast: { hide: true } });
    const url = text.match(/https:\/\/firebasestorage[^\s)}]+/)[0];
    out.urls[name] = url; out.sizes[name] = file.size;
    md[name] = text.includes(url) && /^(!\[|\{\{|\[)/.test(text.trim()) ? text.trim() : `[${name}](${url})`;
  }
  const fileOf = (key) => out.names.find((n) => n === key || n.startsWith(`${key}.`));
  for (const [title, lines] of Object.entries(PAGES)) {
    const pageUid = api.util.generateUID();
    await api.data.page.create({ page: { title, uid: pageUid } });
    out.pages.push(pageUid);
    for (const [order, line] of lines.entries()) {
      const uid = api.util.generateUID();
      const string = line.replace(/\{([^}]+)\}/g, (_, key) => { const name = fileOf(key); (out.blocks[name] ??= []).push(uid); return md[name]; });
      await api.data.block.create({ location: { 'parent-uid': pageUid, order }, block: { uid, string } });
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
  return out;
};

// ---------- the list ----------
const openFiles = async () => {
  await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.open());
  await waitFor('the Files row', extensionLoaded, 10000);
  await evalIn(() => document.querySelector('.rm-left-sidebar__files').click());
  await waitFor('the Files list', () => evalIn((v) => !!document.querySelector(v), VIEW), 10000);
};
const closeFiles = async () => {
  await evalIn(() => document.querySelector('.rm-left-sidebar__daily-notes').click());
  await waitFor('the list to close', () => evalIn((v) => !document.querySelector(v), VIEW), 10000);
};
const rows = () => evalIn((ROW) => [...document.querySelectorAll(ROW)].map((r) => ({
  name: r.querySelector('.rm-pages-title-text')?.textContent.trim(),
  size: r.querySelector('.rfm-col-size')?.textContent.trim(),
  mentions: r.querySelector('.rfm-col-mentions')?.textContent.trim(),
})), ROW);
/** The middle of `selector` inside the row of the file `name`. */
const inRow = (name, selector) => evalIn(([ROW, name, selector]) => {
  const row = [...document.querySelectorAll(ROW)].find((r) => r.querySelector('.rm-pages-title-text')?.textContent.trim() === name);
  const b = row?.querySelector(selector)?.getBoundingClientRect();
  return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
}, [ROW, name, selector]);
const clickInRow = async (name, selector) => {
  const at = await inRow(name, selector);
  if (!at) throw new Error(`no ${selector} in the row of ${name}`);
  await roam.page.mouse.click(at.x, at.y);
};
const tick = (name) => clickInRow(name, '.bp3-control-indicator');
const search = async (text) => { await roam.page.fill(`${VIEW} .search-input`, text); await sleep(500); };
const picturesLoaded = (scope) => evalIn((scope) => [...document.querySelectorAll(`${scope} img`)].every((i) => i.complete && i.naturalWidth > 0), scope);
const parkMouse = () => roam.page.mouse.move(WIDTH - 6, HEIGHT - 6);

// ---------- pictures ----------
let cdp = null;
/** Starts Roam and opens the graph at twice the pixel density, so the pictures are sharp. */
async function start() {
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  cdp = await roam.page.context().newCDPSession(roam.page); // kept open: the override ends with it
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
  await sleep(1000);
}
/** The part of the window that the elements matching `selector` cover together, with `pad` around it. */
const boxOf = (selector, pad = 0) => evalIn(([selector, pad, W, H]) => {
  const rs = [...document.querySelectorAll(selector)].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
  if (!rs.length) return null;
  const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - pad), y = Math.max(0, Math.min(...rs.map((r) => r.top)) - pad);
  return { x, y, width: Math.min(W, Math.max(...rs.map((r) => r.right)) + pad) - x, height: Math.min(H, Math.max(...rs.map((r) => r.bottom)) + pad) - y };
}, [selector, pad, WIDTH, HEIGHT]);
/** The window down to the last row of the list (or the end of `also`, if that is lower), so a picture doesn't end in empty space. */
const downTo = async (also = null, pad = 24) => {
  const list = await boxOf(`${ROW}, ${VIEW} .rm-pages-row-header`);
  const more = also ? await boxOf(also) : null;
  const bottom = Math.max(list ? list.y + list.height : 0, more ? more.y + more.height : 0);
  return { x: 0, y: 0, width: WIDTH, height: Math.min(HEIGHT, Math.ceil(bottom + pad)) };
};
async function snap(name, clip, settle = 500) {
  await sleep(settle);
  // Straight from the page's own session: Playwright's screenshot puts its own 1x viewport back first.
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  log('saved', `${name}.png`, clip ? JSON.stringify(clip) : '');
}

let demo = null;
async function main() {
  serve(DIST);
  await start();
  await loadDevExtension();
  const left = await removeLeftovers();
  if (left) log('removed', left, 'files of an earlier run');
  demo = await makeDemo();
  log('uploaded', demo.names.length, 'files:', demo.names.map((n) => `${n} ${demo.sizes[n]}`).join(', '));
  const VIDEO = demo.names.find((n) => n.startsWith('walkthrough-route.'));
  const mine = (list) => list.filter((r) => demo.names.includes(r.name));

  // The first time the list opens it fetches every file's size, date and name. On a slow connection
  // (here: one made slow for this picture) that takes long enough for the progress box to show.
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 });
  await openFiles();
  await waitFor('the progress box', () => evalIn((v) => parseInt(document.querySelector(`${v} .rfm-loader .bp3-progress-meter`)?.style.width ?? '0', 10) >= 25, VIEW), 20000, 100);
  await parkMouse();
  await snap('first-open', await downTo(), 0);
  if (!(await evalIn((v) => !!document.querySelector(`${v} .rfm-loader`), VIEW))) throw new Error('the progress box was gone before its picture was taken');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send('Network.disable');

  // The list has to have seen a file in a block before it can know that no block holds it any more.
  await waitFor('every demo file in the list', async () => mine(await rows()).length === demo.names.length, 30000);
  for (const name of UNUSED) for (const uid of demo.blocks[name]) await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), uid);
  await evalIn(async (title) => { const api = window.roamAlphaAPI; const uid = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title); if (uid) await api.data.page.delete({ page: { uid } }); }, UNUSED_PAGE);
  await sleep(1500);
  await closeFiles();
  await evalIn(() => window.roamAlphaAPI.ui.rightSidebar.close());
  await openFiles();
  await waitFor('sizes, and 0 mentions for the two files without a block', async () => {
    const list = mine(await rows());
    return list.length === demo.names.length && list.every((r) => r.size) && UNUSED.every((n) => list.find((r) => r.name === n)?.mentions === '0');
  }, 30000);
  const others = (await rows()).length - demo.names.length;
  if (others) log('note:', others, 'other files of the test graph are in the list too');
  await waitFor('the pictures in the list', () => picturesLoaded(VIEW), 30000);
  await waitFor('the video\'s still', () => inRow(VIDEO, '.rfm-still img'), 30000);
  await parkMouse();

  // 1. The list as it opens: newest first.
  await snap('files', await downTo());

  // 2. Sorted by size, largest first.
  await roam.page.click(`${VIEW} .rm-pages-row-header [data-col="size"] .sort-button.desc`);
  await sleep(500);
  await waitFor('the pictures in the list', () => picturesLoaded(VIEW), 15000);
  await parkMouse();
  await snap('sort', await boxOf(`${VIEW} .rm-pages-row-header, ${ROW}`, 12));
  await roam.page.click(`${VIEW} .rm-pages-row-header [data-col="added"] .sort-button.desc`);

  // The eye: Show or Hide Columns.
  await roam.page.click(`${VIEW} .bp3-icon-eye-open`);
  await waitFor('the columns menu', () => evalIn(() => !!document.querySelector('.bp3-popover .bp3-switch')), 5000);
  await roam.page.mouse.move(WIDTH / 2, HEIGHT - 6);
  await snap('columns', await boxOf(`${VIEW} .rm-pages-toolbar, ${VIEW} .rm-pages-row-header, ${ROW}:nth-child(-n+7), .bp3-popover`, 12));
  await evalIn(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))); // a click elsewhere closes it
  await sleep(300);

  // 3. Search, here by the name of a page.
  await search('paint');
  await waitFor('the pictures in the list', () => picturesLoaded(VIEW), 15000);
  await parkMouse();
  await snap('search', await boxOf(`${VIEW} .rm-pages-toolbar, ${VIEW} .rm-pages-row-header, ${ROW}`, 12));
  await search('');

  // 4. The filter, with Unused on.
  await roam.page.click(`${VIEW} .bp3-icon-filter`);
  await waitFor('the filter', () => evalIn(() => !!document.querySelector('.bp3-popover .bp3-switch')), 5000);
  await evalIn(() => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === 'Unused').querySelector('input').click());
  await waitFor('only the unused files', async () => { const list = await rows(); return list.length > 0 && list.every((r) => r.mentions === '0'); }, 10000);
  await waitFor('the pictures in the list', () => picturesLoaded(VIEW), 15000);
  await roam.page.mouse.move(WIDTH / 2, HEIGHT - 6);
  await snap('unused', await boxOf(`${VIEW} .rm-pages-toolbar, ${VIEW} .rm-pages-row-header, ${ROW}, .bp3-popover`, 12));
  await evalIn(() => [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === 'Unused').querySelector('input').click());
  await evalIn(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))); // a click elsewhere closes the filter
  await sleep(500);
  await waitFor('every file again', async () => mine(await rows()).length === demo.names.length, 10000);

  // 5. Hovering a picture shows it larger.
  let at = await inRow('tile-samples.jpg', '.rfm-thumb');
  await roam.page.mouse.move(at.x, at.y, { steps: 4 });
  await waitFor('the larger picture', () => evalIn(() => { const i = document.querySelector('.rfm-preview img'); return !!i && i.complete && i.naturalWidth > 0 && i.closest('.bp3-transition-container').style.visibility !== 'hidden'; }), 20000);
  await snap('preview', await downTo('.rfm-preview'));
  await parkMouse();

  // 6. Hovering a video plays it.
  at = await inRow(VIDEO, '.rfm-still');
  await roam.page.mouse.move(at.x, at.y, { steps: 4 });
  await waitFor('the video to play', () => evalIn(() => { const v = document.querySelector('.rfm-preview video'); return !!v && v.videoWidth > 0 && v.currentTime > 0.6 && !v.paused; }), 30000);
  const onVideo = await boxOf('.rfm-preview video');
  await roam.page.mouse.move(onVideo.x + onVideo.width / 2, onVideo.y + onVideo.height / 2, { steps: 6 }); // its controls show while the pointer is on it
  await sleep(300);
  await snap('video', await downTo('.rfm-preview'));
  await parkMouse();
  await waitFor('the video to go away', () => evalIn(() => !document.querySelector('.rfm-preview')), 5000);

  // 7. A mentions count opens the blocks in the right sidebar, and the list stays.
  await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.close()); // room for both
  await sleep(1000);
  await clickInRow(PLAN, '.rm-clickable-pill');
  await waitFor('the blocks in the right sidebar', () => evalIn((uids) => { const w = window.roamAlphaAPI.ui.rightSidebar.getWindows().map((x) => x['block-uid']); return uids.every((u) => w.includes(u)); }, demo.blocks[PLAN]), 10000);
  await waitFor('the pictures in the sidebar', () => evalIn(() => { const imgs = [...document.querySelectorAll('#right-sidebar img')]; return imgs.length >= 1 && imgs.every((i) => i.complete && i.naturalWidth > 0); }), 30000).catch((e) => log('note:', e.message));
  await sleep(1500);
  await parkMouse();
  const over = await evalIn(() => { const sc = document.querySelector('.rfm-scroller'); return sc.scrollWidth - sc.clientWidth; });
  if (over > 0) throw new Error(`the list runs ${over}px off the edge next to the right sidebar`);
  await snap('mentions', { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  await evalIn(async (uids) => { const s = window.roamAlphaAPI.ui.rightSidebar; for (const uid of uids) await s.removeWindow({ window: { type: 'block', 'block-uid': uid } }); await s.close(); }, demo.blocks[PLAN]);
  await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.open());
  await sleep(1000);

  // 8. The confirmation for files that no block mentions. Cancelled.
  const dialog = async (name, wait) => {
    await roam.page.click(`${VIEW} .bp3-icon-trash`);
    await waitFor('the confirmation', () => evalIn((d) => !!document.querySelector(d), DIALOG), 5000);
    await waitFor('the pictures in the confirmation', () => picturesLoaded(DIALOG), 30000);
    if (wait) await waitFor('the video\'s still in the confirmation', () => evalIn((d) => !!document.querySelector(`${d} .rfm-still img`), DIALOG), 30000);
    await parkMouse();
    await snap(name, await boxOf('.rm-modal-dialog', 28));
    await evalIn((d) => document.querySelector(`${d} .cancel-button`).click(), DIALOG);
    await waitFor('the confirmation to close', () => evalIn((d) => !document.querySelector(d), DIALOG), 5000);
  };
  for (const name of UNUSED) await tick(name);
  await dialog('delete');
  for (const name of UNUSED) await tick(name);

  // 9. The confirmation for files that blocks still mention, with its warning. Cancelled.
  for (const name of [PLAN, VIDEO, 'joinery-quote.pdf']) await tick(name);
  await dialog('delete-warning', true);
  for (const name of [PLAN, VIDEO, 'joinery-quote.pdf']) await tick(name);

  // nothing was deleted through the extension
  const stored = await evalIn((urls) => Promise.all(urls.map((u) => fetch(u.replace(/\?.*$/, '')).then((r) => r.status, () => 0))), Object.values(demo.urls));
  if (!stored.every((s) => s === 200)) throw new Error(`a demo file went missing while the pictures were taken: ${stored.join(' ')}`);
}

let failure = '';
try { await main(); } catch (e) { failure = e.message.split('\n')[0]; log('ERROR', e.stack ?? e.message); if (roam.page && roam.signedIn && cdp) await snap('debug-error').catch(() => {}); }
// leave the test graph as it was: no demo pages, no demo files
try {
  if (roam.page && roam.signedIn) {
    await dismissDialogs();
    const leftOver = await evalIn(async ([urls, pages]) => {
      const api = window.roamAlphaAPI; const left = [];
      for (const uid of pages) if (api.data.pull('[:block/uid]', [':block/uid', uid])) await api.data.page.delete({ page: { uid } });
      for (const url of urls) {
        if ((await fetch(url.replace(/\?.*$/, ''))).status !== 200) continue;
        try { await api.file.delete({ url }); } catch (e) { left.push(String(e).slice(0, 120)); }
      }
      await api.ui.rightSidebar.close();
      return left;
    }, [Object.values(demo?.urls ?? {}), demo?.pages ?? []]);
    if (leftOver.length) log('cleanup could not delete', leftOver.join('; '));
    await removeLeftovers();
    await sleep(1500);
  }
} catch (e) { log('cleanup failed', e.message.split('\n')[0]); }
await killRoam('SIGTERM').catch(() => {});
stopServing();
log(failure ? `FAILED: ${failure}` : 'DONE', '->', OUT);
process.exit(failure ? 1 : 0);
