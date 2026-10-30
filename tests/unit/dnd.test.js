const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../../extension/lib/model.js');
const { zoneFor, resolveDrop } = require('../../extension/content/dnd.js');

/**
 *   root: A, P1
 *   A (open): B, P2
 *   B (open, empty)
 */
function makeDoc() {
  const doc = M.emptyDoc();
  doc.root = ['A', 'P1'];
  doc.folders = {
    A: { name: 'A', open: true, children: ['B', 'P2'] },
    B: { name: 'B', open: true, children: [] },
  };
  doc.playlists = {
    P1: { title: 'One', open: true, items: [{ videoId: 'v1' }, { videoId: 'v2' }] },
    P2: { title: 'Two', open: false, items: [] },
  };
  doc.videos = { v1: { id: 'v1' }, v2: { id: 'v2' } };
  return doc;
}

const folderA = { kind: 'folder', id: 'A', parent: 'root', index: 0, open: true };
const folderB = { kind: 'folder', id: 'B', parent: 'A', index: 0, open: true };
const playlist1 = { kind: 'playlist', id: 'P1', parent: 'root', index: 1, open: true };
const playlist2 = { kind: 'playlist', id: 'P2', parent: 'A', index: 1, open: false };
const video1 = { kind: 'video', playlist: 'P1', index: 0 };

test('zoneFor splits rows into before / inside / after', () => {
  assert.equal(zoneFor('folder', 'playlist', 0.1), 'before');
  assert.equal(zoneFor('folder', 'playlist', 0.5), 'inside');
  assert.equal(zoneFor('folder', 'folder', 0.9), 'after');
  assert.equal(zoneFor('playlist', 'folder', 0.2), 'before');
  assert.equal(zoneFor('playlist', 'playlist', 0.8), 'after');
  assert.equal(zoneFor('playlist', 'video', 0.2), 'inside');
  assert.equal(zoneFor('video', 'video', 0.2), 'before');
  assert.equal(zoneFor('video', 'video', 0.7), 'after');
  assert.equal(zoneFor('video', 'playlist', 0.5), null);
  assert.equal(zoneFor('folder', 'video', 0.5), null);
  assert.equal(zoneFor('empty', 'video', 0.5), 'inside');
});

test('folders and playlists can be dropped into folders and next to rows', () => {
  const doc = makeDoc();
  const p1 = { kind: 'playlist', id: 'P1' };
  assert.deepEqual(resolveDrop(doc, p1, folderB, 'inside'), { type: 'node', parent: 'B', index: 0 });
  assert.deepEqual(resolveDrop(doc, p1, playlist2, 'before'), { type: 'node', parent: 'A', index: 1 });
  assert.deepEqual(resolveDrop(doc, p1, playlist2, 'after'), { type: 'node', parent: 'A', index: 2 });
  assert.deepEqual(resolveDrop(doc, p1, folderA, 'before'), { type: 'node', parent: 'root', index: 0 });
  assert.deepEqual(resolveDrop(doc, p1, { kind: 'end' }, 'inside'), { type: 'node', parent: 'root', index: 2 });
  assert.deepEqual(resolveDrop(doc, p1, { kind: 'empty', container: 'B' }, 'inside'), { type: 'node', parent: 'B', index: 0 });
});

test('just below an open folder with children means "first inside it"', () => {
  const doc = makeDoc();
  assert.deepEqual(resolveDrop(doc, { kind: 'playlist', id: 'P1' }, folderA, 'after'), { type: 'node', parent: 'A', index: 0 });
  // An open but empty folder: "after" really is after it.
  assert.deepEqual(resolveDrop(doc, { kind: 'playlist', id: 'P1' }, folderB, 'after'), { type: 'node', parent: 'A', index: 1 });
});

test('a folder cannot be dropped onto itself or into its own subfolders', () => {
  const doc = makeDoc();
  const a = { kind: 'folder', id: 'A' };
  assert.equal(resolveDrop(doc, a, folderA, 'inside'), null);
  assert.equal(resolveDrop(doc, a, folderB, 'inside'), null);
  assert.equal(resolveDrop(doc, a, playlist2, 'before'), null, 'P2 lives inside A');
  assert.equal(resolveDrop(doc, a, { kind: 'empty', container: 'B' }, 'inside'), null);
  assert.deepEqual(resolveDrop(doc, a, playlist1, 'after'), { type: 'node', parent: 'root', index: 2 });
});

test('folders and playlists cannot be dropped among videos', () => {
  const doc = makeDoc();
  assert.equal(resolveDrop(doc, { kind: 'playlist', id: 'P2' }, video1, 'before'), null);
  assert.equal(resolveDrop(doc, { kind: 'folder', id: 'B' }, { kind: 'empty', container: 'P2' }, 'inside'), null);
  assert.equal(resolveDrop(doc, { kind: 'playlist', id: 'P2' }, playlist1, 'inside'), null);
});

test('videos go into playlists, before or after other videos', () => {
  const doc = makeDoc();
  const v2 = { kind: 'video', playlist: 'P1', index: 1 };
  assert.deepEqual(resolveDrop(doc, v2, video1, 'before'), { type: 'video', playlist: 'P1', index: 0 });
  assert.deepEqual(resolveDrop(doc, v2, video1, 'after'), { type: 'video', playlist: 'P1', index: 1 });
  assert.deepEqual(resolveDrop(doc, v2, playlist2, 'inside'), { type: 'video', playlist: 'P2', index: 0 });
  assert.deepEqual(resolveDrop(doc, v2, playlist1, 'inside'), { type: 'video', playlist: 'P1', index: 2 });
  assert.deepEqual(resolveDrop(doc, v2, { kind: 'empty', container: 'P2' }, 'inside'), { type: 'video', playlist: 'P2', index: 0 });
  assert.equal(resolveDrop(doc, v2, folderA, 'inside'), null);
  assert.equal(resolveDrop(doc, v2, { kind: 'end' }, 'inside'), null);
  assert.equal(resolveDrop(doc, v2, { kind: 'empty', container: 'B' }, 'inside'), null);
});

test('resolved drops apply cleanly to the model', () => {
  const doc = makeDoc();
  const drop = resolveDrop(doc, { kind: 'playlist', id: 'P1' }, playlist2, 'before');
  assert.equal(M.moveNode(doc, 'P1', drop.parent, drop.index), true);
  assert.deepEqual(doc.root, ['A']);
  assert.deepEqual(doc.folders.A.children, ['B', 'P1', 'P2']);

  const videoDrop = resolveDrop(doc, { kind: 'video', playlist: 'P1', index: 0 }, { kind: 'video', playlist: 'P1', index: 1 }, 'after');
  assert.equal(M.moveVideo(doc, 'P1', 0, videoDrop.playlist, videoDrop.index), true);
  assert.deepEqual(doc.playlists.P1.items.map((i) => i.videoId), ['v2', 'v1']);
  assert.deepEqual(M.validate(doc), []);
});
