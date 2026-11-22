// The Files view: a details list of every file uploaded to the graph, drawn with the markup and
// classes of Roam's own All Pages table (rm-all-pages, rm-pages-row, ...), so Roam's stylesheet
// styles it. Rows are virtual: only the rows in view (plus a margin) are in the DOM, so a graph
// with thousands of files scrolls as fast as one with ten.
import { h, icon } from './dom.ts';
import { compare, formatSize, inUseWarning, isEncrypted, type Kind, type Row, type SortKey } from './files.ts';

export const ROW_H = 39;
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
const SORT_NAMES: Record<SortKey, string> = { name: 'Name', ...COL_NAMES } as Record<SortKey, string>;

export const KIND_LABELS: [Kind, string][] = [['image', 'Images'], ['pdf', 'PDFs'], ['audio', 'Audio'], ['video', 'Video'], ['other', 'Other files']];
const KIND_ICON: Record<Kind, string> = { image: 'media', pdf: 'document', audio: 'music', video: 'video', other: 'paperclip' };

export const STYLES = `
.rfm-view .rm-pages-row{height:${ROW_H}px;box-sizing:border-box}
.rfm-view .rm-pages-title-col{display:flex;align-items:center;gap:10px;min-width:0;white-space:nowrap;overflow:hidden;padding-top:6px;padding-bottom:6px}
.rfm-view .rm-pages-row-header .rm-pages-title-col{padding-top:8px;padding-bottom:8px}
.rfm-view .rfm-thumb{flex:0 0 26px;width:26px;height:26px;border-radius:3px;object-fit:cover;background:#f5f8fa}
.rfm-view .rfm-thumb-icon{flex:0 0 26px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#8a9ba8}
.rfm-view .rm-pages-title-text{flex:0 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.rfm-view .title-children-text{flex:0 9999 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.rfm-view .rm-pages-col{line-height:22px}
.rfm-view .rfm-col-type{flex-basis:80px}
.rfm-view .rfm-col-size{flex-basis:90px}
.rfm-view .rfm-col-mentions{flex-basis:110px}
.rfm-view .rfm-col-added{flex-basis:170px}
.rfm-view .rfm-scroller{position:relative;overflow:auto;will-change:transform}
.rfm-view .rm-pages-row:not(.rm-pages-row-header):hover{background:rgb(245,248,250)}
.rfm-view .rfm-thumb,.rfm-view .rfm-thumb-icon{cursor:default}
.rfm-delete-content{display:flex;flex-direction:column;max-height:min(440px,60vh) !important}
.rfm-delete-content .delete-all-dialog-list{flex:1 1 auto;min-height:0;overflow-y:auto}
.rfm-delete-warning{flex:0 0 auto;margin-bottom:12px}
.rfm-delete-item{display:grid;grid-template-columns:48px minmax(0,1fr);column-gap:10px;align-items:center}
.rfm-delete-item .rfm-delete-thumb{grid-row:1 / span 2;width:48px;height:48px;border-radius:3px;object-fit:cover;display:flex;align-items:center;justify-content:center;color:#8a9ba8}
.rfm-delete-warning>.bp3-icon{position:absolute;left:10px;top:10px}
.rfm-preview{padding:6px;line-height:0}
.rfm-preview-img{max-width:360px;max-height:360px;border-radius:3px;display:block}
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
.rfm-view .rfm-sort-button{margin-left:8px}
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
  private sortLabel: HTMLSpanElement;
  private sortDir: HTMLSpanElement;
  /** How the rows are laid out now: files per line, the height of a line, the width of a tile. */
  private per = 1; private lineH = ROW_H; private tileW = 0;
  private headAll: HTMLInputElement;
  private drawn = new Map<number, HTMLDivElement>();
  private ro: ResizeObserver;
  private popover: HTMLElement | null = null;

  constructor(private actions: ViewActions, public state: ViewState = defaultState()) {
    const search = h('input', { class: 'bp3-input bp3-round bp3-minimal search-input', placeholder: 'Search Files', value: state.query,
      onInput: (e: Event) => { this.state.query = (e.target as HTMLInputElement).value; this.refresh(); } });
    this.trash = h('button', { class: 'bp3-button bp3-minimal bp3-icon-trash button-disabled-strong', tabindex: 0, disabled: true, onClick: () => this.confirmDelete() });
    this.filterIcon = icon('filter', 'filter-icon');
    const filterBtn = h('span', { class: 'bp3-button bp3-minimal filter-button', tabindex: 0, onClick: (e: Event) => this.toggleFilter(e.currentTarget as HTMLElement) }, this.filterIcon);
    this.gridIcon = icon('grid-view', 'filter-icon');
    const gridBtn = h('span', { class: 'bp3-button bp3-minimal filter-button rfm-grid-button', tabindex: 0, onClick: () => this.setGrid(!this.state.grid) }, this.gridIcon);
    const eyeBtn = h('span', { class: 'bp3-button bp3-minimal filter-button', tabindex: 0, onClick: (e: Event) => this.toggleColumns(e.currentTarget as HTMLElement) }, icon('eye-open', 'filter-icon'));
    // thumbnails have no columns to carry the header, so its two jobs move into the toolbar: a select-all
    // box by the trash, and one sort control (what the files are sorted by, and an arrow for the direction)
    this.gridAll = h('input', { type: 'checkbox', tabindex: 0, onChange: () => this.selectAll(this.gridAll.checked) });
    const gridAllBox = h('label', { class: 'bp3-control bp3-checkbox rfm-grid-only rfm-grid-all' }, this.gridAll, h('span', { class: 'bp3-control-indicator' }));
    this.sortLabel = h('span', { class: 'bp3-button-text' });
    const sortBtn = h('span', { class: 'bp3-button bp3-minimal rfm-grid-only rfm-sort-button', tabindex: 0, onClick: (e: Event) => this.toggleSort(e.currentTarget as HTMLElement) }, this.sortLabel, icon('caret-down'));
    this.sortDir = icon('arrow-down');
    const dirBtn = h('span', { class: 'bp3-button bp3-minimal rfm-grid-only rfm-sort-dir', tabindex: 0, onClick: () => this.sortBy(this.state.sort, !this.state.desc) }, this.sortDir);
    const toolbar = h('div', { class: 'flex-h-box rm-pages-toolbar' },
      h('div', { class: 'toolbar-action-button-group' }, gridAllBox, this.trash, sortBtn, dirBtn),
      h('div', { class: 'toolbar-search-group' },
        h('div', { class: 'bp3-input-group' }, icon('search', 'search-icon'), search), filterBtn, gridBtn, eyeBtn));
    this.headAll = h('input', { type: 'checkbox', tabindex: 0, onChange: () => this.selectAll(this.headAll.checked) });
    this.header = h('div', { class: 'rm-pages-row rm-pages-row-header' },
      h('div', { class: 'rm-pages-checkbox-col' }, h('label', { class: 'bp3-control bp3-checkbox checkbox-header' }, this.headAll, h('span', { class: 'bp3-control-indicator' }))),
      this.headCell({ key: 'name', label: 'NAME', cls: '', sortable: true, hideable: false }, true),
      ...COLS.map((c) => this.headCell(c)));
    this.spacer = h('div', { style: { position: 'relative', width: '100%' } });
    this.scroller = h('div', { class: 'rfm-scroller', onScroll: () => { this.hidePreview(); this.draw(); } }, this.spacer);
    this.el = h('div', { class: 'rm-all-pages rfm-view' }, toolbar, h('div', { class: 'table' }, this.header, this.scroller));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.el);
    this.applyHidden();
    this.applyGrid();
  }

  destroy() { this.ro.disconnect(); this.closePopover(); this.hidePreview(); this.el.remove(); }

  setRows(rows: Row[]) {
    this.rows = rows;
    const keys = new Set(rows.map((r) => r.key));
    for (const k of this.selected) if (!keys.has(k)) this.selected.delete(k);
    this.refresh();
  }

  /** Sizes, names or upload dates arrived for some rows: sort again and redraw, staying in place. */
  updated() { this.refresh(); }

  /** The rows as listed, and the keys of those on screen now. */
  order(): Row[] { return this.shown; }
  inView(): string[] {
    const first = Math.floor(this.scroller.scrollTop / this.lineH), n = Math.ceil((this.scroller.clientHeight || 0) / this.lineH) + 1;
    return this.shown.slice(first * this.per, (first + n) * this.per).map((r) => r.key);
  }

  refresh() {
    const q = this.state.query.trim().toLowerCase();
    const { kinds, unusedOnly } = this.state;
    this.shown = this.rows.filter((r) => (!kinds.size || kinds.has(r.kind)) && (!unusedOnly || r.unused)
      && (!q || r.name.toLowerCase().includes(q) || r.ext === q || r.uses.some((u) => u.pageTitle.toLowerCase().includes(q))));
    this.shown.sort(compare(this.state.sort, this.state.desc));
    this.filterIcon.classList.toggle('filtered', kinds.size > 0 || unusedOnly);
    this.measure();
    this.updateHeader();
    this.redraw();
  }

  private layout() {
    const top = this.scroller.getBoundingClientRect().top;
    const room = window.innerHeight - top - 16;
    this.scroller.style.height = `${Math.max(ROW_H * 4, room)}px`;
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
    const top = this.scroller.scrollTop, height = this.scroller.clientHeight || window.innerHeight;
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
      ? h('img', { class: 'rfm-thumb', src: r.url, loading: 'lazy', decoding: 'async', alt: '' })
      : h('span', { class: 'rfm-thumb-icon' }, icon(KIND_ICON[r.kind]));
    if (r.kind === 'image' && !isEncrypted(r.key)) this.previewOn(thumb, r);
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
    const pic = r.kind === 'image' && open ? h('img', { src: r.url, loading: 'lazy', decoding: 'async', alt: '' })
      // a video's first frame, with the browser's own player controls: only the start of the file is fetched until it plays
      : r.kind === 'video' && !isEncrypted(r.key) ? h('video', { src: `${r.url}#t=0.1`, preload: 'metadata', controls: true, playsinline: true })
      : icon(KIND_ICON[r.kind]);
    // a video this browser can't play gets its icon, as a file with no picture does
    if (pic instanceof HTMLVideoElement) pic.addEventListener('error', () => pic.replaceWith(icon(KIND_ICON[r.kind])));
    const n = r.uses.length;
    return h('div', { class: 'rfm-tile' },
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
    this.sortLabel.textContent = SORT_NAMES[this.state.sort];
    this.sortDir.className = `bp3-icon bp3-icon-arrow-${this.state.desc ? 'down' : 'up'}`;
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

  // ---------- image preview on hover ----------
  private preview: HTMLElement | null = null;
  private previewTimer = 0;
  private previewOn(el: HTMLElement, r: Row) {
    el.addEventListener('mouseenter', () => {
      clearTimeout(this.previewTimer);
      // a short wait, so that running the pointer down the column loads nothing
      this.previewTimer = window.setTimeout(() => this.showPreview(el, r), 150);
    });
    el.addEventListener('mouseleave', () => this.hidePreview());
  }
  private hidePreview() {
    clearTimeout(this.previewTimer);
    const img = this.preview?.querySelector('img');
    if (img && !img.complete) img.src = '';
    this.preview?.remove(); this.preview = null;
  }
  private showPreview(el: HTMLElement, r: Row) {
    this.hidePreview();
    if (!el.isConnected) return;
    const a = el.getBoundingClientRect();
    const box = h('div', { class: 'bp3-transition-container bp3-popover-enter-done', style: { position: 'fixed', left: `${a.right + 10}px`, top: `${a.top}px`, zIndex: '20', visibility: 'hidden' } });
    const img = h('img', { class: 'rfm-preview-img', src: r.url, alt: '' });
    // shown once the picture has a size, and kept inside the window
    img.addEventListener('load', () => {
      const b = box.getBoundingClientRect();
      box.style.top = `${Math.max(8, Math.min(a.top + a.height / 2 - b.height / 2, window.innerHeight - b.height - 8))}px`;
      box.style.visibility = '';
    });
    box.append(h('div', { class: 'bp3-popover bp3-minimal' }, h('div', { class: 'bp3-popover-content rfm-preview' }, img)));
    this.preview = h('div', { class: 'bp3-portal', style: { pointerEvents: 'none' } }, box);
    document.body.append(this.preview);
  }

  private switchEl(label: string, on: boolean, change: (on: boolean) => void) {
    const input = h('input', { type: 'checkbox', checked: on, onChange: () => change(input.checked) });
    return h('label', { class: 'bp3-control bp3-switch bp3-align-right' }, input, h('span', { class: 'bp3-control-indicator' }), h('span', { style: { fontWeight: '400' } }, label));
  }
  /** Thumbnail view's sort menu: the list's column names; picking the one in use flips the direction. */
  private toggleSort(anchor: HTMLElement) {
    if (this.popover) return this.closePopover();
    this.openPopover(anchor, h('ul', { class: 'bp3-menu rfm-sort-menu' },
      ...(Object.keys(SORT_NAMES) as SortKey[]).map((k) => h('li', {},
        h('a', { class: `bp3-menu-item${k === this.state.sort ? ' bp3-active' : ''}`, tabindex: 0, 'data-sort': k,
          onClick: () => { this.closePopover(); this.sortBy(k, k === this.state.sort ? !this.state.desc : k !== 'name'); } },
          h('div', { class: 'bp3-text-overflow-ellipsis bp3-fill' }, SORT_NAMES[k]))))), 150, true);
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

  // ---------- delete: Roam's own confirmation dialog markup ----------
  confirmDelete() {
    const rows = this.selectedRows().filter((r) => r.own);
    if (!rows.length) return;
    // files still in blocks: a warning above the list, and Enter no longer confirms
    const warning = inUseWarning(rows);
    const n = rows.length, noun = n === 1 ? 'file' : 'files';
    let overlay: HTMLElement;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', key, true); };
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
              ...rows.map((r, i) => h('div', { class: `delete-all-dialog-items rfm-delete-item${i === n - 1 ? ' last-item' : ''}` },
                // what is about to go: the picture itself, or the file's icon
                r.kind === 'image' && !isEncrypted(r.key) && (r.size ?? Infinity) <= DIALOG_THUMB_MAX
                  ? h('img', { class: 'rfm-delete-thumb', src: r.url, loading: 'lazy', decoding: 'async', alt: '' })
                  : h('span', { class: 'rfm-delete-thumb rfm-thumb-icon' }, icon(KIND_ICON[r.kind])),
                h('div', { class: 'bp3-text-overflow-ellipsis' }, r.name),
                // Roam's own dialog says "1 Mentions, 0 Words" under each page
                h('div', { class: 'bp3-text-small delete-all-dialog-secondary-text' }, [`${r.uses.length} Mentions`, formatSize(r.size)].filter(Boolean).join(', ')))))),
            h('div', { class: 'flex-h-box confirmation-content-buttons' },
              h('button', { class: 'bp3-button bp3-minimal cancel-button', onClick: close }, h('span', {}, 'Cancel'), icon('key-escape')),
              confirm))))));
    document.body.append(overlay);
    document.addEventListener('keydown', key, true);
  }
}
