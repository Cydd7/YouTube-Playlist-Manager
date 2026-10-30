/*
 * Background service worker: Google sign-in and the one-time "Pull from YouTube".
 *
 * The dashboard opens a port named "pm-pull" and sends { type: 'start' }. This
 * worker answers with { type: 'progress' | 'done' | 'error' } messages and
 * writes the finished library straight to storage, where every open dashboard
 * picks it up. Messages on the open port also keep the worker alive during a
 * long pull, and closing the tab cancels it.
 */
importScripts('config.js', 'lib/model.js', 'lib/storage.js', 'lib/youtube-api.js');

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const PLAYLISTS_URL = 'https://www.youtube.com/feed/playlists';

let pullRunning = false;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: PLAYLISTS_URL });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pm-pull') return;
  const controller = new AbortController();
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
    controller.abort();
  });
  const send = (message) => {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
    }
  };
  port.onMessage.addListener((message) => {
    if (message?.type === 'start') runPull(controller.signal, send);
  });
});

async function runPull(signal, send) {
  if (pullRunning) {
    send({ type: 'error', message: 'A pull is already running in another tab.' });
    return;
  }
  pullRunning = true;
  try {
    send({ type: 'progress', text: 'Waiting for Google sign-in…' });
    const token = await signIn();
    const data = await PM.youtube.pullAll({
      token,
      signal,
      fetch: (...args) => fetch(...args),
      onProgress: (text) => send({ type: 'progress', text }),
    });
    send({ type: 'progress', text: 'Saving…' });
    const doc = PM.model.buildFromYouTube(data);
    await PM.storage.saveDoc(doc, 'pull');
    const unavailable = Object.values(doc.videos).filter((video) => video.unavailable).length;
    send({ type: 'done', stats: PM.model.docStats(doc), unavailable });
  } catch (err) {
    console.error('Pull from YouTube failed', err);
    send({ type: 'error', message: err.message || String(err) });
  } finally {
    pullRunning = false;
  }
}

/** Asks Google for a read-only YouTube access token, showing Google's account picker. */
async function signIn() {
  const clientId = (self.PM_CONFIG?.googleClientId || '').trim();
  const redirectUri = chrome.identity.getRedirectURL();
  if (!clientId) {
    throw new Error(
      "Pull from YouTube isn't set up yet: add your Google OAuth client ID to extension/config.js " +
      `and reload the extension. The client's authorized redirect URI must be ${redirectUri}`
    );
  }

  const state = crypto.randomUUID();
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    prompt: 'select_account',
  });

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    throw new Error(
      `Google sign-in didn't finish (${err.message}). If Google showed an error, check the client ID ` +
      `in extension/config.js and that ${redirectUri} is an authorized redirect URI.`
    );
  }

  const url = new URL(responseUrl);
  const params = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
  if (params.get('error')) throw new Error(`Google sign-in failed: ${params.get('error')}.`);
  if (params.get('state') !== state) throw new Error('Google sign-in returned an unexpected response. Try again.');
  const token = params.get('access_token');
  if (!token) throw new Error('Google sign-in did not return an access token.');
  return token;
}
