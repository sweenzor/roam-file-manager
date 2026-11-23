import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, map, kw, sym, list } from '../src/transit.ts';

test('writes what Roam\'s page sends its desktop app', () => {
  const tx = [list(sym('roam.electron/delete-graph-file'), map({ 'relemma/graph-name': 'g', 'roam.files/file-id': 'id' }))];
  assert.equal(JSON.stringify(map({ 'pathom/tx': tx })), '["^ ","~:pathom/tx",[["~#list",["~$roam.electron/delete-graph-file",["^ ","~:relemma/graph-name","g","~:roam.files/file-id","id"]]]]]');
  assert.equal(kw('a/b'), '~:a/b');
});

test('reads maps, keywords, symbols and the cache', () => {
  const text = JSON.stringify(['^ ', '~:com.wsscode.async.processing/response-id', '~u1234',
    '~:com.wsscode.async.processing/request-response', ['^ ', '~:roam.files/graph-files', ['^ ',
      '~:abc', ['^ ', '~:name', 'abc.png', '~:size', 10, '~:upload-t', 1700000000000, '~:download-url', 'local-asset://g/abc.png', '~:mime-type', 'image/png'],
      '~:def', ['^ ', '^4', 'def.pdf', '^5', 20, '^6', 1, '^7', 'local-asset://g/def.pdf']]]]);
  const m = read(text);
  const files = m['com.wsscode.async.processing/request-response']['roam.files/graph-files'];
  assert.deepEqual(files.abc, { name: 'abc.png', size: 10, 'upload-t': 1700000000000, 'download-url': 'local-asset://g/abc.png', 'mime-type': 'image/png' });
  assert.deepEqual(files.def, { name: 'def.pdf', size: 20, 'upload-t': 1, 'download-url': 'local-asset://g/def.pdf' });
  assert.deepEqual(read(JSON.stringify(['^ ', '~$roam.electron/delete-graph-file', ['^ ', '~:roam.files/deleted', true]])), { 'roam.electron/delete-graph-file': { 'roam.files/deleted': true } });
  assert.equal(read('["~#\'","~i42"]'), 42);
});

test('reads the file list Roam\'s desktop app sent (recorded in a local graph, Roam 0.0.42)', () => {
  const m = read("[\"^ \",\"~:com.wsscode.async.processing/response-id\",\"~u6d134ae1-7419-4805-8906-b80c7b263dd3\",\"~:com.wsscode.async.processing/request-response\",[\"^ \",\"~:roam.files/graph-files\",[\"^ \",\"~:8tTlPQqIdO\",[\"^ \",\"~:name\",\"8tTlPQqIdO.csv\",\"~:extension\",\".csv\",\"~:size\",1083,\"~:upload-t\",1795464831595,\"~:download-url\",\"local-asset://rfm-probe-mwtpe8rx/8tTlPQqIdO.csv\"],\"~:98F5nw4puY\",[\"^ \",\"^4\",\"98F5nw4puY.mp4\",\"^5\",\".mp4\",\"^6\",314597,\"^7\",1795464831669,\"^8\",\"local-asset://rfm-probe-mwtpe8rx/98F5nw4puY.mp4\",\"~:mime-type\",\"video/mp4\"],\"~:CsbUWLFAT3\",[\"^ \",\"^4\",\"CsbUWLFAT3.pdf\",\"^5\",\".pdf\",\"^6\",98981,\"^7\",1795464831576,\"^8\",\"local-asset://rfm-probe-mwtpe8rx/CsbUWLFAT3.pdf\",\"^:\",\"application/pdf\"],\"~:OwhvjgajGm\",[\"^ \",\"^4\",\"OwhvjgajGm.png\",\"^5\",\".png\",\"^6\",98593,\"^7\",1795464831555,\"^8\",\"local-asset://rfm-probe-mwtpe8rx/OwhvjgajGm.png\",\"^:\",\"image/png\"],\"~:Y2v4KBjqYr\",[\"^ \",\"^4\",\"Y2v4KBjqYr.wav\",\"^5\",\".wav\",\"^6\",288044,\"^7\",1795464831632,\"^8\",\"local-asset://rfm-probe-mwtpe8rx/Y2v4KBjqYr.wav\",\"^:\",\"audio/vnd.wave\"]]]]");
  const files = m['com.wsscode.async.processing/request-response']['roam.files/graph-files'];
  assert.deepEqual(Object.keys(files).sort(), ['8tTlPQqIdO', '98F5nw4puY', 'CsbUWLFAT3', 'OwhvjgajGm', 'Y2v4KBjqYr']);
  assert.deepEqual(files.OwhvjgajGm, { name: 'OwhvjgajGm.png', extension: '.png', size: 98593, 'upload-t': 1795464831555, 'download-url': 'local-asset://rfm-probe-mwtpe8rx/OwhvjgajGm.png', 'mime-type': 'image/png' });
  assert.equal(files['8tTlPQqIdO']['mime-type'], undefined);
});
