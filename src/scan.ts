// Reads the graph: every block whose text holds an uploaded file's address, with its page.
import { collect, findRefs, storageKey, NEEDLES, type BlockRow, type FileEntry } from './files.ts';

/** A hosted graph's uploads are in Firebase Storage. A local graph's are on the computer
 *  (local-asset://), and it can hold hosted ones too, pasted or imported from a hosted graph. */
const isLocalGraph = () => (window as any).roamAlphaAPI.graph?.type === 'offline';
const holds = (v: string) => (isLocalGraph()
  ? `(or [(clojure.string/includes? ${v} "${NEEDLES.hosted}")] [(clojure.string/includes? ${v} "${NEEDLES.local}")])`
  : `[(clojure.string/includes? ${v} "${NEEDLES.hosted}")]`);
// Which blocks hold a file: the one step that has to look at every block's text.
const find = () => `[:find [?uid ...]
  :where [?b :block/string ?s]
         ${holds('?s')}
         [?b :block/uid ?uid]]`;
const BLOCK = '[:block/uid :block/string :create/time {:block/page [:block/uid :node/title]}]';
const CHUNK = 100;

const pause = () => new Promise<void>((r) => setTimeout(r));

/** Every block that holds a file, with its page.
 *
 *  Finding which blocks is the one step that reads every block's text, and Roam's window does nothing
 *  else while it runs: about 0.5 ms per 1,000 blocks (measured). So that query asks for nothing but
 *  the blocks' uids, and the blocks themselves are then read a hundred at a time with a pause between.
 *  (One query for everything took four times as long in one piece.)
 *
 *  Roam's backend can run the query off the window's thread (roamAlphaAPI.data.backend.q), but it
 *  answers from its own copy of the graph, which can be behind the window's, and takes 0.3 s or more
 *  to answer. A list of files has to show the graph as it is now, so the window does the search. */
export async function scanGraph(): Promise<Map<string, FileEntry>> {
  const d = (window as any).roamAlphaAPI.data;
  const FIND = find();
  const uids: string[] = (d.async?.q ? await d.async.q(FIND) : d.q(FIND)) ?? [];
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


// Every value in the graph that holds an uploaded file's address, whatever attribute it is in: block
// text, page titles, and anything else Roam or an extension stores (Roam keeps a PDF's URL in a
// :url attribute, for one). Block props are left out: Roam records the size of a resized image
// there under its URL and keeps that after the image is gone from the block, so it isn't a use.
// Much slower than the block query, so it runs only as the last check before a delete.
const anywhere = () => `[:find ?s
  :where [_ ?a ?v] [(not= ?a :block/props)]
         [(str ?v) ?s]
         ${holds('?s')}]`;

/** The storage paths of every file whose URL is anywhere in the graph. */
export async function keysAnywhere(): Promise<Set<string>> {
  const api = (window as any).roamAlphaAPI;
  const keys = new Set((await scanGraph()).keys());
  const ANYWHERE = anywhere();
  const rows: [string][] = api.data.async?.q ? await api.data.async.q(ANYWHERE) : api.data.q(ANYWHERE);
  for (const [text] of rows) for (const r of findRefs(text)) { const k = storageKey(r.url); if (k) keys.add(k); }
  return keys;
}
