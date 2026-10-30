/*
 * Dashboard styles. They live in the dashboard's shadow root, so YouTube's CSS
 * can't reach them and they can't leak onto YouTube. Sizes are in px because
 * YouTube sets the root font size to 10px.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});

  PM.css = `
:host {
  all: initial;
  display: block;
}

.pm {
  --pm-bg: #ffffff;
  --pm-surface: #f2f2f2;
  --pm-hover: rgba(0, 0, 0, 0.05);
  --pm-border: rgba(0, 0, 0, 0.1);
  --pm-text: #0f0f0f;
  --pm-muted: #606060;
  --pm-accent: #065fd4;
  --pm-accent-soft: rgba(6, 95, 212, 0.1);
  --pm-danger: #cc0000;
  --pm-danger-soft: rgba(204, 0, 0, 0.08);
  --pm-success: #107c10;
  --pm-thumb: #e5e5e5;
  --pm-on-accent: #ffffff;
  --pm-mark: rgba(255, 200, 0, 0.45);
  --pm-indent: 20px;

  box-sizing: border-box;
  font-family: "Roboto", "Arial", sans-serif;
  font-size: 14px;
  line-height: 20px;
  color: var(--pm-text);
  background: var(--pm-bg);
  border: 1px solid var(--pm-border);
  border-radius: 12px;
  overflow: hidden;
}

.pm[data-theme="dark"] {
  --pm-bg: #0f0f0f;
  --pm-surface: #272727;
  --pm-hover: rgba(255, 255, 255, 0.08);
  --pm-border: rgba(255, 255, 255, 0.14);
  --pm-text: #f1f1f1;
  --pm-muted: #aaaaaa;
  --pm-accent: #3ea6ff;
  --pm-accent-soft: rgba(62, 166, 255, 0.15);
  --pm-danger: #ff6b6b;
  --pm-danger-soft: rgba(255, 107, 107, 0.12);
  --pm-success: #6bd66b;
  --pm-thumb: #303030;
  --pm-on-accent: #0f0f0f;
  --pm-mark: rgba(255, 200, 0, 0.35);
}

.pm *, .pm *::before, .pm *::after { box-sizing: inherit; }
.pm [hidden] { display: none !important; }

.pm-icon {
  width: 18px;
  height: 18px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Header ------------------------------------------------------------------ */

.pm-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 12px;
}

.pm-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-right: auto;
}

.pm-title {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  line-height: 22px;
  white-space: nowrap;
}

.pm-summary {
  color: var(--pm-muted);
  font-size: 12px;
  white-space: nowrap;
}

.pm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pm-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 16px;
  background: var(--pm-surface);
  color: var(--pm-text);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.pm-btn:hover { background: var(--pm-hover); box-shadow: inset 0 0 0 1px var(--pm-border); }
.pm-btn:disabled { opacity: 0.5; cursor: default; }
.pm-btn--primary { background: var(--pm-accent); color: var(--pm-on-accent); }
.pm-btn--primary:hover { background: var(--pm-accent); filter: brightness(1.1); }
.pm-btn--danger { color: var(--pm-danger); }

.pm-count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--pm-accent);
  color: var(--pm-on-accent);
  font-size: 12px;
  line-height: 20px;
  text-align: center;
}
.pm-btn .pm-icon { width: 16px; height: 16px; }

.pm-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--pm-muted);
  cursor: pointer;
  text-decoration: none;
  flex: none;
}

.pm-icon-btn:hover { background: var(--pm-hover); color: var(--pm-text); }
.pm-icon-btn:disabled { opacity: 0.4; cursor: default; background: transparent; }
.pm-icon-btn.pm-danger:hover { background: var(--pm-danger-soft); color: var(--pm-danger); }
.pm-icon-btn .pm-icon { width: 16px; height: 16px; }

.pm-collapse .pm-icon { transition: transform 0.15s; }
.pm-collapse[aria-expanded="true"] .pm-icon { transform: rotate(90deg); }

:is(.pm-btn, .pm-icon-btn, .pm-twisty, .pm-link):focus-visible {
  outline: 2px solid var(--pm-accent);
  outline-offset: -2px;
}

/* Status line ---------------------------------------------------------------- */

.pm-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 12px 10px;
  padding: 8px 8px 8px 12px;
  border-radius: 8px;
  background: var(--pm-surface);
  font-size: 13px;
}

.pm-status[data-kind="error"] { background: var(--pm-danger-soft); color: var(--pm-danger); }
.pm-status[data-kind="ask"] { box-shadow: inset 0 0 0 1px var(--pm-accent); }
.pm-status-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.pm-status[data-kind="success"] { color: var(--pm-success); }
.pm-status-text { flex: 1; min-width: 0; padding-top: 4px; overflow-wrap: anywhere; }
.pm-status-text ul { margin: 4px 0 0; padding-left: 18px; }
.pm-status .pm-icon-btn { color: inherit; }

/* Tools: search, folder, undo and the selection ---------------------------------- */

.pm-body { border-top: 1px solid var(--pm-border); }

.pm-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pm-border);
}

.pm-search {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 220px;
  max-width: 420px;
}

.pm-search .pm-icon {
  position: absolute;
  left: 10px;
  width: 16px;
  height: 16px;
  color: var(--pm-muted);
  pointer-events: none;
}

.pm-search-input {
  width: 100%;
  height: 32px;
  padding: 0 12px 0 34px;
  border: 1px solid var(--pm-border);
  border-radius: 16px;
  background: var(--pm-bg);
  color: var(--pm-text);
  font: inherit;
}

.pm-search-input:focus { outline: none; border-color: var(--pm-accent); box-shadow: 0 0 0 2px var(--pm-accent-soft); }

.pm-selection {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-size: 13px;
}

.pm-selection-count { color: var(--pm-muted); white-space: nowrap; }

.pm mark {
  border-radius: 2px;
  background: var(--pm-mark);
  color: inherit;
}

/* Tree ----------------------------------------------------------------------- */

.pm-tree {
  max-height: min(60vh, 640px);
  min-height: 48px;
  overflow: auto;
  padding: 4px 0 24px;
  overscroll-behavior: contain;
}

.pm-tree.pm-busy { opacity: 0.5; pointer-events: none; }
.pm-tree:focus { outline: none; }
.pm-tree:focus-visible { outline: 2px solid var(--pm-accent); outline-offset: -2px; }

.pm-row {
  --depth: 0;
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 2px 8px 2px calc(8px + var(--depth) * var(--pm-indent));
  cursor: default;
  user-select: none;
}

.pm-row:hover { background: var(--pm-hover); }
.pm-row.pm-selected, .pm-row.pm-selected:hover { background: var(--pm-accent-soft); }
.pm-row--folder, .pm-row--playlist { cursor: pointer; }
.pm-row--video { min-height: 44px; }
.pm-row.pm-dragging { opacity: 0.4; }

.pm-twisty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--pm-muted);
  cursor: pointer;
  flex: none;
}

.pm-twisty .pm-icon { width: 16px; height: 16px; transition: transform 0.15s; }
.pm-row[aria-expanded="true"] .pm-twisty .pm-icon { transform: rotate(90deg); }

.pm-kind { color: var(--pm-muted); }
.pm-row--folder .pm-kind { color: var(--pm-accent); }
.pm-row--liked .pm-kind { color: var(--pm-danger); }

.pm-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm-row--folder .pm-name, .pm-row--playlist .pm-name { font-weight: 500; }

.pm-meta {
  flex: none;
  color: var(--pm-muted);
  font-size: 12px;
  white-space: nowrap;
}

.pm-badge {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--pm-surface);
  color: var(--pm-muted);
  font-size: 11px;
  line-height: 18px;
  text-transform: capitalize;
}

.pm-badge--pending {
  background: var(--pm-accent-soft);
  color: var(--pm-accent);
  text-transform: none;
}

.pm-spacer { flex: 1; }

/* Faded out rather than hidden so the buttons stay reachable with Tab. */
.pm-row-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
}

.pm-row:hover .pm-row-actions,
.pm-row:focus-within .pm-row-actions { opacity: 1; }

.pm-rename {
  flex: 1;
  min-width: 120px;
  max-width: 420px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--pm-accent);
  border-radius: 6px;
  background: var(--pm-bg);
  color: var(--pm-text);
  font: inherit;
}

.pm-rename:focus { outline: none; box-shadow: 0 0 0 2px var(--pm-accent-soft); }

.pm-index {
  width: 28px;
  flex: none;
  color: var(--pm-muted);
  font-size: 12px;
  text-align: right;
}

.pm-thumb {
  width: 64px;
  height: 36px;
  flex: none;
  border-radius: 4px;
  background: var(--pm-thumb);
  object-fit: cover;
}

.pm-video-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pm-link {
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm-link:hover { text-decoration: underline; }

.pm-sub {
  overflow: hidden;
  color: var(--pm-muted);
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pm-row--unavailable .pm-link,
.pm-row--unavailable .pm-thumb { opacity: 0.5; }

.pm-row--empty {
  min-height: 30px;
  color: var(--pm-muted);
  font-size: 12px;
  font-style: italic;
  cursor: default;
}

.pm-row--empty:hover { background: transparent; }

.pm-empty {
  padding: 24px 16px 28px;
  color: var(--pm-muted);
  text-align: center;
}

.pm-empty strong { display: block; margin-bottom: 4px; color: var(--pm-text); font-weight: 500; }

/* Drop indicators ------------------------------------------------------------- */

.pm-row.pm-drop-before::before,
.pm-row.pm-drop-after::after,
.pm-tree.pm-drop-end::after {
  content: "";
  position: absolute;
  right: 8px;
  left: calc(8px + var(--depth) * var(--pm-indent));
  height: 2px;
  border-radius: 1px;
  background: var(--pm-accent);
  pointer-events: none;
}

.pm-row.pm-drop-before::before { top: -1px; }
.pm-row.pm-drop-after::after { bottom: -1px; }

.pm-tree.pm-drop-end::after {
  position: static;
  display: block;
  margin: 2px 8px 0;
}

.pm-row.pm-drop-inside {
  background: var(--pm-accent-soft);
  box-shadow: inset 0 0 0 1px var(--pm-accent);
}
`;
})();
