// Probe (temporary): how files work in a local graph of Roam's desktop app, for File Manager's
// local-graph support. Uploads the made-up demo files to a fresh local graph and records what Roam
// does with them: the markdown, the address Roam draws them from, the desktop app's file list and
// delete (the ones Roam's own Settings > Attachments uses), roamAlphaAPI.file.delete.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, signIn, dismissDialogs, openSettings, clickLeaf } from './roam.mjs';
import { buildDemoFiles } from './demo-files.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const GRAPH = `rfm-probe-${Date.now().toString(36)}`;
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'probe-out');
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
roam.out = OUT; roam.logDir = WORK;
const DIST = path.join(WORK, 'dist'); fs.mkdirSync(DIST);
for (const f of ['extension.js', 'README.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

const found = [];
const note = (n, v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); found.push([n, s]); log('FOUND', n, '=>', s.slice(0, 2000)); };
const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms))]);
const attempt = async (n, fn, ms = 60000) => { try { const v = await within(ms, fn()); note(n, v); return v; } catch (e) { note(n, `ERROR ${String(e.message).split('\n')[0].slice(0, 400)}`); } };
const write = () => fs.writeFileSync(path.join(OUT, 'RESULTS.md'), ['# Local graph files probe', '', `Graph \`${GRAPH}\`. Commit ${(process.env.GITHUB_SHA || 'local').slice(0, 7)}.`, '', '| What | Found |', '|---|---|',
  ...found.map(([n, v]) => `| ${n} | ${v.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 6000)} |`), ''].join('\n'));
const pic = async (name) => { await roam.page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {}); };
const graphOpen = () => evalIn(() => !!(window.roamAlphaAPI?.data?.q && document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container, .rm-title-display')));

// The desktop app's own messages to its main process, as Roam's page sends them (main.js BMa/YNa).
const IPC = `
window.__rfmIpc = (entity, tx, timeout = 15000) => new Promise((res, rej) => {
  const id = crypto.randomUUID();
  const t = setTimeout(() => { removeEventListener('message', on); rej(new Error('timeout')); }, timeout);
  function on(e) {
    const d = e.data;
    if (e.source !== window || d?.msgType !== 'roam-electron-main-message-to-renderer' || typeof d.dataInTransit !== 'string' || !d.dataInTransit.includes(id)) return;
    clearTimeout(t); removeEventListener('message', on); res(d.dataInTransit);
  }
  addEventListener('message', on);
  const msg = JSON.stringify(['^ ', '~:relemma.foreign.events/command', '~:relemma.foreign.events/api-request',
    '~:relemma.foreign.events/value', ['^ ', '~:pathom/tx', tx, '~:pathom/entity', entity],
    '~:com.wsscode.async.processing/request-id', '~u' + id]);
  window.postMessage({ msgType: 'roam-electron-renderer-message-to-main', dataInTransit: msg }, '*');
});
undefined`;

let failed = null;
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
  note('graph', await evalIn(() => JSON.stringify(window.roamAlphaAPI.graph)));
  note('location.search', await evalIn(() => location.search));
  note('platform', await evalIn(() => JSON.stringify(window.roamAlphaAPI.platform ?? null)));
  note('user agent', await evalIn(() => navigator.userAgent));
  note('file api', await evalIn(() => Object.keys(window.roamAlphaAPI.file).join('/')));

  // ---- uploads ----
  await roam.page.evaluate(`window.__rfmDemoFiles = ${buildDemoFiles.toString()}; undefined`);
  await roam.page.evaluate(IPC);
  const up = await attempt('uploads', () => evalIn(async () => {
    const api = window.roamAlphaAPI;
    const files = await window.__rfmDemoFiles();
    await api.data.page.create({ page: { title: 'Probe' } });
    const page = api.data.q('[:find ?u . :where [?p :node/title "Probe"] [?p :block/uid ?u]]');
    const out = {};
    for (const name of ['kitchen-floor-plan.png', 'joinery-quote.pdf', 'budget.csv', 'site-visit-voice-memo.wav', Object.keys(files).find((n) => n.startsWith('walkthrough'))]) {
      const f = files[name]; if (!f) continue;
      try {
        const md = await api.file.upload({ file: f, toast: { hide: true } });
        await api.data.block.create({ location: { 'parent-uid': page, order: 'last' }, block: { string: `${name}: ${md}` } });
        out[name] = { md: typeof md === 'string' ? md : JSON.stringify(md), size: f.size };
      } catch (e) { out[name] = { error: String(e?.message ?? e).slice(0, 200) }; }
    }
    return out;
  }), 120000);
  await sleep(2000);
  await evalIn(() => window.roamAlphaAPI.ui.mainWindow.openPage({ page: { title: 'Probe' } }));
  await sleep(4000);
  await pic('01-probe-page');
  note('how Roam draws them', await evalIn(() => [...document.querySelectorAll('.roam-article img, .roam-article video, .roam-article audio, .roam-article iframe, .roam-article a, .roam-article embed, .roam-article object')]
    .map((e) => `${e.tagName} ${(e.currentSrc || e.src || e.href || e.data || '').slice(0, 120)} ${e.naturalWidth ?? ''}`).join(' ;; ')));
  note('pdf markup', await evalIn(() => [...document.querySelectorAll('.roam-article .rm-block')].map((b) => b.innerHTML).filter((h) => /pdf/i.test(h)).map((h) => h.slice(0, 1500)).join(' ;; ')));

  const urls = Object.values(up ?? {}).map((u) => u.md?.match(/local-asset:\/\/[^\s)}]+/)?.[0]).filter(Boolean);
  note('urls', urls);

  // ---- the desktop app's file list (Settings > Attachments uses it) ----
  await attempt('ipc list-graph-files', () => evalIn((g) => window.__rfmIpc(['^ ', '~:relemma/graph-name', g], ['~:roam.files/graph-files']), GRAPH));
  await attempt('ipc check-file-exists', () => evalIn(([g, id]) => window.__rfmIpc(['^ ', '~:relemma/graph-name', g, '~:roam.files/file-id', id], ['~:roam.files/existing-url']), [GRAPH, urls[0]?.split('/').pop().split('.')[0]]));

  // ---- reading them from the page ----
  const port = await evalIn(() => new URLSearchParams(location.search).get('server-port') || '3333');
  const http = (u) => `http://127.0.0.1:${port}/local-asset/${u.slice('local-asset://'.length)}`;
  for (const u of urls.slice(0, 3)) {
    await attempt(`fetch ${u.split('/').pop()}`, () => evalIn(async (h) => { const r = await fetch(h); const b = await r.blob(); return `${r.status} type ${r.headers.get('content-type')} length ${r.headers.get('content-length')} blob ${b.size} lm ${r.headers.get('last-modified')}`; }, http(u)));
    await attempt(`HEAD ${u.split('/').pop()}`, () => evalIn(async (h) => { const r = await fetch(h, { method: 'HEAD' }); return `${r.status} length ${r.headers.get('content-length')} ${[...r.headers.keys()].join(',')}`; }, http(u)));
    await attempt(`fetch local-asset:// ${u.split('/').pop()}`, () => evalIn(async (h) => { const r = await fetch(h); return `${r.status} ${(await r.blob()).size}`; }, u));
  }
  if (urls[0]) await attempt('canvas readback of an image (crossOrigin)', () => evalIn((h) => new Promise((res) => {
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => { try { const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').drawImage(i, 0, 0, 8, 8); res(`ok ${c.toDataURL().length}`); } catch (e) { res(`tainted ${e.message}`); } };
    i.onerror = () => res('error'); i.src = h;
  }), http(urls[0])));
  const vid = urls.find((u) => /\.(webm|mp4)$/.test(u));
  if (vid) await attempt('video still (crossOrigin)', () => evalIn((h) => new Promise((res) => {
    const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'auto';
    v.onseeked = () => { try { const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').drawImage(v, 0, 0, 8, 8); res(`ok ${c.toDataURL().length} ${v.videoWidth}x${v.videoHeight}`); } catch (e) { res(`tainted ${e.message}`); } };
    v.onloadeddata = () => { v.currentTime = 0.1; };
    v.onerror = () => res(`error ${v.error?.code}`); v.src = h; setTimeout(() => res('timeout'), 15000);
  }), http(vid)));

  // ---- Roam's own Attachments settings ----
  await attempt('Settings > Attachments', async () => {
    await openSettings(); await sleep(800);
    await clickLeaf('Attachments'); await sleep(4000);
    await pic('02-settings-attachments');
    const t = await evalIn(() => document.querySelector('.bp3-dialog')?.innerText.slice(0, 1500));
    const html = await evalIn(() => { const d = document.querySelector('.bp3-dialog .bp3-tab-panel[aria-hidden="false"], .bp3-dialog'); return d?.innerHTML.slice(0, 5000); });
    fs.writeFileSync(path.join(OUT, 'attachments.html'), html ?? '');
    return t;
  });
  await within(15000, dismissDialogs()).catch(() => {});

  // ---- deleting ----
  const last = urls[urls.length - 1];
  if (last) {
    await attempt('roamAlphaAPI.file.delete', () => evalIn(async (u) => { try { return JSON.stringify(await window.roamAlphaAPI.file.delete({ url: u })); } catch (e) { return `threw ${String(e?.message ?? e)}`; } }, last));
    await attempt('fetch after file.delete', () => evalIn(async (h) => (await fetch(h)).status, http(last)));
    const id = last.split('/').pop().split('.')[0];
    await attempt('ipc delete-graph-file', () => evalIn(([g, id]) => window.__rfmIpc(['^ ', '~:relemma/graph-name', g], [['~#list', ['~$roam.electron/delete-graph-file', ['^ ', '~:relemma/graph-name', g, '~:roam.files/file-id', id]]]]), [GRAPH, id]));
    await attempt('fetch after ipc delete', () => evalIn(async (h) => (await fetch(h)).status, http(last)));
    await attempt('ipc list after delete', () => evalIn((g) => window.__rfmIpc(['^ ', '~:relemma/graph-name', g], ['~:roam.files/graph-files']), GRAPH));
    await attempt('ipc delete again (gone)', () => evalIn(([g, id]) => window.__rfmIpc(['^ ', '~:relemma/graph-name', g], [['~#list', ['~$roam.electron/delete-graph-file', ['^ ', '~:relemma/graph-name', g, '~:roam.files/file-id', id]]]]), [GRAPH, id]));
  }
  await attempt('ipc list of a graph that is not there', () => evalIn(() => window.__rfmIpc(['^ ', '~:relemma/graph-name', 'no-such-graph-xyz'], ['~:roam.files/graph-files'])));
  await attempt('files on disk', async () => {
    const home = os.homedir();
    const hits = [];
    const walk = (d, depth) => { if (depth > 6) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name === GRAPH) hits.push(p); walk(p, depth + 1); } } };
    walk(path.join(home, '.config'), 0);
    return hits.map((h) => `${h.replace(home, '~')}: ${fs.readdirSync(h, { recursive: true }).join(', ')}`).join(' ;; ');
  });
} catch (e) {
  failed = e.message.split('\n')[0];
  note('stopped', failed);
  await pic('stopped');
} finally {
  write();
  try { await killRoam('SIGTERM'); } catch { /* gone */ }
  stopServing();
}
process.exit(failed ? 1 : 0);
