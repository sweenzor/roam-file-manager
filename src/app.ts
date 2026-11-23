// Ties the graph scan, the device store and the Files view together.
import { type FileEntry, type Row } from './files.ts';
import { scanGraph, keysAnywhere } from './scan.ts';
import { getMeta, putMeta, getSeen, putSeen, forget, fetchMeta, type Meta, type Seen } from './store.ts';
import { FilesView, defaultState, srcOfRow, type ViewState } from './view.ts';
import { kindOf, extOf, storedName, isLocal, localId } from './files.ts';
import { isDesktop, listGraphFiles, deleteGraphFile, type LocalFile } from './local.ts';

export const VIEW_ID = 'roam-file-manager';
const api = () => (window as any).roamAlphaAPI;
const graphName = (): string => api().graph.name;
/** A local graph keeps its uploads on the computer, through Roam's desktop app. */
const isLocalGraph = () => api().graph.type === 'offline';
/** Files uploaded to this graph live under imgs/app/<graph>/ (local-asset/<graph>/ in a local graph).
 *  Only those can be unused or deleted: a file pasted from another graph belongs to that graph. */
const ownPrefix = () => (isLocalGraph() ? `local-asset/${graphName()}/` : `imgs/app/${graphName()}/`);


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

  /** Scans the graph, records what it found as seen, and builds the rows. */
  scan(): Promise<void> {
    return this.scanning ??= this.doScan().finally(() => { this.scanning = null; });
  }

  private async doScan() {
    if (isLocalGraph()) return this.scanLocal();
    const graph = graphName(), own = ownPrefix(), now = Date.now();
    const files = await scanGraph();
    const seen = await getSeen(graph).catch(() => [] as Seen[]);
    const seenBy = new Map(seen.map((s) => [s.key, s]));
    const all0 = [...files.keys(), ...seen.map((s) => s.key)];
    const missing = all0.filter((k) => !this.meta.has(k));
    if (missing.length) for (const [k, v] of await getMeta(missing).catch(() => new Map<string, Meta>())) this.meta.set(k, v);
    // a file deleted from here is gone, even while blocks still hold its dead link
    for (const k of [...files.keys()]) if (this.meta.get(k)?.gone) files.delete(k);
    const updates: Seen[] = [];
    for (const f of files.values()) {
      if (!f.key.startsWith(own)) continue;
      const prev = seenBy.get(f.key);
      updates.push({ id: `${graph}|${f.key}`, graph, key: f.key, url: f.url, name: f.name, added: prev?.added || f.added, lastUsed: now, lastPage: f.uses[0]?.pageTitle ?? '' });
    }
    await putSeen(updates).catch(() => {});
    const unused: FileEntry[] = seen.filter((s) => !files.has(s.key)).map((s) => {
      const ext = extOf(s.key);
      return { key: s.key, url: s.url, name: s.name, ext, kind: kindOf(ext), added: s.added, uses: [] };
    });
    const all = [...files.values(), ...unused];
    const lastUsed = new Map(seen.map((s) => [s.key, s.lastUsed]));
    this.rows = all.map((f) => this.toRow(f, !files.has(f.key), f.key.startsWith(own), lastUsed.get(f.key) ?? 0));
  }

  /** A local graph: Roam's desktop app lists the graph's files, as Roam's own Settings > Attachments does,
   *  so an unused file is one in that list that no block holds, and nothing has to be remembered.
   *  In a browser there is no such list (and nothing can be uploaded to a local graph there): only
   *  what the blocks hold is listed, and nothing of it can be deleted. */
  private async scanLocal() {
    const own = ownPrefix();
    const files = await scanGraph();
    let stored: Map<string, LocalFile> | null = null;
    if (isDesktop()) stored = await listGraphFiles(graphName()).catch((e) => { console.warn('[roam-file-manager]', e); return null; });
    const rows: Row[] = [];
    for (const f of files.values()) {
      const mine = f.key.startsWith(own);
      if (mine && stored && !stored.has(storedName(f.key))) continue; // deleted: the blocks keep a dead link
      rows.push(this.toRow(f, false, mine && !!stored, 0));
    }
    for (const s of stored?.values() ?? []) {
      const key = own + s.name;
      this.meta.set(key, { size: s.size, created: s.created, fileName: null, type: s.type });
      if (files.has(key)) continue;
      const ext = extOf(key);
      rows.push(this.toRow({ key, url: s.url, name: s.name, ext, kind: kindOf(ext), added: s.created, uses: [] }, true, true, 0));
    }
    for (const r of rows) this.applyMeta(r);
    this.rows = rows;
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
    // a local graph's file has no metadata to fetch: Roam's desktop app sends its size and date with the list
    const todo = new Map((this.view?.order() ?? this.rows).filter((r) => !this.meta.has(r.key) && !isLocal(r.url)).map((r) => [r.key, r]));
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
          const m = await fetchMeta(r.url, ctl.signal);
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
    const own = ownPrefix(), graph = graphName();
    // look at the graph again first, this time at every text in it (blocks, page titles, anything
    // else that holds text): a file the confirmation listed with 0 mentions is not deleted if its
    // link is anywhere in the graph. A file listed with mentions was confirmed with the warning.
    const current = await keysAnywhere();
    const gone: string[] = [];
    for (const r of rows) {
      if (!r.key.startsWith(own) || (r.uses.length === 0 && current.has(r.key))) continue;
      try {
        // roamAlphaAPI.file.delete refuses local graphs: Roam's desktop app deletes their files, as in Settings > Attachments
        if (isLocal(r.url)) await deleteGraphFile(graph, localId(r.key));
        else await api().file.delete({ url: r.url });
        gone.push(r.key);
      } catch (e) {
        // already gone from storage counts as deleted
        if (/not.?found|404|does not exist/i.test(String(e))) gone.push(r.key);
        else console.warn('[roam-file-manager] delete failed', r.key, e);
      }
    }
    await forget(graph, gone).catch(() => {});
    for (const k of gone) this.meta.delete(k);
    // the blocks that held a deleted file keep its dead link: remember that the file is gone (a local
    // graph's list of files says so by itself)
    const dead: [string, Meta][] = gone.filter((k) => current.has(k) && !k.startsWith('local-asset/')).map((k) => [k, { size: 0, created: 0, fileName: null, type: null, gone: true }]);
    for (const [k, m] of dead) this.meta.set(k, m);
    await putMeta(dead).catch(() => {});
    await this.scan().catch(() => {});
    this.view?.setRows(this.rows);
    // what was asked for, wasn't deleted, and is still listed
    const left = rows.filter((r) => !gone.includes(r.key) && this.rows.some((x) => x.key === r.key));
    if (left.length) errorToast(`Couldn't delete ${left.map((r) => r.name).join(', ')}`);
  }
}

function errorToast(message: string) {
  const T = (window as any).Blueprint?.Core?.Toaster;
  if (!T) return;
  const t = T.create({ position: 'top' });
  t.show({ message, intent: 'danger', timeout: 6000 });
}
