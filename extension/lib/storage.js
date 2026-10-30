/*
 * Saving the library in chrome.storage.local.
 *
 * The document is split across two keys so that the frequent writes (every
 * drag, rename or toggle) only rewrite the small structure, never the large
 * video details:
 *
 *   pm.structure  format, version, root, folders, playlists
 *   pm.videos     the videos map (written only by import and pull)
 *   pm.meta       { rev, by } – who wrote last, so tabs can ignore their own writes
 *   pm.ui         dashboard preferences that are not part of the backup
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const KEYS = {
    structure: 'pm.structure',
    videos: 'pm.videos',
    meta: 'pm.meta',
    ui: 'pm.ui',
  };

  async function loadDoc() {
    const data = await chrome.storage.local.get([KEYS.structure, KEYS.videos]);
    const structure = data[KEYS.structure];
    if (!structure) return PM.model.emptyDoc();
    return { ...structure, videos: data[KEYS.videos] || {} };
  }

  function meta(by) {
    return { rev: Date.now(), by };
  }

  // The save functions are async so that a synchronous throw (e.g. after the
  // extension was reloaded) reaches callers as a rejected promise.

  /** Saves everything except the videos map. */
  async function saveStructure(doc, by) {
    const { videos, ...structure } = doc;
    return chrome.storage.local.set({ [KEYS.structure]: structure, [KEYS.meta]: meta(by) });
  }

  /** Saves the whole document, replacing what was stored. */
  async function saveDoc(doc, by) {
    const { videos, ...structure } = doc;
    return chrome.storage.local.set({
      [KEYS.structure]: structure,
      [KEYS.videos]: videos,
      [KEYS.meta]: meta(by),
    });
  }

  async function loadUi() {
    const data = await chrome.storage.local.get(KEYS.ui);
    return data[KEYS.ui] || {};
  }

  async function saveUi(ui) {
    return chrome.storage.local.set({ [KEYS.ui]: ui });
  }

  /** Calls `onChange` whenever someone other than `selfId` (another tab, the pull) saves the library. */
  function watch(selfId, onChange) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEYS.meta]) return;
      if (changes[KEYS.meta].newValue?.by === selfId) return;
      onChange();
    });
  }

  PM.storage = { KEYS, loadDoc, saveStructure, saveDoc, loadUi, saveUi, watch };
})();
