// Ties the graph scan, the device store and the Files view together.
import { type FileEntry, type Row } from './files.ts';
import { scanGraph, keysInUse, pdfKeys } from './scan.ts';
import { storageKey } from './files.ts';
import { getMeta, putMeta, getSeen, putSeen, forget, fetchMeta, localMeta, type Meta, type Seen } from './store.ts';
import { FilesView, defaultState, srcOfRow, type ViewState } from './view.ts';
import { kindOf, extOf, storedName, isLocal, isOwnKey } from './files.ts';

export const VIEW_ID = 'roam-file-manager';
const api = () => (window as any).roamAlphaAPI;
const graphName = (): string => api().graph.name;
/** A local graph keeps its uploads on the computer, through Roam's desktop app. */
const isLocalGraph = () => api().graph.type === 'offline';
/** Roam's desktop app: the only place a local graph's files can be read from. */
const isDesktop = () => navigator.userAgent.includes('Electron');


/** Opening the list with this many sizes and dates to fetch shows the progress box at once ... */
const PROGRESS_AT_ONCE = 50;
/** ... and with fewer, only when they still aren't in after this long (ms): a slow connection. */
const PROGRESS_AFTER = 1000;

const STATE_KEY = 'roam-file-manager:view';
function loadState(): ViewState {
  const s = defaultState();
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    if (['name', 'kind', 'size', 'mentions', 'added'].includes(v.sort)) s.sort = v.sort;
    if (typeof v.desc === 'boolean') s.desc = v.desc;
    if (Array.isArray(v.hidden)) s.hidden = new Set(v.hidden);
    s.grid = v.grid === true;
  } catch { /* defaults */ }
  return s;
}
function saveState(s: ViewState) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ sort: s.sort, desc: s.desc, hidden: [...s.hidden], grid: s.grid })); } catch { /* private mode */ }
}

export class App {
  private meta = new Map<string, Meta>();
  private view: FilesView | null = null;
  private rows: Row[] = [];
  private fetching: AbortController | null = null;
  private scanning: Promise<void> | null = null;
  private stopped = false;
  private toasts: HTMLElement | null = null;

  /** Unload: nothing is read, fetched or deleted after this, and nothing of the extension stays on the page. */
  stop() {
    this.stopped = true;
    this.unmount();
    this.toasts?.remove(); this.toasts = null; this.toaster = null;
  }

  /** Scans the graph, records what it found as seen, and builds the rows. */
  scan(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.scanning ??= this.doScan().finally(() => { this.scanning = null; });
  }

  private async doScan() {
    if (isLocalGraph()) return this.scanLocal();
    const graph = graphName(), now = Date.now();
    // Files uploaded to this graph live in imgs/app/<graph>/. Only those can be unused or deleted: a
    // file pasted from another graph belongs to that graph.
    const own = (key: string) => isOwnKey(key, graph);
    const files = await scanGraph();
    // a PDF page goes on drawing from its file after the {{pdf}} block is gone: such a file is in use
    const inPdf = await pdfKeys().catch(() => new Set<string>());
    const seen = await getSeen(graph).catch(() => [] as Seen[]);
    const seenBy = new Map(seen.map((s) => [s.key, s]));
    const all0 = [...files.keys(), ...seen.map((s) => s.key)];
    const missing = all0.filter((k) => !this.meta.has(k));
    if (missing.length) for (const [k, v] of await getMeta(missing).catch(() => new Map<string, Meta>())) this.meta.set(k, v);
    // a file deleted from here is gone, even while blocks still hold its dead link
    for (const k of [...files.keys()]) if (this.meta.get(k)?.gone) files.delete(k);
    const updates: Seen[] = [];
    for (const f of files.values()) {
      if (!own(f.key)) continue;
      const prev = seenBy.get(f.key);
      updates.push({ id: `${graph}|${f.key}`, graph, key: f.key, url: f.url, name: f.name, added: prev?.added || f.added, lastUsed: now, lastPage: f.uses[0]?.pageTitle ?? '' });
    }
    await putSeen(updates).catch(() => {});
    const unused: FileEntry[] = seen.filter((s) => !files.has(s.key) && own(s.key)).map((s) => {
      const ext = extOf(s.key);
      return { key: s.key, url: s.url, name: s.name, ext, kind: kindOf(ext), added: s.added, uses: [] };
    });
    const all = [...files.values(), ...unused];
    const lastUsed = new Map(seen.map((s) => [s.key, s.lastUsed]));
    this.rows = all.map((f) => this.toRow(f, !files.has(f.key) && !inPdf.has(f.key), own(f.key), lastUsed.get(f.key) ?? 0));
  }

  /** A local graph: what its blocks hold is listed, and nothing more. Roam's public API can neither
   *  list a local graph's stored files nor delete one (file.delete refuses local graphs), so nothing
   *  here is found as unused, and nothing can be ticked or deleted. */
  private async scanLocal() {
    const files = await scanGraph();
    this.rows = [...files.values()].map((f) => this.toRow(f, false, false, 0));
  }

  private toRow(f: FileEntry, unused: boolean, own: boolean, lastUsed: number): Row {
    const r: Row = { ...f, size: null, unused, own, lastUsed };
    this.applyMeta(r);
    return r;
  }

  private applyMeta(r: Row) {
    const m = this.meta.get(r.key);
    if (!m) return;
    r.size = m.size;
    if (m.created) r.added = m.created;
    if (m.fileName && r.name === storedName(r.key)) r.name = m.fileName;
  }

  /** Fetches storage metadata for rows that have none, a few at a time, updating the view as it goes. */
  private async fillMeta() {
    this.fetching?.abort();
    const ctl = this.fetching = new AbortController();
    // what is on screen first, then the rest in the order of the list
    // a local graph's files can be read in Roam's desktop app only: a browser has no local server to ask
    const todo = new Map((this.view?.order() ?? this.rows).filter((r) => !this.meta.has(r.key) && (!isLocal(r.url) || isDesktop())).map((r) => [r.key, r]));
    // a first open has every file to fetch: the view shows how far that has got, and waits for it
    const total = todo.size;
    let done = 0, shown = total >= PROGRESS_AT_ONCE;
    const progress = () => { if (shown && !ctl.signal.aborted) this.view?.progress(done / total); };
    const late = window.setTimeout(() => { shown = done < total; progress(); }, PROGRESS_AFTER);
    progress();
    const next = (): Row | undefined => {
      for (const k of this.view?.inView() ?? []) { const r = todo.get(k); if (r) { todo.delete(k); return r; } }
      for (const [k, r] of todo) { todo.delete(k); return r; }
    };
    // an unused file that storage no longer has (deleted some other way) has nothing left to manage
    const gone: string[] = [];
    let pending: [string, Meta][] = [], last = Date.now();
    const flush = async (force = false) => {
      if (!pending.length || (!force && Date.now() - last < 400)) return;
      const batch = pending; pending = []; last = Date.now();
      const keys = new Set(batch.map(([k]) => k));
      for (const r of this.rows) if (keys.has(r.key)) this.applyMeta(r);
      this.view?.updated();
      await putMeta(batch).catch(() => {});
    };
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let r = next(); r && !ctl.signal.aborted; r = next()) {
        try {
          // a local graph's file is read where Roam's desktop app serves it to the page, for its size
          const m = isLocal(r.url) ? await localMeta(srcOfRow(r), ctl.signal) : await fetchMeta(r.url, ctl.signal);
          if (m === 'gone') { if (r.unused) gone.push(r.key); }
          else if (m) { this.meta.set(r.key, m); pending.push([r.key, m]); }
        } catch { /* offline or aborted: try again next time */ }
        done++;
        progress();
        await flush();
      }
    }));
    window.clearTimeout(late);
    // the list was left before the end: what has arrived is kept, the rest is fetched next time
    await flush(true);
    if (ctl.signal.aborted) return;
    this.view?.progress(null);
    if (gone.length) {
      await forget(graphName(), gone).catch(() => {});
      this.rows = this.rows.filter((r) => !gone.includes(r.key));
      this.view?.setRows(this.rows);
    }
  }

  /** Builds the view for the main window and starts filling it. */
  mount(host: HTMLElement) {
    const state = loadState();
    this.view = new FilesView({
      openFile: (r) => window.open(srcOfRow(r), '_blank', 'noopener'),
      openMentions: (r) => this.openMentions(r),
      deleteFiles: (rows) => this.deleteFiles(rows),
      dateTitle: (ms) => api().util.dateToPageTitle(new Date(ms)),
      stateChanged: () => saveState(state),
    }, state);
    host.append(this.view.el);
    if (this.rows.length) this.view.setRows(this.rows);
    // the list may be left before the graph has been read (a click on Files by accident): then nothing is fetched
    const view = this.view;
    this.scan().then(() => { if (this.view !== view) return; view.setRows(this.rows); return this.fillMeta(); }).catch((e) => console.warn('[roam-file-manager]', e));
  }

  get mounted() { return !!this.view; }

  unmount() {
    this.fetching?.abort(); this.fetching = null;
    this.view?.destroy(); this.view = null;
  }

  /** All Pages opens a page's mentions in the right sidebar and stays where it is. For a file, the blocks that hold it. */
  private async openMentions(row: Row) {
    const side = api().ui.rightSidebar;
    // the newest mention ends up on top: each new window goes above the last
    for (const use of [...row.uses].reverse()) await side.addWindow({ window: { type: 'block', 'block-uid': use.uid } });
    await side.open();
  }

  private async deleteFiles(rows: Row[]) {
    const graph = graphName(), view = this.view;
    // Look at the graph again first. A file the confirmation listed with 0 mentions is not deleted if a
    // block mentions it by now, or if it is in use outside block text (a PDF page, block props such as
    // a drawing): that second look runs only when a ticked file has 0 mentions. A file listed with
    // mentions was confirmed with the warning. If the graph can't be checked, nothing is deleted.
    let current: Awaited<ReturnType<typeof keysInUse>>;
    try { current = await keysInUse(rows.some((r) => r.uses.length === 0)); }
    catch (e) {
      console.warn('[roam-file-manager]', e);
      this.errorToast('Couldn\'t check the graph. Nothing was deleted.');
      return;
    }
    const gone: string[] = [], mentioned: Row[] = [], used: Row[] = [], failed: Row[] = [];
    for (const r of rows) {
      // unloaded, the list left, or another graph opened since the confirmation: the rest is left alone
      if (this.stopped || this.view !== view || graphName() !== graph) break;
      if (!r.own || isLocal(r.url) || !isOwnKey(r.key, graph) || storageKey(r.url) !== r.key) continue;
      if (r.uses.length === 0 && current.other.has(r.key)) { used.push(r); continue; }
      if (r.uses.length === 0 && current.text.has(r.key)) { mentioned.push(r); continue; }
      let answered = true;
      try { await api().file.delete({ url: r.url }); }
      catch (e) { answered = false; console.warn('[roam-file-manager] delete failed', r.key, e); }
      // Then storage is asked about the file: 'gone' is its 403 or 404. A delete that threw counts only
      // when storage says the file isn't there (no error text is read). One that didn't throw counts
      // unless storage still has the file.
      const m = await fetchMeta(r.url).catch(() => null);
      if (m === 'gone' || (answered && m === null)) gone.push(r.key);
      else failed.push(r);
    }
    await forget(graph, gone).catch(() => {});
    for (const k of gone) this.meta.delete(k);
    // the blocks that held a deleted file keep its dead link: remember that the file is gone
    const dead: [string, Meta][] = gone.filter((k) => current.text.has(k)).map((k) => [k, { size: 0, created: 0, fileName: null, type: null, gone: true }]);
    for (const [k, m] of dead) this.meta.set(k, m);
    await putMeta(dead).catch(() => {});
    if (this.stopped || this.view !== view) return;
    await this.scan().catch(() => {});
    this.view?.setRows(this.rows);
    // what was kept, and why
    const names = (list: Row[]) => list.map((r) => r.name).join(', ');
    if (used.length) this.errorToast(`Still used in a PDF page or drawing: ${names(used)}`);
    if (mentioned.length) this.errorToast(`Still mentioned in a block: ${names(mentioned)}`);
    if (failed.length) this.errorToast(`Couldn't delete ${names(failed)}`);
  }

  /** Roam's toast, in a container of the extension's own, so that unload can take it away. */
  private toaster: any = null;
  private errorToast(message: string) {
    const T = (window as any).Blueprint?.Core?.Toaster;
    if (!T || this.stopped) return;
    if (!this.toasts?.isConnected) {
      this.toasts = document.createElement('div');
      this.toasts.className = 'rfm-toasts';
      document.body.append(this.toasts);
      this.toaster = T.create({ position: 'top' }, this.toasts);
    }
    this.toaster.show({ message, intent: 'danger', timeout: 6000 });
  }
}
