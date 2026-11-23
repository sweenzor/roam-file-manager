import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefs, storageKey, srcOf, localId, collect, compare, formatSize, kindOf, restOf, type Row, inUseWarning, countText } from '../src/files.ts';

const U = (id: string, g = 'g') => `https://firebasestorage.googleapis.com/v0/b/firescript-577a2.appspot.com/o/imgs%2Fapp%2F${g}%2F${id}?alt=media&token=t-${id}`;

test('finds files in every form Roam writes', () => {
  const s = `![](${U('a.png')}) and {{[[pdf]]: ${U('b.pdf')}}} {{pdf: ${U('c.pdf')}}}\n{{[[audio]]: ${U('d.mp3')}}} [Report Q3.xlsx](${U('e.xlsx')}) <${U('f.txt')}>`;
  const r = findRefs(s);
  assert.deepEqual(r.map((x) => storageKey(x.url)), ['a.png', 'b.pdf', 'c.pdf', 'd.mp3', 'e.xlsx', 'f.txt'].map((f) => `imgs/app/g/${f}`));
  assert.deepEqual(r.map((x) => x.label), [null, null, null, null, 'Report Q3.xlsx', null]);
});

test('keeps encoded spaces and decodes the storage path', () => {
  const url = U('buk9okKVv0.06.37%20PM.png');
  assert.equal(findRefs(`![](${url})`)[0].url, url);
  assert.equal(storageKey(url), 'imgs/app/g/buk9okKVv0.06.37 PM.png');
});

test('an image in a label is not a label', () => {
  assert.equal(findRefs(`![alt](${U('a.png')})`)[0].label, null);
});

test('ignores other links', () => {
  assert.deepEqual(findRefs('see https://example.com/x.png and [a](https://roamresearch.com)'), []);
});

test('groups by storage path across tokens and blocks', () => {
  const files = collect([
    { uid: 'b1', text: `![](${U('a.png')})`, time: 200, pageUid: 'p1', pageTitle: 'One' },
    { uid: 'b2', text: `![](${U('a.png').replace('t-a.png', 'other')}) ![](${U('a.png')})`, time: 100, pageUid: 'p2', pageTitle: 'Two' },
    { uid: 'b3', text: `[notes.txt](${U('XyZ1234567notes.txt')})`, time: 300, pageUid: 'p2', pageTitle: 'Two' },
  ]);
  assert.equal(files.size, 2);
  const a = files.get('imgs/app/g/a.png')!;
  assert.equal(a.added, 100);
  assert.deepEqual(a.uses.map((u) => u.uid), ['b1', 'b2']);
  assert.equal(a.kind, 'image');
  assert.equal(files.get('imgs/app/g/XyZ1234567notes.txt')!.name, 'notes.txt');
});

test('kinds', () => {
  assert.equal(kindOf('jpeg'), 'image');
  assert.equal(kindOf('pdf'), 'pdf');
  assert.equal(kindOf('m4a'), 'audio');
  assert.equal(kindOf('mov'), 'video');
  assert.equal(kindOf('zip'), 'other');
});

test('sorts by date, newest first, and by size with unknown sizes last', () => {
  const row = (key: string, added: number, size: number | null): Row => ({ key, url: '', name: key, ext: 'png', kind: 'image', added, uses: [], size, unused: false, own: true, lastUsed: 0 });
  const rows = [row('a', 1, 10), row('b', 3, null), row('c', 2, 30)];
  assert.deepEqual([...rows].sort(compare('added', true)).map((r) => r.key), ['b', 'c', 'a']);
  assert.deepEqual([...rows].sort(compare('size', true)).map((r) => r.key), ['c', 'a', 'b']);
});

test('sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(null), '');
});

test('what else a block says, without its files', () => {
  assert.equal(restOf(`![](${U('a.png')})`), '');
  assert.equal(restOf(`{{[[pdf]]: ${U('b.pdf')}}} #Deck`), '#Deck');
  assert.equal(restOf(`Logo: ![](${U('a.png')}) for the site`), 'Logo: for the site');
  assert.equal(restOf(`[Report Q3.xlsx](${U('e.xlsx')})`), 'Report Q3.xlsx');
  assert.equal(restOf('x'.repeat(200)).length, 80);
});

test('the delete warning counts the files still in blocks and the blocks they break', () => {
  const use = (uid: string) => ({ uid, pageUid: 'p', pageTitle: 'P', time: 0, text: '' });
  const row = (key: string, kind: Row['kind'], uids: string[]): Row => ({ key, url: '', name: key, ext: 'x', kind, added: 0, uses: uids.map(use), size: 1, unused: !uids.length, own: true, lastUsed: 0 });
  assert.equal(inUseWarning([row('a', 'image', [])]), '');
  assert.equal(inUseWarning([row('a', 'image', ['b1'])]), 'This file is still referenced in 1 block, which will be left with a broken image.');
  assert.equal(inUseWarning([row('a', 'pdf', ['b1', 'b2'])]), 'This file is still referenced in 2 blocks, which will be left with broken links.');
  assert.equal(inUseWarning([row('a', 'image', ['b1']), row('b', 'video', ['b1', 'b2'])]), 'These files are still referenced in 2 blocks, which will be left with broken images and links.');
  assert.equal(inUseWarning([row('a', 'image', ['b1']), row('b', 'image', []), row('c', 'image', [])]), '1 of these files is still referenced in 1 block, which will be left with a broken image.');
  assert.equal(inUseWarning([row('a', 'image', ['b1']), row('b', 'image', ['b2']), row('c', 'image', [])]), '2 of these files are still referenced in 2 blocks, which will be left with broken images.');
});

test('the count in the toolbar', () => {
  assert.equal(countText(529, 529), '529 Files');
  assert.equal(countText(1, 1), '1 File');
  assert.equal(countText(0, 0), '0 Files');
  assert.equal(countText(12, 529), '12 / 529 Files');
  assert.equal(countText(0, 1), '0 / 1 File');
  assert.equal(countText(1200, 12345), '1,200 / 12,345 Files');
});

// ---------- local graphs ----------
const L = (file: string, g = 'my-local') => `local-asset://${g}/${file}`;

test('finds a local graph\'s files in every form Roam writes', () => {
  const s = `![](${L('fWGmbK9_OS.png')}) {{[[pdf]]: ${L('Ab12345678.pdf')}}} [notes.txt](${L('Cd12345678.txt')}) {{[[video]]: ${L('Ef12345678.webm')}}}`;
  const r = findRefs(s);
  assert.deepEqual(r.map((x) => storageKey(x.url)), ['fWGmbK9_OS.png', 'Ab12345678.pdf', 'Cd12345678.txt', 'Ef12345678.webm'].map((f) => `local-asset/my-local/${f}`));
  assert.deepEqual(r.map((x) => x.label), [null, null, 'notes.txt', null]);
  assert.equal(restOf(`look ![](${L('a.png')}) here`), 'look here');
});

test('hosted and local files side by side are kept apart', () => {
  const files = collect([{ uid: 'b', text: `![](${U('a.png')}) ![](${L('a.png')})`, time: 1, pageUid: 'p', pageTitle: 'P' }]);
  assert.deepEqual([...files.keys()], ['imgs/app/g/a.png', 'local-asset/my-local/a.png']);
});

test('a local file is drawn from Roam\'s desktop app server', () => {
  assert.equal(srcOf(L('x.png')), 'http://127.0.0.1:3333/local-asset/my-local/x.png');
  assert.equal(srcOf(L('x.png'), '4444'), 'http://127.0.0.1:4444/local-asset/my-local/x.png');
  assert.equal(srcOf(U('a.png')), U('a.png'));
  assert.equal(localId('local-asset/my-local/fWGmbK9_OS.png'), 'fWGmbK9_OS');
});
