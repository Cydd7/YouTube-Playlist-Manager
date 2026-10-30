/*
 * YouTube Data API v3 client, used by the background service worker.
 *
 * client({ token, fetch, signal }) returns:
 *   fetchLibrary(onProgress)   your channel, every playlist it owns with all its entries,
 *                              Liked videos, and the full details of every video in them
 *   insertItem / deleteItem / moveItem   add, remove and reposition a playlist entry
 *
 * Quota: each read returns up to 50 results for 1 unit; each write costs 50 units.
 * `fetch` and `sleep` are passed in so the tests can fake them.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const API = 'https://www.googleapis.com/youtube/v3';
  const PAGE_SIZE = 50;
  const PLAYLIST_PARTS = 'snippet,contentDetails,status';
  const ITEM_PARTS = 'snippet,contentDetails,status';
  const VIDEO_PARTS = 'snippet,contentDetails,statistics,status,topicDetails,recordingDetails,liveStreamingDetails';
  const RETRIES = 3;
  const REQUEST_TIMEOUT_MS = 25000;
  const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

  class ApiError extends Error {
    constructor(message, { status, reason } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.reason = reason;
    }
  }

  const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const backoff = (attempt) => 1000 * 2 ** attempt;
  const cancelled = () => new ApiError('The sync was cancelled.', { reason: 'cancelled' });
  const videoIdOf = (item) => item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;

  function errorReason(body) {
    const error = body?.error;
    return error?.errors?.[0]?.reason || error?.details?.find((d) => d.reason)?.reason || error?.status;
  }

  function explain(status, reason, message) {
    switch (reason) {
      case 'quotaExceeded':
      case 'dailyLimitExceeded':
        return "Today's YouTube API quota is used up. It resets at midnight Pacific time.";
      case 'accessNotConfigured':
      case 'SERVICE_DISABLED':
        return "The YouTube Data API v3 isn't enabled in your Google Cloud project. Enable it and try again.";
      case 'insufficientPermissions':
      case 'ACCESS_TOKEN_SCOPE_INSUFFICIENT':
        return "Google didn't grant the access this needs. Try again and allow access.";
      case 'youtubeSignupRequired':
      case 'channelNotFound':
        return "This Google account doesn't have a YouTube channel. Pick the account (or brand channel) that owns your playlists.";
      case 'manualSortRequired':
        return "the playlist isn't sorted manually";
      case 'videoNotFound':
        return 'the video no longer exists or is private';
      case 'playlistItemNotFound':
        return 'that entry is already gone from YouTube';
    }
    if (status === 401) return 'Google rejected the sign-in (it may have expired). Try again.';
    return `YouTube API error ${status}${message ? `: ${message}` : ''}`;
  }

  /**
   * One API call, retried when YouTube is briefly unavailable. Adding an entry
   * (POST) is only retried when YouTube says it didn't happen (rate limits):
   * repeating it after an unclear failure could add the video twice.
   */
  async function request(ctx, path, params, { method = 'GET', body } = {}) {
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    const repeatable = method !== 'POST';
    for (let attempt = 0; ; attempt++) {
      if (ctx.signal?.aborted) throw cancelled();

      // A request that hangs would let Chrome stop the service worker, so time it out.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
      const onCancel = () => timeout.abort();
      ctx.signal?.addEventListener('abort', onCancel);
      let response;
      try {
        response = await ctx.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${ctx.token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: timeout.signal,
        });
      } catch (err) {
        if (ctx.signal?.aborted) throw cancelled();
        if (repeatable && attempt < RETRIES) {
          await ctx.sleep(backoff(attempt));
          continue;
        }
        throw new ApiError(`Could not reach YouTube (${err.message}).`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onCancel);
      }

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const errorBody = await response.json().catch(() => null);
      const reason = errorReason(errorBody);
      const rateLimited = response.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      if ((rateLimited || (repeatable && response.status >= 500)) && attempt < RETRIES) {
        await ctx.sleep(backoff(attempt));
        continue;
      }
      throw new ApiError(explain(response.status, reason, errorBody?.error?.message), { status: response.status, reason });
    }
  }

  /** Follows nextPageToken until the last page and returns every item. */
  async function listAll(ctx, path, params, onPage) {
    const all = [];
    const seenTokens = new Set();
    let pageToken;
    do {
      const page = await request(ctx, path, { ...params, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) });
      all.push(...(page.items || []));
      onPage?.(all.length, page.pageInfo?.totalResults);
      pageToken = page.nextPageToken;
      if (pageToken && seenTokens.has(pageToken)) {
        throw new ApiError('YouTube kept returning the same page, so the sync stopped.');
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return all;
  }

  function uniqueById(resources) {
    const seen = new Set();
    return resources.filter((r) => r?.id && !seen.has(r.id) && seen.add(r.id));
  }

  const counted = (label) => (n, total) => `${label} ${n}${total ? ` of ${total}` : ''}`;

  /**
   * Your channel, every playlist it owns with all its entries, Liked videos, and the
   * full details of every video in them, as raw API resources:
   * { channel: { id, title }, playlists, items: { [playlistId]: [...] }, liked: { id, items } | null, videos: { [videoId]: {...} } }
   */
  async function fetchLibrary(ctx, onProgress = () => {}) {
    onProgress('Reading your channel…');
    const channel = (await request(ctx, 'channels', { part: 'snippet,contentDetails', mine: 'true' })).items?.[0];
    if (!channel) throw new ApiError(explain(404, 'channelNotFound'), { status: 404, reason: 'channelNotFound' });

    const playlistProgress = counted('Fetching your playlists…');
    onProgress('Fetching your playlists…');
    const playlists = uniqueById(await listAll(ctx, 'playlists', { part: PLAYLIST_PARTS, mine: 'true' },
      (n, total) => onProgress(playlistProgress(n, total))));

    const items = {};
    for (const [i, playlist] of playlists.entries()) {
      const name = playlist.snippet?.title || playlist.id;
      const prefix = `Playlist ${i + 1} of ${playlists.length} (“${name}”)`;
      onProgress(`${prefix}…`);
      try {
        items[playlist.id] = await listAll(ctx, 'playlistItems', { part: ITEM_PARTS, playlistId: playlist.id },
          (n, total) => onProgress(`${prefix}: ${n}${total ? ` of ${total}` : ''} videos`));
      } catch (err) {
        if (err.reason !== 'cancelled') err.message += ` (while reading playlist “${name}”)`;
        throw err;
      }
    }

    const videos = {};
    let liked = null;
    const likedId = channel.contentDetails?.relatedPlaylists?.likes;
    if (likedId) {
      const likedProgress = counted('Liked videos:');
      onProgress('Fetching your liked videos…');
      try {
        liked = { id: likedId, items: await listAll(ctx, 'playlistItems', { part: ITEM_PARTS, playlistId: likedId },
          (n, total) => onProgress(likedProgress(n, total))) };
      } catch (err) {
        if (!(err.status === 404 || (err.status === 403 && !QUOTA_REASONS.has(err.reason)))) throw err;
        // Some accounts don't expose the Liked videos playlist; the videos rated "like" are the same list.
        const rated = await listAll(ctx, 'videos', { part: VIDEO_PARTS, myRating: 'like' }, (n, total) => onProgress(likedProgress(n, total)));
        for (const video of rated) videos[video.id] = video;
        liked = {
          id: likedId,
          items: rated.map((video) => ({ snippet: { title: video.snippet?.title, resourceId: { videoId: video.id } }, contentDetails: { videoId: video.id } })),
        };
      }
    }

    const allItems = [...Object.values(items).flat(), ...(liked?.items || [])];
    const ids = [...new Set(allItems.map(videoIdOf).filter((id) => id && !videos[id]))];
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      onProgress(`Fetching video details… ${Math.min(i + PAGE_SIZE, ids.length)} of ${ids.length}`);
      const page = await request(ctx, 'videos', { part: VIDEO_PARTS, id: ids.slice(i, i + PAGE_SIZE).join(',') });
      for (const video of page.items || []) videos[video.id] = video;
    }

    return { channel: { id: channel.id, title: channel.snippet?.title }, playlists, items, liked, videos };
  }

  const resource = (playlistId, videoId, position) => ({
    playlistId,
    resourceId: { kind: 'youtube#video', videoId },
    position, // omitted from the JSON when undefined: add at the end
  });

  function client({ token, fetch, signal, sleep = defaultSleep }) {
    const ctx = { token, fetch, signal, sleep };
    return {
      fetchLibrary: (onProgress) => fetchLibrary(ctx, onProgress),
      insertItem: ({ playlistId, videoId, position }) =>
        request(ctx, 'playlistItems', { part: 'snippet' }, { method: 'POST', body: { snippet: resource(playlistId, videoId, position) } }),
      deleteItem: (itemId) => request(ctx, 'playlistItems', { id: itemId }, { method: 'DELETE' }),
      moveItem: ({ itemId, playlistId, videoId, position }) =>
        request(ctx, 'playlistItems', { part: 'snippet' }, { method: 'PUT', body: { id: itemId, snippet: resource(playlistId, videoId, position) } }),
    };
  }

  const youtube = { API, VIDEO_PARTS, ApiError, client };

  PM.youtube = youtube;
  if (typeof module === 'object' && module.exports) module.exports = youtube;
})();
