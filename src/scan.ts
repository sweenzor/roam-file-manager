// Reads the graph: every block whose text holds a Roam-hosted file URL, with its page.
import { collect, findRefs, storageKey, type BlockRow, type FileEntry } from './files.ts';

const QUERY = `[:find ?uid ?s ?ct ?pu ?pt
  :where [?b :block/string ?s]
         [(clojure.string/includes? ?s "firebasestorage.googleapis.com")]
         [?b :block/uid ?uid]
         [(get-else $ ?b :create/time 0) ?ct]
         [?b :block/page ?p] [?p :block/uid ?pu] [?p :node/title ?pt]]`;

export async function scanGraph(): Promise<Map<string, FileEntry>> {
  const api = (window as any).roamAlphaAPI;
  const rows: [string, string, number, string, string][] = api.data.async?.q
    ? await api.data.async.q(QUERY) : api.data.q(QUERY);
  return collect(rows.map(([uid, text, time, pageUid, pageTitle]): BlockRow => ({ uid, text, time, pageUid, pageTitle })));
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
  const keys = new Set((await scanGraph()).keys());
  const rows: [string][] = api.data.async?.q ? await api.data.async.q(ANYWHERE) : api.data.q(ANYWHERE);
  for (const [text] of rows) for (const r of findRefs(text)) { const k = storageKey(r.url); if (k) keys.add(k); }
  return keys;
}
