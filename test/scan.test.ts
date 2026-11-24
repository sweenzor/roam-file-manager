import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propStrings, keysInUse, pdfKeys } from '../src/scan.ts';

const U = (id: string, g = 'g') => `https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/o/imgs%2Fapp%2F${g}%2F${id}?alt=media&token=t-${id}`;
const K = (id: string) => `imgs/app/g/${id}`;

test('props: every string and key, except the saved image sizes', () => {
  const props = {
    ':image-size': { [U('old.png')]: { ':width': 200, ':height': null } },
    ':excalidraw': { ':files': { ':f1': { ':dataURL': U('drawn.png') } }, ':elements': [{ ':link': U('linked.pdf') }, 7, null] },
    [U('as-key.png')]: true,
  };
  const all = propStrings(props).join('\n');
  for (const id of ['drawn.png', 'linked.pdf', 'as-key.png']) assert.ok(all.includes(U(id)), id);
  assert.ok(!all.includes(U('old.png')));
  // the key without its colon, as q returns it
  assert.deepEqual(propStrings({ 'image-size': { [U('old.png')]: {} } }), []);
  // image sizes are skipped at any depth, and nothing else is
  assert.ok(!propStrings({ a: { ':image-size': { [U('old.png')]: {} } } }).join().includes('old.png'));
  assert.deepEqual(propStrings(null), []);
  assert.deepEqual(propStrings('x'), ['x']);
});

/** A graph of blocks { uid, string, props } and PDF pages, behind the three calls the scan makes. */
function fakeRoam(blocks: { uid: string; string?: string; props?: any }[], pdfUrls: string[], fail = '') {
  const queries: string[] = [];
  const q = async (query: string) => {
    queries.push(query);
    if (fail && query.includes(fail)) throw new Error('query failed');
    if (query.includes(':pdf/url')) return pdfUrls;
    if (query.includes(':block/props')) return blocks.filter((b) => b.props && JSON.stringify(b.props).includes('firebasestorage.googleapis.com')).map((b) => b.uid);
    if (query.includes(':block/string')) return blocks.filter((b) => b.string?.includes('firebasestorage.googleapis.com')).map((b) => b.uid);
    throw new Error(`unexpected query ${query}`);
  };
  const pull_many = (_pattern: string, ids: [string, string][]) => ids.map(([, uid]) => {
    const b = blocks.find((x) => x.uid === uid)!;
    return { ':block/uid': uid, ':block/string': b.string, ':create/time': 1, ':block/page': { ':block/uid': 'p', ':node/title': 'P' }, ':block/props': b.props };
  });
  (globalThis as any).window = { roamAlphaAPI: { graph: { type: 'hosted' }, data: { async: { q }, pull_many } } };
  return queries;
}

test('the look before a delete: block text, PDF pages and block props, but not saved image sizes', async () => {
  const queries = fakeRoam([
    { uid: 'a', string: `![](${U('in-text.png')})` },
    { uid: 'b', string: 'a drawing', props: { ':excalidraw': { ':files': { ':f': { ':dataURL': U('drawn.png') } } } } },
    { uid: 'c', string: 'resized once', props: { ':image-size': { [U('sized.png')]: { ':width': 1 } } } },
    { uid: 'd', string: 'no file', props: { ':other': 1 } },
  ], [U('paper.pdf')]);
  const quick = await keysInUse(false);
  assert.deepEqual([...quick.text], [K('in-text.png')]);
  assert.equal(quick.other.size, 0);
  assert.ok(queries.every((x) => !x.includes(':pdf/url') && !x.includes(':block/props')), 'the quick look reads block text only');
  const thorough = await keysInUse(true);
  assert.deepEqual([...thorough.text], [K('in-text.png')]);
  assert.deepEqual([...thorough.other].sort(), [K('drawn.png'), K('paper.pdf')]);
  assert.ok(queries.every((x) => !x.includes('[_ ?a ?v]')), 'no query walks every value in the graph');
  assert.deepEqual([...await pdfKeys()], [K('paper.pdf')]);
});

test('a look that fails says so: nothing is taken for unused', async () => {
  fakeRoam([{ uid: 'a', string: `![](${U('in-text.png')})` }], [], ':block/props');
  await assert.rejects(keysInUse(true));
  fakeRoam([], [], ':pdf/url');
  await assert.rejects(keysInUse(true));
});
