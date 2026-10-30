/*
 * Background service worker: Google sign-in and syncing with YouTube.
 *
 * The dashboard opens a port named "pm-sync" and sends { type: 'pull' } or
 * { type: 'push' }. This worker reads the library from storage, talks to
 * YouTube, writes the result back to storage (every open dashboard picks it up
 * from there) and reports with { type: 'progress' | 'ask' | 'done' | 'error' }.
 * An 'ask' waits for { type: 'apply' } or { type: 'cancel' }. The dashboard
 * pings while a sync runs, which keeps this worker alive; closing the tab
 * cancels the sync.
 */
importScripts('config.js', 'lib/model.js', 'lib/storage.js', 'lib/youtube-api.js', 'lib/sync.js');

const READ_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const WRITE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const TOKEN_KEY = 'pm.token';
const PLAYLISTS_URL = 'https://www.youtube.com/feed/playlists';

let syncRunning = false;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: PLAYLISTS_URL });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pm-sync') return;
  const controller = new AbortController();
  let connected = true;
  let answer = null;
  port.onDisconnect.addListener(() => {
    connected = false;
    controller.abort();
    answer?.('cancel');
  });
  const send = (message) => {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
    }
  };
  const ask = (question) => new Promise((resolve) => {
    answer = resolve;
    send({ type: 'ask', ...question });
  });
  port.onMessage.addListener((message) => {
    if (message?.type === 'pull' || message?.type === 'push') {
      runSync(message.type, { signal: controller.signal, send, ask });
    } else if ((message?.type === 'apply' || message?.type === 'cancel') && answer) {
      const resolve = answer;
      answer = null;
      resolve(message.type);
    }
  });
});

async function runSync(mode, { signal, send, ask }) {
  if (syncRunning) {
    send({ type: 'error', text: 'A sync is already running in another tab.' });
    return;
  }
  syncRunning = true;
  try {
    send({ type: 'progress', text: 'Waiting for Google sign-in…' });
    const token = await getToken(mode === 'push' ? WRITE_SCOPE : READ_SCOPE);
    const youtube = PM.youtube.client({ token, signal, fetch: (...args) => fetch(...args) });
    const remote = await youtube.fetchLibrary((text) => send({ type: 'progress', text }));

    let doc = await PM.storage.loadDoc();
    if (PM.model.validate(doc).length) {
      throw new Error('The saved library looks damaged, so nothing was synced. Import a backup first.');
    }

    const owner = PM.sync.libraryChannel(doc);
    if (owner && owner.id !== remote.channel.id) {
      const signedIn = remote.channel.title || remote.channel.id;
      const reply = await ask({
        text: `Your library's playlists come from “${owner.title || owner.id}”, but you signed in as “${signedIn}”.`,
        details: [
          `Replace library: your folders and playlists here are replaced by ${signedIn}'s playlists.`,
          'Cancel: nothing changes. Next time, pick the channel your library came from.',
        ],
        confirm: 'Replace library',
      });
      if (reply !== 'apply') {
        await forgetToken(); // so the next sync shows Google's account picker
        send({ type: 'done', kind: 'info', text: 'Nothing was changed.' });
        return;
      }
      doc = PM.model.emptyDoc();
    }

    send({ type: 'progress', text: 'Merging with your library…' });
    const summary = PM.sync.merge(doc, remote);
    await PM.storage.saveDoc(doc, 'sync');
    const plan = PM.sync.planPush(doc);
    if (mode === 'pull') {
      send({ type: 'done', ...PM.sync.describePull(summary, plan.total) });
      return;
    }

    const pulled = PM.sync.describePull(summary);
    if (!plan.total) {
      send({ type: 'done', kind: 'success', text: 'Nothing to push: YouTube already matches your library.', details: pulled.details });
      return;
    }
    if ((await ask(PM.sync.describePlan(plan))) !== 'apply') {
      send({ type: 'done', kind: 'info', text: 'Push cancelled. Nothing was changed on YouTube.' });
      return;
    }

    const result = await PM.sync.executePush(doc, plan, {
      insert: youtube.insertItem,
      remove: youtube.deleteItem,
      move: youtube.moveItem,
      onProgress: (done, total) => send({ type: 'progress', text: `Pushing to YouTube… ${done} of ${total}` }),
      checkpoint: () => PM.storage.saveStructure(doc, 'sync'),
    });
    doc.sync = { ...doc.sync, pushedAt: new Date().toISOString() };
    await PM.storage.saveStructure(doc, 'sync');
    if (result.stopped?.status === 401) await forgetToken();
    send({ type: 'done', ...PM.sync.describePush(result) });
  } catch (err) {
    console.error('Sync with YouTube failed', err);
    if (err.status === 401) await forgetToken();
    send({ type: 'error', text: err.message || String(err) });
  } finally {
    syncRunning = false;
  }
}

/**
 * A Google access token with `scope`, reused until it expires. Kept in session
 * storage, which only this extension's own pages can read and which is never
 * written to disk. Read-only access is enough for a pull; a push needs write access.
 */
async function getToken(scope) {
  const { [TOKEN_KEY]: saved } = await chrome.storage.session.get(TOKEN_KEY);
  const covers = (s) => saved.scopes.includes(s) || (s === READ_SCOPE && saved.scopes.includes(WRITE_SCOPE));
  if (saved && saved.expiresAt > Date.now() + 60_000 && covers(scope)) return saved.token;
  const fresh = await signIn(scope);
  await chrome.storage.session.set({ [TOKEN_KEY]: fresh });
  return fresh.token;
}

function forgetToken() {
  return chrome.storage.session.remove(TOKEN_KEY);
}

/** Asks Google for an access token, showing its account picker (so you can choose a brand channel). */
async function signIn(scope) {
  const clientId = (self.PM_CONFIG?.googleClientId || '').trim();
  const redirectUri = chrome.identity.getRedirectURL();
  if (!clientId) {
    throw new Error(
      "Syncing with YouTube isn't set up yet: add your Google OAuth client ID to extension/config.js " +
      `and reload the extension. The client's authorized redirect URI must be ${redirectUri}`
    );
  }

  const state = crypto.randomUUID();
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    redirect_uri: redirectUri,
    scope,
    include_granted_scopes: 'true',
    state,
    prompt: 'select_account',
  });

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (err) {
    throw new Error(
      `Google sign-in didn't finish (${err.message}). If Google showed an error, check the client ID in ` +
      `extension/config.js, that ${redirectUri} is an authorized redirect URI, and that the consent screen ` +
      `lists the scope ${scope}.`
    );
  }

  const url = new URL(responseUrl);
  const params = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
  if (params.get('error')) throw new Error(`Google sign-in failed: ${params.get('error')}.`);
  if (params.get('state') !== state) throw new Error('Google sign-in returned an unexpected response. Try again.');
  const token = params.get('access_token');
  if (!token) throw new Error('Google sign-in did not return an access token.');
  return {
    token,
    scopes: (params.get('scope') || scope).split(' '),
    expiresAt: Date.now() + Number(params.get('expires_in') || 3600) * 1000,
  };
}
