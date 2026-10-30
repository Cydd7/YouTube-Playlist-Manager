/*
 * "Pull from YouTube": the temporary one-time import of all your playlists and
 * videos through the YouTube Data API. The background worker does the work;
 * this file starts it and shows its progress.
 *
 * To remove the feature: delete this file, lib/youtube-api.js, config.js and
 * the pull code in background.js, then remove them, the "identity" permission
 * and the googleapis.com host permission from manifest.json. The dashboard
 * hides the button when this file isn't loaded.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});
  const { plural } = PM.dom;

  let running = false;

  function start(app) {
    if (running) return;
    if (!PM.model.isEmpty(app.doc)) {
      const question = 'Replace your current folders and playlists with a fresh copy of your YouTube playlists?\n\n' +
        'Your folders will be lost. Export a backup first if you want to keep them.';
      if (!window.confirm(question)) return;
    }

    let port = null;
    let finished = false;
    const finish = () => {
      finished = true;
      running = false;
      app.setBusy(false);
      try {
        port?.disconnect();
      } catch {
        // Already disconnected.
      }
    };

    running = true;
    app.setBusy(true);
    app.setStatus('Starting…', 'progress');
    try {
      port = chrome.runtime.connect({ name: 'pm-pull' });
    } catch (err) {
      finish();
      app.reportError(err);
      return;
    }

    port.onMessage.addListener((message) => {
      if (message.type === 'progress') {
        app.setStatus(message.text, 'progress');
      } else if (message.type === 'done') {
        finish();
        const { stats, unavailable } = message;
        const note = unavailable ? ` ${plural(unavailable, 'video')} ${unavailable === 1 ? 'is' : 'are'} deleted or private.` : '';
        app.setStatus(`Pulled ${plural(stats.playlists, 'playlist')} with ${plural(stats.videos, 'video')}.${note} ` +
          'Everything is at the top level, ready to sort into folders.', 'success');
      } else if (message.type === 'error') {
        finish();
        app.setStatus(message.message, 'error');
      }
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      finish();
      app.setStatus('The pull stopped unexpectedly. Try again.', 'error');
    });
    port.postMessage({ type: 'start' });
  }

  PM.pull = { start };
})();
