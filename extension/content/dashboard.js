/*
 * The dashboard: toolbar, status line and the folder tree, rendered in a
 * shadow root. main.js decides when and where it is shown.
 *
 * Every change edits `this.doc` through PM.model, re-renders the tree and
 * schedules a save; the tree is simply rebuilt from the document each time.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});
  const { h, icon, plural } = PM.dom;
  const M = PM.model;

  const SAVE_DELAY_MS = 300;
  const SUCCESS_HIDE_MS = 8000;
  const MAX_DETAILS = 8;
  // Marks this tab's own storage writes so it only reloads for other tabs' changes.
  const INSTANCE = `tab-${Math.random().toString(36).slice(2)}`;

  const describe = (stats) =>
    `${plural(stats.folders, 'folder')}, ${plural(stats.playlists, 'playlist')} and ${plural(stats.videos, 'video')}`;

  function dateStamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  class Dashboard {
    constructor() {
      this.doc = M.emptyDoc();
      this.ui = { collapsed: false };
      this.loaded = false;
      this.loading = null;
      this.reloadAgain = false;
      this.editingId = null;
      this.status = null;
      this.statusTimer = null;
      this.busy = false;
      this.dragSource = null;
      this.saveTimer = null;
      this.themeObserver = null;
      this.host = this.build();
      PM.storage.watch(INSTANCE, () => this.reload());
      window.addEventListener('pagehide', () => this.flushSave());
    }

    // -------------------------------------------------------------------------
    // Setup

    build() {
      const host = h('div', { id: 'youtube-playlist-manager', style: { display: 'block', margin: '16px 0 24px' } });
      // Keys typed in the dashboard must not trigger YouTube's keyboard shortcuts.
      for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());
      const shadow = host.attachShadow({ mode: 'open' });

      this.collapseBtn = h('button', {
        class: 'pm-icon-btn pm-collapse',
        type: 'button',
        title: 'Show or hide the folders',
        'aria-label': 'Show or hide the folders',
        onclick: () => this.setCollapsed(!this.ui.collapsed),
      }, icon('chevron'));
      this.summary = h('span', { class: 'pm-summary' });

      this.buttons = {
        folder: h('button', { class: 'pm-btn', type: 'button', title: 'Add a folder at the top level', onclick: () => this.addFolder(M.ROOT) },
          icon('folderPlus'), 'Folder'),
        import: h('button', { class: 'pm-btn', type: 'button', title: 'Load a backup file', onclick: () => this.fileInput.click() },
          icon('import'), 'Import'),
        export: h('button', { class: 'pm-btn', type: 'button', title: 'Download everything as one JSON file', onclick: () => this.exportBackup() },
          icon('export'), 'Export'),
      };
      if (PM.pull) {
        this.buttons.pull = h('button', { class: 'pm-btn', type: 'button', title: 'Read all your playlists and videos from YouTube', onclick: () => PM.pull.start(this) },
          icon('pull'), 'Pull from YouTube');
      }

      this.fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => this.importFile(e.target) });
      this.statusEl = h('div', { class: 'pm-status', role: 'status', hidden: true });
      this.tree = h('div', { class: 'pm-tree', role: 'tree', 'aria-label': 'Folders and playlists' });
      this.body = h('div', { class: 'pm-body' }, this.tree);
      this.root = h('div', { class: 'pm' },
        h('div', { class: 'pm-bar' },
          h('div', { class: 'pm-heading' }, this.collapseBtn, h('h2', { class: 'pm-title' }, 'YouTube Playlist Manager'), this.summary),
          h('div', { class: 'pm-actions' }, Object.values(this.buttons))),
        this.statusEl,
        this.body,
        this.fileInput);

      shadow.append(h('style', null, PM.css), this.root);

      this.tree.addEventListener('click', (e) => this.onTreeClick(e));
      this.tree.addEventListener('dblclick', (e) => this.onTreeDblClick(e));
      PM.dnd.attach(this, this.tree);
      return host;
    }

    mount(anchor) {
      anchor.prepend(this.host);
      this.followTheme();
      if (this.loaded || this.loading) this.render();
      else this.reload();
    }

    unmount() {
      this.flushSave();
      this.host.remove();
      this.themeObserver?.disconnect();
      this.themeObserver = null;
    }

    /** YouTube marks dark mode with a `dark` attribute on <html>. */
    followTheme() {
      const apply = () => {
        this.root.dataset.theme = document.documentElement.hasAttribute('dark') ? 'dark' : 'light';
      };
      apply();
      if (!this.themeObserver) {
        this.themeObserver = new MutationObserver(apply);
        this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
      }
    }

    // -------------------------------------------------------------------------
    // Loading and saving

    reload() {
      if (this.loading) {
        this.reloadAgain = true;
        return this.loading;
      }
      this.loading = (async () => {
        try {
          const [doc, ui] = await Promise.all([PM.storage.loadDoc(), PM.storage.loadUi()]);
          const problems = M.validate(doc);
          if (problems.length) {
            this.doc = M.emptyDoc();
            this.setStatus('The saved library looks damaged, so the dashboard started empty. Import a backup to restore it.', 'error', problems);
          } else {
            // Libraries saved before the rename carry the old format name.
            this.doc = { ...doc, format: M.FORMAT };
          }
          this.ui = { collapsed: false, ...ui };
          this.loaded = true;
        } catch (err) {
          this.reportError(err);
        } finally {
          this.loading = null;
        }
        if (this.reloadAgain) {
          this.reloadAgain = false;
          return this.reload();
        }
        this.render();
      })();
      return this.loading;
    }

    /** Re-renders now and saves the structure shortly after (several quick edits share one save). */
    commit() {
      this.render();
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DELAY_MS);
    }

    async flushSave() {
      if (this.saveTimer == null) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      try {
        await PM.storage.saveStructure(this.doc, INSTANCE);
      } catch (err) {
        this.reportError(err);
      }
    }

    /** Replaces the whole stored library with `doc` (import). */
    async replaceDoc(doc) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.doc = doc;
      this.editingId = null;
      this.render();
      await PM.storage.saveDoc(doc, INSTANCE);
    }

    setCollapsed(collapsed) {
      this.ui.collapsed = collapsed;
      this.render();
      PM.storage.saveUi(this.ui).catch((err) => this.reportError(err));
    }

    setBusy(busy) {
      this.busy = busy;
      this.render();
    }

    reportError(err) {
      console.error('[YouTube Playlist Manager]', err);
      const message = String(err?.message || err);
      if (/context invalidated/i.test(message)) {
        this.setStatus('YouTube Playlist Manager was updated or reloaded. Refresh this page to keep using it.', 'error');
      } else {
        this.setStatus(`Something went wrong: ${message}`, 'error');
      }
    }

    // -------------------------------------------------------------------------
    // Status line

    /** kind: 'info' | 'progress' | 'success' | 'error'; details: optional list of lines. */
    setStatus(text, kind = 'info', details = null) {
      clearTimeout(this.statusTimer);
      this.status = text ? { text, kind, details } : null;
      if (kind === 'success') this.statusTimer = setTimeout(() => this.setStatus(null), SUCCESS_HIDE_MS);
      this.renderStatus();
    }

    renderStatus() {
      const status = this.status;
      this.statusEl.hidden = !status;
      if (!status) {
        this.statusEl.replaceChildren();
        return;
      }
      this.statusEl.dataset.kind = status.kind;
      const details = status.details || [];
      const shown = details.slice(0, MAX_DETAILS);
      if (details.length > MAX_DETAILS) shown.push(`…and ${details.length - MAX_DETAILS} more.`);
      this.statusEl.replaceChildren(
        h('div', { class: 'pm-status-text' },
          status.text,
          shown.length ? h('ul', null, shown.map((line) => h('li', null, line))) : null),
        status.kind === 'progress' ? null : h('button', {
          class: 'pm-icon-btn',
          type: 'button',
          title: 'Dismiss',
          'aria-label': 'Dismiss',
          onclick: () => this.setStatus(null),
        }, icon('close')));
    }

    // -------------------------------------------------------------------------
    // Rendering

    render() {
      if (!this.host.isConnected) return;
      const stats = M.docStats(this.doc);
      this.summary.textContent = this.loaded
        ? `${plural(stats.folders, 'folder')} · ${plural(stats.playlists, 'playlist')} · ${plural(stats.videos, 'video')}`
        : '';
      this.collapseBtn.setAttribute('aria-expanded', String(!this.ui.collapsed));
      this.body.hidden = this.ui.collapsed;
      for (const button of [this.buttons.import, this.buttons.pull]) if (button) button.disabled = this.busy;
      this.tree.classList.toggle('pm-busy', this.busy);
      this.renderStatus();
      this.renderTree();
    }

    renderTree() {
      if (!this.loaded) {
        this.tree.replaceChildren(h('div', { class: 'pm-empty' }, 'Loading…'));
      } else if (M.isEmpty(this.doc)) {
        this.tree.replaceChildren(h('div', { class: 'pm-empty' },
          h('strong', null, 'Nothing here yet'),
          PM.pull
            ? 'Pull your playlists from YouTube, import a backup, or start by adding folders.'
            : 'Import a backup or start by adding folders.'));
      } else {
        const rows = [];
        this.addRows(rows, M.ROOT, 0);
        this.tree.replaceChildren(...rows);
      }
      if (this.editingId) {
        const input = this.tree.querySelector('.pm-rename');
        if (input && this.root.getRootNode().activeElement !== input) {
          input.focus();
          input.select();
        }
      }
    }

    addRows(rows, containerId, depth) {
      M.childrenOf(this.doc, containerId).forEach((id, index) => {
        const folder = M.getFolder(this.doc, id);
        if (folder) {
          rows.push(this.reuseOr(`f:${id}`, () => this.folderRow(id, folder, containerId, index, depth)));
          if (!folder.open) return;
          if (folder.children.length) this.addRows(rows, id, depth + 1);
          else rows.push(this.emptyRow(id, depth + 1, 'Empty folder. Drag folders or playlists here.'));
          return;
        }
        const playlist = M.getPlaylist(this.doc, id);
        if (!playlist) return;
        rows.push(this.reuseOr(`p:${id}`, () => this.playlistRow(id, playlist, containerId, index, depth)));
        if (!playlist.open) return;
        if (!playlist.items.length) rows.push(this.emptyRow(id, depth + 1, 'No videos. Drag videos here.'));
        playlist.items.forEach((item, i) => {
          rows.push(this.reuseOr(`v:${id}:${i}`, () => this.videoRow(id, item, i, depth + 1)));
        });
      });
    }

    /** While a row is being dragged its element is kept: replacing it would detach the element the browser is dragging. */
    reuseOr(key, create) {
      return this.dragSource?.key === key ? this.dragSource.el : create();
    }

    folderRow(id, folder, parent, index, depth) {
      const editing = this.editingId === id;
      const stats = M.folderStats(this.doc, id);
      const meta = stats.folders || stats.playlists
        ? `${plural(stats.playlists, 'playlist')} · ${plural(stats.videos, 'video')}`
        : 'Empty';
      return h('div', {
        class: 'pm-row pm-row--folder',
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-expanded': String(folder.open),
        draggable: editing ? 'false' : 'true',
        style: { '--depth': depth },
        dataset: { kind: 'folder', id, parent, index, open: String(folder.open), label: folder.name },
      },
        this.twisty(folder.open, folder.name),
        icon('folder', 'pm-icon pm-kind'),
        editing ? this.renameInput(id, folder.name) : h('span', { class: 'pm-name', title: folder.name }, folder.name),
        editing ? null : h('span', { class: 'pm-meta' }, meta),
        h('span', { class: 'pm-spacer' }),
        editing ? null : h('span', { class: 'pm-row-actions' },
          this.actionButton('add-folder', 'folderPlus', `New folder inside “${folder.name}”`),
          this.actionButton('rename', 'pencil', `Rename “${folder.name}”`),
          this.actionButton('delete', 'trash', `Delete “${folder.name}”`, 'pm-danger')));
    }

    playlistRow(id, playlist, parent, index, depth) {
      const privacy = playlist.youtube?.status?.privacyStatus;
      return h('div', {
        class: 'pm-row pm-row--playlist',
        role: 'treeitem',
        'aria-level': depth + 1,
        'aria-expanded': String(playlist.open),
        draggable: 'true',
        style: { '--depth': depth },
        dataset: { kind: 'playlist', id, parent, index, open: String(playlist.open), label: playlist.title },
      },
        this.twisty(playlist.open, playlist.title),
        icon('playlist', 'pm-icon pm-kind'),
        h('span', { class: 'pm-name', title: playlist.title }, playlist.title),
        h('span', { class: 'pm-meta' }, plural(playlist.items.length, 'video')),
        privacy && privacy !== 'public' ? h('span', { class: 'pm-badge' }, privacy) : null,
        h('span', { class: 'pm-spacer' }),
        h('span', { class: 'pm-row-actions' },
          this.link(`https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`, 'Open on YouTube', 'pm-icon-btn', icon('external'))));
    }

    videoRow(playlistId, item, index, depth) {
      const info = M.videoInfo(this.doc, item.videoId);
      const details = [info.channel, info.duration, info.unavailable ? 'Unavailable' : ''].filter(Boolean).join(' · ');
      const thumb = info.unavailable
        ? h('span', { class: 'pm-thumb' })
        : h('img', {
          class: 'pm-thumb',
          src: `https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/mqdefault.jpg`,
          alt: '',
          loading: 'lazy',
          draggable: 'false',
        });
      return h('div', {
        class: `pm-row pm-row--video${info.unavailable ? ' pm-row--unavailable' : ''}`,
        role: 'treeitem',
        'aria-level': depth + 1,
        draggable: 'true',
        style: { '--depth': depth },
        dataset: { kind: 'video', playlist: playlistId, index, label: info.title },
      },
        h('span', { class: 'pm-index' }, index + 1),
        thumb,
        h('span', { class: 'pm-video-text' },
          this.link(`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`, info.title, 'pm-link', info.title),
          details ? h('span', { class: 'pm-sub' }, details) : null));
    }

    emptyRow(containerId, depth, text) {
      return h('div', {
        class: 'pm-row pm-row--empty',
        role: 'none',
        style: { '--depth': depth },
        dataset: { kind: 'empty', container: containerId },
      }, text);
    }

    twisty(open, name) {
      return h('button', {
        class: 'pm-twisty',
        type: 'button',
        'aria-label': `${open ? 'Close' : 'Open'} “${name}”`,
        dataset: { action: 'toggle' },
      }, icon('chevron'));
    }

    actionButton(action, iconName, label, extraClass = '') {
      return h('button', {
        class: `pm-icon-btn ${extraClass}`.trim(),
        type: 'button',
        title: label,
        'aria-label': label,
        dataset: { action },
      }, icon(iconName));
    }

    link(href, label, className, content) {
      return h('a', { class: className, href, title: label, 'aria-label': label, draggable: 'false' }, content);
    }

    renameInput(id, name) {
      const input = h('input', { class: 'pm-rename', type: 'text', value: name, maxlength: '200', 'aria-label': 'Folder name' });
      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        this.editingId = null;
        if (save && M.renameFolder(this.doc, id, input.value)) this.commit();
        else this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true));
      return input;
    }

    // -------------------------------------------------------------------------
    // Tree interactions

    onTreeClick(e) {
      if (e.target.closest('a, input')) return;
      const row = e.target.closest('.pm-row');
      const { kind, id } = row?.dataset || {};
      if (kind !== 'folder' && kind !== 'playlist') return;
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'add-folder') return this.addFolder(id);
      if (action === 'rename') return this.startRename(id);
      if (action === 'delete') return this.deleteFolder(id);
      if (e.detail > 1) return; // the second click of a double-click
      this.toggle(id);
    }

    /** Double-clicking a folder's name renames it (and undoes the toggle from the first click). */
    onTreeDblClick(e) {
      const row = e.target.closest('.pm-row--folder');
      if (!row || !e.target.closest('.pm-name')) return;
      M.setOpen(this.doc, row.dataset.id);
      this.editingId = row.dataset.id;
      this.commit();
    }

    toggle(id) {
      if (M.setOpen(this.doc, id) !== null) this.commit();
    }

    addFolder(parentId) {
      this.editingId = M.addFolder(this.doc, parentId);
      this.commit();
    }

    startRename(id) {
      if (!M.isFolder(this.doc, id)) return;
      this.editingId = id;
      this.render();
    }

    deleteFolder(id) {
      const folder = M.getFolder(this.doc, id);
      if (!folder) return;
      const parent = M.parentOf(this.doc, id);
      const destination = parent === M.ROOT ? 'the top level' : `“${this.doc.folders[parent].name}”`;
      const count = folder.children.length;
      const question = count
        ? `Delete the folder “${folder.name}”?\n\nThe ${plural(count, 'item')} inside will move to ${destination}. No playlists or videos are deleted.`
        : `Delete the empty folder “${folder.name}”?`;
      if (!window.confirm(question)) return;
      M.deleteFolder(this.doc, id);
      this.commit();
    }

    // Drag and drop (called by PM.dnd) ------------------------------------------

    setDragSource(row, drag) {
      this.dragSource?.el.classList.remove('pm-dragging');
      if (!row) {
        this.dragSource = null;
        return;
      }
      const key = drag.kind === 'video' ? `v:${drag.playlist}:${drag.index}` : `${drag.kind[0]}:${drag.id}`;
      this.dragSource = { el: row, key };
      // Dim the row only after the browser has captured it as the drag image.
      requestAnimationFrame(() => {
        if (this.dragSource?.el === row) row.classList.add('pm-dragging');
      });
    }

    openWhileDragging(id) {
      if (M.setOpen(this.doc, id, true) !== null) this.commit();
    }

    applyDrop(drag, result) {
      const moved = result.type === 'node'
        ? M.moveNode(this.doc, drag.id, result.parent, result.index)
        : M.moveVideo(this.doc, drag.playlist, drag.index, result.playlist, result.index);
      if (!moved) {
        this.render();
        return;
      }
      // Keep the moved item in view by opening the folder or playlist it went into.
      const container = result.type === 'node' ? result.parent : result.playlist;
      if (container !== M.ROOT) M.setOpen(this.doc, container, true);
      this.commit();
    }

    // -------------------------------------------------------------------------
    // Import and export

    exportBackup() {
      const json = JSON.stringify(M.toBackup(this.doc), null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = h('a', { href: url, download: `youtube-playlist-manager-backup-${dateStamp()}.json`, hidden: true });
      this.root.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      this.setStatus(`Exported ${describe(M.docStats(this.doc))}.`, 'success');
    }

    async importFile(input) {
      const file = input.files?.[0];
      input.value = ''; // lets the same file be chosen again later
      if (!file) return;

      let doc;
      try {
        doc = M.parseBackup(await file.text());
      } catch (err) {
        const problems = err.problems || [err.message];
        if (problems.length === 1) this.setStatus(`Couldn't import “${file.name}”: ${problems[0]}`, 'error');
        else this.setStatus(`Couldn't import “${file.name}” because of these problems:`, 'error', problems);
        return;
      }

      const incoming = M.docStats(doc);
      if (!M.isEmpty(this.doc)) {
        const question = `Replace your current library (${describe(M.docStats(this.doc))}) ` +
          `with “${file.name}” (${describe(incoming)})?\n\nExport first if you want to keep the current one.`;
        if (!window.confirm(question)) return;
      }
      try {
        await this.replaceDoc(doc);
        this.setStatus(`Imported ${describe(incoming)}.`, 'success');
      } catch (err) {
        this.reportError(err);
      }
    }
  }

  PM.Dashboard = Dashboard;
})();
