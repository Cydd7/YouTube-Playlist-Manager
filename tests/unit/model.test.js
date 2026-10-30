const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../../extension/lib/model.js');

const SAMPLE = path.join(__dirname, '../../samples/sample-backup.json');

const video = (id, extra = {}) => ({ id, snippet: { title: `Video ${id}`, channelTitle: 'Chan' }, ...extra });
const playlist = (title, videoIds) => ({ title, open: false, items: videoIds.map((videoId) => ({ videoId })) });

/**
 *   root: A, P1
 *   A (open): B, P2
 *   B (closed): P3
 */
function makeDoc() {
  const doc = M.emptyDoc();
  doc.root = ['A', 'P1'];
  doc.folders = {
    A: { name: 'A', open: true, children: ['B', 'P2'] },
    B: { name: 'B', open: false, children: ['P3'] },
  };
  doc.playlists = {
    P1: playlist('One', ['v1', 'v2', 'v3']),
    P2: playlist('Two', ['v4']),
    P3: playlist('Three', []),
  };
  doc.videos = { v1: video('v1'), v2: video('v2'), v3: video('v3'), v4: video('v4') };
  return doc;
}

const items = (doc, id) => doc.playlists[id].items.map((i) => i.videoId);

test('an empty document and the sample backup are valid', () => {
  assert.deepEqual(M.validate(M.emptyDoc()), []);
  assert.deepEqual(M.validate(makeDoc()), []);
  const sample = M.parseBackup(fs.readFileSync(SAMPLE, 'utf8'));
  assert.equal(M.docStats(sample).playlists, 5);
});

test('addFolder adds at the top level or inside a folder and opens the parent', () => {
  const doc = makeDoc();
  const top = M.addFolder(doc);
  assert.match(top, /^fld_[a-z0-9]{8}$/);
  assert.equal(doc.root.at(-1), top);
  assert.equal(doc.folders[top].name, 'New folder');

  const inner = M.addFolder(doc, 'B', '  Deep   one ');
  assert.deepEqual(doc.folders.B.children, ['P3', inner]);
  assert.equal(doc.folders[inner].name, 'Deep one');
  assert.equal(doc.folders.B.open, true);
  assert.deepEqual(M.validate(doc), []);

  assert.throws(() => M.addFolder(doc, 'P1'));
});

test('renameFolder cleans the name and ignores empty or unchanged names', () => {
  const doc = makeDoc();
  assert.equal(M.renameFolder(doc, 'A', '  Music\n videos '), true);
  assert.equal(doc.folders.A.name, 'Music videos');
  assert.equal(M.renameFolder(doc, 'A', '   '), false);
  assert.equal(doc.folders.A.name, 'Music videos');
  assert.equal(M.renameFolder(doc, 'A', 'Music videos'), false);
  assert.equal(M.renameFolder(doc, 'P1', 'x'), false);
});

test('deleteFolder moves its contents into the parent where the folder was', () => {
  const doc = makeDoc();
  assert.deepEqual(M.deleteFolder(doc, 'A'), { parent: 'root', moved: 2 });
  assert.deepEqual(doc.root, ['B', 'P2', 'P1']);
  assert.equal(M.isFolder(doc, 'A'), false);

  assert.deepEqual(M.deleteFolder(doc, 'B'), { parent: 'root', moved: 1 });
  assert.deepEqual(doc.root, ['P3', 'P2', 'P1']);
  assert.deepEqual(M.validate(doc), []);
  assert.equal(M.deleteFolder(doc, 'nope'), null);
});

test('moveNode reorders, nests and refuses moves into a playlist or into itself', () => {
  const doc = makeDoc();
  assert.equal(M.moveNode(doc, 'P1', 'root', 0), true);
  assert.deepEqual(doc.root, ['P1', 'A']);
  assert.equal(M.moveNode(doc, 'P1', 'root', 2), true);
  assert.deepEqual(doc.root, ['A', 'P1']);
  assert.equal(M.moveNode(doc, 'P1', 'root', 2), false, 'already there');

  assert.equal(M.moveNode(doc, 'P1', 'B', 0), true);
  assert.deepEqual(doc.root, ['A']);
  assert.deepEqual(doc.folders.B.children, ['P1', 'P3']);

  assert.equal(M.moveNode(doc, 'A', 'B'), false, 'a folder cannot go into its own subfolder');
  assert.equal(M.moveNode(doc, 'A', 'A'), false, 'a folder cannot go into itself');
  assert.equal(M.moveNode(doc, 'P2', 'P1'), false, 'playlists do not hold folders or playlists');
  assert.equal(M.moveNode(doc, 'v1', 'root'), false, 'videos are not tree nodes');

  assert.equal(M.moveNode(doc, 'B', 'root'), true);
  assert.deepEqual(doc.root, ['A', 'B']);
  assert.deepEqual(doc.folders.A.children, ['P2']);
  assert.deepEqual(M.validate(doc), []);
});

test('moveVideo reorders within a playlist and moves between playlists', () => {
  const doc = makeDoc();
  assert.equal(M.moveVideo(doc, 'P1', 0, 'P1', 3), true);
  assert.deepEqual(items(doc, 'P1'), ['v2', 'v3', 'v1']);
  assert.equal(M.moveVideo(doc, 'P1', 2, 'P1', 0), true);
  assert.deepEqual(items(doc, 'P1'), ['v1', 'v2', 'v3']);
  assert.equal(M.moveVideo(doc, 'P1', 1, 'P1', 2), false, 'dropping right before the next item is a no-op');

  assert.equal(M.moveVideo(doc, 'P1', 1, 'P2', 0), true);
  assert.deepEqual(items(doc, 'P1'), ['v1', 'v3']);
  assert.deepEqual(items(doc, 'P2'), ['v2', 'v4']);
  assert.equal(M.moveVideo(doc, 'P2', 0, 'P3'), true);
  assert.deepEqual(items(doc, 'P3'), ['v2']);

  assert.equal(M.moveVideo(doc, 'P1', 9, 'P2'), false);
  assert.equal(M.moveVideo(doc, 'P1', 0, 'A'), false);
  assert.deepEqual(M.validate(doc), []);
});

test('setOpen toggles folders and playlists', () => {
  const doc = makeDoc();
  assert.equal(M.setOpen(doc, 'B'), true);
  assert.equal(M.setOpen(doc, 'B'), false);
  assert.equal(M.setOpen(doc, 'P1', true), true);
  assert.equal(M.setOpen(doc, 'missing'), null);
});

test('stats count folders, playlists and videos', () => {
  const doc = makeDoc();
  assert.deepEqual(M.docStats(doc), { folders: 2, playlists: 3, videos: 4 });
  assert.deepEqual(M.folderStats(doc, 'A'), { folders: 1, playlists: 2, videos: 1 });
  assert.deepEqual(M.folderStats(doc, 'B'), { folders: 0, playlists: 1, videos: 0 });
});

test('formatDuration reads ISO 8601 durations', () => {
  assert.equal(M.formatDuration('PT45S'), '0:45');
  assert.equal(M.formatDuration('PT3M5S'), '3:05');
  assert.equal(M.formatDuration('PT1H2M3S'), '1:02:03');
  assert.equal(M.formatDuration('PT2H'), '2:00:00');
  assert.equal(M.formatDuration('P1DT1H'), '25:00:00');
  assert.equal(M.formatDuration('P0D'), '');
  assert.equal(M.formatDuration(undefined), '');
  assert.equal(M.formatDuration('nonsense'), '');
});

test('videoInfo describes available and unavailable videos', () => {
  const doc = makeDoc();
  doc.videos.v1.contentDetails = { duration: 'PT4M' };
  doc.videos.v2 = { id: 'v2', unavailable: true, snippet: { title: 'Deleted video' } };
  assert.deepEqual(M.videoInfo(doc, 'v1'), { title: 'Video v1', channel: 'Chan', duration: '4:00', unavailable: false });
  assert.equal(M.videoInfo(doc, 'v2').unavailable, true);
  assert.equal(M.videoInfo(doc, 'missing').title, 'missing');
});

test('validate reports structural problems', () => {
  const cases = [
    [(d) => { d.format = 'other'; }, /not a YouTube Playlist Manager backup/],
    [(d) => { d.version = 99; }, /newer version/],
    [(d) => { d.root = {}; }, /"root" must be a list/],
    [(d) => { d.folders.A.children.push('ghost'); }, /not a folder or playlist/],
    [(d) => { d.root.push('P2'); }, /appears in more than one place/],
    [(d) => { d.folders.A.children = ['B']; }, /playlist "Two" is not in any folder/],
    [(d) => { d.root = ['P1']; d.folders.B.children.push('A'); }, /inside a loop/],
    [(d) => { d.playlists.A = playlist('Clash', []); }, /both a folder and a playlist/],
    [(d) => { d.playlists.P1.items.push({ videoId: 'nope' }); }, /video "nope" is missing/],
    [(d) => { d.playlists.P1.items.push({}); }, /needs a "videoId"/],
    [(d) => { d.folders.B.name = 5; }, /needs a "name"/],
    [(d) => { d.playlists.P2.open = 'yes'; }, /"open" must be true or false/],
  ];
  for (const [mutate, expected] of cases) {
    const doc = makeDoc();
    mutate(doc);
    const problems = M.validate(doc);
    assert.ok(problems.some((p) => expected.test(p)), `${expected} not in ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(M.validate(null), ['The file does not contain a JSON object.']);
});

test('validate caps a long list of problems', () => {
  const doc = makeDoc();
  for (let i = 0; i < 80; i++) doc.playlists.P1.items.push({ videoId: `missing${i}` });
  const problems = M.validate(doc);
  assert.equal(problems.length, 51);
  assert.match(problems.at(-1), /and 30 more problems/);
});

test('backups round-trip and invalid files are rejected with reasons', () => {
  const doc = makeDoc();
  const backup = M.toBackup(doc, new Date('2026-01-02T03:04:05Z'));
  assert.equal(backup.exportedAt, '2026-01-02T03:04:05.000Z');
  const restored = M.parseBackup(JSON.stringify(backup));
  assert.deepEqual(restored, doc);

  assert.throws(() => M.parseBackup('{not json'), (err) => err instanceof M.BackupError && /not valid JSON/.test(err.problems[0]));
  const broken = { ...backup, root: ['A'] };
  assert.throws(() => M.parseBackup(JSON.stringify(broken)), (err) => err.problems.length === 1 && /not in any folder/.test(err.problems[0]));
});

test('backups made before the rename still import', () => {
  const backup = { ...M.toBackup(makeDoc()), format: 'playlist-manager' };
  assert.equal(M.parseBackup(JSON.stringify(backup)).format, 'youtube-playlist-manager');
});

test('parseBackup fills in missing open flags and keeps extra per-item fields', () => {
  const doc = makeDoc();
  delete doc.folders.A.open;
  doc.playlists.P1.items[0].note = 'keep me';
  const restored = M.parseBackup(JSON.stringify(M.toBackup(doc)));
  assert.equal(restored.folders.A.open, false);
  assert.equal(restored.playlists.P1.items[0].note, 'keep me');
});

test('cleanResource drops API bookkeeping and repeated translations', () => {
  const raw = { kind: 'youtube#video', etag: 'e', id: 'v1', snippet: { title: 'One', description: 'd', localized: { title: 'One', description: 'd' } } };
  assert.deepEqual(M.cleanResource(raw), { id: 'v1', snippet: { title: 'One', description: 'd' } });
  const translated = { id: 'v2', snippet: { title: 'Two', description: 'd', localized: { title: 'Zwei', description: 'd' } } };
  assert.equal(M.cleanResource(translated).snippet.localized.title, 'Zwei');
});

test('moveNodes moves several folders and playlists together, in order', () => {
  const doc = makeDoc();
  const C = M.addFolder(doc, 'root', 'C');
  assert.equal(M.moveNodes(doc, ['P1', 'P2', 'B'], C), true);
  assert.deepEqual(doc.folders[C].children, ['P1', 'P2', 'B']);
  assert.deepEqual(doc.root, ['A', C]);
  assert.deepEqual(doc.folders.A.children, []);

  // Dropping before an entry that is itself moving lands before the next one that isn't.
  assert.equal(M.moveNodes(doc, ['B', 'P1'], C, 1), true);
  assert.deepEqual(doc.folders[C].children, ['B', 'P1', 'P2']);
  assert.equal(M.moveNodes(doc, ['B', 'P1'], C, 0), false, 'already there');

  assert.equal(M.moveNodes(doc, ['A', 'B'], 'B'), false, 'one bad move cancels the whole move');
  assert.deepEqual(M.validate(doc), []);
});

test('moveVideos moves several videos, keeping their order', () => {
  const doc = makeDoc();
  assert.equal(M.moveVideos(doc, [{ playlist: 'P1', index: 2 }, { playlist: 'P1', index: 0 }], 'P2', 0), true);
  assert.deepEqual(items(doc, 'P2'), ['v3', 'v1', 'v4']);
  assert.deepEqual(items(doc, 'P1'), ['v2']);
  // The same video picked twice is only moved once.
  assert.equal(M.moveVideos(doc, [{ playlist: 'P2', index: 0 }, { playlist: 'P2', index: 0 }], 'P3'), true);
  assert.deepEqual(items(doc, 'P3'), ['v3']);
  assert.deepEqual(items(doc, 'P2'), ['v1', 'v4']);
});

test('moved entries keep their YouTube ID; copies are new entries', () => {
  const doc = makeDoc();
  doc.playlists.P1.items[0].itemId = 'yt-1';
  const moved = doc.playlists.P1.items[0];
  M.moveVideo(doc, 'P1', 0, 'P2');
  assert.equal(doc.playlists.P2.items.at(-1), moved, 'the same entry object, not a copy');
  assert.equal(M.moveVideos(doc, [{ playlist: 'P2', index: 1 }], 'P3', 0, { copy: true }), true);
  assert.deepEqual(doc.playlists.P3.items, [{ videoId: 'v1' }]);
  assert.deepEqual(items(doc, 'P2'), ['v4', 'v1']);
});

test('Liked videos is read-only: copied from, never moved into, removed from or reordered', () => {
  const doc = makeDoc();
  doc.playlists.P1.kind = 'liked';
  assert.equal(M.moveVideo(doc, 'P1', 0, 'P2', 0), true);
  assert.deepEqual(items(doc, 'P1'), ['v1', 'v2', 'v3'], 'dragging out copies');
  assert.deepEqual(items(doc, 'P2'), ['v1', 'v4']);
  assert.equal(M.moveVideo(doc, 'P2', 0, 'P1', 0), false);
  assert.equal(M.moveVideo(doc, 'P1', 2, 'P1', 0), false);
  assert.equal(M.removeVideos(doc, [{ playlist: 'P1', index: 0 }]), 0);
});

test('removeVideos removes the picked entries', () => {
  const doc = makeDoc();
  assert.equal(M.removeVideos(doc, [{ playlist: 'P1', index: 0 }, { playlist: 'P1', index: 2 }, { playlist: 'P1', index: 2 }, { playlist: 'P2', index: 0 }]), 3);
  assert.deepEqual(items(doc, 'P1'), ['v2']);
  assert.deepEqual(items(doc, 'P2'), []);
  assert.deepEqual(M.validate(doc), []);
});

test('snapshot and restore undo edits but keep open and closed state', () => {
  const doc = makeDoc();
  const snap = M.snapshot(doc);
  const newFolder = M.addFolder(doc, 'A', 'New');
  M.renameFolder(doc, 'B', 'Renamed');
  M.moveVideo(doc, 'P1', 0, 'P3');
  M.removeVideos(doc, [{ playlist: 'P2', index: 0 }]);
  M.setOpen(doc, 'B', true);

  M.restore(doc, snap);
  assert.equal(M.isFolder(doc, newFolder), false);
  assert.equal(doc.folders.B.name, 'B');
  assert.deepEqual(items(doc, 'P1'), ['v1', 'v2', 'v3']);
  assert.deepEqual(items(doc, 'P2'), ['v4']);
  assert.deepEqual(items(doc, 'P3'), []);
  assert.equal(doc.folders.B.open, true, 'opening a folder is not undone');
  assert.deepEqual(M.validate(doc), []);
});

test('version 2 fields are checked, and version 1 files still load', () => {
  const doc = makeDoc();
  doc.playlists.P1.items[0].itemId = 'yt-1';
  doc.playlists.P1.synced = ['yt-1'];
  doc.playlists.P2.kind = 'liked';
  doc.sync = { channelId: 'UC1', pulledAt: '2026-01-01T00:00:00Z' };
  assert.deepEqual(M.validate(doc), []);
  assert.deepEqual(M.parseBackup(JSON.stringify(M.toBackup(doc))).sync, doc.sync);

  const cases = [
    [(d) => { d.playlists.P1.items[0].itemId = 5; }, /"itemId" must be text/],
    [(d) => { d.playlists.P1.synced = 'yt-1'; }, /"synced" must be a list/],
    [(d) => { d.playlists.P2.kind = 'favourite'; }, /unknown "kind"/],
    [(d) => { d.sync = []; }, /"sync" must be an object/],
  ];
  for (const [mutate, expected] of cases) {
    const broken = structuredClone(doc);
    mutate(broken);
    assert.ok(M.validate(broken).some((p) => expected.test(p)), String(expected));
  }

  const v1 = { ...M.toBackup(makeDoc()), version: 1 };
  assert.equal(M.parseBackup(JSON.stringify(v1)).version, 2);
});
