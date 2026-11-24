// End-to-end run of the built extension in a LOCAL graph of Roam's real desktop app (Linux build,
// under Xvfb), signed in to the test account. In a local graph Roam's desktop app keeps uploads on the
// computer (local-asset://<graph>/<id>.<ext>). Roam's public API can't list or delete them
// (roamAlphaAPI.file.delete refuses local graphs), so File Manager lists what the blocks hold and
// deletes nothing there.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/local.mjs
//
// Makes a fresh local graph by its address (#/offline/<name>; every CI runner starts without one),
// uploads three files to it and checks: they are listed with type, size and date, with their pages and
// mentions; the pictures are drawn; nothing can be ticked or deleted; a file whose block is deleted
// leaves the list, and stays on the computer. Writes
// RESULTS.md and PNG screenshots to $OUT/local.
//
// Credentials as in run.mjs: from the environment only, never logged, no picture before the graph is open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, shot, signIn, dismissDialogs, loadDevExtension, extensionLoaded } from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const RUN = Date.now().toString(36);
const GRAPH = process.env.LOCAL_GRAPH || `rfm-ci-${RUN}`;
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'real-roam-out', 'local');
const TEST_PAGE = 'File Manager local test';
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-local-'));
roam.out = OUT; roam.logDir = WORK;
const DIST = path.join(WORK, 'dist');
fs.mkdirSync(DIST);
for (const f of ['extension.js', 'README.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
function writeResults(extra = '') {
  const pass = checks.length > 0 && checks.every((c) => c.ok) && !extra;
  const roamVersion = (() => { try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'roam-research'], { encoding: 'utf8' }); } catch { return '?'; } })();
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), [
    `# Real Roam, local graph: ${pass ? 'PASS' : 'FAIL'}`, '',
    `Roam desktop ${roamVersion} (Linux, Xvfb), a new local graph. Commit ${(process.env.COMMIT || process.env.GITHUB_SHA || 'local').slice(0, 7)}.`, '',
    extra ? `**Stopped early:** ${extra}\n` : '',
    '| Check | Result |', '|---|---|',
    ...checks.map((c) => `| ${c.name}${c.detail ? ` (${c.detail})` : ''} | ${c.ok ? 'PASS' : '**FAIL**'} |`), '',
  ].join('\n'));
  return pass;
}

const VIEW = '.rfm-view';
const graphOpen = () => evalIn(() => !!(window.roamAlphaAPI?.data?.q && document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container, .rm-title-display')));
const openAllFiles = async () => {
  await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.open());
  await waitFor('the Files row', extensionLoaded, 10000);
  await evalIn(() => document.querySelector('.rm-left-sidebar__files').click());
  await waitFor('the Files list', () => evalIn((v) => !!document.querySelector(v), VIEW), 10000);
};
const closeAllFiles = async () => {
  await evalIn(() => document.querySelector('.rm-left-sidebar__daily-notes').click());
  await waitFor('the list to close', () => evalIn((v) => !document.querySelector(v), VIEW), 10000);
};
const rows = () => evalIn((v) => [...document.querySelectorAll(`${v} .rm-pages-row:not(.rm-pages-row-header)`)].map((r) => ({
  name: r.querySelector('.rm-pages-title-text')?.textContent.trim(),
  type: r.querySelector('.rfm-col-type')?.textContent.trim(),
  size: r.querySelector('.rfm-col-size')?.textContent.trim(),
  page: r.querySelector('.title-children-text')?.textContent.trim(),
  mentions: r.querySelector('.rfm-col-mentions')?.textContent.trim(),
  added: r.querySelector('.rfm-col-added')?.textContent.trim(),
  ticks: !r.querySelector('input[type=checkbox]')?.disabled,
})), VIEW);
const rowOf = async (name) => (await rows()).find((r) => r.name === name);
const trashOff = () => evalIn((v) => document.querySelector(`${v} .bp3-icon-trash`).disabled, VIEW);
/** Where Roam's desktop app serves a local file, and whether it still has it: 200, or 404 once deleted. */
const httpOf = (url) => `http://127.0.0.1:3333/local-asset/${url.slice('local-asset://'.length)}`;
const stored = (url) => evalIn((u) => fetch(u).then((r) => r.status, () => 0), httpOf(url));
const nameOf = (url) => url.split('/').pop();

let failed = '';
try {
  serve(DIST);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await sleep(3000);
  await roam.page.goto(`${roam.page.url().split('#')[0]}#/offline/${GRAPH}`);
  await sleep(1000);
  if (!(await graphOpen().catch(() => false))) await roam.page.reload().catch(() => {});
  await waitFor('the local graph', graphOpen, 90000);
  roam.signedIn = true;
  await dismissDialogs();
  // Roam's banner about backing up local graphs sits over the top of the window: closed as a user would
  const closeBanner = () => evalIn(() => document.querySelectorAll('.bp3-toast .bp3-icon-cross').forEach((b) => (b.closest('button') ?? b).click()));
  await sleep(2000); await closeBanner();
  check('a new local graph opens by its address', await evalIn(() => window.roamAlphaAPI.graph.type === 'offline'));
  await loadDevExtension();
  check('loads through Roam Depot developer mode in a local graph', await extensionLoaded());

  // ---- three files on a test page ----
  const made = await evalIn(async (title) => {
    const api = window.roamAlphaAPI;
    const pageUid = api.util.generateUID();
    await api.data.page.create({ page: { title, uid: pageUid } });
    const png = (seed) => {
      const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
      x.fillStyle = `hsl(${seed},70%,55%)`; x.fillRect(0, 0, 48, 48); x.fillStyle = '#fff'; x.fillRect(12, 12, 24, 24);
      return new Promise((res) => c.toBlob(res, 'image/png'));
    };
    const files = {
      kept: new File([await png(210)], 'kept.png', { type: 'image/png' }),
      dropped: new File([await png(10)], 'dropped.png', { type: 'image/png' }),
      doc: new File(['File Manager local test file\n'.repeat(40)], 'local-notes.txt', { type: 'text/plain' }),
    };
    const out = { pageUid, md: {}, urls: {}, blocks: {}, sizes: {} };
    let order = 0;
    for (const [k, file] of Object.entries(files)) {
      const md = await api.file.upload({ file, toast: { hide: true } });
      out.md[k] = md;
      out.urls[k] = md.match(/local-asset:\/\/[^\s)}]+/)?.[0];
      out.sizes[k] = file.size;
      const uid = api.util.generateUID();
      await api.data.block.create({ location: { 'parent-uid': pageUid, order: order++ }, block: { uid, string: md } });
      out.blocks[k] = uid;
    }
    out.page2Uid = api.util.generateUID();
    await api.data.page.create({ page: { title: `${title} 2`, uid: out.page2Uid } });
    out.blocks.kept2 = api.util.generateUID();
    await api.data.block.create({ location: { 'parent-uid': out.page2Uid, order: 0 }, block: { uid: out.blocks.kept2, string: `Second use ![](${out.urls.kept})` } });
    return out;
  }, TEST_PAGE);
  log('uploaded', JSON.stringify(made.md));
  const urls = made.urls;
  // Roam writes a local text file as a bare address: it is listed by its stored name
  const DOC = made.md.doc.match(/^\[([^\]]+)\]\(/)?.[1] ?? nameOf(urls.doc);
  check('Roam keeps the uploads on the computer (local-asset://)', Object.values(urls).every((u) => u?.startsWith(`local-asset://${GRAPH}/`)), Object.values(urls).map(nameOf).join(', '));
  check('Roam\'s desktop app serves them', (await Promise.all(Object.values(urls).map(stored))).every((s) => s === 200));

  // ---- they are listed ----
  await closeBanner();
  await openAllFiles();
  await waitFor('the three files in the list, with sizes', async () => { const r = await rows(); return r.length >= 3 && r.every((x) => x.size); }, 30000).catch(() => {});
  let list = await rows();
  log('rows', JSON.stringify(list));
  const kept = await rowOf(nameOf(urls.kept)), dropped = await rowOf(nameOf(urls.dropped)), doc = await rowOf(DOC);
  check('lists the local graph\'s files by their stored names, as Roam\'s Settings > Attachments does', kept && dropped && doc, list.map((r) => r.name).join(', '));
  check('shows type and size', kept?.type === 'PNG' && /\d+ B|KB/.test(kept?.size ?? '') && doc?.type === 'TXT' && doc?.size === '1.1 KB', `${kept?.type} ${kept?.size}; ${doc?.type} ${doc?.size}`);
  check('shows the page and one mention', dropped?.page === TEST_PAGE && dropped?.mentions === '1', `${dropped?.page}, ${dropped?.mentions}`);
  check('a file on two pages names both and counts two mentions', kept?.mentions === '2' && kept?.page.includes(`${TEST_PAGE} 2`), `${kept?.page}, ${kept?.mentions}`);
  const today = await evalIn(() => window.roamAlphaAPI.util.dateToPageTitle(new Date()));
  check('shows the date added in Roam\'s date format', kept?.added === today, kept?.added);
  check('nothing can be ticked in a local graph: Roam\'s API can\'t delete its files', !kept?.ticks && !doc?.ticks && !dropped?.ticks);
  await waitFor('the thumbnails', () => evalIn((v) => [...document.querySelectorAll(`${v} img.rfm-thumb`)].filter((i) => i.complete && i.naturalWidth > 0).length >= 2, VIEW), 15000).then(
    () => check('the pictures are drawn from Roam\'s desktop app', true), () => check('the pictures are drawn from Roam\'s desktop app', false));
  await evalIn(([v, name]) => [...document.querySelectorAll(`${v} .rm-pages-row:not(.rm-pages-row-header)`)].find((r) => r.querySelector('.rm-pages-title-text')?.textContent.trim() === name).querySelector('.rm-clickable-pill').click(), [VIEW, nameOf(urls.kept)]);
  const side = () => evalIn(() => window.roamAlphaAPI.ui.rightSidebar.getWindows().filter((w) => w.type === 'block').map((w) => w['block-uid']));
  const mine = [made.blocks.kept, made.blocks.kept2];
  await waitFor('the blocks in the right sidebar', async () => { const w = await side(); return mine.every((u) => w.includes(u)); }, 10000).catch(() => {});
  const opened = await side();
  check('its count opens the blocks that hold it in the right sidebar', mine.every((u) => opened.includes(u)), opened.join(', '));
  await sleep(1000);
  await shot('local-files');
  await evalIn(async (uids) => { const s = window.roamAlphaAPI.ui.rightSidebar; for (const uid of uids) await s.removeWindow({ window: { type: 'block', 'block-uid': uid } }); await s.close(); }, mine);
  await sleep(800);
  await evalIn((v) => document.querySelector(`${v} .rfm-grid-button`).click(), VIEW);
  await waitFor('a picture in a tile', () => evalIn(() => [...document.querySelectorAll('.rfm-view .rfm-tile img')].some((i) => i.complete && i.naturalWidth > 0)), 15000).then(
    () => check('a tile shows the uploaded picture', true), () => check('a tile shows the uploaded picture', false));
  await shot('local-thumbnails');
  await evalIn((v) => document.querySelector(`${v} .rfm-grid-button`).click(), VIEW);
  await sleep(500);

  // ---- a file whose block is deleted leaves the list; nothing is deleted from the computer ----
  await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), made.blocks.dropped);
  await sleep(1000);
  await closeAllFiles();
  await openAllFiles();
  await waitFor('the other files', async () => !!(await rowOf(nameOf(urls.kept))), 20000).catch(() => {});
  list = await rows();
  check('a file no block holds any more leaves the list', !list.some((r) => r.name === nameOf(urls.dropped)) && list.some((r) => r.name === nameOf(urls.kept)), list.map((r) => r.name).join(', '));
  check('the trash stays off', await trashOff());
  check('every file is still on the computer', (await Promise.all(Object.values(urls).map(stored))).every((s) => s === 200));
  await shot('local-after-block-deleted');
} catch (e) {
  failed = e.message.split('\n')[0];
  log('ERROR', e.message);
  await shot('error');
} finally {
  // the graph lives only on this runner; it goes with it
  await killRoam('SIGTERM').catch(() => {});
  stopServing();
}
const pass = writeResults(failed);
log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
