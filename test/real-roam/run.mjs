// End-to-end run of the built extension in Roam's real desktop app (the Linux build, under Xvfb),
// signed in to a hosted test graph. Drives Roam over the Chrome DevTools Protocol with Playwright.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… node test/real-roam/run.mjs
//
// Checks what a read-only graph can't show: files uploaded to the graph appear in Files with
// their name, size and page; a file whose block is deleted turns up as unused; only unused files can
// be deleted, and only after Roam's confirmation; a delete really removes the file from storage; and
// a file still in a block is never touched. Writes RESULTS.md and PNG screenshots to $OUT.
//
// It uploads three tiny files to the test graph and removes them again, with the page it made.
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

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'real-roam-out');
const TEST_PAGE = 'File Manager CI test';
const RUN = Date.now().toString(36);
const NAMES = { kept: `fm-ci-kept-${RUN}.png`, dropped: `fm-ci-dropped-${RUN}.png`, doc: `fm-ci-doc-${RUN}.txt`, used: `fm-ci-used-${RUN}.png` };

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
  await openGraph(GRAPH);
  await loadDevExtension();
  check('loads through Roam Depot developer mode', await extensionLoaded());
  // which video formats this build of Roam can show a frame of
  log('browser', await evalIn(() => { const v = document.createElement('video'); const can = (c) => v.canPlayType(`video/mp4; codecs="${c}"`) || 'no'; return `${navigator.userAgent.match(/Chrome\/[\d.]+|Electron\/[\d.]+/g)?.join(' ')}; H.264 ${can('avc1.42E01E')}, HEVC ${can('hvc1.1.6.L93.B0')}`; }));
  check('Files sits under All Pages in the left sidebar', await evalIn(() => document.querySelector('.rm-left-sidebar__all-pages')?.nextElementSibling?.classList.contains('rm-left-sidebar__files')));

  // ---- four files on a test page ----
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
    const files = {
      kept: new File([await png(210)], names.kept, { type: 'image/png' }),
      dropped: new File([await png(10)], names.dropped, { type: 'image/png' }),
      doc: new File(['File Manager CI test file\n'.repeat(40)], names.doc, { type: 'text/plain' }),
      used: new File([await png(120)], names.used, { type: 'image/png' }),
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
  check('Roam stored the four test files', (await Promise.all(Object.values(urls).map(stored))).every((s) => s === 200));

  // ---- they are listed ----
  await openAllFiles();
  await search(`fm-ci-`);
  await waitFor('the test files in the list, with sizes', async () => { const r = await rows(); return r.length >= 3 && r.filter((x) => x.name?.includes(RUN)).every((x) => x.size); }, 30000);
  let kept = await rowOf(NAMES.kept), dropped = await rowOf(NAMES.dropped), doc = await rowOf(NAMES.doc);
  check('lists uploaded files by the name they were uploaded with', kept && dropped && doc, [kept, dropped, doc].map((r) => r?.name).join(', '));
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

  // ---- a file whose block is deleted becomes unused ----
  await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), made.blocks.dropped);
  await evalIn((uid) => window.roamAlphaAPI.data.block.delete({ block: { uid } }), made.blocks.doc);
  await sleep(1000);
  await closeAllFiles();
  await openAllFiles();
  await setSwitch('Unused', true);
  await closePopover();
  await waitFor('the unused files', async () => (await rows()).some((r) => r.name === NAMES.dropped), 20000);
  let list = await rows();
  check('Unused filter lists the files no block uses any more', list.some((r) => r.name === NAMES.dropped) && list.some((r) => r.name === NAMES.doc) && !list.some((r) => r.name === NAMES.kept), list.map((r) => r.name).filter((n) => n?.includes(RUN)).join(', '));
  check('an unused file shows 0 mentions and no page', (await rowOf(NAMES.dropped))?.mentions === '0' && !(await rowOf(NAMES.dropped))?.page);
  check('the deleted blocks did not delete the files', (await stored(urls.dropped)) === 200 && (await stored(urls.doc)) === 200);
  await shot('unused');

  // ---- delete: only after the confirmation, and never a file whose link is still in the graph ----
  // the text file's link now lives on in a page title, which the list doesn't read
  const titleUid = await evalIn(async (url) => {
    const uid = window.roamAlphaAPI.util.generateUID();
    await window.roamAlphaAPI.data.page.create({ page: { title: `File Manager CI link ${url}`, uid } });
    return uid;
  }, urls.doc);
  pageUids.push(titleUid);
  await sleep(1000);
  await tick(NAMES.dropped); await tick(NAMES.doc);
  check('trash is on for unused files', !(await trashOff()));
  await roam.page.click(`${VIEW} .bp3-icon-trash`);
  await waitFor('the confirmation', () => evalIn(() => !!document.querySelector('.confirmation-content-dialog')), 5000);
  const dialog = await evalIn(() => document.querySelector('.confirmation-content-dialog').innerText);
  check('asks before deleting, naming the files and their mentions', /permanently delete 2 files\?/.test(dialog) && dialog.includes(NAMES.dropped) && dialog.includes(NAMES.doc) && await evalIn(() => document.querySelectorAll('.confirmation-content-dialog .rfm-delete-item .rm-clickable-pill.empty-pill').length === 2), dialog.split('\n')[0]);
  check('no warning for files with 0 mentions, and each has its picture or icon', !(await warningText()) && await evalIn(() => document.querySelectorAll('.confirmation-content-dialog img.rfm-delete-thumb').length === 1 && document.querySelectorAll('.confirmation-content-dialog .rfm-delete-thumb').length === 2));
  await shot('delete-confirm');
  await evalIn(() => document.querySelector('.confirmation-content-dialog .cancel-button').click());
  await sleep(1500);
  check('Cancel deletes nothing', (await stored(urls.dropped)) === 200 && !!(await rowOf(NAMES.dropped)));
  await roam.page.click(`${VIEW} .bp3-icon-trash`);
  await waitFor('the confirmation', () => evalIn(() => !!document.querySelector('.confirmation-content-dialog')), 5000);
  await evalIn(() => document.querySelector('.confirmation-content-dialog .confirm-button').click());
  await waitFor('the deleted file to leave the list', async () => !(await rowOf(NAMES.dropped)), 30000);
  await sleep(1500);
  let after = [await stored(urls.dropped), await stored(urls.doc), await stored(urls.kept)];
  check('confirming deletes the file from Roam\'s storage', [403, 404].includes(after[0]), `storage answers ${after[0]}`);
  check('a file whose link is still somewhere in the graph is not deleted', after[1] === 200 && !!(await rowOf(NAMES.doc)));
  check('the file still in a block is untouched', after[2] === 200);
  check('nothing stays ticked after a delete', await evalIn((v) => ![...document.querySelectorAll(`${v} input[type=checkbox]`)].some((c) => c.checked), VIEW) && await trashOff());
  check('says which file it could not delete', await evalIn((name) => [...document.querySelectorAll('.bp3-toast')].some((t) => t.textContent.includes(name)), NAMES.doc));
  await shot('after-delete');
  // with the page title gone, the text file can go too
  await evalIn((uid) => window.roamAlphaAPI.data.page.delete({ page: { uid } }), titleUid);
  await sleep(1000);
  await tick(NAMES.doc);
  await roam.page.click(`${VIEW} .bp3-icon-trash`);
  await waitFor('the confirmation', () => evalIn(() => !!document.querySelector('.confirmation-content-dialog')), 5000);
  await evalIn(() => document.querySelector('.confirmation-content-dialog .confirm-button').click());
  await waitFor('the text file to leave the list', async () => !(await rowOf(NAMES.doc)), 30000);
  after = [await stored(urls.doc), await stored(urls.kept)];
  check('once nothing links to it, it is deleted', [403, 404].includes(after[0]) && after[1] === 200, `storage answers ${after[0]}`);
  await setSwitch('Unused', false);
  await closePopover();
  await search('fm-ci-');
  list = await rows();
  check('the list keeps the file in use and drops the deleted ones', list.some((r) => r.name === NAMES.kept) && !list.some((r) => r.name === NAMES.dropped || r.name === NAMES.doc));

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
