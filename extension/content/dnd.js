/*
 * Drag and drop in the dashboard tree.
 *
 * zoneFor() and resolveDrop() decide what a drop would do; they are pure and
 * unit-tested. attach() wires them to the browser's native drag events.
 * Several selected rows can be dragged together. Videos are copied instead of
 * moved when Alt or Ctrl is held, or when they come from Liked videos.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  const AUTO_OPEN_MS = 700;
  const SCROLL_EDGE = 32;
  const SCROLL_STEP = 14;

  /** Which part of a row the pointer is over: y is 0 at the row's top and 1 at its bottom. */
  function zoneFor(targetKind, dragKind, y) {
    if (targetKind === 'empty' || targetKind === 'end') return 'inside';
    if (dragKind === 'video') {
      if (targetKind === 'playlist') return 'inside';
      if (targetKind === 'video') return y < 0.5 ? 'before' : 'after';
      return null;
    }
    if (targetKind === 'folder') return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
    if (targetKind === 'playlist') return y < 0.5 ? 'before' : 'after';
    return null;
  }

  /**
   * What dropping `drag` on `target` in `zone` would do, or null when it isn't allowed.
   *
   *   drag    { kind: 'node', ids: [folder or playlist IDs] }  or  { kind: 'video', items: [{ playlist, index }] }
   *   target  { kind: 'folder' | 'playlist', id, parent, index, open }
   *           { kind: 'video', playlist, index }
   *           { kind: 'empty', container }   placeholder row inside an open, empty folder or playlist
   *           { kind: 'end' }                blank space below the last row (top level)
   *
   * Returns { type: 'node', parent, index } or { type: 'video', playlist, index },
   * where index means "before the entry currently at that position".
   */
  function resolveDrop(doc, drag, target, zone) {
    const M = PM.model;
    if (!drag || !target || !zone) return null;

    if (drag.kind === 'video') {
      const editable = (id) => M.isPlaylist(doc, id) && !M.isReadOnly(doc.playlists[id]);
      if (target.kind === 'playlist' && zone === 'inside' && editable(target.id)) {
        return { type: 'video', playlist: target.id, index: doc.playlists[target.id].items.length };
      }
      if (target.kind === 'video' && zone !== 'inside' && editable(target.playlist)) {
        return { type: 'video', playlist: target.playlist, index: target.index + (zone === 'after' ? 1 : 0) };
      }
      if (target.kind === 'empty' && editable(target.container)) {
        return { type: 'video', playlist: target.container, index: 0 };
      }
      return null;
    }

    let parent;
    let index;
    if (target.kind === 'end') {
      parent = M.ROOT;
      index = doc.root.length;
    } else if (target.kind === 'empty' && M.isFolder(doc, target.container)) {
      parent = target.container;
      index = 0;
    } else if (target.kind === 'folder' && zone === 'inside') {
      parent = target.id;
      index = M.childrenOf(doc, target.id).length;
    } else if (target.kind === 'folder' && zone === 'after' && target.open && M.childrenOf(doc, target.id).length) {
      // Right below an open folder's row is where its first child goes.
      parent = target.id;
      index = 0;
    } else if ((target.kind === 'folder' || target.kind === 'playlist') && zone !== 'inside') {
      parent = target.parent;
      index = target.index + (zone === 'after' ? 1 : 0);
    } else {
      return null;
    }
    if (drag.ids.includes(target.id) || !drag.ids.every((id) => M.canMoveNode(doc, id, parent))) return null;
    return { type: 'node', parent, index };
  }

  /** Reads the drop-target description that the dashboard stores in a row's data attributes. */
  function describeRow(row) {
    const d = row.dataset;
    switch (d.kind) {
      case 'folder':
      case 'playlist':
        return { kind: d.kind, id: d.id, parent: d.parent, index: Number(d.index), open: d.open === 'true' };
      case 'video':
        return { kind: 'video', playlist: d.playlist, index: Number(d.index) };
      case 'empty':
        return { kind: 'empty', container: d.container };
      default:
        return null;
    }
  }

  const wantsCopy = (e) => e.altKey || e.ctrlKey || e.metaKey;

  function autoScroll(scroller, clientY) {
    const rect = scroller.getBoundingClientRect();
    if (clientY < rect.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_STEP;
    else if (clientY > rect.bottom - SCROLL_EDGE) scroller.scrollTop += SCROLL_STEP;
  }

  /**
   * Wires drag and drop to `tree`. The dashboard (`app`) provides:
   *   app.doc, app.beginDrag(row) → drag description (or null), app.endDrag(),
   *   app.openWhileDragging(id), app.applyDrop(drag, result, { copy })
   */
  function attach(app, tree) {
    let drag = null;
    let pending = null;
    let marked = null;
    let openTimer = null;
    let openTarget = null;

    const unmark = () => {
      marked?.classList.remove('pm-drop-before', 'pm-drop-after', 'pm-drop-inside', 'pm-drop-end');
      marked = null;
    };
    const cancelAutoOpen = () => {
      clearTimeout(openTimer);
      openTimer = null;
      openTarget = null;
    };
    const reset = () => {
      if (!drag) return;
      drag = null;
      pending = null;
      unmark();
      cancelAutoOpen();
      app.endDrag();
    };

    // Hovering over a closed folder (or a closed playlist while dragging videos) opens it.
    const autoOpen = (target, zone) => {
      const closed = zone === 'inside' && (target.kind === 'folder' || target.kind === 'playlist') && !target.open;
      const id = closed ? target.id : null;
      if (id === openTarget) return;
      cancelAutoOpen();
      if (!id) return;
      openTarget = id;
      openTimer = setTimeout(() => {
        openTimer = null;
        if (drag) app.openWhileDragging(id);
      }, AUTO_OPEN_MS);
    };

    tree.addEventListener('dragstart', (e) => {
      const row = e.target.closest?.('.pm-row');
      if (!row || row.getAttribute('draggable') !== 'true') return;
      drag = app.beginDrag(row);
      if (!drag) return;
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', row.dataset.label || '');
      row.addEventListener('dragend', reset, { once: true });
    });

    tree.addEventListener('dragover', (e) => {
      if (!drag) return;
      autoScroll(tree, e.clientY);

      const row = e.target.closest?.('.pm-row');
      const target = row ? describeRow(row) : { kind: 'end' };
      let zone = 'inside';
      if (row && target) {
        const rect = row.getBoundingClientRect();
        zone = zoneFor(target.kind, drag.kind, (e.clientY - rect.top) / rect.height);
      }

      unmark();
      pending = target && resolveDrop(app.doc, drag, target, zone);
      if (!pending) {
        e.dataTransfer.dropEffect = 'none';
        cancelAutoOpen();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = drag.kind === 'video' && (drag.fromReadOnly || wantsCopy(e)) ? 'copy' : 'move';
      marked = row || tree;
      marked.classList.add(row ? `pm-drop-${zone}` : 'pm-drop-end');
      autoOpen(target, zone);
    });

    tree.addEventListener('dragleave', (e) => {
      if (drag && !tree.contains(e.relatedTarget)) {
        unmark();
        cancelAutoOpen();
        pending = null;
      }
    });

    tree.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      const source = drag;
      const result = pending;
      reset();
      if (result) app.applyDrop(source, result, { copy: wantsCopy(e) });
    });
  }

  const dnd = { zoneFor, resolveDrop, attach };

  PM.dnd = dnd;
  if (typeof module === 'object' && module.exports) module.exports = dnd;
})();
