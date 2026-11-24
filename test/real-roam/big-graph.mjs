// How Files behaves on a very large graph: times finding the files (the datalog query that reads every
// block's text) and opening the list, in Roam's real desktop app (the Linux build, under Xvfb), at
// several graph sizes, and records how long Roam's window stalls while they run.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… BLOCKS=100000,300000,1000000 node test/real-roam/big-graph.mjs
//
// The graph is a LOCAL graph made for this run when the account can make one (browser storage on the
// machine it runs on, gone with the machine). An account without a plan can't: then the run uses the
// HOSTED test graph ($ROAM_GRAPH), up to HOSTED_MAX blocks. Everything it writes there is on pages whose
// title starts with "rfm-big ", and it deletes those pages again (leftovers of an earlier run first,
// its own at the end, also after a failure), waits for Roam to save, reloads and checks none is left.
// CLEAN_ONLY=1 does only that.
//
// The graph is filled with made-up notes about a kitchen renovation, and FILES blocks that hold a file
// link. Those files don't exist: the page's fetch is answered here for their URLs, so no request for
// them leaves the machine, and they are documents, not pictures, so no row asks for a picture either.
//
// Credentials come only from the environment and are handled as in run.mjs. Writes RESULTS.md to $OUT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, signIn, dismissDialogs,
  loadDevExtension, extensionLoaded, openGraph,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const SIZES = (process.env.BLOCKS || '20000,100000,300000,1000000').split(',').map((s) => +s.trim()).filter(Boolean).sort((a, b) => a - b);
const FILES = +(process.env.FILES || 2000);
const FILL_MINUTES = +(process.env.FILL_MINUTES || 45); // stop adding blocks after this long, and measure what there is
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'big-graph-out');
let GRAPH = `rfm-big-${Date.now().toString(36)}`;
const HOSTED = process.env.ROAM_GRAPH || 'vault-spike-hosted';
const HOSTED_MAX = +(process.env.HOSTED_MAX || 300000);
const KIND = process.env.GRAPH_KIND || 'auto'; // local, hosted, or auto: local when the account can make one
const PREFIX = 'rfm-big ';
const LOAD_MINUTES = +(process.env.LOAD_MINUTES || 40);
const CLEAN_GOES = +(process.env.CLEAN_GOES || 12);
let hosted = false;
const VIEW = '.rfm-view';

fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'big-graph-'));
roam.out = OUT; roam.logDir = WORK;
const DIST = path.join(WORK, 'dist');
fs.mkdirSync(DIST);
for (const f of ['extension.js', 'README.md']) fs.copyFileSync(path.join(ROOT, f), path.join(DIST, f));

const results = []; // { blocks, rows: [[what, value]] }
const notes = [];
function writeResults(extra = '') {
  const names = [...new Set(results.flatMap((r) => r.rows.map(([k]) => k)))];
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), [
    '# Files on a large graph', '',
    `Roam desktop (Linux, Xvfb), ${hosted ? 'the hosted test graph, filled for the run with' : 'a local graph of'} made-up notes with ${FILES} file links. Commit ${(process.env.COMMIT || process.env.GITHUB_SHA || 'local').slice(0, 7)}. Times in ms; "stall" is the longest time Roam's window did not respond.`, '',
    extra ? `**Stopped early:** ${extra}\n` : '',
    `| | ${results.map((r) => `${r.blocks.toLocaleString('en')} blocks`).join(' | ')} |`,
    `|---|${results.map(() => '---').join('|')}|`,
    ...names.map((k) => `| ${k} | ${results.map((r) => r.rows.find(([n]) => n === k)?.[1] ?? '').join(' | ')} |`), '',
    ...notes.map((n) => `- ${n}`), '',
  ].join('\n'));
}

// ---------- the local graph ----------
/** What kind of screen Roam shows, without quoting what is on it: the log is public. */
const screen = () => evalIn(() => {
  const t = document.body.innerText;
  return [location.hash.split('/').slice(0, 2).join('/'), /sign in|log in/i.test(t) && 'sign-in form', /hosted graphs/i.test(t) && 'graph list', /local graph/i.test(t) && 'mentions local graphs',
    !!document.querySelector('input[placeholder="New Local Graph Name"]') && 'new-local-graph field', /error/i.test(t) && 'an error', !!window.roamAlphaAPI && 'api ready',
    !!document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container') && 'graph open', `${t.length} chars`,
    `${document.querySelectorAll('.bp3-dialog').length} dialogs`, `inputs: ${[...document.querySelectorAll('input')].map((i) => i.placeholder || i.type).join('/')}`,
    `buttons: ${[...document.querySelectorAll('button, .bp3-button')].map((b) => b.textContent.trim().slice(0, 24)).filter(Boolean).slice(0, 12).join('/')}`].filter(Boolean).join(', ');
}).catch(() => 'page not readable');
const graphOpen = () => evalIn((g) => !!(window.roamAlphaAPI?.data?.q && window.roamAlphaAPI.graph?.name === g
  && document.querySelector('.roam-main .roam-article, .roam-main .roam-log-container, .rm-title-display')), GRAPH);
const canWrite = () => evalIn(() => { const a = window.roamAlphaAPI; return !!((a.data.block?.create ?? a.createBlock) && (a.data.page?.create ?? a.createPage)); });
async function openLocalGraph() {
  const base = roam.page.url().split('#')[0];
  // The graph list has a form for it: "New Local Graph Name", then "Create Local Graph". (Going straight
  // to #/offline/<name> opens a graph of that name too, but one that can't be written to.)
  await roam.page.goto(`${base}#/app`);
  await waitFor('the graph list', () => evalIn(() => /hosted graphs|local graphs?/i.test(document.body.innerText)), 60000).catch(() => {});
  await sleep(2000);
  log('graph list:', await screen(), '; local:', await evalIn(() => [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /local|plan\b|subscri/i.test(e.textContent) && e.textContent.length < 140).map((e) => `<${e.tagName.toLowerCase()}> ${e.textContent.trim()}`).slice(0, 12).join(' | ')));
  let field = roam.page.locator('input[placeholder="New Local Graph Name"]');
  if (!(await field.count())) {
    // the form may sit behind a tab or a button that names local graphs
    await evalIn(() => [...document.querySelectorAll('button, .bp3-button, .bp3-tab, a, span, div')].find((e) => e.children.length === 0 && /^(\+ ?)?(new |create |add )?local graphs?$/i.test(e.textContent.trim()))?.click());
    await sleep(1500);
    field = roam.page.locator('input[placeholder="New Local Graph Name"]');
  }
  if (await field.count()) {
    await field.first().fill(GRAPH);
    await sleep(300);
    const create = roam.page.locator('button, .bp3-button', { hasText: /^Create Local Graph$/ });
    if (await create.count()) await create.first().click(); else await field.first().press('Enter');
  } else {
    // Roam's graph list no longer has that form (2026-11-24). A graph opened by its address can be
    // written to since the test account has a plan, and local.mjs makes its graph that way.
    log('no form to make a local graph (Roam shows:', await screen(), '); opening one by its address');
    await roam.page.goto(`${base}#/offline/${GRAPH}`);
    await sleep(1000);
    if (!(await graphOpen().catch(() => false))) await roam.page.reload().catch(() => {});
  }
  try { await waitFor('the new local graph', graphOpen, 60000); } catch {
    throw new Error(`the local graph did not open (Roam shows: ${await screen()}; ${await evalIn(() => [...document.querySelectorAll('.bp3-dialog *, .bp3-callout, .bp3-toast-message, [class*="error"]')].filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => e.textContent.trim().slice(0, 120)).slice(0, 6).join(' | '))})`);
  }
  roam.signedIn = true;
  await dismissDialogs();
  log('local graph open; can be written to:', await canWrite().catch(() => false));
}

// ---------- filling it ----------
/** Adds `count` blocks of made-up notes as pages of about 500 blocks, `files` of them holding a file
 *  link. Returns how many blocks it added and how. */
const fill = (count, files, seed) => evalIn(async ([count, files, seed, graph, prefix]) => {
  const api = window.roamAlphaAPI, d = api.data;
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const WORDS = 'cabinet counter tile grout sink faucet oven hob hood island pantry drawer hinge plinth worktop oak walnut quartz laminate splashback socket circuit plumber joiner electrician quote invoice deposit delivery measure level plaster primer paint skirting floor underlay extractor duct lighting pendant dimmer fridge dishwasher budget schedule snag sample order return supplier warranty fitting template'.split(' ');
  const GLUE = 'the a for with before after under over next to and but then still not yet check call ask confirm move book'.split(' ');
  const sentence = () => { const n = 4 + Math.floor(rnd() * 14); let t = ''; for (let i = 0; i < n; i++) t += (i ? ' ' : '') + (rnd() < 0.45 ? pick(GLUE) : pick(WORDS)); return t[0].toUpperCase() + t.slice(1); };
  const id = () => { let t = ''; for (let i = 0; i < 10; i++) t += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[Math.floor(rnd() * 64)]; return t; };
  const EXT = ['pdf', 'csv', 'txt', 'zip', 'docx', 'xlsx'];
  const fileLine = () => { const ext = pick(EXT); return `[${pick(WORDS)}-${pick(WORDS)}-${Math.floor(rnd() * 900 + 100)}.${ext}](https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/o/imgs%2Fapp%2F${graph}%2F${id()}.${ext}?alt=media&token=00000000-0000-4000-8000-${Math.floor(rnd() * 1e12).toString().padStart(12, '0')})`; };
  const PER = 500, pages = Math.ceil(count / PER);
  const fileEvery = files ? Math.max(1, Math.floor(count / files)) : 0;
  const mkPage = d.page?.create ?? api.createPage, mkBlock = d.block?.create ?? api.createBlock;
  let how = d.page?.fromMarkdown ? 'page.fromMarkdown' : 'block.create', why = '';
  let made = 0, madeFiles = 0;
  for (let p = 0; p < pages && made < count; p++) {
    const n = Math.min(PER, count - made), lines = [];
    for (let i = 0; i < n; i++) {
      const file = fileEvery && madeFiles < files && (made + i) % fileEvery === 0;
      if (file) madeFiles++;
      lines.push({ depth: i === 0 ? 0 : Math.min(3, Math.floor(rnd() * 4)), text: file ? fileLine() : sentence() });
    }
    for (let i = 1; i < lines.length; i++) lines[i].depth = Math.min(lines[i].depth, lines[i - 1].depth + 1);
    const title = `${prefix}${seed}-${p} kitchen notes ${pick(WORDS)} ${pick(WORDS)}`;
    let done = false;
    if (how === 'page.fromMarkdown') {
      try { await d.page.fromMarkdown({ page: { title }, 'markdown-string': lines.map((l) => `${'    '.repeat(l.depth)}- ${l.text}`).join('\n') }); done = true; }
      catch (e) { how = 'block.create'; why = String(e?.message ?? e).slice(0, 160); }
    }
    if (!done) {
      const uid = api.util.generateUID();
      await mkPage({ page: { title, uid } });
      const parents = [uid];
      for (const l of lines) {
        const b = api.util.generateUID();
        await mkBlock({ location: { 'parent-uid': parents[l.depth], order: 'last' }, block: { uid: b, string: l.text } });
        parents[l.depth + 1] = b;
      }
    }
    made += n;
    if (p % 4 === 3) await new Promise((r) => setTimeout(r)); // let Roam draw and save
  }
  return { made, madeFiles, how, why };
}, [count, files, seed, GRAPH, PREFIX]);
/** Gives some of the file blocks props, as a graph in use has: on PROPS_SIZES of them the saved size of
 *  a resized picture (under the file's own address), on PROPS_DRAWINGS a file's address inside a nested
 *  map, the way a drawing keeps its pictures. */
const PROPS_SIZES = +(process.env.PROPS_SIZES || 1000), PROPS_DRAWINGS = +(process.env.PROPS_DRAWINGS || 100);
const addProps = () => evalIn(async ([sizes, drawings]) => {
  const api = window.roamAlphaAPI, d = api.data;
  const rows = d.q('[:find ?uid ?s :where [?b :block/string ?s] [(clojure.string/includes? ?s "firebasestorage.googleapis.com")] [?b :block/uid ?uid]]');
  let made = 0;
  for (const [uid, text] of rows.slice(0, sizes + drawings)) {
    const url = text.match(/https:\/\/firebasestorage[^\s)}]+/)?.[0];
    if (!url) continue;
    const props = made < sizes ? { 'image-size': { [url]: { width: 320, height: 200 } } } : { excalidraw: { files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: url } } } };
    await (d.block?.update ?? api.updateBlock)({ block: { uid, props } });
    if (++made % 20 === 0) await new Promise((r) => setTimeout(r, 500)); // a hosted graph saves each write: 1,100 at once never finished saving (2026-11-24)
  }
  return { made, withProps: d.q('[:find (count ?b) . :where [?b :block/props]]') ?? 0 };
}, [PROPS_SIZES, PROPS_DRAWINGS]);
const countBlocks = () => evalIn(() => { const t = performance.now(); const n = window.roamAlphaAPI.data.q('[:find (count ?b) . :where [?b :block/string]]') ?? 0; return { n, ms: Math.round(performance.now() - t) }; });

// ---------- a hosted graph: saving, and taking the pages out again ----------
/** Roam's own mark in the top bar that everything is saved to the server. */
const synced = () => evalIn(() => !!document.querySelector('.rm-sync--synced') && !document.querySelector('.rm-sync--saving-remote, .rm-sync--saving-local'));
async function waitSynced(minutes = 15) {
  const t = Date.now();
  await sleep(1500); // a write shows as saving a moment after it is made
  await waitFor('Roam to save to the server', synced, minutes * 60000, 1000);
  return Date.now() - t;
}
const ourPages = () => evalIn((prefix) => window.roamAlphaAPI.data.q(`[:find [?u ...] :in $ ?prefix :where [?p :node/title ?t] [(clojure.string/starts-with? ?t ?prefix)] [?p :block/uid ?u]]`, prefix) ?? [], PREFIX);
/** Deletes every page this script made (by title), 20 at a time with a wait for the save in between.
 *  Returns how many. */
async function deleteOurPages() {
  const uids = await ourPages();
  for (let i = 0; i < uids.length; i += 20) {
    await evalIn(async (some) => {
      const a = window.roamAlphaAPI, del = a.data.page?.delete ?? a.deletePage;
      for (const uid of some) await del({ page: { uid } });
    }, uids.slice(i, i + 20));
    if (hosted) await waitSynced().catch((e) => log('still saving after a batch of deletes:', e.message.split('\n')[0]));
    if (i % 100 === 0) log('deleted', i + 20, 'of', uids.length, 'pages; heap', await heapMb(), 'MB');
  }
  return uids.length;
}
/** Opens the hosted graph, with patience: after a run has filled and emptied it, Roam can take many
 *  minutes to load it. Logs what the loading screen says meanwhile (never a signed-in graph's content). */
async function openHosted() {
  const t = Date.now();
  const iv = setInterval(async () => {
    const text = await evalIn(() => (window.roamAlphaAPI?.data?.q && document.querySelector('.roam-main') ? '' : document.body.innerText.replace(/\S+@\S+/g, '***').replace(/\s+/g, ' ').slice(0, 200))).catch(() => '');
    if (text) log('still loading after', Math.round((Date.now() - t) / 1000), 's; Roam says:', text);
  }, 60000);
  try { await openGraph(GRAPH, LOAD_MINUTES * 60000); } finally { clearInterval(iv); }
  log('the graph took', Math.round((Date.now() - t) / 1000), 's to open');
}
/** After the run on a hosted graph: the pages out, saved, and after a reload none of them there. */
async function cleanUp() {
  const n = await deleteOurPages();
  await waitSynced(30);
  await roam.page.reload();
  await openHosted();
  await sleep(5000);
  const left = (await ourPages()).length, c = await countBlocks();
  log('clean-up: deleted', n, 'pages; after a reload', left, 'of them are left and the graph has', c.n, 'blocks');
  if (left) throw new Error(`${left} pages of this run are still in the graph after the clean-up`);
  return { n, blocks: c.n };
}
const heapMb = () => evalIn(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576)).catch(() => -1);
/** The clean-up, started again in a new Roam when Roam's window closes under it: a graph left with
 *  300,000 blocks of a run closed the window 80 s after it opened (2026-11-24). What was deleted and
 *  saved before the window closed stays deleted, so each go has less to do. */
async function cleanUpWithRestarts() {
  for (let go = 1; ; go++) {
    try {
      if (go > 1) {
        await killRoam();
        process.env.HEAP_MB ||= '4096';
        await launchRoam();
        await signIn(EMAIL, PASSWORD);
        await openHosted();
        log('Roam is open again with', (await ourPages()).length, 'pages of the run left; heap', await heapMb(), 'MB');
      }
      return await cleanUp();
    } catch (e) {
      const why = e.message.split('\n')[0];
      if (go >= CLEAN_GOES || !/closed/i.test(why)) throw e;
      log('clean-up go', go, 'ended:', why, '; starting Roam again');
    }
  }
}

// ---------- the made-up files ----------
/** Their storage records are answered in the page, so nothing is asked of Roam's storage. */
const fakeStorage = () => evalIn((graph) => {
    if (window.__rfmFaked != null) return;
    const real = window.fetch.bind(window);
    const mark = `/o/imgs%2Fapp%2F${graph}%2F`;
    window.__rfmFaked = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (!url.includes(mark)) return real(input, init);
      window.__rfmFaked++;
      let h = 0; for (const c of url) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      const body = { size: String(2000 + (h % 4000000)), timeCreated: new Date(Date.UTC(2026, 0, 1) + (h % 300) * 86400000).toISOString(), contentType: 'application/octet-stream', metadata: {} };
      return new Promise((res, rej) => {
        const t = setTimeout(() => res(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })), 80); // about what a real answer takes
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); });
      });
    };
}, GRAPH);

// ---------- measuring ----------
/** In the page: watches for stalls (a timer that should fire every 5 ms and doesn't) until stopped. */
const watchStalls = () => evalIn(() => {
  const w = window.__rfmStalls = { gaps: [], last: performance.now(), t0: performance.now() };
  w.iv = setInterval(() => { const t = performance.now(); if (t - w.last > 50) w.gaps.push(Math.round(t - w.last)); w.last = t; }, 5);
});
const stopStalls = () => evalIn(() => {
  const w = window.__rfmStalls; clearInterval(w.iv);
  const t = performance.now(); if (t - w.last > 50) w.gaps.push(Math.round(t - w.last));
  const g = w.gaps.sort((a, b) => b - a);
  return { longest: g[0] ?? 0, over50: g.length, sum: g.reduce((a, b) => a + b, 0), top: g.slice(0, 5) };
});
const fmtStall = (s) => (s.longest ? `${s.longest} (${s.over50} over 50 ms, ${s.sum} in all)` : 'none');

/** The file query as the extension runs it, and other ways to get the same rows, each timed with the
 *  stall it causes. */
const timeQueries = () => evalIn(async () => {
  const d = window.roamAlphaAPI.data;
  const NEEDLE = 'firebasestorage.googleapis.com';
  const Q = `[:find ?uid ?s ?ct ?pu ?pt
  :where [?b :block/string ?s]
         [(clojure.string/includes? ?s "${NEEDLE}")]
         [?b :block/uid ?uid]
         [(get-else $ ?b :create/time 0) ?ct]
         [?b :block/page ?p] [?p :block/uid ?pu] [?p :node/title ?pt]]`;
  const BARE = `[:find ?b ?s :where [?b :block/string ?s] [(clojure.string/includes? ?s "${NEEDLE}")]]`;
  const SINCE = `[:find ?b ?s :in $ ?since :where [?b :edit/time ?t] [(> ?t ?since)] [?b :block/string ?s] [(clojure.string/includes? ?s "${NEEDLE}")]]`;
  const PAGES = '[:find [?p ...] :where [?p :node/title]]';
  const BY_PAGE = `[:find ?uid ?s ?ct ?pu ?pt
  :in $ [?p ...]
  :where [?b :block/page ?p] [?b :block/string ?s]
         [(clojure.string/includes? ?s "${NEEDLE}")]
         [?b :block/uid ?uid]
         [(get-else $ ?b :create/time 0) ?ct]
         [?p :block/uid ?pu] [?p :node/title ?pt]]`;
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const timed = async (fn, n = 3) => {
    const times = []; let rows = 0, stall = 0;
    for (let i = 0; i < n; i++) {
      await tick();
      let last = performance.now(), gap = 0;
      const iv = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; }, 5);
      const t = performance.now();
      const r = await fn();
      times.push(Math.round(performance.now() - t));
      await new Promise((r) => setTimeout(r, 20));
      gap = Math.max(gap, performance.now() - last - 20);
      clearInterval(iv);
      stall = Math.max(stall, Math.round(gap)); rows = r?.length ?? r ?? 0;
    }
    times.sort((a, b) => a - b);
    return { ms: times[Math.floor(times.length / 2)], stall, rows };
  };
  const out = {};
  const safe = async (name, fn, n) => { try { out[name] = await timed(fn, n); } catch (e) { out[name] = { error: String(e?.message ?? e).slice(0, 120) }; } };
  // what the extension runs now: the uids only, then the blocks a hundred at a time
  const FIND = `[:find [?uid ...] :where [?b :block/string ?s] [(clojure.string/includes? ?s "${NEEDLE}")] [?b :block/uid ?uid]]`;
  const BLOCK = '[:block/uid :block/string :create/time {:block/page [:block/uid :node/title]}]';
  await safe('as the extension does it: which blocks', () => d.async.q(FIND));
  try {
    const uids = d.q(FIND); let longest = 0; const t0 = performance.now();
    for (let i = 0; i < uids.length; i += 100) { const t = performance.now(); d.pull_many(BLOCK, uids.slice(i, i + 100).map((u) => [':block/uid', u])); longest = Math.max(longest, performance.now() - t); await new Promise((r) => setTimeout(r)); }
    out['as the extension does it: reading the blocks'] = { ms: Math.round(performance.now() - t0), stall: Math.round(longest), rows: uids.length };
  } catch (e) { out['as the extension does it: reading the blocks'] = { error: String(e?.message ?? e).slice(0, 120) }; }
  // the last look before a delete of a file with 0 mentions: PDF pages, then block props
  await safe('before a delete: PDF pages (:pdf/url)', async () => d.q('[:find [?u ...] :where [_ :pdf/url ?u]]'));
  const PROPS = `[:find [?uid ...] :where [?b :block/props ?p] [(str ?p) ?s] [(clojure.string/includes? ?s "${NEEDLE}")] [?b :block/uid ?uid]]`;
  await safe('before a delete: which blocks hold a file in their props', () => d.async.q(PROPS));
  try {
    const uids = d.q(PROPS); let longest = 0; const t0 = performance.now();
    for (let i = 0; i < uids.length; i += 100) { await new Promise((r) => setTimeout(r)); const t = performance.now(); d.pull_many('[:block/props]', uids.slice(i, i + 100).map((u) => [':block/uid', u])); longest = Math.max(longest, performance.now() - t); }
    out['before a delete: reading those props'] = { ms: Math.round(performance.now() - t0), stall: Math.round(longest), rows: uids.length };
  } catch (e) { out['before a delete: reading those props'] = { error: String(e?.message ?? e).slice(0, 120) }; }
  if (d.backend?.q) await safe("Roam's backend (off the window's thread): which blocks", () => d.backend.q(FIND));
  await safe('before: one query for everything (async.q)', () => d.async.q(Q));
  await safe('one query for everything (q)', async () => d.q(Q));
  if (d.fast?.q) await safe('one query for everything (fast.q)', async () => d.fast.q(Q));
  await safe('bare scan: text only', () => d.async.q(BARE));
  await safe('edited-since scan', () => d.async.q(SINCE, Date.now() + 1e6));
  await safe('list of pages', async () => d.q(PAGES));
  // the same rows, read a slice of pages at a time with a pause between slices
  for (const size of [50, 400]) {
    try {
      const pages = d.q(PAGES);
      let rows = 0, longest = 0, slices = 0;
      const t0 = performance.now();
      for (let i = 0; i < pages.length; i += size) {
        const t = performance.now();
        rows += (await d.async.q(BY_PAGE, pages.slice(i, i + size))).length;
        longest = Math.max(longest, performance.now() - t); slices++;
        await new Promise((r) => setTimeout(r));
      }
      out[`by page, ${size} pages a slice`] = { ms: Math.round(performance.now() - t0), stall: Math.round(longest), rows, slices };
    } catch (e) { out[`by page, ${size} pages a slice`] = { error: String(e?.message ?? e).slice(0, 120) }; }
  }
  return out;
});

const openFiles = async () => {
  await fakeStorage();
  await evalIn(() => window.roamAlphaAPI.ui.leftSidebar.open());
  await waitFor('the Files row', extensionLoaded, 10000);
  await watchStalls();
  const t0 = Date.now();
  await evalIn(() => document.querySelector('.rm-left-sidebar__files').click());
  await waitFor('the Files list', () => evalIn((v) => !!document.querySelector(v), VIEW), 120000, 50);
  const shown = Date.now() - t0;
  await waitFor('rows in the list', () => evalIn((v) => !!document.querySelector(`${v} .rfm-scroller .rm-pages-row`), VIEW), 300000, 50);
  const rows = Date.now() - t0;
  await sleep(300);
  const box = await evalIn((v) => !!document.querySelector(`${v} .rfm-loader`), VIEW);
  await waitFor('the list to unlock', () => evalIn((v) => !document.querySelector(`${v} .rfm-loader`), VIEW), 600000, 100);
  const ready = Date.now() - t0;
  await sleep(1000);
  return { shown, rows, ready, box, stall: await stopStalls() };
};
const closeFiles = async () => {
  await evalIn(() => document.querySelector('.rm-left-sidebar__daily-notes').click());
  await waitFor('the list to close', () => evalIn((v) => !document.querySelector(v), VIEW), 20000);
  await sleep(1500);
};
/** Something Roam does itself on the same graph, for comparison: opening All Pages. */
const openAllPages = async () => {
  await watchStalls();
  const t0 = Date.now();
  await evalIn(() => document.querySelector('.rm-left-sidebar__all-pages').click());
  await waitFor('All Pages', () => evalIn(() => !!document.querySelector('.rm-all-pages .rm-pages-row:not(.rm-pages-row-header)')), 300000, 50);
  const rows = Date.now() - t0;
  await sleep(1000);
  return { rows, stall: await stopStalls() };
};

async function measure(blocks) {
  const rows = [];
  const add = (k, v) => { rows.push([k, v]); log(`[${blocks}]`, k, '=', v); };
  results.push({ blocks, rows });
  await watchStalls(); await sleep(5000);
  add('Roam left alone for 5 s: stall', fmtStall(await stopStalls()));

  const q = await timeQueries();
  for (const [k, v] of Object.entries(q)) add(`Finding the files, ${k}`, v.error ? `error: ${v.error}` : `${v.ms}, stall ${v.stall}, ${v.rows} rows${v.slices ? `, ${v.slices} slices` : ''}`);
  writeResults();

  const first = await openFiles();
  add('Open Files: list on screen', first.shown);
  add('Open Files: rows on screen', first.rows);
  add('Open Files: list usable', `${first.ready}${first.box ? ' (progress box shown)' : ''}`);
  add('Open Files: stall', fmtStall(first.stall));
  add('Open Files: files listed', await evalIn((v) => Math.round((document.querySelector(`${v} .rfm-scroller`)?.firstElementChild?.offsetHeight ?? 0) / 39), VIEW));
  // a sort and a search on the open list
  await watchStalls();
  await evalIn((v) => document.querySelector(`${v} .rm-pages-row-header [data-col="name"]`)?.firstElementChild?.click(), VIEW);
  await sleep(1500);
  add('Sort by name: stall', fmtStall(await stopStalls()));
  await watchStalls();
  await roam.page.fill(`${VIEW} .search-input`, 'oak');
  await sleep(1500);
  add('Search: stall', fmtStall(await stopStalls()));
  await roam.page.fill(`${VIEW} .search-input`, '');
  await closeFiles();
  writeResults();

  const again = await openFiles();
  add('Open Files again: list usable', `${again.ready}${again.box ? ' (progress box shown)' : ''}`);
  add('Open Files again: stall', fmtStall(again.stall));
  await closeFiles();

  const all = await openAllPages();
  add("Roam's own All Pages: rows on screen", all.rows);
  add("Roam's own All Pages: stall", fmtStall(all.stall));
  await evalIn(() => document.querySelector('.rm-left-sidebar__daily-notes').click());
  await sleep(2000);
  writeResults();
}

// ---------- the run ----------
let failed = '', baseline = 0;
try {
  serve(DIST);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  // the clean-up check is about the hosted test graph, whatever kind of graph a fill would use
  if (KIND === 'hosted' || process.env.CLEAN_ONLY) hosted = true;
  else {
    try { await openLocalGraph(); } catch (e) {
      if (KIND === 'local') throw e;
      log('no local graph:', e.message.split('\n')[0], '; using the hosted test graph');
      hosted = true;
    }
  }
  if (hosted) {
    GRAPH = HOSTED;
    await openHosted();
    await waitSynced(5);
    baseline = (await countBlocks()).n;
    const old = await deleteOurPages();
    if (old) { await waitSynced(30); log('deleted', old, 'pages an earlier run left behind'); baseline = (await countBlocks()).n; }
    log('hosted graph open with', baseline, 'blocks of its own');
    notes.push(`The graph had ${baseline.toLocaleString('en')} blocks of its own before the run.`);
    if (process.env.CLEAN_ONLY) throw new Error('CLEAN_ONLY');
  }

  await fakeStorage();

  try { await loadDevExtension(); } catch (e) {
    // Roam Depot's developer mode didn't take in a local graph: load the same build straight from its URL
    log('developer mode failed:', e.message.split('\n')[0], '; Roam shows:', await screen());
    await dismissDialogs();
    await evalIn(async () => { const m = await import('http://127.0.0.1:8766/ci/extension.js'); await m.default.onload({ extensionAPI: { settings: { get() {}, set() {}, getAll() { return {}; }, panel: { create() {} } } } }); });
    await waitFor('the Files row in the left sidebar', extensionLoaded, 15000);
  }
  const apiNow = () => evalIn(() => { const a = window.roamAlphaAPI, d = a.data; return `top: ${Object.keys(a).join('/')}; data: ${Object.keys(d).join('/')}; page: ${Object.keys(d.page ?? {}).join('/')}; block: ${Object.keys(d.block ?? {}).join('/')}; async: ${Object.keys(d.async ?? {}).join('/')}`; });
  // the write half of the API can arrive a moment after the graph opens
  await waitFor('the API to write blocks', () => evalIn(() => { const a = window.roamAlphaAPI; return !!((a.data.block?.create ?? a.createBlock) && (a.data.page?.create ?? a.createPage)); }), 30000)
    .catch(async () => { throw new Error(`no API to write blocks in a local graph (${await apiNow()})`); });
  log('extension loaded; API:', await apiNow());

  const t0 = Date.now();
  let have = (await countBlocks()).n, filesLeft = FILES, seed = 1, rate = 0, propsDone = false;
  for (const size of hosted ? [...new Set(SIZES.map((n) => Math.min(n, HOSTED_MAX)))] : SIZES) {
    while (have < size) {
      if ((Date.now() - t0) / 60000 > FILL_MINUTES) break;
      const want = Math.min(size - have, rate ? Math.max(2000, Math.round(rate * 20)) : 2000); // about 20 s a call
      const t = Date.now();
      const r = await fill(want, Math.min(filesLeft, Math.ceil(FILES * want / SIZES[0])), seed++);
      filesLeft -= r.madeFiles;
      if (seed === 2 || seed % 10 === 0) {
        const c = await countBlocks();
        if (seed === 2) log('first', want, 'blocks by', r.how, r.why ? `(page.fromMarkdown failed: ${r.why})` : '', 'in', Date.now() - t, 'ms; the graph now has', c.n, `(counted in ${c.ms} ms)`);
        if (seed === 2 && c.n - have < want * 0.9) throw new Error(`${r.how} made ${c.n - have} blocks out of ${want}`);
        have = c.n;
      } else have += r.made;
      if (hosted) await waitSynced(20); // never more unsaved than one call's worth
      rate = r.made / ((Date.now() - t) / 1000);
      if (seed % 10 === 0) log('filled to', have, 'blocks,', Math.round(rate), 'a second');
    }
    const c = await countBlocks();
    have = c.n;
    if (hosted) log('saved to the server after', await waitSynced(20), 'ms');
    if (!propsDone) {
      propsDone = true;
      const p = await addProps();
      if (hosted) await waitSynced(20);
      log('props on', p.made, 'file blocks;', p.withProps, 'blocks in the graph have props');
      notes.push(`${PROPS_SIZES.toLocaleString('en')} of the file blocks have a saved image size in their props and ${PROPS_DRAWINGS} hold a file's address there as a drawing does (${p.withProps.toLocaleString('en')} blocks with props in the graph).`);
    }
    log('measuring at', have, 'blocks;', FILES - filesLeft, 'file links; counting them took', c.ms, 'ms');
    await sleep(5000);
    await measure(have);
    if (have < size) { notes.push(`Filling stopped at ${have.toLocaleString('en')} blocks after ${FILL_MINUTES} minutes.`); break; }
  }
  notes.push(`Requests answered here for the made-up files: ${await evalIn(() => window.__rfmFaked)}.`);
} catch (e) {
  failed = e.message.split('\n')[0];
  if (failed === 'CLEAN_ONLY') failed = ''; else log('FAILED', failed);
}
if (hosted && roam.signedIn) {
  try {
    const c = await cleanUpWithRestarts();
    notes.push(`Afterwards the run deleted its ${c.n.toLocaleString('en')} pages again; after a reload none was left and the graph had ${c.blocks.toLocaleString('en')} blocks.`);
  } catch (e) {
    const why = e.message.split('\n')[0];
    log('CLEAN-UP FAILED', why);
    notes.push(`**Clean-up failed:** ${why}. Run the workflow again with "clean only".`);
    failed ||= `clean-up: ${why}`;
  }
}
writeResults(failed);
console.log(`\n${fs.readFileSync(path.join(OUT, 'RESULTS.md'), 'utf8')}`);
await killRoam('SIGTERM').catch(() => {});
stopServing();
process.exit(failed ? 1 : 0);
