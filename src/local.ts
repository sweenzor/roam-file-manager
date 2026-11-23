// A local graph's files, through Roam's desktop app. The app keeps a local graph's uploads on the
// computer, and its main process answers Roam's page about them: the list of a graph's files (what
// Roam's own Settings > Attachments shows) and deleting one (what its delete button does). Roam's
// page asks with window.postMessage, Transit-encoded, and the app answers the same way; this asks
// exactly as Roam's page does. roamAlphaAPI.file.delete refuses local graphs ("delete-file is not
// available for offline graphs"), so this is the only way to delete one of their files.
import { kw, map, list, sym, read } from './transit.ts';

const TO_MAIN = 'roam-electron-renderer-message-to-main';
const FROM_MAIN = 'roam-electron-main-message-to-renderer';
const WAIT = 15000;

/** Roam's own test for its desktop app. */
export const isDesktop = () => typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

/** One request to the desktop app's main process: `entity` is what the request is about, `tx` what to read or do. */
function ask(entity: Record<string, unknown>, tx: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const done = () => { clearTimeout(timer); window.removeEventListener('message', on); };
    const timer = window.setTimeout(() => { done(); reject(new Error('Roam\'s desktop app did not answer')); }, WAIT);
    function on(e: MessageEvent) {
      const d = e.data;
      if (e.source !== window || d?.msgType !== FROM_MAIN || typeof d.dataInTransit !== 'string' || !d.dataInTransit.includes(id)) return;
      done();
      try {
        const m = read(d.dataInTransit);
        const res = m?.['com.wsscode.async.processing/request-response'];
        if (res?.['relemma.foreign.events/error'] || res == null) reject(new Error(String(res?.message ?? 'no answer')));
        else resolve(res);
      } catch (err) { reject(err); }
    }
    window.addEventListener('message', on);
    const msg = map({
      'relemma.foreign.events/command': kw('relemma.foreign.events/api-request'),
      'relemma.foreign.events/value': map({ 'pathom/tx': tx, 'pathom/entity': map(entity) }),
      'com.wsscode.async.processing/request-id': `~u${id}`,
    });
    window.postMessage({ msgType: TO_MAIN, dataInTransit: JSON.stringify(msg) }, '*');
  });
}

export interface LocalFile { name: string; size: number; created: number; type: string | null; url: string }

/** Every file stored for the local graph `graph`, by stored file name (<id>.<ext>). */
export async function listGraphFiles(graph: string): Promise<Map<string, LocalFile>> {
  const res = await ask({ 'relemma/graph-name': graph }, [kw('roam.files/graph-files')]);
  const files = res['roam.files/graph-files'];
  if (!files || typeof files !== 'object') throw new Error('Roam\'s desktop app sent no file list');
  const out = new Map<string, LocalFile>();
  for (const f of Object.values<any>(files)) {
    if (typeof f?.name !== 'string' || typeof f['download-url'] !== 'string') continue;
    out.set(f.name, { name: f.name, size: +f.size || 0, created: +f['upload-t'] || 0, type: f['mime-type'] ?? null, url: f['download-url'] });
  }
  return out;
}

/** Deletes a local graph's file by its upload id. True when the app deleted it, false when it wasn't there. */
export async function deleteGraphFile(graph: string, id: string): Promise<boolean> {
  const op = 'roam.electron/delete-graph-file';
  const res = await ask({ 'relemma/graph-name': graph }, [list(sym(op), map({ 'relemma/graph-name': graph, 'roam.files/file-id': id }))]);
  return res?.[op]?.['roam.files/deleted'] === true;
}
