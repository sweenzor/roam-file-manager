// Finds out whether a local graph can be made by going straight to #/offline/<name>, in Roam's
// desktop app (Linux build, under Xvfb) and in a browser (Chrome, headless), signed in to the test
// account. For each: does the graph open, can it be written to (API and typing), does what was
// written survive a reload and a restart, does it turn up in the graph list, and does Files work in
// it (upload, list, delete). Writes RESULTS.md and PNG screenshots to $OUT.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… PART=desktop|browser node test/real-roam/local-graph.mjs
//
// Credentials as in run.mjs: from the environment only, never logged, no picture before a graph is open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, signIn,
  dismissDialogs, loadDevExtension, extensionLoaded, openSettings,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const PART = process.env.PART || 'desktop';
const GRAPH = process.env.LOCAL_GRAPH || `rfm-local-${PART}-${Date.now().toString(36)}`;
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'local-graph-out', PART);
const MARK = `local graph test ${Date.now().toString(36)}`;
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'local-graph-'));
roam.out = OUT; roam.logDir = WORK;
const DIST = path.join(WORK, 'dist');
fs.mkdirSync(DIST);
for (const f of ['extension.js', 'README.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

const found = [];
const note = (name, value) => { found.push([name, String(value)]); log('FOUND', name, '=>', String(value)); };
const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms))]);
const attempt = async (name, fn, ms = 90000) => { log('TRY', name); try { const v = await within(ms, fn()); note(name, typeof v === 'string' ? v : JSON.stringify(v)); return v; } catch (e) { note(name, `ERROR ${e.message.split('\n')[0].slice(0, 300)}`); return undefined; } };
const writeResults = () => fs.writeFileSync(path.join(OUT, 'RESULTS.md'), [`# Local graph by address: ${PART}`, '', `Graph \`${GRAPH}\`. Commit ${(process.env.GITHUB_SHA || 'local').slice(0, 7)}.`, '', '| What | Found |', '|---|---|', ...found.map(([n, v]) => `| ${n} | ${v.replace(/\|/g, '\\|')} |`), ''].join('\n'));

/** What kind of screen Roam shows, without the account's own details. */
const screen = () => evalIn(() => {
  const t = document.body.innerText;
  return [location.hash, /sign in|log in/i.test(t) && 'sign-in form', /hosted graphs/i.test(t) && 'graph list',
    !!document.querySelector('input[placeholder="New Local Graph Name"]') && 'new-local-graph field', !!window.roamAlphaAPI && 'api ready',
    !!document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container') && 'graph open', `${t.length} chars`,
    `${document.querySelectorAll('.bp3-dialog').length} dialogs`,
    `buttons: ${[...document.querySelectorAll('button, .bp3-button')].map((b) => b.textContent.trim().slice(0, 24)).filter(Boolean).slice(0, 12).join('/')}`].filter(Boolean).join(', ');
}).catch(() => 'page not readable');
/** Short texts on screen about plans, local graphs and read-only. */
const hints = () => evalIn(() => [...new Set([...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /read.?only|local|offline|plan\b|subscri|upgrade|trial|expired/i.test(e.textContent) && e.textContent.trim().length < 160 && !/@/.test(e.textContent)).map((e) => e.textContent.trim()))].slice(0, 15).join(' | '));
const graphOpen = () => evalIn(() => !!(window.roamAlphaAPI?.data?.q && document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container, .rm-title-display')));
const base = () => roam.page.url().split('#')[0];
const hasMark = (mark) => evalIn((mark) => window.roamAlphaAPI.data.q('[:find (count ?b) . :in $ ?m :where [?b :block/string ?s] [(clojure.string/includes? ?s ?m)]]', mark) ?? 0, mark);

async function gotoOffline() {
  await roam.page.goto(`${base()}#/offline/${GRAPH}`);
  await sleep(1000);
  // a hash change alone may not start the app again
  if (!(await graphOpen().catch(() => false))) await roam.page.reload().catch(() => {});
  try { await waitFor('the local graph', graphOpen, 90000); } catch { /* reported by the caller */ }
  const open = await graphOpen().catch(() => false);
  if (open) { roam.signedIn = true; await sleep(1500); }
  return open;
}

async function launch() {
  if (PART === 'desktop') { await launchRoam(); return; }
  const require = createRequire(import.meta.url);
  const { chromium } = (() => { try { return require('playwright-core'); } catch { return require('playwright'); } })();
  const ctx = await chromium.launchPersistentContext(path.join(WORK, 'profile'), { channel: process.env.BROWSER_CHANNEL || 'chrome', headless: !!process.env.HEADLESS, viewport: { width: 1200, height: 773 }, args: ['--no-sandbox'] });
  roam.browser = ctx; // close() ends it, as killRoam expects
  roam.page = ctx.pages()[0] ?? await ctx.newPage();
  roam.page.on('console', (m) => { if (m.text().includes('[roam-file-manager]')) log('[page]', m.text().slice(0, 300)); });
  await roam.page.goto('https://roamresearch.com/#/app');
}
async function quit() {
  if (PART === 'desktop') { await killRoam('SIGTERM'); return; }
  await roam.browser.close(); roam.browser = null; roam.page = null;
}

/** A picture with anything that looks like an email address covered, and never of the graph list. */
const pic = async (name) => {
  if (!roam.signedIn || !roam.page || !/#\/offline\//.test(roam.page.url())) return;
  const f = path.join(OUT, `${String(++roam.shotN).padStart(2, '0')}-${name}.png`);
  await within(20000, roam.page.screenshot({ path: f, mask: [roam.page.locator('text=/[\\w.+-]+@[\\w-]+\\.[\\w.]+/')], maskColor: '#888' })).catch((e) => log('screenshot failed', e.message.split('\n')[0]));
};
let failed = '';
try {
  serve(DIST);
  await launch();
  await signIn(EMAIL, PASSWORD);
  await sleep(4000);
  note('after sign-in', await screen());
  await roam.page.goto(`${base()}#/app`); await sleep(5000);
  note('graph list', await screen());
  note('graph list hints', await hints());
  // what the account's plan looks like from here. Digits are blanked and nothing with an @ is kept: the log is public.
  const planWords = () => evalIn(() => [...new Set([...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /believer|\bpro\b|plan\b|subscri|expir|renew|billing|trial|valid|until|member/i.test(e.textContent) && e.textContent.trim().length < 200 && !/@/.test(e.textContent)).map((e) => e.textContent.trim().replace(/\d/g, '#')))].slice(0, 25).join(' | '));
  note('graph list: plan words', await planWords());
  await attempt('account menu', async () => {
    const who = roam.page.locator('text=/@/').first();
    const box = await who.boundingBox();
    await who.click({ timeout: 5000 }).catch(() => {});
    await sleep(800);
    let items = await evalIn(() => [...document.querySelectorAll('.bp3-popover *, .bp3-menu *')].filter((e) => e.children.length === 0 && e.textContent.trim() && !/@/.test(e.textContent)).map((e) => e.textContent.trim().replace(/\d/g, '#')).slice(0, 20).join(' | '));
    if (!items && box) { await roam.page.mouse.click(box.x + box.width + 28, box.y + box.height / 2); await sleep(800); items = await evalIn(() => [...document.querySelectorAll('.bp3-popover *, .bp3-menu *')].filter((e) => e.children.length === 0 && e.textContent.trim() && !/@/.test(e.textContent)).map((e) => e.textContent.trim().replace(/\d/g, '#')).slice(0, 20).join(' | ')); }
    const words = await planWords();
    await roam.page.keyboard.press('Escape');
    return `menu: ${items || 'none'} ;; plan words with it open: ${words}`;
  });
  note('graph list names our graph (before)', await evalIn((g) => document.body.innerText.includes(g), GRAPH));

  // ---- the address ----
  const open = await gotoOffline();
  note('opens at #/offline/<name>', open);
  note('screen', await screen());
  note('hints', await hints());
  if (!open) throw new Error('the graph did not open at its address');
  const bar = () => evalIn(() => [...document.querySelectorAll('body *')].filter((e) => /read-only mode/i.test(e.textContent) && e.textContent.length < 400).map((e) => e.textContent.trim().replace(/\s+/g, ' ')).sort((a, b) => b.length - a.length)[0] ?? 'no read-only bar');
  const writeApi = () => evalIn(() => { const a = window.roamAlphaAPI; return `page: ${Object.keys(a.data.page ?? {}).join('/') || 'none'}; block: ${Object.keys(a.data.block ?? {}).join('/') || 'none'}; file: ${Object.keys(a.file ?? {}).join('/')}; createBlock: ${typeof a.createBlock}`; });
  await pic('opened-first-moment');
  note('read-only bar at once', await bar());
  note('write API at once', await writeApi());
  await sleep(30000);
  note('read-only bar after 30 s', await bar());
  note('write API after 30 s', await writeApi());
  await attempt('roamAlphaAPI.user', () => evalIn(() => Object.keys(window.roamAlphaAPI.user ?? {}).join('/')));
  // close the help panel and the backup notice the way a person would
  await attempt('closed the panels', async () => { let n = 0; for (const sel of ['.bp3-toast .bp3-icon-cross', '.bp3-toast button', '.rm-help-dialog .bp3-icon-cross', '.bp3-drawer .bp3-icon-cross', '.bp3-overlay .bp3-icon-cross']) { const b = roam.page.locator(sel).first(); if (await b.count()) { await b.click({ timeout: 2000 }).catch(() => {}); n++; await sleep(400); } } await roam.page.keyboard.press('Escape'); return n; });
  await sleep(1000);
  await pic('opened');
  await attempt('roamAlphaAPI.graph', () => evalIn(() => window.roamAlphaAPI.graph));
  await attempt('API', () => evalIn(() => { const a = window.roamAlphaAPI, d = a.data; return `top: ${Object.keys(a).join('/')}; data: ${Object.keys(d).join('/')}; page: ${Object.keys(d.page ?? {}).join('/')}; block: ${Object.keys(d.block ?? {}).join('/')}; file: ${Object.keys(a.file ?? {}).join('/')}`; }));
  await attempt('blocks in the graph', () => evalIn(() => window.roamAlphaAPI.data.q('[:find (count ?b) . :where [?b :block/string]]') ?? 0));
  const before = await hasMark('local graph test ');
  note('blocks of an earlier run', before);

  // ---- writing ----
  await attempt('write through the API', () => evalIn(async (mark) => {
    const api = window.roamAlphaAPI, title = 'Local graph test';
    let uid = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', title);
    if (!uid) { uid = api.util.generateUID(); await api.data.page.create({ page: { title, uid } }); }
    await api.data.block.create({ location: { 'parent-uid': uid, order: 'last' }, block: { string: `${mark} api` } });
    await api.ui.mainWindow.openPage({ page: { uid } });
    return 'no error';
  }, MARK));
  await sleep(1500);
  note('API block is in the graph', await hasMark(`${MARK} api`));
  await attempt('daily notes', async () => { await evalIn(() => window.roamAlphaAPI.ui.mainWindow.openDailyNotes?.()); await sleep(2000); return evalIn(() => { const m = document.querySelector('.roam-main'); return `blocks drawn: ${m.querySelectorAll('.roam-block, .rm-block-input, textarea').length}; text: ${m.innerText.trim().replace(/\s+/g, ' ').slice(0, 160)}`; }); });
  await attempt('write by typing', async () => {
    const block = roam.page.locator('.roam-main .roam-block, .roam-main .rm-block-text').first();
    if (await block.count()) await block.click({ timeout: 5000 }); else await roam.page.mouse.click(600, 220);
    await sleep(500);
    const focused = await evalIn(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`.slice(0, 80));
    await roam.page.keyboard.type(`${MARK} typed`, { delay: 25 });
    await sleep(500);
    await pic('typing');
    await roam.page.keyboard.press('Enter');
    await roam.page.keyboard.type('second item', { delay: 25 });
    await roam.page.keyboard.press('Escape');
    await sleep(1500);
    return `focus went to ${focused}; blocks with the typed text: ${await hasMark(`${MARK} typed`)}; blocks in the graph: ${await evalIn(() => window.roamAlphaAPI.data.q('[:find (count ?b) . :where [?b :block/string]]') ?? 0)}`;
  });
  note('hints after writing', await hints());
  await pic('written');

  await attempt('Settings: what it says about the plan', async () => {
    await openSettings();
    await sleep(1000);
    const tabs = await evalIn(() => [...document.querySelectorAll('.bp3-dialog .bp3-tab, .bp3-dialog [role="tab"]')].map((e) => e.textContent.trim()).join('/'));
    const seen = [];
    for (const t of tabs.split('/').filter((t) => /user|account|billing|subscri|plan|member|graph/i.test(t))) {
      await evalIn((t) => [...document.querySelectorAll('.bp3-dialog .bp3-tab, .bp3-dialog [role="tab"]')].find((e) => e.textContent.trim() === t)?.click(), t);
      await sleep(1200);
      seen.push(`[${t}] ${await evalIn(() => [...new Set([...document.querySelectorAll('.bp3-dialog *')].filter((e) => e.children.length === 0 && /believer|\bpro\b|plan\b|subscri|expir|renew|billing|trial|valid|until|member/i.test(e.textContent) && e.textContent.trim().length < 200 && !/@/.test(e.textContent)).map((e) => e.textContent.trim().replace(/\d/g, '#')))].slice(0, 12).join(' | '))}`);
    }
    await within(15000, dismissDialogs()).catch(() => {});
    return `tabs: ${tabs} ;; ${seen.join(' ;; ')}`;
  });

  // Billing: what the account's own billing page says about the plan and its end. Only lines about the
  // plan and dates are kept; nothing with an @ and no long numbers (card details). No picture of it.
  await attempt('Billing page', async () => {
    await openSettings(); await sleep(800);
    await evalIn(() => [...document.querySelectorAll('.bp3-dialog .bp3-tab, .bp3-dialog [role="tab"]')].find((e) => e.textContent.trim() === 'Account')?.click());
    await sleep(1000);
    const ctx = roam.page.context();
    const popup = ctx.waitForEvent('page', { timeout: 20000 }).catch(() => null);
    const before = roam.page.url();
    await evalIn(() => [...document.querySelectorAll('.bp3-dialog button, .bp3-dialog a, .bp3-dialog .bp3-button')].find((e) => /open billing/i.test(e.textContent))?.click());
    const p = (await popup) ?? roam.page;
    await sleep(12000);
    const where = new URL(p.url()).host;
    const lines = (await p.evaluate(() => document.body.innerText).catch(() => '')).split('\n').map((l) => l.trim())
      .filter((l) => l && l.length < 160 && !/@/.test(l) && !/\d{5,}/.test(l) && /believer|\bpro\b|plan|subscri|expir|renew|cancel|until|period|year|month|next|invoice|\$\d|20\d\d/i.test(l));
    if (p !== roam.page) await p.close().catch(() => {}); else if (roam.page.url() !== before) await roam.page.goto(before).catch(() => {});
    await within(15000, dismissDialogs()).catch(() => {});
    return `opened ${where}: ${[...new Set(lines)].slice(0, 25).join(' | ')}`;
  }, 60000);

  // ---- Files in a local graph ----
  if (PART === 'desktop') await attempt('developer extension loads', async () => { await loadDevExtension(); return extensionLoaded(); });
  if (PART === 'desktop' && !(await extensionLoaded().catch(() => false))) {
    await within(15000, dismissDialogs()).catch(() => {});
    await attempt('extension loaded straight from its URL', async () => {
      await evalIn(async () => { const m = await import('http://127.0.0.1:8766/ci/extension.js'); await m.default.onload({ extensionAPI: { settings: { get() {}, set() {}, getAll() { return {}; }, panel: { create() {} } } } }); });
      await waitFor('the Files row', extensionLoaded, 15000); return true;
    });
  }
  const up = await attempt('file.upload', () => evalIn(async (mark) => {
    const api = window.roamAlphaAPI;
    const c = document.createElement('canvas'); c.width = c.height = 48; const x = c.getContext('2d');
    x.fillStyle = '#3b7'; x.fillRect(0, 0, 48, 48); x.fillStyle = '#fff'; x.fillRect(12, 12, 24, 24);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const md = await api.file.upload({ file: new File([blob], 'local-graph-test.png', { type: 'image/png' }), toast: { hide: true } });
    const uid = api.data.q('[:find ?u . :in $ ?t :where [?p :node/title ?t] [?p :block/uid ?u]]', 'Local graph test');
    await api.data.block.create({ location: { 'parent-uid': uid, order: 'last' }, block: { string: `${md} ${mark} file` } });
    const url = md.match(/\((\S+?)\)/)?.[1] ?? md;
    return { markdown: md.replace(/\?.*$/, '?…').slice(0, 200), scheme: url.split(':')[0], url };
  }, MARK));
  if (up?.url) {
    await attempt('file.get on the upload', () => evalIn(async (url) => { const f = await window.roamAlphaAPI.file.get({ url }); return `${f?.constructor?.name} ${f?.name ?? ''} ${f?.size ?? ''} ${f?.type ?? ''}`; }, up.url));
    await attempt('upload metadata without sign-in', () => evalIn((url) => fetch(url.replace(/\?.*$/, '')).then((r) => r.status, (e) => `fetch failed: ${e.message}`), up.url));
  }
  await sleep(1500);
  await attempt('Files lists', async () => {
    await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.open());
    await evalIn(() => document.querySelector('.rm-left-sidebar__files').click());
    await waitFor('the Files list', () => evalIn(() => !!document.querySelector('.rfm-view')), 10000);
    await sleep(6000);
    return evalIn(() => [...document.querySelectorAll('.rfm-view .rm-pages-row:not(.rm-pages-row-header)')].map((r) => [...r.querySelectorAll('.rm-pages-title-text, .rfm-col-type, .rfm-col-size, .rfm-col-mentions, .rfm-col-added')].map((e) => e.textContent.trim()).join(' ; ')).slice(0, 10));
  });
  await pic('files');
  await attempt('back to daily notes', async () => { await evalIn(() => document.querySelector('.rm-left-sidebar__daily-notes').click()); await sleep(1000); return true; });

  // ---- does it last ----
  await sleep(3000);
  await roam.page.reload(); await sleep(2000);
  await waitFor('the graph after a reload', graphOpen, 90000).catch(() => {});
  note('after a reload', await screen());
  note('after a reload: API block', await hasMark(`${MARK} api`).catch((e) => `ERROR ${e.message.split('\n')[0]}`));
  note('after a reload: typed block', await hasMark(`${MARK} typed`).catch((e) => `ERROR ${e.message.split('\n')[0]}`));
  await attempt('IndexedDB databases', () => evalIn(async () => (await indexedDB.databases()).map((d) => d.name).join(', ')));
  await attempt('storage estimate', () => evalIn(async () => { const e = await navigator.storage.estimate(); return `${e.usage} bytes used, persisted: ${await navigator.storage.persisted()}`; }));

  await quit();
  await sleep(3000);
  await launch();
  await signIn(EMAIL, PASSWORD);
  await sleep(4000);
  await roam.page.goto(`${base()}#/app`); await sleep(5000);
  note('after a restart: graph list', await screen());
  note('after a restart: graph list names our graph', await evalIn((g) => document.body.innerText.includes(g), GRAPH));
  note('after a restart: graph list hints', await hints());
  note('after a restart: opens', await gotoOffline());
  note('after a restart: API block', await hasMark(`${MARK} api`).catch((e) => `ERROR ${e.message.split('\n')[0]}`));
  note('after a restart: typed block', await hasMark(`${MARK} typed`).catch((e) => `ERROR ${e.message.split('\n')[0]}`));
  note('after a restart: Files row (extension loaded by itself)', await extensionLoaded().catch(() => false));
  await within(15000, dismissDialogs()).catch(() => {});
  await pic('after-restart');
} catch (e) {
  failed = e.message.split('\n')[0];
  log('STOPPED', failed);
  note('stopped', failed);
  await pic('stopped');
} finally {
  writeResults();
  try { await quit(); } catch { /* gone */ }
  stopServing();
}
process.exit(failed ? 1 : 0);
