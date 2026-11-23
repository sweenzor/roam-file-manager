// The Files view: a details list of every file uploaded to the graph, drawn with the markup and
// classes of Roam's own All Pages table (rm-all-pages, rm-pages-row, ...), so Roam's stylesheet
// styles it. Rows are virtual: only the rows in view (plus a margin) are in the DOM, so a graph
// with thousands of files scrolls as fast as one with ten.
import { h, icon } from './dom.ts';
import { getStill, putStill } from './store.ts';
import { countText, compare, formatSize, inUseWarning, isEncrypted, srcOf, type Kind, type Row, type SortKey } from './files.ts';

/** The address a file is drawn from: its own, or for a local graph's file, where Roam's desktop app serves it
 *  (on Roam's server port, which the address of Roam's window names when it isn't the usual one). */
export const srcOfRow = (r: Row | { url: string }) => srcOf(r.url, new URLSearchParams(location.search).get('server-port'));

export const ROW_H = 39;
/** Below this width (the right sidebar open on a small window) the columns close up, so that names keep their room. */
const NARROW = 1000;
/** A sort expected to take longer than this (ms) shows the progress box while it runs. */
const SLOW_SORT_MS = 250;
/** Runs fn once the browser has had the chance to draw what was just changed. */
const afterPaint = (fn: () => void) => {
  let ran = false;
  const run = () => { if (!ran) { ran = true; fn(); } };
  requestAnimationFrame(() => setTimeout(run));
  setTimeout(run, 150); // a hidden window draws no frames
};
const OVERSCAN = 8;
/** Roam stores no thumbnails, so a picture's preview is the picture itself: only small ones are shown. */
const THUMB_MAX = 1.5 * 1024 * 1024;
/** The delete confirmation shows few files at a time and loads them as they scroll into view, so larger pictures are fine there. */
const DIALOG_THUMB_MAX = 10 * 1024 * 1024;
/** The thumbnail view draws only the tiles in view and stops a picture that scrolls away, so it shows larger pictures too. */
const GRID_THUMB_MAX = 10 * 1024 * 1024;
/** Thumbnail view: the narrowest a tile gets, the space between tiles, and the height under the picture. */
const TILE_MIN = 168, TILE_GAP = 16, TILE_CAPTION = 56;

type Col = { key: SortKey; label: string; cls: string; sortable: boolean; hideable: boolean };
const COLS: Col[] = [
  { key: 'kind', label: 'TYPE', cls: 'rfm-col-type', sortable: true, hideable: true },
  { key: 'size', label: 'SIZE', cls: 'rfm-col-size', sortable: true, hideable: true },
  { key: 'mentions', label: 'MENTIONS', cls: 'rfm-col-mentions', sortable: true, hideable: true },
  { key: 'added', label: 'ADDED', cls: 'rfm-col-added', sortable: true, hideable: true },
];
const COL_NAMES: Record<string, string> = { kind: 'Type', size: 'Size', mentions: 'Mentions', added: 'Added' };
/** Thumbnail view's sort menu, worded as Roam words its extension browser's ("Downloads (high to low)", "Created (newest first)", "Alphabetical (A to Z)"). */
const SORT_MENU: [SortKey, boolean, string][][] = [
  [['added', true, 'Added (newest first)'], ['added', false, 'Added (oldest first)']],
  [['size', true, 'Size (high to low)'], ['size', false, 'Size (low to high)']],
  [['mentions', true, 'Mentions (high to low)'], ['mentions', false, 'Mentions (low to high)']],
  [['kind', false, 'Type (A to Z)'], ['kind', true, 'Type (Z to A)']],
  [['name', false, 'Alphabetical (A to Z)'], ['name', true, 'Alphabetical (Z to A)']],
];

export const KIND_LABELS: [Kind, string][] = [['image', 'Images'], ['pdf', 'PDFs'], ['audio', 'Audio'], ['video', 'Video'], ['other', 'Other files']];
const KIND_ICON: Record<Kind, string> = { image: 'media', pdf: 'document', audio: 'music', video: 'video', other: 'paperclip' };

export const STYLES = `
.rfm-view .rfm-scroller .rm-pages-row{height:${ROW_H}px;box-sizing:border-box}
.rfm-view .rfm-scroller .rm-pages-row .rm-pages-title-col{display:flex;align-items:center;gap:10px;min-width:0;white-space:nowrap;overflow:hidden;padding-top:6px;padding-bottom:6px}
.rfm-view .rfm-thumb{flex:0 0 26px;width:26px;height:26px;border-radius:3px;object-fit:cover;background:#f5f8fa}
.rfm-view .rfm-thumb-icon{flex:0 0 26px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8a9ba8}
.rfm-view .rm-pages-title-text{flex:0 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.rfm-view .title-children-text{flex:0 9999 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.rfm-view .rfm-scroller .rm-pages-row .rm-pages-col{line-height:22px}
.rm-all-pages.rfm-narrow .table .rm-pages-row .rfm-col-type{flex-basis:72px}
.rm-all-pages.rfm-narrow .table .rm-pages-row .rfm-col-size{flex-basis:70px}
.rm-all-pages.rfm-narrow .table .rm-pages-row .rfm-col-mentions{flex-basis:98px}
.rm-all-pages.rfm-narrow .table .rm-pages-row .rfm-col-added{flex-basis:146px;white-space:nowrap}
.rfm-view .rfm-scroller{position:relative;overflow:auto;will-change:transform}
.rfm-view .rfm-count{align-self:center;margin-left:8px;white-space:nowrap}
.rfm-view{position:relative}
.rfm-view.rfm-loading>.rm-pages-toolbar,.rfm-view.rfm-loading>.table{opacity:.35;pointer-events:none;user-select:none}
.rfm-loader{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;justify-content:center;cursor:progress;z-index:5}
.rfm-loader-box{display:flex;align-items:center;gap:12px;width:300px;box-sizing:border-box;padding:16px;border-radius:3px;background:#fff;color:#5c7080;box-shadow:0 0 0 1px rgba(16,22,26,.1),0 2px 4px rgba(16,22,26,.2),0 8px 24px rgba(16,22,26,.2)}
.bp3-dark .rfm-loader-box{background:#394b59;color:#a7b6c2}
.rfm-view .rm-pages-row:not(.rm-pages-row-header):hover{background:rgb(245,248,250)}
.rfm-view .rfm-thumb,.rfm-view .rfm-thumb-icon{cursor:default}
.rfm-delete-content{display:flex;flex-direction:column;max-height:min(440px,60vh) !important}
.rfm-delete-content .delete-all-dialog-list{flex:1 1 auto;min-height:0;overflow-y:auto}
.rfm-delete-warning{flex:0 0 auto;margin-bottom:12px}
.rfm-delete-item{display:grid;grid-template-columns:48px minmax(0,1fr) auto;column-gap:10px;align-items:center}
.rfm-delete-item .rm-clickable-pill{grid-column:3;grid-row:1 / span 2;margin-right:6px}
.rfm-delete-item .rfm-delete-thumb{grid-row:1 / span 2;width:48px;height:48px;border-radius:3px;object-fit:cover;display:flex;align-items:center;justify-content:center;color:#8a9ba8}
.rfm-delete-warning>.bp3-icon{position:absolute;left:10px;top:10px}
.rfm-still{overflow:hidden}
.rfm-still>img{width:100%;height:100%;object-fit:cover;border-radius:3px;display:block}
.rfm-preview{padding:6px;line-height:0}
.rfm-preview-img{max-width:360px;max-height:360px;border-radius:3px;display:block}
.rfm-preview-video{max-width:480px;background:#000}
.rfm-view .rfm-tile{box-sizing:border-box;border-radius:3px}
.rfm-view .rfm-tile-pic{position:relative;border-radius:3px;overflow:hidden;background:#f5f8fa;display:flex;align-items:center;justify-content:center;color:#8a9ba8;cursor:pointer}
.rfm-view .rfm-tile-pic img,.rfm-view .rfm-tile-pic video{width:100%;height:100%;object-fit:cover;display:block}
.rfm-view .rfm-tile-pic .bp3-icon::before{font-size:32px}
.rfm-view .rfm-tile-check{position:absolute;left:8px;top:8px;margin:0}
.rfm-view .rfm-tile-name{display:block;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.rfm-view .rfm-tile-meta{display:flex;align-items:center;gap:8px;height:22px;color:#8a9ba8;white-space:nowrap}
.rfm-view .rfm-tile-meta>*{flex:0 0 auto}
.rfm-view .rfm-tile-meta .rfm-col-mentions{margin-left:auto}
.rfm-view.rfm-grid .rm-pages-row-header{display:none}
.rfm-view .rfm-grid-only{display:none}
.rfm-view.rfm-grid .rfm-grid-only{display:inline-flex}
.rfm-view .toolbar-action-button-group{display:flex;align-items:center}
.rfm-view .rfm-grid-all{margin:0 6px 0 12px}
.rfm-hide-kind .rfm-col-type,.rfm-hide-size .rfm-col-size,.rfm-hide-mentions .rfm-col-mentions,.rfm-hide-added .rfm-col-added{display:none}
.bp3-dark .rfm-view .rm-pages-title-text{color:inherit}
.bp3-dark .rfm-view .rm-pages-row:not(.rm-pages-row-header):hover{background:rgba(255,255,255,.04)}
.bp3-dark .rfm-view .rfm-tile-pic{background:rgba(255,255,255,.06)}
`;

/** Roam's own classes for a Mentions count in All Pages (measured there: 0, 1 to 5, up to 25, up to 50, more). */
const pillLevel = (n: number) => (n === 0 ? ' empty-pill' : n > 50 ? ' level3-pill' : n > 25 ? ' level2-pill' : n > 5 ? ' level1-pill' : '');

/** The titles of the pages a file is on, the newest mention first. */
export function pagesOf(r: Row): string[] {
  const out: string[] = [];
  for (const u of r.uses) if (!out.includes(u.pageTitle)) out.push(u.pageTitle);
  return out;
}

/** Pictures and videos show a preview when the pointer is on their thumbnail or icon. */
const previewable = (r: Row) => (r.kind === 'image' || r.kind === 'video') && !isEncrypted(r.key);

// ---------- a video's still ----------
// Roam stores no thumbnails, so a video's still is its own first frame: decoded once by this
// browser, kept as a small JPEG on the device, and shown as an ordinary picture after that.
// A video this browser has no decoder for (HEVC .mov files where the system can't decode HEVC)
// has no frame to show and keeps the video icon.
const STILL_MAX = 320, STILL_WAIT = 15000, STILLS_AT_ONCE = 3;
const stills = new Map<string, string | false>();
const stillsPending = new Map<string, Promise<string | false | undefined>>();
/** Who is waiting for each still: rows are redrawn and scroll away, so the askers change while it waits its turn. */
const stillsWanted = new Map<string, (() => boolean)[]>();
let stillsRunning = 0;
const stillsWaiting: (() => void)[] = [];

function decodeStill(url: string): Promise<string | false> {
  return new Promise((done) => {
    const v = document.createElement('video');
    let over = false;
    const end = (s: string | false) => { if (over) return; over = true; clearTimeout(t); v.removeAttribute('src'); v.load(); done(s); };
    const t = setTimeout(() => end(false), STILL_WAIT);
    v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    v.addEventListener('error', () => end(false));
    v.addEventListener('loadeddata', () => {
      // sound but no picture: the container opened, the video track has no decoder here
      if (!v.videoWidth) return end(false);
      try {
        const k = Math.min(1, STILL_MAX / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        end(c.toDataURL('image/jpeg', 0.75));
      } catch { end(false); }
    });
    v.src = `${url}#t=0.1`;
  });
}

/** The still of a video as a data URL; false when this browser can't decode it; undefined when `wanted` said no by the time its turn came. */
export function videoStillUrl(r: Row, wanted: () => boolean = () => true): Promise<string | false | undefined> {
  const known = stills.get(r.key);
  if (known !== undefined) return Promise.resolve(known);
  let p = stillsPending.get(r.key);
  stillsWanted.set(r.key, [...(stillsWanted.get(r.key) ?? []), wanted]);
  if (!p) {
    p = (async () => {
      try {
        const saved = await getStill(r.key).catch(() => undefined);
        if (saved) { stills.set(r.key, saved); return saved; }
        if (stillsRunning >= STILLS_AT_ONCE) await new Promise<void>((go) => stillsWaiting.push(go));
        stillsRunning++;
        try {
          // rows scroll away: a video nobody is looking at any more isn't fetched
          if (!(stillsWanted.get(r.key) ?? []).some((w) => w())) return undefined;
          const s = await decodeStill(srcOfRow(r));
          stills.set(r.key, s);
          if (s) putStill(r.key, s).catch(() => {});
          return s;
        } finally { stillsRunning--; stillsWaiting.pop()?.(); }
      } finally { stillsPending.delete(r.key); stillsWanted.delete(r.key); }
    })();
    stillsPending.set(r.key, p);
  }
  return p;
}

/** The element for a video's still: its first frame, or the video icon while it loads and when there is no frame to show. */
export function videoStill(r: Row, cls: string): HTMLElement {
  const box = h('span', { class: `${cls} rfm-still` }, icon(KIND_ICON.video));
  if (isEncrypted(r.key)) return box;
  const show = (s: string | false | undefined) => { if (s) box.replaceChildren(h('img', { src: s, alt: '' })); };
  const known = stills.get(r.key);
  if (known !== undefined) show(known); else videoStillUrl(r, () => box.isConnected).then(show);
  return box;
}

/** Removes a row and stops its thumbnail if it is still loading. */
function drop(el: HTMLElement) {
  const img = el.querySelector('img'); if (img && !img.complete) img.src = '';
  const video = el.querySelector('video'); if (video) { video.removeAttribute('src'); video.load(); }
  el.remove();
}

export interface ViewActions {
  openFile(row: Row): void;
  /** Opens every block that holds the file in the right sidebar, as All Pages' Mentions count does for a page. */
  openMentions(row: Row): void;
  deleteFiles(rows: Row[]): Promise<void>;
  dateTitle(ms: number): string;
  stateChanged(): void;
}

export interface ViewState {
  sort: SortKey; desc: boolean; query: string;
  kinds: Set<Kind>; unusedOnly: boolean; hidden: Set<string>;
  /** Thumbnail view in place of the list. */
  grid: boolean;
}

export const defaultState = (): ViewState => ({ sort: 'added', desc: true, query: '', kinds: new Set(), unusedOnly: false, hidden: new Set(), grid: false });

export class FilesView {
  readonly el: HTMLDivElement;
  private rows: Row[] = [];
  private shown: Row[] = [];
  private selected = new Set<string>();
  private scroller: HTMLDivElement;
  private spacer: HTMLDivElement;
  private header: HTMLDivElement;
  private trash: HTMLButtonElement;
  private filterIcon: HTMLSpanElement;
  private gridIcon: HTMLSpanElement;
  private gridAll: HTMLInputElement;
  /** How the rows are laid out now: files per line, the height of a line, the width of a tile. */
  private per = 1; private lineH = ROW_H; private tileW = 0;
  private headAll: HTMLInputElement;
  private drawn = new Map<number, HTMLDivElement>();
  private ro: ResizeObserver;
  private popover: HTMLElement | null = null;
  /** How many files the graph has, next to the trash: "529 Files", or "12 / 529 Files" while a search or filter narrows the list. */
  private count: HTMLElement;
  private counted = false;
  private parts: HTMLElement[];
  private loader: HTMLDivElement | null = null;
  private loading: number | null = null;
  private sorting = false;
  private sortRun = 0;
  /** ms per n*log2(n) for a sort by each column. Measured on 100,000 files: by name 400 ms, the others
   *  under 100 ms. Every sort that ran long enough to time corrects it. */
  private sortCost: Record<SortKey, number> = { name: 2.4e-4, kind: 6e-5, size: 6e-5, mentions: 6e-5, added: 6e-5 };

  constructor(private actions: ViewActions, public state: ViewState = defaultState()) {
    const search = h('input', { class: 'bp3-input bp3-round bp3-minimal search-input', placeholder: 'Search Files', value: state.query,
      onInput: (e: Event) => { this.state.query = (e.target as HTMLInputElement).value; this.refresh(); } });
    this.trash = h('button', { class: 'bp3-button bp3-minimal bp3-icon-trash button-disabled-strong', tabindex: 0, disabled: true, onClick: () => this.confirmDelete() });
    this.count = h('span', { class: 'rfm-count bp3-text-muted' });
    this.filterIcon = icon('filter', 'filter-icon');
    const filterBtn = h('span', { class: 'bp3-button bp3-minimal filter-button', tabindex: 0, onClick: (e: Event) => this.toggleFilter(e.currentTarget as HTMLElement) }, this.filterIcon);
    this.gridIcon = icon('grid-view', 'filter-icon');
    const gridBtn = h('span', { class: 'bp3-button bp3-minimal filter-button rfm-grid-button', tabindex: 0, onClick: () => this.setGrid(!this.state.grid) }, this.gridIcon);
    const eyeBtn = h('span', { class: 'bp3-button bp3-minimal filter-button', tabindex: 0, onClick: (e: Event) => this.toggleColumns(e.currentTarget as HTMLElement) }, icon('eye-open', 'filter-icon'));
    // thumbnails have no columns to carry the header, so its two jobs move into the toolbar: a select-all
    // box by the trash, and one sort button beside the search
    this.gridAll = h('input', { type: 'checkbox', tabindex: 0, onChange: () => this.selectAll(this.gridAll.checked) });
    const gridAllBox = h('label', { class: 'bp3-control bp3-checkbox rfm-grid-only rfm-grid-all' }, this.gridAll, h('span', { class: 'bp3-control-indicator' }));

    // the sort button of Roam's own card grid (the extension browser in Settings > Roam Depot): same classes, same kind of menu
    const sortBtn = h('button', { class: 'bp3-button bp3-icon-standard bp3-minimal bp3-icon-sort rfm-grid-only rfm-sort-button', onClick: (e: Event) => this.toggleSort(e.currentTarget as HTMLElement) });
    const toolbar = h('div', { class: 'flex-h-box rm-pages-toolbar' },
      h('div', { class: 'toolbar-action-button-group' }, gridAllBox, this.trash, this.count),
      h('div', { class: 'toolbar-search-group' },
        h('div', { class: 'bp3-input-group' }, icon('search', 'search-icon'), search), sortBtn, filterBtn, gridBtn, eyeBtn));
    this.headAll = h('input', { type: 'checkbox', tabindex: 0, onChange: () => this.selectAll(this.headAll.checked) });
    this.header = h('div', { class: 'rm-pages-row rm-pages-row-header' },
      h('div', { class: 'rm-pages-checkbox-col' }, h('label', { class: 'bp3-control bp3-checkbox checkbox-header' }, this.headAll, h('span', { class: 'bp3-control-indicator' }))),
      this.headCell({ key: 'name', label: 'NAME', cls: '', sortable: true, hideable: false }, true),
      ...COLS.map((c) => this.headCell(c)));
    this.spacer = h('div', { style: { position: 'relative', width: '100%' } });
    this.scroller = h('div', { class: 'rfm-scroller', onScroll: () => { this.hidePreview(); this.draw(); } }, this.spacer);
    this.parts = [toolbar, h('div', { class: 'table' }, this.header, this.scroller)];
    this.el = h('div', { class: 'rm-all-pages rfm-view' }, ...this.parts);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    this.applyHidden();
    this.applyGrid();
  }

  destroy() { this.sortRun++; this.sorting = false; this.ro.disconnect(); this.closePopover(); this.hidePreview(); this.progress(null); this.el.remove(); }

  setRows(rows: Row[]) {
    this.rows = rows;
    this.counted = true;
    const keys = new Set(rows.map((r) => r.key));
    for (const k of this.selected) if (!keys.has(k)) this.selected.delete(k);
    this.refresh();
  }

  /** Sizes, names or upload dates arrived for some rows: sort again and redraw, staying in place. */
  updated() { this.refresh(); }

  /**
   * How far the first fetch of sizes and dates has got (0 to 1): a box with a striped bar in the
   * middle of the view. While it shows, the list underneath is dimmed and takes no clicks or keys,
   * since sorting or deleting on half the sizes would mislead. null when there is nothing to wait for.
   */
  progress(done: number | null) {
    this.loading = done == null || done >= 1 ? null : done;
    this.syncLoader();
  }

  /** The box shows while sizes are being fetched (with how far that is) and while a long sort runs (a full, moving bar). */
  private syncLoader() {
    if (this.loading == null && !this.sorting) {
      if (!this.loader) return;
      this.loader.remove(); this.loader = null;
      this.el.classList.remove('rfm-loading');
      for (const p of this.parts) p.removeAttribute('inert');
      return;
    }
    if (!this.loader) {
      this.closePopover(); this.hidePreview();
      this.loader = h('div', { class: 'rfm-loader' },
        h('div', { class: 'rfm-loader-box' }, icon('folder-close'),
          h('div', { class: 'bp3-progress-bar bp3-intent-primary' }, h('div', { class: 'bp3-progress-meter' }))));
      this.el.append(this.loader);
      this.el.classList.add('rfm-loading');
      this.fitLoader();
    }
    // a sort is over in a moment and may have been started from the search box, which keeps its focus
    for (const p of this.parts) p.toggleAttribute('inert', this.loading != null);
    (this.loader.querySelector('.bp3-progress-meter') as HTMLElement).style.width = `${this.loading == null ? 100 : Math.round(this.loading * 100)}%`;
  }

  /** The progress box sits in the middle of what is on screen of the view: from its top to the bottom of the window. */
  private fitLoader() {
    if (this.loader) this.loader.style.height = `${Math.max(120, window.innerHeight - this.el.getBoundingClientRect().top)}px`;
  }

  /** The rows as listed, and the keys of those on screen now. */
  order(): Row[] { return this.shown; }
  inView(): string[] {
    const first = Math.floor(this.scroller.scrollTop / this.lineH), n = Math.ceil(Math.min(this.scroller.clientHeight || 0, window.innerHeight) / this.lineH) + 1;
    return this.shown.slice(first * this.per, (first + n) * this.per).map((r) => r.key);
  }

  refresh() {
    const q = this.state.query.trim().toLowerCase();
    const { kinds, unusedOnly } = this.state;
    const next = this.rows.filter((r) => (!kinds.size || kinds.has(r.kind)) && (!unusedOnly || r.unused)
      && (!q || r.name.toLowerCase().includes(q) || r.ext === q || r.uses.some((u) => u.pageTitle.toLowerCase().includes(q))));
    this.filterIcon.classList.toggle('filtered', kinds.size > 0 || unusedOnly);
    // empty until the graph has been read: "0 Files" would be wrong for that moment
    this.count.textContent = this.counted ? countText(next.length, this.rows.length) : '';
    const key = this.state.sort, desc = this.state.desc, run = ++this.sortRun;
    const work = next.length > 1 ? next.length * Math.log2(next.length) : 0;
    const slow = this.sortCost[key] * work > SLOW_SORT_MS;
    const sort = () => {
      if (run !== this.sortRun) return; // a newer refresh has taken over
      const t = performance.now();
      next.sort(compare(key, desc));
      const ms = performance.now() - t;
      if (work && (ms >= 5 || slow)) this.sortCost[key] = Math.max(ms, 0.5) / work;
      this.shown = next;
      this.measure();
      this.updateHeader();
      this.redraw();
      this.sorting = false;
      this.syncLoader();
    };
    // A sort that will take a while (tens of thousands of files) would freeze the list with no sign
    // of why: the progress box goes up first, and the sort runs once it is on screen.
    if (slow) { this.sorting = true; this.updateHeader(); this.syncLoader(); afterPaint(sort); } else sort();
  }

  private layout() {
    // All Pages gives every column 140px and the title what is left, down to 140px. A file's name
    // shares that with its picture, so with little room the columns give some of theirs back.
    this.el.classList.toggle('rfm-narrow', this.el.clientWidth < NARROW);
    const top = this.scroller.getBoundingClientRect().top;
    const room = window.innerHeight - top - 16;
    this.scroller.style.height = `${Math.max(ROW_H * 4, room)}px`;
    this.fitLoader();
    // a width change moves every tile
    if (this.measure()) this.redraw(); else this.draw();
  }

  /** Works out the layout for the width there is; true when it changed. */
  private measure(): boolean {
    const { per, lineH, tileW } = this;
    if (this.state.grid) {
      const w = this.scroller.clientWidth || this.el.clientWidth || TILE_MIN;
      this.per = Math.max(1, Math.floor((w + TILE_GAP) / (TILE_MIN + TILE_GAP)));
      this.tileW = Math.floor((w - TILE_GAP * (this.per - 1)) / this.per);
      this.lineH = Math.round(this.tileW * 0.75) + TILE_CAPTION + TILE_GAP;
    } else { this.per = 1; this.lineH = ROW_H; this.tileW = 0; }
    this.spacer.style.height = `${Math.ceil(this.shown.length / this.per) * this.lineH}px`;
    return per !== this.per || lineH !== this.lineH || tileW !== this.tileW;
  }

  private setGrid(on: boolean) {
    this.state.grid = on; this.hidePreview(); this.applyGrid();
    // the header row comes or goes, so the room for the files changes too
    this.scroller.scrollTop = 0; this.layout(); this.redraw(); this.actions.stateChanged();
  }
  private applyGrid() { this.el.classList.toggle('rfm-grid', this.state.grid); this.gridIcon.parentElement!.classList.toggle('bp3-active', this.state.grid); }

  private redraw() { for (const el of this.drawn.values()) drop(el); this.drawn.clear(); this.draw(); }

  private draw() {
    // never more than a window's worth: before the scroller has been given its height it is as tall as
    // the whole list, and every row would be drawn
    const top = this.scroller.scrollTop, height = Math.min(this.scroller.clientHeight || window.innerHeight, window.innerHeight);
    const over = this.state.grid ? 2 : OVERSCAN;
    const first = Math.max(0, (Math.floor(top / this.lineH) - over) * this.per);
    const last = Math.min(this.shown.length - 1, (Math.ceil((top + height) / this.lineH) + over) * this.per - 1);
    for (const [i, el] of this.drawn) if (i < first || i > last) { drop(el); this.drawn.delete(i); }
    for (let i = first; i <= last; i++) {
      if (this.drawn.has(i)) continue;
      const el = this.state.grid ? this.tileEl(this.shown[i]) : this.rowEl(this.shown[i]);
      el.style.cssText = this.state.grid
        ? `position:absolute;left:${(i % this.per) * (this.tileW + TILE_GAP)}px;top:${Math.floor(i / this.per) * this.lineH}px;width:${this.tileW}px`
        : `position:absolute;left:0;top:${i * ROW_H}px;width:100%`;
      this.spacer.append(el); this.drawn.set(i, el);
    }
  }

  private rowEl(r: Row): HTMLDivElement {
    // a file stored under another graph can't be deleted from here, so it can't be ticked
    const cb = h('input', { type: 'checkbox', checked: this.selected.has(r.key), disabled: !r.own, onChange: () => { cb.checked ? this.selected.add(r.key) : this.selected.delete(r.key); this.updateHeader(); } });
    const thumb = r.kind === 'image' && r.size != null && r.size <= THUMB_MAX && !isEncrypted(r.key)
      ? h('img', { class: 'rfm-thumb', src: srcOfRow(r), loading: 'lazy', decoding: 'async', alt: '' })
      : r.kind === 'video' ? videoStill(r, 'rfm-thumb-icon')
      : h('span', { class: 'rfm-thumb-icon' }, icon(KIND_ICON[r.kind]));
    if (previewable(r)) this.previewOn(thumb, r);
    const n = r.uses.length;
    return h('div', { class: 'rm-pages-row' },
      h('div', { class: 'rm-pages-checkbox-col' }, h('label', { class: `bp3-control bp3-checkbox${r.own ? '' : ' bp3-disabled'}`, style: { marginBottom: '0' } }, cb, h('span', { class: 'bp3-control-indicator' }))),
      h('div', { class: 'rm-pages-title-col bp3-text-overflow-ellipsis' }, thumb,
        h('a', { class: 'rm-pages-title-text', onClick: () => this.actions.openFile(r) }, h('strong', {}, r.name)),
        // where All Pages shows the start of a page in grey, the page (or pages) the file is on
        n > 0 && h('span', { class: 'title-children-text' }, pagesOf(r).join(', '))),
      h('div', { class: 'rm-pages-col bp3-text-small rfm-col-type' }, r.ext.toUpperCase()),
      h('div', { class: 'rm-pages-col bp3-text-small rfm-col-size' }, formatSize(r.size)),
      h('div', { class: 'rm-pages-col rfm-col-mentions' },
        h('div', { class: `rm-clickable-pill${pillLevel(n)}`, onClick: () => { if (n) this.actions.openMentions(r); } }, String(n))),
      h('div', { class: 'rm-pages-col bp3-text-small rfm-col-added' }, r.added ? this.actions.dateTitle(r.added) : ''));
  }

  /** A file in the thumbnail view: its picture, then what the list's columns say about it. */
  private tileEl(r: Row): HTMLDivElement {
    const cb = h('input', { type: 'checkbox', checked: this.selected.has(r.key), disabled: !r.own, onChange: () => { cb.checked ? this.selected.add(r.key) : this.selected.delete(r.key); this.updateHeader(); } });
    const open = !isEncrypted(r.key) && r.size != null && r.size <= GRID_THUMB_MAX;
    const pic = r.kind === 'image' && open ? h('img', { src: srcOfRow(r), loading: 'lazy', decoding: 'async', alt: '' })
      // a video plays in its tile with the browser's own controls; nothing of it is fetched until then. The
      // controls come when the pointer does (or with a click): at rest Roam's desktop app draws the player's
      // loading circle over the still for good, so a tile at rest is the still alone
      : r.kind === 'video' && previewable(r) ? h('video', { src: srcOfRow(r), preload: 'none', playsinline: true })
      : icon(KIND_ICON[r.kind]);
    // its picture is the shared still (videoStillUrl); a video this browser has no decoder for keeps the icon and gets no player
    if (pic instanceof HTMLVideoElement) videoStillUrl(r, () => pic.isConnected).then((s) => {
      if (s) pic.poster = s; else if (s === false) pic.replaceWith(icon(KIND_ICON[r.kind]));
    });
    // a video this browser can't play gets its icon, as a file with no picture does
    if (pic instanceof HTMLVideoElement) pic.addEventListener('error', () => pic.replaceWith(icon(KIND_ICON[r.kind])));
    const n = r.uses.length;
    const arm = () => { if (pic instanceof HTMLVideoElement && pic.isConnected) pic.controls = true; };
    if (pic instanceof HTMLVideoElement) pic.addEventListener('click', () => { if (!pic.controls) { arm(); void pic.play().catch(() => {}); } });
    return h('div', { class: 'rfm-tile', onPointerenter: arm },
      h('div', { class: 'rfm-tile-pic', style: { height: `${Math.round(this.tileW * 0.75)}px` }, onClick: (e: Event) => { if (!(e.target as HTMLElement).closest('label, video')) this.actions.openFile(r); } }, pic,
        h('label', { class: `bp3-control bp3-checkbox rfm-tile-check${r.own ? '' : ' bp3-disabled'}` }, cb, h('span', { class: 'bp3-control-indicator' }))),
      h('a', { class: 'rm-pages-title-text rfm-tile-name', onClick: () => this.actions.openFile(r) }, h('strong', {}, r.name)),
      h('div', { class: 'rfm-tile-meta bp3-text-small' },
        h('span', { class: 'rfm-col-type' }, r.ext.toUpperCase()),
        h('span', { class: 'rfm-col-size' }, formatSize(r.size)),
        h('div', { class: `rm-clickable-pill rfm-col-mentions${pillLevel(n)}`, onClick: () => { if (n) this.actions.openMentions(r); } }, String(n))));
  }

  private headCell(c: Col, title = false) {
    const cell = h('div', { class: title ? 'rm-pages-title-col bp3-text-overflow-ellipsis' : `rm-pages-col ${c.cls}`, 'data-col': c.key },
      h('span', {}, c.label));
    if (c.sortable) {
      const up = icon('chevron-up', 'sort-button'), down = icon('chevron-down', 'sort-button desc');
      up.addEventListener('click', () => this.sortBy(c.key as SortKey, false));
      down.addEventListener('click', () => this.sortBy(c.key as SortKey, true));
      cell.append(h('span', { class: 'sorting-button-group' }, up, down));
      cell.firstElementChild!.addEventListener('click', () => this.sortBy(c.key as SortKey, this.state.sort === c.key ? !this.state.desc : c.key !== 'name'));
      (cell.firstElementChild as HTMLElement).style.cursor = 'pointer';
    }
    return cell;
  }

  private sortBy(key: SortKey, desc: boolean) { this.state.sort = key; this.state.desc = desc; this.scroller.scrollTop = 0; this.refresh(); this.actions.stateChanged(); }

  private updateHeader() {
    for (const cell of this.header.querySelectorAll<HTMLElement>('[data-col]')) {
      const on = cell.dataset.col === this.state.sort;
      cell.firstElementChild!.classList.toggle('sorted-header-text', on);
      cell.querySelector('.sort-button:not(.desc)')?.classList.toggle('focused', on && !this.state.desc);
      cell.querySelector('.sort-button.desc')?.classList.toggle('focused', on && this.state.desc);
    }
    const sel = this.selectedRows();
    this.headAll.checked = this.gridAll.checked = sel.length > 0 && sel.length === this.shown.filter((r) => r.own).length;
    // like All Pages' trash: on when something is ticked
    const ok = sel.length > 0;
    this.trash.disabled = !ok;
    this.trash.classList.toggle('button-disabled-strong', !ok);
  }

  private selectedRows() { return this.shown.filter((r) => this.selected.has(r.key)); }

  private selectAll(on: boolean) {
    this.selected.clear();
    if (on) for (const r of this.shown) if (r.own) this.selected.add(r.key);
    this.updateHeader(); this.redraw();
  }

  private applyHidden() { for (const c of COLS) this.el.classList.toggle(`rfm-hide-${c.key}`, this.state.hidden.has(c.key)); }

  // ---------- popovers (Blueprint markup, like All Pages' column switches) ----------
  private closePopover() { this.popover?.remove(); this.popover = null; document.removeEventListener('mousedown', this.outside, true); }
  private outside = (e: MouseEvent) => { if (this.popover && !this.popover.contains(e.target as Node)) this.closePopover(); };
  private openPopover(anchor: HTMLElement, body: HTMLElement, width = 220, left = false) {
    this.closePopover();
    const r = anchor.getBoundingClientRect();
    this.popover = h('div', { class: 'bp3-portal' }, h('div', { class: 'bp3-transition-container bp3-popover-enter-done', style: { position: 'fixed', top: `${r.bottom + 4}px`, left: `${Math.max(8, Math.min(left ? r.left : r.right - width, window.innerWidth - width - 8))}px`, zIndex: '20' } },
      h('div', { class: 'bp3-popover bp3-minimal' }, h('div', { class: 'bp3-popover-content' }, body))));
    document.body.append(this.popover);
    setTimeout(() => document.addEventListener('mousedown', this.outside, true));
  }

  // ---------- preview on hover: a picture, or a video that plays ----------
  private preview: HTMLElement | null = null;
  private previewTimer = 0;
  private previewOn(el: HTMLElement, r: Row) {
    el.addEventListener('mouseenter', () => {
      clearTimeout(this.previewTimer);
      // a short wait, so that running the pointer down the column loads nothing
      this.previewTimer = window.setTimeout(() => this.showPreview(el, r), 150);
    });
    // a video's preview has controls, so the pointer gets a moment to move onto it
    el.addEventListener('mouseleave', () => (r.kind === 'video' && this.preview ? this.hidePreviewSoon() : this.hidePreview()));
  }
  private hidePreviewSoon() { clearTimeout(this.previewTimer); this.previewTimer = window.setTimeout(() => this.hidePreview(), 300); }
  private hidePreview() {
    clearTimeout(this.previewTimer);
    const media = this.preview?.querySelector<HTMLImageElement | HTMLVideoElement>('img, video');
    // stop a picture that is still loading, and a video that is still streaming
    if (media instanceof HTMLVideoElement) { media.pause(); media.removeAttribute('src'); media.load(); }
    else if (media && !media.complete) media.src = '';
    this.preview?.remove(); this.preview = null;
  }
  private showPreview(el: HTMLElement, r: Row) {
    this.hidePreview();
    if (!el.isConnected) return;
    const a = el.getBoundingClientRect();
    const video = r.kind === 'video';
    // a video this browser can't decode has nothing to play
    if (video && stills.get(r.key) === false) return;
    const box = h('div', { class: 'bp3-transition-container bp3-popover-enter-done', style: { position: 'fixed', left: `${a.right + 10}px`, top: `${a.top}px`, zIndex: '30', visibility: 'hidden' } });
    // shown once the picture or video has a size, and kept inside the window
    const place = () => {
      const b = box.getBoundingClientRect();
      box.style.top = `${Math.max(8, Math.min(a.top + a.height / 2 - b.height / 2, window.innerHeight - b.height - 8))}px`;
      box.style.visibility = '';
    };
    // a video starts by itself without sound; its controls turn the sound on
    const media = video
      ? h('video', { class: 'rfm-preview-img rfm-preview-video', src: srcOfRow(r), autoplay: true, loop: true, playsinline: true, controls: true })
      : h('img', { class: 'rfm-preview-img', src: srcOfRow(r), alt: '' });
    if (media instanceof HTMLVideoElement) media.muted = true;
    media.addEventListener(video ? 'loadeddata' : 'load', () => {
      if (media instanceof HTMLVideoElement && !media.videoWidth) { if (this.preview?.contains(media)) this.hidePreview(); return; }
      place();
    });
    // a video this browser can't play (some .mov files) shows nothing
    media.addEventListener('error', () => { if (this.preview?.contains(media)) this.hidePreview(); });
    box.append(h('div', { class: 'bp3-popover bp3-minimal' }, h('div', { class: 'bp3-popover-content rfm-preview' }, media)));
    this.preview = h('div', { class: 'bp3-portal', style: { pointerEvents: 'none' } }, box);
    if (video) {
      box.style.pointerEvents = 'auto';
      box.addEventListener('mouseenter', () => clearTimeout(this.previewTimer));
      box.addEventListener('mouseleave', () => this.hidePreview());
    }
    document.body.append(this.preview);
  }

  private switchEl(label: string, on: boolean, change: (on: boolean) => void) {
    const input = h('input', { type: 'checkbox', checked: on, onChange: () => change(input.checked) });
    return h('label', { class: 'bp3-control bp3-switch bp3-align-right' }, input, h('span', { class: 'bp3-control-indicator' }), h('span', { style: { fontWeight: '400' } }, label));
  }
  /** Thumbnail view's sort menu, with the markup of the one in Roam's extension browser. */
  private toggleSort(anchor: HTMLElement) {
    if (this.popover) return this.closePopover();
    const item = ([k, desc, label]: [SortKey, boolean, string]) => h('li', {},
      h('a', { class: `bp3-menu-item${k === this.state.sort && desc === this.state.desc ? ' bp3-active bp3-intent-primary' : ''} bp3-popover-dismiss`, tabindex: 0, 'data-sort': `${k}-${desc ? 'desc' : 'asc'}`,
        onClick: () => { this.closePopover(); this.sortBy(k, desc); } },
        h('div', { class: 'bp3-fill bp3-text-overflow-ellipsis' }, label)));
    this.openPopover(anchor, h('ul', { class: 'bp3-menu rfm-sort-menu' },
      ...SORT_MENU.flatMap((pair, i) => [i > 0 && h('li', { class: 'bp3-menu-divider' }), ...pair.map(item)])), 200);
  }
  private toggleColumns(anchor: HTMLElement) {
    if (this.popover) return this.closePopover();
    this.openPopover(anchor, h('div', { style: { padding: '8px', width: '204px' } },
      h('div', { style: { paddingBottom: '8px', fontWeight: '600' } }, 'Show or Hide Columns'),
      ...COLS.map((c) => this.switchEl(COL_NAMES[c.key], !this.state.hidden.has(c.key), (on) => {
        on ? this.state.hidden.delete(c.key) : this.state.hidden.add(c.key); this.applyHidden(); this.actions.stateChanged();
      }))));
  }
  private toggleFilter(anchor: HTMLElement) {
    if (this.popover) return this.closePopover();
    this.openPopover(anchor, h('div', { style: { padding: '8px', width: '204px' } },
      h('div', { style: { paddingBottom: '8px', fontWeight: '600' } }, 'Filter Files'),
      ...KIND_LABELS.map(([k, label]) => this.switchEl(label, this.state.kinds.has(k), (on) => { on ? this.state.kinds.add(k) : this.state.kinds.delete(k); this.refresh(); })),
      h('div', { style: { height: '1px', background: 'rgba(16,22,26,.15)', margin: '4px 0 10px' } }),
      this.switchEl('Unused', this.state.unusedOnly, (on) => { this.state.unusedOnly = on; this.refresh(); })));
  }

  /** What is about to go: the picture itself, a video's still, or the file's icon. Hovering shows it larger, as in the list. */
  private dialogThumb(r: Row): HTMLElement {
    const iconEl = () => h('span', { class: 'rfm-delete-thumb rfm-thumb-icon' }, icon(KIND_ICON[r.kind]));
    let el: HTMLElement;
    if (isEncrypted(r.key)) el = iconEl();
    else if (r.kind === 'image' && (r.size ?? Infinity) <= DIALOG_THUMB_MAX) el = h('img', { class: 'rfm-delete-thumb', src: srcOfRow(r), loading: 'lazy', decoding: 'async', alt: '' });
    else if (r.kind === 'video') el = videoStill(r, 'rfm-delete-thumb rfm-thumb-icon');
    else el = iconEl();
    if (previewable(r)) this.previewOn(el, r);
    return el;
  }

  // ---------- delete: Roam's own confirmation dialog markup ----------
  confirmDelete() {
    const rows = this.selectedRows().filter((r) => r.own);
    if (!rows.length) return;
    // files still in blocks: a warning above the list, and Enter no longer confirms
    const warning = inUseWarning(rows);
    const n = rows.length, noun = n === 1 ? 'file' : 'files';
    let overlay: HTMLElement;
    const close = () => { this.hidePreview(); overlay.remove(); document.removeEventListener('keydown', key, true); };
    const go = async () => {
      confirm.disabled = true;
      // nothing stays ticked afterwards, including a file that could not be deleted
      try { await this.actions.deleteFiles(rows); } finally { for (const r of rows) this.selected.delete(r.key); this.refresh(); close(); }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'Enter') { e.preventDefault(); if (!warning) go(); } };
    const confirm = h('button', { class: 'bp3-button confirm-button bp3-intent-danger', onClick: go }, h('span', {}, `Yes, delete ${noun}`), !warning && icon('key-enter'));
    overlay = h('div', { class: 'bp3-portal' }, h('div', { class: 'bp3-overlay bp3-overlay-open bp3-overlay-scroll-container' },
      h('div', { class: 'bp3-overlay-backdrop', onClick: close }),
      h('div', { class: 'bp3-dialog-container bp3-overlay-content' },
        h('div', { class: 'bp3-dialog rm-modal-dialog rm-modal-dialog--confirmation-with-content', role: 'dialog' },
          h('div', { class: 'confirmation-content-dialog' },
            h('h3', { class: 'bp3-heading confirmation-content-header' }, `Are you sure you want to permanently delete ${n} ${noun}?`),
            h('div', { class: 'confirmation-content rfm-delete-content' },
              warning && h('div', { class: 'bp3-callout bp3-intent-danger bp3-callout-icon rfm-delete-warning' }, icon('warning-sign'),
                h('h4', { class: 'bp3-heading' }, 'Deleting can\'t be undone'), warning),
              h('div', { class: 'delete-all-dialog-list' },
              ...rows.map((r, i) => {
                const m = r.uses.length;
                return h('div', { class: `delete-all-dialog-items rfm-delete-item${i === n - 1 ? ' last-item' : ''}` },
                  this.dialogThumb(r),
                  h('div', { class: 'bp3-text-overflow-ellipsis' }, r.name),
                  h('div', { class: 'bp3-text-small delete-all-dialog-secondary-text' }, [r.ext.toUpperCase(), formatSize(r.size)].filter(Boolean).join(', ')),
                  // the same count as in the list. A click shows the blocks: the dialog goes away, the ticks stay
                  h('div', { class: `rm-clickable-pill${pillLevel(m)}`, onClick: () => { if (m) { close(); this.actions.openMentions(r); } } }, String(m)));
              }))),
            h('div', { class: 'flex-h-box confirmation-content-buttons' },
              h('button', { class: 'bp3-button bp3-minimal cancel-button', onClick: close }, h('span', {}, 'Cancel'), icon('key-escape')),
              confirm))))));
    document.body.append(overlay);
    document.addEventListener('keydown', key, true);
  }
}
