const test = require('node:test');
const assert = require('node:assert/strict');

const { client, ApiError, VIDEO_PARTS } = require('../../extension/lib/youtube-api.js');
const createFakeYouTube = require('../support/fake-youtube.js');

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const apiError = (status, reason, message = 'nope') => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);
const noSleep = async () => {};
const titles = (ids) => Object.fromEntries(ids.map((id) => [id, { title: `Title ${id}` }]));

test('fetchLibrary reads the channel, every playlist page, Liked videos and video details in batches of 50', async () => {
  const many = Array.from({ length: 120 }, (_, i) => `v${i}`);
  const yt = createFakeYouTube({
    playlists: [
      { id: 'PA', title: 'A', videos: ['v1', 'v2', 'v3'] },
      { id: 'PB', title: 'B', videos: many },
      { id: 'PC', title: 'C', videos: ['gone'] },
    ],
    liked: ['v1', 'extra'],
    videos: titles([...many, 'extra']),
    pageSize: 7,
  });
  const progress = [];
  const data = await client({ token: 'read-token', fetch: yt.fetch, sleep: noSleep }).fetchLibrary((t) => progress.push(t));

  assert.deepEqual(data.channel, { id: 'UCfakechannel', title: 'Fake Channel' });
  assert.deepEqual(data.playlists.map((p) => p.id), ['PA', 'PB', 'PC']);
  assert.equal(data.items.PB.length, 120);
  assert.deepEqual(data.liked.items.map((i) => i.contentDetails.videoId), ['v1', 'extra']);
  assert.equal(data.liked.id, 'LL');
  assert.equal(Object.keys(data.videos).length, 121, 'every video once; "gone" has no details');

  const videoCalls = yt.state.calls.filter((c) => c === 'GET videos').length;
  assert.equal(videoCalls, 3, '122 IDs in batches of 50');
  assert.ok(progress.includes('Reading your channel…'));
  assert.ok(progress.some((t) => /Playlist 2 of 3 \(“B”\): 119 of 120 videos/.test(t)));
  assert.ok(progress.some((t) => /Liked videos: 2 of 2/.test(t)));
});

test('video details are requested with every part, and without maxResults', async () => {
  const urls = [];
  const yt = createFakeYouTube({ playlists: [{ id: 'P', title: 'P', videos: ['a'] }], videos: titles(['a']), likedPlaylist: 'none' });
  const spy = async (href, init) => {
    urls.push(new URL(href));
    return yt.fetch(href, init);
  };
  const data = await client({ token: 'read-token', fetch: spy, sleep: noSleep }).fetchLibrary();
  assert.equal(data.liked, null, 'no Liked videos playlist: none is created');
  const videos = urls.find((u) => u.pathname.endsWith('/videos'));
  assert.equal(videos.searchParams.get('part'), VIDEO_PARTS);
  assert.equal(videos.searchParams.has('maxResults'), false);
  assert.equal(urls[0].searchParams.get('mine'), 'true');
});

test('when Liked videos is hidden, the videos rated "like" are used instead', async () => {
  const yt = createFakeYouTube({ liked: ['a', 'b'], videos: titles(['a', 'b']), likedPlaylist: 'hidden' });
  const data = await client({ token: 'read-token', fetch: yt.fetch, sleep: noSleep }).fetchLibrary();
  assert.deepEqual(data.liked.items.map((i) => i.contentDetails.videoId), ['a', 'b']);
  assert.equal(data.videos.a.snippet.title, 'Title a');
  assert.equal(yt.state.calls.filter((c) => c === 'GET videos').length, 1, 'the details came with the list');
});

test('an account without a channel gets a clear message', async () => {
  const fetch = async () => json({ items: [] });
  await assert.rejects(client({ token: 't', fetch, sleep: noSleep }).fetchLibrary(), /doesn't have a YouTube channel/);
});

test('writes add, remove and reposition entries', async () => {
  const yt = createFakeYouTube({ playlists: [{ id: 'P', title: 'P', videos: ['a', 'b'] }], videos: titles(['a', 'b', 'c']) });
  const api = client({ token: 'write-token', fetch: yt.fetch, sleep: noSleep });
  const added = await api.insertItem({ playlistId: 'P', videoId: 'c', position: 0 });
  assert.deepEqual(yt.videosIn('P'), ['c', 'a', 'b']);
  await api.moveItem({ itemId: added.id, playlistId: 'P', videoId: 'c', position: 2 });
  assert.deepEqual(yt.videosIn('P'), ['a', 'b', 'c']);
  assert.equal(await api.deleteItem(added.id), null);
  assert.deepEqual(yt.videosIn('P'), ['a', 'b']);
  await api.insertItem({ playlistId: 'P', videoId: 'c' });
  assert.deepEqual(yt.videosIn('P'), ['a', 'b', 'c'], 'no position: added at the end');
});

test('reads and moves are retried when YouTube is briefly unavailable', async () => {
  let failures = 2;
  const sleeps = [];
  const flaky = async () => (failures-- > 0 ? apiError(503, 'backendError') : json({ items: [{ id: 'UC', snippet: {}, contentDetails: { relatedPlaylists: {} } }] }));
  const api = client({ token: 't', fetch: async (h, i) => (h.includes('/channels') ? flaky() : json({ items: [] })), sleep: async (ms) => sleeps.push(ms) });
  await api.fetchLibrary();
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('adding is not repeated after an unclear failure, but is after a rate limit', async () => {
  let calls = 0;
  const serverError = client({ token: 't', fetch: async () => { calls++; return apiError(503, 'backendError'); }, sleep: noSleep });
  await assert.rejects(serverError.insertItem({ playlistId: 'P', videoId: 'a' }), /YouTube API error 503/);
  assert.equal(calls, 1);

  calls = 0;
  const offline = client({ token: 't', fetch: async () => { calls++; throw new TypeError('Failed to fetch'); }, sleep: noSleep });
  await assert.rejects(offline.insertItem({ playlistId: 'P', videoId: 'a' }), /Could not reach YouTube/);
  assert.equal(calls, 1);

  calls = 0;
  const limited = client({ token: 't', fetch: async () => (++calls < 3 ? apiError(429, 'rateLimitExceeded') : json({ id: 'new' })), sleep: noSleep });
  assert.deepEqual(await limited.insertItem({ playlistId: 'P', videoId: 'a' }), { id: 'new' });
  assert.equal(calls, 3);
});

test('network failures on reads are retried, then reported', async () => {
  let attempts = 0;
  const down = async () => {
    attempts++;
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(client({ token: 't', fetch: down, sleep: noSleep }).fetchLibrary(), /Could not reach YouTube \(Failed to fetch\)/);
  assert.equal(attempts, 4);
});

test('permanent errors are explained and not retried', async () => {
  const cases = [
    [apiError(403, 'quotaExceeded'), /quota is used up/],
    [apiError(403, 'accessNotConfigured'), /isn't enabled/],
    [apiError(401, 'authError'), /rejected the sign-in/],
    [apiError(403, 'insufficientPermissions'), /didn't grant the access this needs/],
    [apiError(400, 'invalidParameter', 'Bad thing'), /YouTube API error 400: Bad thing/],
  ];
  for (const [response, expected] of cases) {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return response;
    };
    await assert.rejects(client({ token: 't', fetch, sleep: noSleep }).fetchLibrary(), (err) => err instanceof ApiError && expected.test(err.message));
    assert.equal(calls, 1, `${expected} must not be retried`);
  }
});

test('errors while reading a playlist name the playlist', async () => {
  const yt = createFakeYouTube({ playlists: [{ id: 'P1', title: 'Road trip', videos: ['a'] }], videos: titles(['a']) });
  const fetch = async (href, init) => (href.includes('playlistItems') ? apiError(404, 'playlistNotFound', 'Not found') : yt.fetch(href, init));
  await assert.rejects(client({ token: 'read-token', fetch, sleep: noSleep }).fetchLibrary(), /while reading playlist “Road trip”/);
});

test('a page token that repeats stops instead of looping forever', async () => {
  const fetch = async (href) => (href.includes('/channels')
    ? json({ items: [{ id: 'UC', snippet: {}, contentDetails: { relatedPlaylists: {} } }] })
    : json({ items: [{ id: 'P1', snippet: { title: 'x' } }], nextPageToken: 'same' }));
  await assert.rejects(client({ token: 't', fetch, sleep: noSleep }).fetchLibrary(), /same page/);
});

test('cancelling stops the reading', async () => {
  const controller = new AbortController();
  const yt = createFakeYouTube({ playlists: [{ id: 'P1', title: 'One', videos: ['a'] }, { id: 'P2', title: 'Two', videos: ['b'] }], videos: titles(['a', 'b']) });
  const fetch = async (href, init) => {
    if (href.includes('playlistItems')) controller.abort();
    return yt.fetch(href, init);
  };
  await assert.rejects(client({ token: 'read-token', fetch, signal: controller.signal, sleep: noSleep }).fetchLibrary(), (err) => err.reason === 'cancelled');
});
