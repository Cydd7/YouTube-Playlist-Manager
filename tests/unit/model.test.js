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
    [(d) => { d.format = 'other'; }, /not a Playlist Manager backup/],
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

test('parseBackup fills in missing open flags and keeps extra per-item fields', () => {
  const doc = makeDoc();
  delete doc.folders.A.open;
  doc.playlists.P1.items[0].note = 'keep me';
  const restored = M.parseBackup(JSON.stringify(M.toBackup(doc)));
  assert.equal(restored.folders.A.open, false);
  assert.equal(restored.playlists.P1.items[0].note, 'keep me');
});

test('buildFromYouTube turns API resources into a document', () => {
  const pl = (id, title) => ({ kind: 'youtube#playlist', etag: 'e', id, snippet: { title, localized: { title, description: '' }, description: '' }, status: { privacyStatus: 'private' } });
  const item = (videoId, extra = {}) => ({ snippet: { publishedAt: '2024-01-01T00:00:00Z', title: `t-${videoId}`, resourceId: { videoId } }, contentDetails: { videoId }, ...extra });
  const doc = M.buildFromYouTube({
    playlists: [pl('PA', 'Alpha'), pl('PB', 'Beta'), pl('PA', 'Alpha again')],
    items: {
      PA: [item('v1'), item('v2', { contentDetails: { videoId: 'v2', note: 'hi' } })],
      PB: [item('v1'), item('gone', { snippet: { title: 'Deleted video', resourceId: { videoId: 'gone' } }, status: { privacyStatus: 'privacyStatusUnspecified' } })],
    },
    videos: {
      v1: { kind: 'youtube#video', etag: 'e', id: 'v1', snippet: { title: 'One', description: 'd', localized: { title: 'One', description: 'd' } } },
      v2: { kind: 'youtube#video', etag: 'e', id: 'v2', snippet: { title: 'Two', description: 'd', localized: { title: 'Zwei', description: 'd' } } },
    },
  });

  assert.deepEqual(doc.root, ['PA', 'PB']);
  assert.equal(doc.playlists.PA.title, 'Alpha');
  assert.deepEqual(doc.playlists.PA.youtube, { id: 'PA', snippet: { title: 'Alpha', description: '' }, status: { privacyStatus: 'private' } });
  assert.deepEqual(doc.playlists.PA.items, [
    { videoId: 'v1', addedAt: '2024-01-01T00:00:00Z' },
    { videoId: 'v2', addedAt: '2024-01-01T00:00:00Z', note: 'hi' },
  ]);
  assert.deepEqual(items(doc, 'PB'), ['v1', 'gone']);
  assert.deepEqual(doc.videos.v1, { id: 'v1', snippet: { title: 'One', description: 'd' } }, 'kind, etag and a duplicate localized copy are dropped');
  assert.equal(doc.videos.v2.snippet.localized.title, 'Zwei', 'a real translation is kept');
  assert.deepEqual(doc.videos.gone, { id: 'gone', unavailable: true, snippet: { title: 'Deleted video' }, status: { privacyStatus: 'privacyStatusUnspecified' } });
  assert.deepEqual(M.validate(doc), []);
});
