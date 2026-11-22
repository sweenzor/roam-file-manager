// How Files behaves on a very large graph: times finding the files (the datalog query that reads every
// block's text) and opening the list, in Roam's real desktop app (the Linux build, under Xvfb), at
// several graph sizes, and records how long Roam's window stalls while they run.
//
//   DISPLAY=:99 ROAM_EMAIL=… ROAM_PASSWORD=… BLOCKS=100000,300000,1000000 node test/real-roam/big-graph.mjs
//
// The graph is a LOCAL graph made for this run (browser storage on the machine it runs on; nothing is
// written to a hosted graph, and it is gone with the machine). It is filled with made-up notes about
// a kitchen renovation, and FILES blocks that hold a file link. Those files don't exist: the page's
// fetch is answered here for their URLs, so no request for them leaves the machine, and they are
// documents, not pictures, so no row asks for a picture either.
//
// Credentials come only from the environment and are handled as in run.mjs. Writes RESULTS.md to $OUT.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  roam, log, sleep, evalIn, serve, stopServing, launchRoam, killRoam, waitFor, signIn, dismissDialogs,
  loadDevExtension, extensionLoaded,
} from './roam.mjs';

const EMAIL = process.env.ROAM_EMAIL, PASSWORD = process.env.ROAM_PASSWORD;
delete process.env.ROAM_EMAIL; delete process.env.ROAM_PASSWORD;

const SIZES = (process.env.BLOCKS || '20000,100000,300000,1000000').split(',').map((s) => +s.trim()).filter(Boolean).sort((a, b) => a - b);
const FILES = +(process.env.FILES || 2000);
const FILL_MINUTES = +(process.env.FILL_MINUTES || 45); // stop adding blocks after this long, and measure what there is
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.resolve(process.env.OUT || 'big-graph-out');
const GRAPH = `rfm-big-${Date.now().toString(36)}`;
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
    `Roam desktop (Linux, Xvfb), a local graph of made-up notes with ${FILES} file links. Commit ${(process.env.COMMIT || process.env.GITHUB_SHA || 'local').slice(0, 7)}. Times in ms; "stall" is the longest time Roam's window did not respond.`, '',
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
async function openLocalGraph() {
  const base = roam.page.url().split('#')[0];
  // Roam lists local graphs as links to #/offline/<name>; going to the address of a new name makes it
  await roam.page.goto(`${base}#/offline/${GRAPH}`);
  try { await waitFor('the local graph', graphOpen, 45000); } catch {
    log('not open by its address; Roam shows:', await screen());
    // the form on the graph list: "New Local Graph Name", Enter
    await roam.page.goto(`${base}#/app`);
    await sleep(4000);
    let field = roam.page.locator('input[placeholder="New Local Graph Name"]');
    if (!(await field.count())) {
      // the form may sit behind a tab or a button that names local graphs
      await evalIn(() => [...document.querySelectorAll('button, .bp3-button, .bp3-tab, a, span, div')].find((e) => e.children.length === 0 && /^(new |create )?local graphs?$/i.test(e.textContent.trim()))?.click());
      await sleep(1500);
      field = roam.page.locator('input[placeholder="New Local Graph Name"]');
    }
    if (!(await field.count())) throw new Error(`no way found to make a local graph (Roam shows: ${await screen()})`);
    await field.first().fill(GRAPH);
    await field.first().press('Enter');
    try { await waitFor('the new local graph', graphOpen, 60000); } catch { throw new Error(`the local graph did not open (Roam shows: ${await screen()})`); }
  }
  roam.signedIn = true;
  await dismissDialogs();
  log('local graph open');
}

// ---------- filling it ----------
/** Adds `count` blocks of made-up notes as pages of about 500 blocks, `files` of them holding a file
 *  link. Returns how many blocks it added and how. */
const fill = (count, files, seed) => evalIn(async ([count, files, seed, graph]) => {
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
    const title = `Kitchen notes ${seed}-${p} ${pick(WORDS)} ${pick(WORDS)}`;
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
}, [count, files, seed, GRAPH]);
const countBlocks = () => evalIn(() => { const t = performance.now(); const n = window.roamAlphaAPI.data.q('[:find (count ?b) . :where [?b :block/string]]') ?? 0; return { n, ms: Math.round(performance.now() - t) }; });

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
  await safe('query (async.q)', () => d.async.q(Q));
  await safe('query (q)', async () => d.q(Q));
  if (d.fast?.q) await safe('query (fast.q)', async () => d.fast.q(Q));
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
let failed = '';
try {
  serve(DIST);
  await launchRoam();
  await signIn(EMAIL, PASSWORD);
  await openLocalGraph();

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
  let have = (await countBlocks()).n, filesLeft = FILES, seed = 1, rate = 0;
  for (const size of SIZES) {
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
      rate = r.made / ((Date.now() - t) / 1000);
      if (seed % 10 === 0) log('filled to', have, 'blocks,', Math.round(rate), 'a second');
    }
    const c = await countBlocks();
    have = c.n;
    log('measuring at', have, 'blocks;', FILES - filesLeft, 'file links; counting them took', c.ms, 'ms');
    await sleep(5000);
    await measure(have);
    if (have < size) { notes.push(`Filling stopped at ${have.toLocaleString('en')} blocks after ${FILL_MINUTES} minutes.`); break; }
  }
  notes.push(`Requests answered here for the made-up files: ${await evalIn(() => window.__rfmFaked)}.`);
} catch (e) {
  failed = e.message.split('\n')[0];
  log('FAILED', failed);
}
writeResults(failed);
console.log(`\n${fs.readFileSync(path.join(OUT, 'RESULTS.md'), 'utf8')}`);
await killRoam('SIGTERM').catch(() => {});
stopServing();
process.exit(failed ? 1 : 0);
