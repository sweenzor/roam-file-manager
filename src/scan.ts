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


/** Every string in a block's props, keys included, except Roam's saved image sizes: Roam records the
 *  size of a resized image there under its URL and keeps that after the image is gone from the block,
 *  so it isn't a use. */
export function propStrings(v: any, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (k === ':image-size' || k === 'image-size') continue;
    out.push(k);
    propStrings(x, out);
  }
  return out;
}

const run = async (query: string): Promise<any[]> => {
  const d = (window as any).roamAlphaAPI.data;
  return (d.async?.q ? await d.async.q(query) : d.q(query)) ?? [];
};
const keysOf = (text: unknown, into: Set<string>) => {
  if (typeof text !== 'string') return;
  for (const r of findRefs(text)) { const k = storageKey(r.url); if (k) into.add(k); }
};

/** The files a PDF page still draws from: Roam keeps a PDF's address in :pdf/url, and goes on rendering
 *  from it after the {{pdf}} block is gone. Reads that one attribute only, by its index. */
export async function pdfKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const u of await run('[:find [?u ...] :where [_ :pdf/url ?u]]')) keysOf(u, keys);
  return keys;
}

/** The files block props hold, except under :image-size: an Excalidraw drawing keeps its pictures'
 *  addresses there and nowhere else, and other extensions store what they like. Which blocks: one query
 *  that looks at the props only (few blocks have any). The props themselves: pull_many, which keeps the
 *  keys' namespaces (q drops them), a hundred blocks at a time with a pause between. */
export async function propKeys(): Promise<Set<string>> {
  const d = (window as any).roamAlphaAPI.data;
  const keys = new Set<string>();
  const uids: string[] = await run(`[:find [?uid ...]
  :where [?b :block/props ?p] [(str ?p) ?s] ${holds('?s')} [?b :block/uid ?uid]]`);
  for (let i = 0; i < uids.length; i += CHUNK) {
    await pause();
    const blocks = d.pull_many('[:block/props]', uids.slice(i, i + CHUNK).map((u) => [':block/uid', u])) ?? [];
    for (const b of blocks) for (const text of propStrings(b?.[':block/props'])) keysOf(text, keys);
  }
  return keys;
}

/** Storage paths still in use: `text` in block text (a mention), `other` outside it (a PDF page or block
 *  props, such as a drawing). `thorough` looks outside block text; without it `other` is empty. */
export async function keysInUse(thorough: boolean): Promise<{ text: Set<string>; other: Set<string> }> {
  const text = new Set((await scanGraph()).keys());
  const other = new Set<string>();
  if (thorough) for (const k of [...await pdfKeys(), ...await propKeys()]) other.add(k);
  return { text, other };
}
