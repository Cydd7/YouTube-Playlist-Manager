/*
 * Small DOM helpers. The dashboard is built from elements, never from HTML
 * strings: YouTube enforces Trusted Types, so innerHTML throws on its pages.
 */
(() => {
  'use strict';

  const PM = (globalThis.PM ??= {});
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * h('button', { class: 'pm-btn', title: 'Delete', onclick: fn, dataset: { id } }, 'Label', child)
   * Props that are null, undefined or false are skipped; `true` sets an empty attribute.
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    el.append(...present(children));
    return el;
  }

  /** Replaces an element's children, skipping null, undefined and false as h() does. */
  function fill(el, ...children) {
    el.replaceChildren(...present(children));
  }

  // DOM methods would turn a null child into the text "null".
  function present(children) {
    return children.flat(Infinity).filter((c) => c != null && c !== false);
  }

  // 24×24 stroke icons.
  const ICONS = {
    chevron: ['M9 6l6 6-6 6'],
    folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
    folderPlus: [
      'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
      'M12 11v5M9.5 13.5h5',
    ],
    playlist: ['M3 6h13M3 11h13M3 16h7', 'M15 14v6l5-3z'],
    pencil: ['M4 20h4L18.5 9.5l-4-4L4 16v4z', 'M13 7l4 4'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M10 11v6M14 11v6'],
    external: ['M14 4h6v6', 'M20 4l-8 8', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    import: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 20h16'],
    export: ['M12 15V4', 'M7 9l5-5 5 5', 'M4 20h16'],
    pull: ['M12 11v9', 'M8.5 16.5L12 20l3.5-3.5', 'M7 17a5 5 0 0 1-1-9.9A6 6 0 0 1 17.7 8 4.5 4.5 0 0 1 17 17'],
    push: ['M12 20v-9', 'M8.5 14.5L12 11l3.5 3.5', 'M7 17a5 5 0 0 1-1-9.9A6 6 0 0 1 17.7 8 4.5 4.5 0 0 1 17 17'],
    close: ['M6 6l12 12M18 6L6 18'],
    heart: ['M12 20l-7-7a4.5 4.5 0 0 1 7-5.6 4.5 4.5 0 0 1 7 5.6z'],
    undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
    redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
    search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  };

  function icon(name, className = 'pm-icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  /** plural(3, 'video') → "3 videos" */
  function plural(n, word) {
    return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  }

  PM.dom = { h, fill, icon, plural };
})();
