// Reads the graph: every block whose text holds a Roam-hosted file URL, with its page.
import { collect, findRefs, storageKey, type BlockRow, type FileEntry } from './files.ts';

const NEEDLE = 'firebasestorage.googleapis.com';
// Which blocks hold a file: the one step that has to look at every block's text.
const FIND = `[:find [?uid ...]
  :where [?b :block/string ?s]
         [(clojure.string/includes? ?s "${NEEDLE}")]
         [?b :block/uid ?uid]]`;
const BLOCK = '[:block/uid :block/string :create/time {:block/page [:block/uid :node/title]}]';
const CHUNK = 100;

const pause = () => new Promise<void>((r) => setTimeout(r));

/** The uids of the blocks whose text holds a file URL.
 *
 *  Asked of Roam's backend (roamAlphaAPI.data.backend.q, "runs against the backend, off thread"), so
 *  Roam's window doesn't stop while a large graph is searched: the same search in the window takes
 *  about 0.5 ms per 1,000 blocks, all of it with Roam frozen. Roam itself runs the query in the window
 *  when the graph has no backend or it can't be reached (encrypted, local, offline). */
async function fileBlocks(known: boolean, inWindow: boolean): Promise<string[]> {
  const d = (window as any).roamAlphaAPI.data;
  const local = async (): Promise<string[]> => (d.async?.q ? await d.async.q(FIND) : d.q(FIND)) ?? [];
  if (inWindow || !d.backend?.q) return local();
  let uids: string[] | null = null;
  try { uids = await d.backend.q(FIND); } catch { /* the window can still answer */ }
  // no answer, or none where files were found before: don't take the backend's word for it
  if (!Array.isArray(uids) || (uids.length === 0 && known)) return local();
  return uids;
}

/** True when Roam's backend can answer for this graph, so the window isn't the one that searches it. */
export const hasBackend = (): boolean => {
  const api = (window as any).roamAlphaAPI;
  return !!api.data.backend?.q && api.graph?.type === 'hosted' && !api.graph?.isEncrypted;
};

/** Every block that holds a file, with its page. `known`: files have been found in this graph before.
 *  `inWindow`: search in the window whatever the graph, for an answer that can't be a moment behind.
 *
 *  The blocks themselves are read in the window, a hundred at a time with a pause between, so what
 *  is listed is what the graph holds now: a block the backend named that is gone is left out. */
export async function scanGraph(known = false, inWindow = false): Promise<Map<string, FileEntry>> {
  const d = (window as any).roamAlphaAPI.data;
  const uids = await fileBlocks(known, inWindow);
  const rows: BlockRow[] = [];
  for (let i = 0; i < uids.length; i += CHUNK) {
    if (i) await pause();
    for (const b of d.pull_many(BLOCK, uids.slice(i, i + CHUNK).map((u) => [':block/uid', u])) ?? []) {
      const page = b?.[':block/page'];
      if (typeof b?.[':block/string'] !== 'string' || !page?.[':block/uid'] || page[':node/title'] == null) continue;
      rows.push({ uid: b[':block/uid'], text: b[':block/string'], time: b[':create/time'] ?? 0, pageUid: page[':block/uid'], pageTitle: page[':node/title'] });
    }
  }
  return collect(rows);
}


// Every value in the graph that holds a Roam-hosted file URL, whatever attribute it is in: block
// text, page titles, and anything else Roam or an extension stores (Roam keeps a PDF's URL in a
// :url attribute, for one). Block props are left out: Roam records the size of a resized image
// there under its URL and keeps that after the image is gone from the block, so it isn't a use.
// Much slower than the block query, so it runs only as the last check before a delete.
const ANYWHERE = `[:find ?s
  :where [_ ?a ?v] [(not= ?a :block/props)]
         [(str ?v) ?s]
         [(clojure.string/includes? ?s "firebasestorage.googleapis.com")]]`;

/** The storage paths of every file whose URL is anywhere in the graph. */
export async function keysAnywhere(): Promise<Set<string>> {
  const api = (window as any).roamAlphaAPI;
  const keys = new Set((await scanGraph(false, true)).keys());
  const rows: [string][] = api.data.async?.q ? await api.data.async.q(ANYWHERE) : api.data.q(ANYWHERE);
  for (const [text] of rows) for (const r of findRefs(text)) { const k = storageKey(r.url); if (k) keys.add(k); }
  return keys;
}
