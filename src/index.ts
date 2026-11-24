// File Manager for Roam Research. Adds "Files" under All Pages in the left sidebar: a details
// list of every file uploaded to the graph, in the style of Roam's All Pages.
import { App, VIEW_ID as ID } from './app.ts';
import { openStore, closeStore } from './store.ts';
import { STYLES } from './view.ts';
import { h } from './dom.ts';

const RESCAN_MS = 10 * 60 * 1000;
const QUIET_MS = 3000;

let cleanup: (() => void)[] = [];

function onload() {
  const api = (window as any).roamAlphaAPI;
  const React = (window as any).React;
  openStore();
  const app = new App();

  const style = h('style', { 'data-roam-file-manager': 'style' }, STYLES);
  document.head.append(style);
  cleanup.push(() => style.remove());

  // the main-window view
  const AllFiles = () => {
    const ref = React.useRef(null);
    React.useEffect(() => { app.mount(ref.current); return () => app.unmount(); }, []);
    return React.createElement('div', { ref, style: { height: '100%' } });
  };
  api.ui.mainWindow.registerComponent(ID, AllFiles);
  cleanup.push(() => {
    if (app.mounted) api.ui.mainWindow.closeComponent(ID);
    api.ui.mainWindow.unregisterComponent(ID);
    app.unmount();
  });

  // "Files" in the left sidebar, built like the All Pages row. Roam redraws the sidebar when it
  // is opened or closed, so the row is put back whenever it goes missing.
  const row = h('div', { class: 'log-button rm-left-sidebar__files', onClick: () => api.ui.mainWindow.openComponent(ID) },
    h('div', { class: 'flex-h-box', style: { alignItems: 'center', justifyContent: 'space-between' } },
      h('span', { class: 'bp3-icon bp3-icon-folder-close icon bp3-icon-small' }), 'Files'));
  const place = () => {
    if (row.isConnected) return;
    document.querySelector('.roam-sidebar-content .rm-left-sidebar__all-pages')?.after(row);
  };
  place();
  const obs = new MutationObserver(place);
  obs.observe(document.querySelector('.roam-app') ?? document.body, { childList: true, subtree: true });
  cleanup.push(() => { obs.disconnect(); row.remove(); });

  // Roam closes a main-window component when its route changes. Going to where Roam already was
  // (Daily Notes, opened from Daily Notes) changes no route, so the list would stay up: close it on
  // any click in the left sidebar and on picking a page in Find or Create Page.
  const leave = (e: Event) => {
    if (!app.mounted) return;
    const t = e.target as HTMLElement | null;
    if (!t?.closest || t.closest('.rm-left-sidebar__files')) return;
    const nav = e.type === 'keydown'
      ? (e as KeyboardEvent).key === 'Enter' && !!t.closest('.rm-find-or-create-wrapper')
      : !!t.closest('.roam-sidebar-content .log-button, .roam-sidebar-content .starred-pages, .rm-find-or-create-wrapper .rm-menu-item, .rm-find-or-create-wrapper .rm-search-list-item');
    if (nav) api.ui.mainWindow.closeComponent(ID);
  };
  document.addEventListener('click', leave, true);
  document.addEventListener('keydown', leave, true);
  cleanup.push(() => { document.removeEventListener('click', leave, true); document.removeEventListener('keydown', leave, true); });

  // Roam can't list a graph's stored files, so the extension notes the files it sees in blocks, to
  // know later which of them no block uses any more. A scan when Roam is idle, then now and then.
  // Reading the graph holds Roam up for a moment (about 0.5 ms per 1,000 blocks), so a scan nobody
  // asked for waits until nothing has been typed or clicked for a few seconds.
  let lastInput = Date.now(), waiting = 0;
  const input = () => { lastInput = Date.now(); };
  for (const type of ['keydown', 'pointerdown', 'wheel']) document.addEventListener(type, input, { capture: true, passive: true });
  const quietScan = () => {
    clearTimeout(waiting);
    const busy = QUIET_MS - (Date.now() - lastInput);
    if (busy > 0) { waiting = window.setTimeout(quietScan, busy); return; }
    if (!document.hidden) app.scan().catch(() => {});
  };
  const first = setTimeout(quietScan, 8000);
  const timer = setInterval(quietScan, RESCAN_MS);
  cleanup.push(() => {
    clearTimeout(first); clearInterval(timer); clearTimeout(waiting);
    for (const type of ['keydown', 'pointerdown', 'wheel']) document.removeEventListener(type, input, { capture: true });
    closeStore();
  });
}

function onunload() {
  for (const f of cleanup.splice(0).reverse()) { try { f(); } catch (e) { console.warn('[roam-file-manager]', e); } }
}

export default { onload, onunload };
