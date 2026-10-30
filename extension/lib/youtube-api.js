/*
 * YouTube Data API v3 client for the one-time "Pull from YouTube".
 *
 * Runs in the background service worker. `fetch` and `sleep` are passed in so
 * the tests can fake them. Quota: every call below costs 1 unit and returns up
 * to 50 results, so a pull needs a few hundred of the 10,000 free daily units.
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
  const cancelled = () => new ApiError('The pull was cancelled.', { reason: 'cancelled' });
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
        return "Google didn't grant read access to YouTube. Pull again and allow access.";
      case 'youtubeSignupRequired':
      case 'channelNotFound':
        return "This Google account doesn't have a YouTube channel. Pick the account (or brand channel) that owns your playlists.";
    }
    if (status === 401) return 'Google rejected the sign-in (it may have expired). Pull again.';
    return `YouTube API error ${status}${message ? `: ${message}` : ''}`;
  }

  async function request(ctx, path, params) {
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      if (ctx.signal?.aborted) throw cancelled();

      // A request that hangs would let Chrome stop the service worker, so time it out and retry.
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
      const onCancel = () => timeout.abort();
      ctx.signal?.addEventListener('abort', onCancel);
      let response;
      try {
        response = await ctx.fetch(url, {
          headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
          signal: timeout.signal,
        });
      } catch (err) {
        if (ctx.signal?.aborted) throw cancelled();
        if (attempt < RETRIES) {
          await ctx.sleep(backoff(attempt));
          continue;
        }
        throw new ApiError(`Could not reach YouTube (${err.message}).`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onCancel);
      }

      if (response.ok) return response.json();

      const body = await response.json().catch(() => null);
      const reason = errorReason(body);
      const transient = response.status === 429 || response.status >= 500 ||
        reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
      if (transient && attempt < RETRIES) {
        await ctx.sleep(backoff(attempt));
        continue;
      }
      throw new ApiError(explain(response.status, reason, body?.error?.message), { status: response.status, reason });
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
        throw new ApiError('YouTube kept returning the same page, so the pull stopped.');
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return all;
  }

  function uniqueById(resources) {
    const seen = new Set();
    return resources.filter((r) => r?.id && !seen.has(r.id) && seen.add(r.id));
  }

  /**
   * Reads every playlist the signed-in channel owns, every entry in them and
   * the full details of every video. Resolves to the raw API resources:
   * { playlists: [...], items: { [playlistId]: [...] }, videos: { [videoId]: {...} } }.
   */
  async function pullAll({ token, fetch, signal, sleep = defaultSleep, onProgress = () => {} }) {
    const ctx = { token, fetch, signal, sleep };

    onProgress('Fetching your playlists…');
    const playlists = uniqueById(await listAll(ctx, 'playlists', { part: PLAYLIST_PARTS, mine: 'true' },
      (n, total) => onProgress(`Fetching your playlists… ${n}${total ? ` of ${total}` : ''}`)));

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

    const ids = [...new Set(Object.values(items).flat().map(videoIdOf).filter(Boolean))];
    const videos = {};
    for (let i = 0; i < ids.length; i += PAGE_SIZE) {
      onProgress(`Fetching video details… ${Math.min(i + PAGE_SIZE, ids.length)} of ${ids.length}`);
      const page = await request(ctx, 'videos', { part: VIDEO_PARTS, id: ids.slice(i, i + PAGE_SIZE).join(',') });
      for (const video of page.items || []) videos[video.id] = video;
    }

    return { playlists, items, videos };
  }

  const youtube = { API, VIDEO_PARTS, ApiError, pullAll };

  PM.youtube = youtube;
  if (typeof module === 'object' && module.exports) module.exports = youtube;
})();
