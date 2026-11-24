// End-to-end run of the built extension in Roam's real desktop app (the Linux build, under Xvfb),
// signed in to a hosted test graph. Drives Roam over the Chrome DevTools Protocol with Playwright.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/run.mjs
//
// Checks what a read-only graph can't show: files uploaded to the graph appear in Files with
// their name, size and page; a file whose block is deleted turns up as unused; only unused files can
// be deleted, and only after Roam's confirmation; a delete really removes the file from storage; and
// a file still in a block is never touched; nor is one that block props or a PDF page still use.
// Writes RESULTS.md and PNG screenshots to $OUT.
//
// It uploads a few tiny files to the test graph and removes them again, with the pages it made.
//
// Credentials come only from the environment (GitHub Actions secrets in CI). They are removed from
// this process's environment before anything else starts, never written to disk or to the log, and
// no screenshot is taken before the graph is open. See .github/workflows/real-roam.yml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, shot, signIn, openGraph,
  dismissDialogs, loadDevExtension, extensionLoaded,
} from './roam.mjs';
import { checkPlan } from './plan.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'real-roam-out');
const TEST_PAGE = 'File Manager CI test';
const RUN = Date.now().toString(36);
const NAMES = { kept: `fm-ci-kept-${RUN}.png`, dropped: `fm-ci-dropped-${RUN}.png`, doc: `fm-ci-doc-${RUN}.txt`, used: `fm-ci-used-${RUN}.png`,
  drawn: `fm-ci-drawn-${RUN}.png`, sized: `fm-ci-sized-${RUN}.png`, paper: `fm-ci-paper-${RUN}.pdf`, extra1: `fm-ci-extra1-${RUN}.png`, extra2: `fm-ci-extra2-${RUN}.png` };

fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'real-roam-'));
roam.out = OUT; roam.logDir = WORK; // Roam's own log stays in WORK: it isn't ours to publish
const DIST = path.join(WORK, 'dist');
fs.mkdirSync(DIST);
for (const f of ['extension.js', 'README.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
function writeResults(extra = '') {
  const pass = checks.length > 0 && checks.every((c) => c.ok) && !extra;
  const roamVersion = (() => { try { return execFileSync('dpkg-query', ['-W', '-f=${Version}', 'roam-research'], { encoding: 'utf8' }); } catch { return '?'; } })();
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), [
    `# Real Roam run: ${pass ? 'PASS' : 'FAIL'}`, '',
    `Roam desktop ${roamVersion} (Linux, Xvfb), hosted graph \`${GRAPH}\`. Commit ${(process.env.COMMIT || process.env.GITHUB_SHA || 'local').slice(0, 7)}.`, '',
    extra ? `**Stopped early:** ${extra}\n` : '',
    '| Check | Result |', '|---|---|',
    ...checks.map((c) => `| ${c.name}${c.detail ? ` (${c.detail})` : ''} | ${c.ok ? 'PASS' : '**FAIL**'} |`), '',
  ].join('\n'));
  return pass;
}

// ---------- the list ----------
const VIEW = '.rfm-view';
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
const search = async (text) => {
  await roam.page.fill(`${VIEW} .search-input`, text);
  await sleep(400);
};
/** The rows on screen as { name, type, size, page, mentions, added }. */
const rows = () => evalIn((v) => [...document.querySelectorAll(`${v} .rm-pages-row:not(.rm-pages-row-header)`)].map((r) => ({
  name: r.querySelector('.rm-pages-title-text')?.textContent.trim(),
  type: r.querySelector('.rfm-col-type')?.textContent.trim(),
  size: r.querySelector('.rfm-col-size')?.textContent.trim(),
  page: r.querySelector('.title-children-text')?.textContent.trim(),
  mentions: r.querySelector('.rfm-col-mentions')?.textContent.trim(),
  added: r.querySelector('.rfm-col-added')?.textContent.trim(),
})), VIEW);
const rowOf = async (name) => (await rows()).find((r) => r.name === name);
const tick = (name) => evalIn(([v, name]) => {
  const r = [...document.querySelectorAll(`${v} .rm-pages-row:not(.rm-pages-row-header)`)].find((r) => r.querySelector('.rm-pages-title-text')?.textContent.trim() === name);
  r?.querySelector('input[type=checkbox]').click(); return !!r;
}, [VIEW, name]);
const trashOff = () => evalIn((v) => document.querySelector(`${v} .bp3-icon-trash`).disabled, VIEW);
const setSwitch = async (label, on) => {
  if (!(await evalIn(() => !!document.querySelector('.bp3-popover .bp3-switch')))) await roam.page.click(`${VIEW} .bp3-icon-filter`);
  await sleep(300);
  await evalIn(([label, on]) => { const i = [...document.querySelectorAll('.bp3-popover label')].find((e) => e.textContent.trim() === label).querySelector('input'); if (i.checked !== on) i.click(); }, [label, on]);
  await sleep(300);
};
const closePopover = async () => { await roam.page.mouse.click(700, 740); await sleep(300); };
/** HTTP status of the file's storage record: 200 while it is stored, 403 (or 404) once deleted. */
const stored = (url) => evalIn((url) => fetch(url.replace(/\?.*$/, '')).then((r) => r.status, () => 0), url);

// files an aborted earlier run left in storage can be passed in to be removed with this run's
const STALE = (process.env.CLEANUP_URLS || '').split(/\s+/).filter(Boolean);
let urls = {}, pageUid = null; const pageUids = [];
try {
  serve(DIST);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  { const plan = await checkPlan(roam.page, GRAPH.startsWith('offline/') ? `#/${GRAPH}` : `#/app/${GRAPH}`); check("The test account's plan is Believer and ends more than a year away", plan.ok, plan.detail); }
  await openGraph(GRAPH);
  await loadDevExtension();
  check('loads through Roam Depot developer mode', await extensionLoaded());
  // which video formats this build of Roam can show a frame of
  log('browser', await evalIn(() => { const v = document.createElement('video'); const can = (c) => v.canPlayType(`video/mp4; codecs="${c}"`) || 'no'; return `${navigator.userAgent.match(/Chrome\/[\d.]+|Electron\/[\d.]+/g)?.join(' ')}; H.264 ${can('avc1.42E01E')}, HEVC ${can('hvc1.1.6.L93.B0')}`; }));
  check('Files sits under All Pages in the left sidebar', await evalIn(() => document.querySelector('.rm-left-sidebar__all-pages')?.nextElementSibling?.classList.contains('rm-left-sidebar__files')));

  // ---- the test files on a test page ----
  const made = await evalIn(async ([title, names]) => {
    const api = window.roamAlphaAPI;
    const old = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title);
    if (old) await api.data.page.delete({ page: { uid: old } });
    const pageUid = api.util.generateUID();
    await api.data.page.create({ page: { title, uid: pageUid } });
    const png = (seed) => { // a small valid PNG, different bytes per file
      const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
      x.fillStyle = `hsl(${seed},70%,55%)`; x.fillRect(0, 0, 48, 48); x.fillStyle = '#fff'; x.fillRect(12, 12, 24, 24);
      return new Promise((res) => c.toBlob(res, 'image/png'));
    };
    const pdf = (text) => { // a small valid one-page PDF
      const stream = `BT /F1 20 Tf 72 700 Td (${text}) Tj ET`;
      const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
      let out = '%PDF-1.4\n'; const at = [];
      objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
      const xref = out.length;
      return `${out}xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    };
    const files = {
      kept: new File([await png(210)], names.kept, { type: 'image/png' }),
      dropped: new File([await png(10)], names.dropped, { type: 'image/png' }),
      doc: new File(['File Manager CI test file\n'.repeat(40)], names.doc, { type: 'text/plain' }),
      used: new File([await png(120)], names.used, { type: 'image/png' }),
      drawn: new File([await png(60)], names.drawn, { type: 'image/png' }),
      sized: new File([await png(280)], names.sized, { type: 'image/png' }),
      paper: new File([pdf(names.paper.replace(/\.pdf$/, ''))], names.paper, { type: 'application/pdf' }),
      extra1: new File([await png(330)], names.extra1, { type: 'image/png' }),
      extra2: new File([await png(170)], names.extra2, { type: 'image/png' }),
    };
    const out = { pageUid, md: {}, urls: {}, blocks: {} };
    let order = 0;
    for (const [k, file] of Object.entries(files)) {
      const md = await api.file.upload({ file, toast: { hide: true } });
      out.md[k] = md.slice(0, 40);
      out.urls[k] = md.match(/https:\/\/firebasestorage[^\s)}]+/)[0];
      const uid = api.util.generateUID();
      await api.data.block.create({ location: { 'parent-uid': pageUid, order: order++ }, block: { uid, string: md } });
      out.blocks[k] = uid;
    }
    // the kept file is also on a second page
    const old2 = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', `${title} 2`);
    if (old2) await api.data.page.delete({ page: { uid: old2 } });
    out.page2Uid = api.util.generateUID();
    await api.data.page.create({ page: { title: `${title} 2`, uid: out.page2Uid } });
    out.blocks.kept2 = api.util.generateUID();
    await api.data.block.create({ location: { 'parent-uid': out.page2Uid, order: 0 }, block: { uid: out.blocks.kept2, string: `Second use ${out.md.kept.startsWith('![') ? `![](${out.urls.kept})` : out.urls.kept}` } });
    return out;
  }, [TEST_PAGE, NAMES]);
  urls = made.urls; pageUid = made.pageUid; pageUids.push(made.pageUid, made.page2Uid);
  log('uploaded', JSON.stringify(made.md));
  check('Roam stored the test files', (await Promise.all(Object.values(urls).map(stored))).every((s) => s === 200));

  // ---- they are listed ----
  const openedAt = Date.now();
  await openAllFiles();
  await search(`fm-ci-`);
  await waitFor('the test files in the list, with sizes', async () => { const r = await rows(); return r.length >= 3 && r.filter((x) => x.name?.includes(RUN)).every((x) => x.size); }, 30000);
  check('files uploaded a moment ago are listed at once', Date.now() - openedAt < 15000, `listed, with sizes, ${Date.now() - openedAt} ms after Files was opened`);
  // for the record: how Roam's backend (roamAlphaAPI.data.backend.q) answers the same question about blocks this new
  log('backend:', await evalIn(async () => {
    const d = window.roamAlphaAPI.data, Q = '[:find [?uid ...] :where [?b :block/string ?s] [(clojure.string/includes? ?s "firebasestorage.googleapis.com")] [?b :block/uid ?uid]]';
    if (!d.backend?.q) return 'no backend.q';
    const out = [];
    for (const wait of [0, 5000, 15000]) {
      await new Promise((r) => setTimeout(r, wait));
      const t = performance.now();
      try { const r = await Promise.race([d.backend.q(Q), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 20 s')), 20000))]); out.push(`${r?.length} blocks from the backend in ${Math.round(performance.now() - t)} ms, ${d.q(Q).length} in the window`); }
      catch (e) { out.push(`failed after ${Math.round(performance.now() - t)} ms: ${String(e?.message ?? e).slice(0, 80)}`); }
    }
    return out.join('; ');
  }).catch((e) => `not measured: ${e.message.split('\n')[0]}`));
  let kept = await rowOf(NAMES.kept), dropped = await rowOf(NAMES.dropped), doc = await rowOf(NAMES.doc);
  check('lists uploaded files by the name they were uploaded with', kept && dropped && doc, [kept, dropped, doc].map((r) => r?.name).join(', '));
  await search(NAMES.doc);
  const counted = await evalIn((v) => document.querySelector(`${v} .rfm-count`)?.textContent ?? '', VIEW);
  check('the toolbar counts the files: shown / all while searching', /^1 \/ [\d,]+ Files$/.test(counted) && +counted.split(' / ')[1].replace(/\D/g, '') >= 4, counted);
  await search('fm-ci-');
  check('shows type and size', kept?.type === 'PNG' && /\d+ B|KB/.test(kept?.size ?? '') && doc?.type === 'TXT' && doc?.size === '1.0 KB', `${kept?.type} ${kept?.size}; ${doc?.type} ${doc?.size}`);
  check('shows the page and one mention', dropped?.page === TEST_PAGE && dropped?.mentions === '1', `${dropped?.page}, ${dropped?.mentions}`);
  check('a file on two pages names both and counts two mentions', kept?.mentions === '2' && kept?.page.includes(`${TEST_PAGE} 2`) && kept?.page.replace(`${TEST_PAGE} 2`, '').includes(TEST_PAGE), `${kept?.page}, ${kept?.mentions}`);
  await evalIn(([v, name]) => [...document.querySelectorAll(`${v} .rm-pages-row:not(.rm-pages-row-header)`)].find((r) => r.querySelector('.rm-pages-title-text')?.textContent.trim() === name).querySelector('.rm-clickable-pill').click(), [VIEW, NAMES.kept]);
  const side = () => evalIn(() => window.roamAlphaAPI.ui.rightSidebar.getWindows().filter((w) => w.type === 'block').map((w) => w['block-uid']));
  const mine = [made.blocks.kept, made.blocks.kept2];
  await waitFor('the blocks in the right sidebar', async () => { const w = await side(); return mine.every((u) => w.includes(u)); }, 10000).catch(() => {});
  const opened = await side();
  check('its count opens the blocks that hold it in the right sidebar', mine.every((u) => opened.includes(u)), opened.join(', '));
  check('the list stays open', await evalIn(() => !!document.querySelector('.rfm-view')));
  await sleep(1500);
  await shot('mentions-in-sidebar');
  await evalIn(async (uids) => { const s = window.roamAlphaAPI.ui.rightSidebar; for (const uid of uids) await s.removeWindow({ window: { type: 'block', 'block-uid': uid } }); await s.close(); }, mine);
  await sleep(800);
  const today = await evalIn(() => window.roamAlphaAPI.util.dateToPageTitle(new Date()));
  check('shows the date added in Roam\'s date format', kept?.added === today, kept?.added);
  await search('');
  await sleep(500);
  const top = (await rows()).slice(0, 3).map((r) => r.name);
  check('newest files come first', top.every((n) => n?.includes(RUN)), top.join(', '));
  await shot('all-files');
  // ---- thumbnail view: the same files as tiles, the uploaded picture drawn from Roam's storage ----
  await roam.page.click(`${VIEW} .rfm-grid-button`);
  await waitFor('the tiles', () => evalIn(() => document.querySelectorAll('.rfm-view .rfm-tile').length > 0), 5000);
  const tiles = await evalIn(() => [...document.querySelectorAll('.rfm-view .rfm-tile')].slice(0, 3).map((t) => t.querySelector('.rfm-tile-name')?.textContent ?? ''));
  check('the thumbnail button shows the same files as tiles', tiles.join() === top.join() && await evalIn(() => !document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')), tiles.join(', '));
  await waitFor('a picture in a tile', () => evalIn(() => [...document.querySelectorAll('.rfm-view .rfm-tile img')].some((i) => i.complete && i.naturalWidth > 0)), 15000).then(
    () => check('a tile shows the uploaded picture', true), () => check('a tile shows the uploaded picture', false));
  await shot('thumbnails');
  await roam.page.click(`${VIEW} .rfm-grid-button`);
  await waitFor('the list again', () => evalIn(() => !document.querySelector('.rfm-view .rfm-tile') && !!document.querySelector('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')), 5000);
  check('the button goes back to the list', true);
  // ---- a file still in blocks can be deleted, behind a warning ----
  const dialogOpen = () => evalIn(() => !!document.querySelector('.confirmation-content-dialog'));
  const openDialog = async () => { await roam.page.click(`${VIEW} .bp3-icon-trash`); await waitFor('the confirmation', dialogOpen, 5000); };
  const cancelDialog = async () => { await evalIn(() => document.querySelector('.confirmation-content-dialog .cancel-button').click()); await sleep(500); };
  const warningText = () => evalIn(() => document.querySelector('.confirmation-content-dialog .rfm-delete-warning')?.innerText.replace(/\s+/g, ' ') ?? '');
  await tick(NAMES.kept);
  check('trash is on for a file that blocks still hold', !(await trashOff()));
  await openDialog();
  let warn = await warningText();
  check('the confirmation warns that it leaves broken images and can\'t be undone', warn.includes('can\'t be undone') && warn.includes('This file is still referenced in 2 blocks, which will be left with broken images.'), warn);
  await waitFor('the picture in the confirmation', () => evalIn(() => { const i = document.querySelector('.confirmation-content-dialog img.rfm-delete-thumb'); return !!i && i.complete && i.naturalWidth > 0; }), 15000).then(
    () => check('the confirmation shows the picture', true), () => check('the confirmation shows the picture', false));
  await shot('delete-in-use-confirm');
  await roam.page.keyboard.press('Enter');
  await sleep(1500);
  check('Enter does not confirm a delete that breaks blocks', (await dialogOpen()) && (await stored(urls.kept)) === 200);
  // the mentions count in the confirmation shows the blocks: the dialog goes away, nothing is deleted, the tick stays
  const chipText = await evalIn(() => document.querySelector('.confirmation-content-dialog .rfm-delete-item .rm-clickable-pill')?.textContent);
  await evalIn(() => document.querySelector('.confirmation-content-dialog .rfm-delete-item .rm-clickable-pill').click());
  await waitFor('the blocks in the right sidebar', async () => { const w = await side(); return mine.every((u) => w.includes(u)); }, 10000).catch(() => {});
  const opened2 = await side();
  check('the confirmation shows the mentions count, and a click on it opens the blocks instead of deleting', chipText === '2' && mine.every((u) => opened2.includes(u)) && !(await dialogOpen()) && (await stored(urls.kept)) === 200 && !(await trashOff()), `${chipText}; ${opened2.join(', ')}`);
  await evalIn(async (uids) => { const s = window.roamAlphaAPI.ui.rightSidebar; for (const uid of uids) await s.removeWindow({ window: { type: 'block', 'block-uid': uid } }); await s.close(); }, mine);
  await sleep(800);
  await openDialog();
  await cancelDialog();
  check('Cancel keeps the file', !(await dialogOpen()) && (await stored(urls.kept)) === 200);
  await tick(NAMES.kept);

  // ---- uses outside block text: block props (where a drawing keeps its pictures) and a PDF page ----
  await closeAllFiles();
  // one block's props hold the first picture's address, the way an Excalidraw drawing's hold its pictures;
  // another block's props hold only the saved size of the second picture, which Roam leaves behind
  const inProps = await evalIn(async ([pageUid, urls]) => {
    const api = window.roamAlphaAPI, out = {};
    out.drawing = api.util.generateUID();
    await api.data.block.create({ location: { 'parent-uid': pageUid, order: 'last' }, block: { uid: out.drawing, string: 'File Manager CI drawing', props: { excalidraw: { files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: urls.drawn } } } } } });
    out.sizes = api.util.generateUID();
    await api.data.block.create({ location: { 'parent-uid': pageUid, order: 'last' }, block: { uid: out.sizes, string: 'File Manager CI sizes', props: { 'image-size': { [urls.sized]: { width: 120, height: 120 } } } } });
    const props = (uid) => JSON.stringify(api.data.pull('[:block/props]', [':block/uid', uid])?.[':block/props'] ?? null);
    out.ok = props(out.drawing).includes(urls.drawn) && props(out.sizes).includes(urls.sized) && props(out.sizes).includes('image-size');
    return out;
  }, [pageUid, urls]);
  check('two test blocks hold a picture in their props: one as a drawing does, one as a saved image size', inProps.ok);
  // a highlight on a PDF makes Roam give the PDF a page of its own, which keeps the address in :pdf/url
  const pdfPages = () => evalIn((url) => window.roamAlphaAPI.data.q('[:find [?uid ...] :in $ ?u :where [?e :pdf/url ?u] [?e :block/uid ?uid]]', url) ?? [], urls.paper);
  await evalIn((uid) => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { uid } }), pageUid);
  await waitFor('the PDF in its block', () => evalIn(() => document.querySelectorAll('.roam-article .rm-pdf-container .rm-pdf-toolbar button').length > 2), 30000);
  await evalIn(() => document.querySelector('.roam-article .rm-pdf-container').scrollIntoView({ block: 'center' }));
  await sleep(6000);
  await evalIn(() => document.querySelectorAll('.roam-article .rm-pdf-container .rm-pdf-toolbar button')[1].click()); // area highlight
  await sleep(800);
  const box = await evalIn(() => { const r = document.querySelector('.roam-article .rm-pdf-container').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  log('pdf block', JSON.stringify(box));
  await roam.page.mouse.move(box.x + 50, box.y + 110); await roam.page.mouse.down();
  await roam.page.mouse.move(box.x + 300, box.y + 190, { steps: 8 }); await roam.page.mouse.up();
  await waitFor('Roam\'s PDF page for the test PDF', async () => (await pdfPages()).length > 0, 30000);
  pageUids.push(...await pdfPages());
  check('a highlight on the test PDF gave it a PDF page, which keeps the file\'s address (:pdf/url)', true);
  await evalIn(() => document.querySelector('.rm-left-sidebar__daily-notes').click());
  await sleep(1500);

  // ---- a file whose block is deleted becomes unused ----
  for (const k of ['dropped', 'doc', 'drawn', 'sized', 'paper', 'extra1', 'extra2']) await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), made.blocks[k]);
  await sleep(1000);
  check('the PDF page still has the address after the {{pdf}} block is gone', (await pdfPages()).length > 0);
  await openAllFiles();
  await setSwitch('Unused', true);
  await closePopover();
  await waitFor('the unused files', async () => (await rows()).some((r) => r.name === NAMES.dropped), 20000);
  let list = await rows();
  check('Unused filter lists the files no block uses any more', list.some((r) => r.name === NAMES.dropped) && list.some((r) => r.name === NAMES.doc) && !list.some((r) => r.name === NAMES.kept), list.map((r) => r.name).filter((n) => n?.includes(RUN)).join(', '));
  check('a PDF that a PDF page still draws from is not listed as unused', !list.some((r) => r.name === NAMES.paper));
  check('an unused file shows 0 mentions and no page', (await rowOf(NAMES.dropped))?.mentions === '0' && !(await rowOf(NAMES.dropped))?.page);
  check('the deleted blocks did not delete the files', (await Promise.all(['dropped', 'doc', 'drawn', 'sized', 'paper'].map((k) => stored(urls[k])))).every((s) => s === 200));
  await shot('unused');

  // ---- delete: only after the confirmation, and never a file the graph still uses ----
  /** A toast of the extension's that is on screen, not covered, and holds every one of these texts. */
  const toastShows = (...texts) => evalIn((texts) => [...document.querySelectorAll('.bp3-toast')].some((t) => { const b = t.getBoundingClientRect(); return texts.every((x) => t.textContent.includes(x)) && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.bp3-toast') === t; }), texts);
  for (const k of ['dropped', 'doc', 'drawn', 'sized']) await tick(NAMES[k]);
  check('trash is on for unused files', !(await trashOff()));
  await roam.page.click(`${VIEW} .bp3-icon-trash`);
  await waitFor('the confirmation', () => evalIn(() => !!document.querySelector('.confirmation-content-dialog')), 5000);
  const dialog = await evalIn(() => document.querySelector('.confirmation-content-dialog').innerText);
  check('asks before deleting, naming the files and their mentions', /permanently delete 4 files\?/.test(dialog) && ['dropped', 'doc', 'drawn', 'sized'].every((k) => dialog.includes(NAMES[k])) && await evalIn(() => document.querySelectorAll('.confirmation-content-dialog .rfm-delete-item .rm-clickable-pill.empty-pill').length === 4), dialog.split('\n')[0]);
  check('no warning for files with 0 mentions, and each has its picture or icon', !(await warningText()) && await evalIn(() => document.querySelectorAll('.confirmation-content-dialog img.rfm-delete-thumb').length === 3 && document.querySelectorAll('.confirmation-content-dialog .rfm-delete-thumb').length === 4));
  await shot('delete-confirm');
  // Enter on a focused Cancel cancels, even for files with 0 mentions (where Enter alone confirms)
  await roam.page.focus('.confirmation-content-dialog .cancel-button');
  await roam.page.keyboard.press('Enter');
  await sleep(1500);
  check('Enter on a focused Cancel deletes nothing', !(await evalIn(() => !!document.querySelector('.confirmation-content-dialog'))) && (await stored(urls.dropped)) === 200 && !!(await rowOf(NAMES.dropped)));
  // Enter held on the trash button opens the confirmation and doesn't confirm it
  await roam.page.focus(`${VIEW} .bp3-icon-trash`);
  await roam.page.keyboard.down('Enter');
  for (let i = 0; i < 8; i++) { await roam.page.keyboard.down('Enter'); await sleep(40); }
  await roam.page.keyboard.up('Enter');
  await sleep(1500);
  check('Enter held on the trash opens the confirmation and deletes nothing', await evalIn(() => document.querySelectorAll('.confirmation-content-dialog').length === 1) && (await stored(urls.dropped)) === 200);
  await evalIn(() => document.querySelector('.confirmation-content-dialog .cancel-button').click());
  await sleep(1500);
  check('Cancel deletes nothing', (await stored(urls.dropped)) === 200 && !!(await rowOf(NAMES.dropped)));
  await roam.page.click(`${VIEW} .bp3-icon-trash`);
  await waitFor('the confirmation', () => evalIn(() => !!document.querySelector('.confirmation-content-dialog')), 5000);
  // once the delete runs, Cancel, the backdrop and Escape leave the confirmation where it is
  const locked = await evalIn(() => {
    const d = document.querySelector('.confirmation-content-dialog'), cancel = d.querySelector('.cancel-button');
    d.querySelector('.confirm-button').click();
    const off = cancel.disabled;
    cancel.click();
    d.closest('.bp3-portal').querySelector('.bp3-overlay-backdrop').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    return { off, open: !!document.querySelector('.confirmation-content-dialog') };
  });
  check('while the delete runs, Cancel is off and neither it, a click outside nor Escape closes the confirmation', locked.off && locked.open, JSON.stringify(locked));
  await waitFor('the deleted file to leave the list', async () => !(await rowOf(NAMES.dropped)), 30000);
  await waitFor('the confirmation to close at the end of the delete', async () => !(await dialogOpen()), 30000);
  await sleep(1500);
  const gone = (s) => [403, 404].includes(s);
  let after = Object.fromEntries(await Promise.all(['dropped', 'doc', 'sized', 'drawn', 'kept'].map(async (k) => [k, await stored(urls[k])])));
  check('confirming deletes a file used nowhere from Roam\'s storage', gone(after.dropped) && gone(after.doc), `storage answers ${after.dropped}, ${after.doc}`);
  check('a file whose only trace is a saved image size in block props is deleted', gone(after.sized), `storage answers ${after.sized}`);
  check('a file whose block is gone but which block props still hold (a drawing) is not deleted', after.drawn === 200 && !!(await rowOf(NAMES.drawn)), `storage answers ${after.drawn}`);
  check('the file still in a block is untouched', after.kept === 200);
  check('nothing stays ticked after a delete', await evalIn((v) => ![...document.querySelectorAll(`${v} input[type=checkbox]`)].some((c) => c.checked), VIEW) && await trashOff());
  check('says why the file was kept', await toastShows(NAMES.drawn, 'Still used in a PDF page or drawing'));
  await shot('after-delete');
  // the PDF: its block is gone, its PDF page is not
  await setSwitch('Unused', false);
  await closePopover();
  await search(NAMES.paper);
  check('the PDF is listed, with 0 mentions', (await rowOf(NAMES.paper))?.mentions === '0');
  await tick(NAMES.paper);
  await openDialog();
  await evalIn(() => document.querySelector('.confirmation-content-dialog .confirm-button').click());
  await waitFor('the confirmation to close at the end of the delete', async () => !(await dialogOpen()), 30000);
  await sleep(1500);
  check('a PDF whose {{pdf}} block is gone but whose PDF page remains is not deleted', (await stored(urls.paper)) === 200 && !!(await rowOf(NAMES.paper)), `storage answers ${await stored(urls.paper)}`);
  check('says why the PDF was kept', await toastShows(NAMES.paper, 'Still used in a PDF page or drawing'));
  // leaving Files while a delete runs ends it before its next file
  await search('fm-ci-extra');
  await tick(NAMES.extra1); await tick(NAMES.extra2);
  await openDialog();
  await evalIn(() => { document.querySelector('.confirmation-content-dialog .confirm-button').click(); document.querySelector('.rm-left-sidebar__daily-notes').click(); });
  await waitFor('the list to close', () => evalIn((v) => !document.querySelector(v), VIEW), 10000);
  await sleep(5000);
  const extras = [await stored(urls.extra1), await stored(urls.extra2)];
  check('leaving Files during a delete closes the confirmation and ends the delete before its next file', !(await dialogOpen()) && extras.some((s) => s === 200), `storage answers ${extras.join(', ')}`);
  // with the drawing and the PDF page gone, those files can go too
  await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), inProps.drawing);
  for (const uid of await pdfPages()) await evalIn((uid) => window.roamAlphaAPI.data.page.delete({ page: { uid } }), uid);
  await sleep(1000);
  await openAllFiles();
  await setSwitch('Unused', false);
  await closePopover();
  await search('fm-ci-');
  await waitFor('the list', async () => !!(await rowOf(NAMES.drawn)), 20000);
  const last = ['drawn', 'paper', 'extra1', 'extra2'];
  for (const k of last) if (await rowOf(NAMES[k])) await tick(NAMES[k]);
  await openDialog();
  await evalIn(() => document.querySelector('.confirmation-content-dialog .confirm-button').click());
  await waitFor('the confirmation to close at the end of the delete', async () => !(await dialogOpen()), 60000);
  await sleep(1500);
  const lastAfter = await Promise.all(last.map((k) => stored(urls[k])));
  check('once nothing uses them, they are deleted', lastAfter.every(gone), `storage answers ${lastAfter.join(', ')}`);
  check('the file in two blocks is still stored', (await stored(urls.kept)) === 200);
  list = await rows();
  check('the list keeps the file in use and drops the deleted ones', list.some((r) => r.name === NAMES.kept) && !list.some((r) => [NAMES.dropped, NAMES.doc, NAMES.sized, NAMES.drawn, NAMES.paper].includes(r.name)));

  // ---- deleting a file that a block still holds ----
  await tick(NAMES.used);
  await openDialog();
  warn = await warningText();
  check('warns about the one block', warn.includes('This file is still referenced in 1 block, which will be left with a broken image.'), warn);
  await evalIn(() => document.querySelector('.confirmation-content-dialog .confirm-button').click());
  await waitFor('the deleted file to leave the list', async () => !(await rowOf(NAMES.used)), 30000);
  check('confirming deletes a file that was still in a block', [403, 404].includes(await stored(urls.used)), `storage answers ${await stored(urls.used)}`);
  check('its block is left as it was', await evalIn(([uid, url]) => window.roamAlphaAPI.data.pull('[:block/string]', [':block/uid', uid])?.[':block/string']?.includes(url), [made.blocks.used, urls.used]));
  check('the other file is untouched', (await stored(urls.kept)) === 200 && !!(await rowOf(NAMES.kept)));
  await closeAllFiles();
  await openAllFiles();
  await search('fm-ci-');
  await sleep(1500);
  check('a deleted file stays out of the list while its dead link is still in a block', !(await rowOf(NAMES.used)) && !!(await rowOf(NAMES.kept)));
  await search('');

  // ---- what it has seen survives a restart ----
  for (const uid of [made.blocks.kept, made.blocks.kept2]) await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), uid);
  await sleep(1500);
  await killRoam('SIGTERM');
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openGraph(GRAPH);
  await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.open());
  await waitFor('the extension after a restart', extensionLoaded, 60000);
  await openAllFiles();
  await setSwitch('Unused', true);
  await closePopover();
  await waitFor('the last test file as unused', async () => !!(await rowOf(NAMES.kept)), 20000).then(
    () => check('after a restart, a file whose block went away is still found as unused', true),
    () => check('after a restart, a file whose block went away is still found as unused', false));
  await setSwitch('Unused', false);
  await closePopover();
} catch (e) {
  log('ERROR', e.message);
  await shot('error');
  writeResults(e.message.split('\n')[0]);
} finally {
  // leave the test graph as it was: no test page, no test files
  try {
    if (roam.page && roam.signedIn) {
      const left = await evalIn(async ([urls, pageUids]) => {
        const api = window.roamAlphaAPI; const left = [];
        // a PDF page Roam made for one of the test files
        for (const url of Object.values(urls)) for (const uid of api.data.q('[:find [?uid ...] :in $ ?u :where [?e :pdf/url ?u] [?e :block/uid ?uid]]', url) ?? []) pageUids.push(uid);
        for (const uid of pageUids) if (uid && api.data.pull('[:block/uid]', [':block/uid', uid])) await api.data.page.delete({ page: { uid } });
        for (const url of Object.values(urls)) {
          if ((await fetch(url.replace(/\?.*$/, ''))).status !== 200) continue;
          try { await api.file.delete({ url }); } catch (e) { left.push(String(e).slice(0, 120)); }
        }
        return left;
      }, [{ ...urls, ...Object.fromEntries(STALE.map((u, i) => [`stale${i}`, u])) }, pageUids]);
      if (left.length) log('cleanup could not delete', left.join('; '));
      await dismissDialogs();
    }
  } catch (e) { log('cleanup failed', e.message.split('\n')[0]); }
  await killRoam('SIGTERM').catch(() => {});
  stopServing();
}
const pass = fs.existsSync(path.join(OUT, 'RESULTS.md')) && /Stopped early/.test(fs.readFileSync(path.join(OUT, 'RESULTS.md'), 'utf8')) ? false : writeResults();
log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
