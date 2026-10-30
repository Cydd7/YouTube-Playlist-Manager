const test = require('node:test');
const assert = require('node:assert/strict');

const { pullAll, ApiError, VIDEO_PARTS } = require('../../extension/lib/youtube-api.js');

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const apiError = (status, reason, message = 'nope') => json({ error: { code: status, message, errors: [{ reason, message }] } }, status);

/** A fake YouTube API: `playlists` is a list of { id, title, videos: [videoIds] }. */
function fakeYouTube(playlists, { pageSize = 2 } = {}) {
  const calls = [];
  const page = (all, url) => {
    const start = Number(url.searchParams.get('pageToken') || 0);
    const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
    return json({ items: all.slice(start, start + pageSize), nextPageToken: next, pageInfo: { totalResults: all.length } });
  };
  const fetch = async (href, init) => {
    const url = new URL(href);
    calls.push({ url, init });
    const endpoint = url.pathname.split('/').pop();
    if (endpoint === 'playlists') {
      return page(playlists.map((p) => ({ id: p.id, snippet: { title: p.title } })), url);
    }
    if (endpoint === 'playlistItems') {
      const p = playlists.find((x) => x.id === url.searchParams.get('playlistId'));
      return page(p.videos.map((v) => ({ snippet: { resourceId: { videoId: v } }, contentDetails: { videoId: v } })), url);
    }
    if (endpoint === 'videos') {
      const ids = url.searchParams.get('id').split(',');
      return json({ items: ids.filter((id) => !id.startsWith('gone')).map((id) => ({ id, snippet: { title: id } })) });
    }
    throw new Error(`unexpected ${href}`);
  };
  return { fetch, calls };
}

const noSleep = async () => {};

test('pullAll follows every page and batches video details 50 at a time', async () => {
  const many = Array.from({ length: 120 }, (_, i) => `v${i}`);
  const api = fakeYouTube([
    { id: 'PA', title: 'A', videos: ['v1', 'v2', 'v3'] },
    { id: 'PB', title: 'B', videos: many },
    { id: 'PC', title: 'C', videos: ['gone1'] },
  ], { pageSize: 50 });
  const progress = [];
  const data = await pullAll({ token: 'tok', fetch: api.fetch, sleep: noSleep, onProgress: (t) => progress.push(t) });

  assert.deepEqual(data.playlists.map((p) => p.id), ['PA', 'PB', 'PC']);
  assert.equal(data.items.PB.length, 120);
  assert.equal(Object.keys(data.videos).length, 120, 'v1–v3 are also in PB; gone1 is not returned');

  const videoCalls = api.calls.filter((c) => c.url.pathname.endsWith('/videos'));
  assert.deepEqual(videoCalls.map((c) => c.url.searchParams.get('id').split(',').length), [50, 50, 21]);
  assert.equal(videoCalls[0].url.searchParams.get('part'), VIDEO_PARTS);
  assert.equal(videoCalls[0].url.searchParams.has('maxResults'), false, 'maxResults is not allowed together with id');

  const playlistCall = api.calls[0];
  assert.equal(playlistCall.url.searchParams.get('mine'), 'true');
  assert.equal(playlistCall.init.headers.Authorization, 'Bearer tok');
  assert.ok(progress.some((t) => /Playlist 2 of 3/.test(t)));
  assert.ok(progress.some((t) => /video details… 121 of 121/.test(t)));
});

test('pullAll paginates with small pages', async () => {
  const api = fakeYouTube([
    { id: 'P1', title: 'One', videos: ['a', 'b', 'c', 'd', 'e'] },
    { id: 'P2', title: 'Two', videos: [] },
    { id: 'P3', title: 'Three', videos: ['f'] },
  ]);
  const data = await pullAll({ token: 't', fetch: api.fetch, sleep: noSleep });
  assert.equal(data.playlists.length, 3);
  assert.deepEqual(data.items.P1.map((i) => i.contentDetails.videoId), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(data.items.P2, []);
});

test('transient errors are retried with backoff', async () => {
  const api = fakeYouTube([{ id: 'P1', title: 'One', videos: ['a'] }]);
  let failures = 2;
  const sleeps = [];
  const flaky = async (href, init) => (failures-- > 0 ? apiError(503, 'backendError') : api.fetch(href, init));
  const data = await pullAll({ token: 't', fetch: flaky, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(data.playlists.length, 1);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('network failures are retried, then reported', async () => {
  let attempts = 0;
  const down = async () => {
    attempts++;
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(pullAll({ token: 't', fetch: down, sleep: noSleep }), /Could not reach YouTube \(Failed to fetch\)/);
  assert.equal(attempts, 4);
});

test('permanent errors stop the pull with an explanation', async () => {
  const cases = [
    [apiError(403, 'quotaExceeded'), /quota is used up/],
    [apiError(403, 'accessNotConfigured'), /isn't enabled/],
    [apiError(401, 'authError'), /rejected the sign-in/],
    [apiError(400, 'invalidParameter', 'Bad thing'), /YouTube API error 400: Bad thing/],
  ];
  for (const [response, expected] of cases) {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return response;
    };
    await assert.rejects(pullAll({ token: 't', fetch, sleep: noSleep }), (err) => err instanceof ApiError && expected.test(err.message));
    assert.equal(calls, 1, `${expected} must not be retried`);
  }
});

test('errors while reading a playlist name the playlist', async () => {
  const api = fakeYouTube([{ id: 'P1', title: 'Road trip', videos: ['a'] }]);
  const fetch = async (href, init) => (href.includes('playlistItems') ? apiError(404, 'playlistNotFound', 'Not found') : api.fetch(href, init));
  await assert.rejects(pullAll({ token: 't', fetch, sleep: noSleep }), /while reading playlist “Road trip”/);
});

test('a page token that repeats stops the pull instead of looping forever', async () => {
  const fetch = async () => json({ items: [{ id: 'P1', snippet: { title: 'x' } }], nextPageToken: 'same' });
  await assert.rejects(pullAll({ token: 't', fetch, sleep: noSleep }), /same page/);
});

test('cancelling stops the pull', async () => {
  const controller = new AbortController();
  const api = fakeYouTube([{ id: 'P1', title: 'One', videos: ['a'] }, { id: 'P2', title: 'Two', videos: ['b'] }]);
  const fetch = async (href, init) => {
    if (href.includes('playlistItems')) controller.abort();
    return api.fetch(href, init);
  };
  await assert.rejects(pullAll({ token: 't', fetch, signal: controller.signal, sleep: noSleep }), (err) => err.reason === 'cancelled');
});
