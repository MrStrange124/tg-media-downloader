(function (root) {
  'use strict';

  let active = false;
  let observer = null;
  let clickHook = null;

  // Keys, not elements: the grid is virtualised, so an element selected before
  // scrolling may be detached by the time the run starts.
  const chosen = new Set();

  const sel = () => root.TGMD.selectors;

  function announce() {
    const btn = document.querySelector(
      '.tgmd-panel [data-act="select"], .tgmd-panel [data-act="download-selected"]');
    if (!btn) return;
    if (!active) {
      btn.textContent = 'Select media…';
      btn.dataset.act = 'select';
    } else if (chosen.size) {
      btn.textContent = 'Download selected (' + chosen.size + ')';
      btn.dataset.act = 'download-selected';
    } else {
      btn.textContent = 'Selecting — tap tiles';
      btn.dataset.act = 'select';
    }
  }

  // Paint every live tile according to whether its key is chosen. Called after
  // any grid mutation because recycling drops the class.
  function repaint() {
    for (const tile of sel().grid.tiles()) {
      const key = sel().grid.tileKey(tile);
      if (!key) continue;
      tile.classList.toggle('tgmd-selected', chosen.has(key));
    }
    announce();
  }

  // Resolve whatever was clicked to one of the grid's tiles.
  //
  // Direct matching against tiles() is not enough: since tiles() resolves to
  // the media element itself, and Telegram lays a clickable overlay *above*
  // the thumbnail, e.target is usually that overlay — which an <img> can
  // never contain. So walk up until we find the subtree holding exactly one
  // media element; that subtree is the grid cell.
  function tileFromEvent(e) {
    const c = sel().grid.container();
    if (!c) return null;

    let node = e.target;
    for (let hop = 0; hop < 8 && node && node !== c; hop++) {
      if (node.querySelectorAll) {
        const media = node.querySelectorAll('img, video');
        if (media.length === 1) return normalise(media[0]);
        if (media.length > 1) break;   // gone too far: this holds several cells
      }
      node = node.parentElement;
    }

    // Fall back to a direct hit on a media element or a tile.
    if (e.target.tagName === 'IMG' || e.target.tagName === 'VIDEO') {
      return normalise(e.target);
    }
    for (const t of sel().grid.tiles()) {
      if (t === e.target || (t.contains && t.contains(e.target))) return t;
    }
    return null;
  }

  // Match the same element tiles() would have produced for this media node,
  // so the key we store lines up with the key the run engine looks for.
  function normalise(media) {
    const tiles = sel().grid.tiles();
    for (const t of tiles) {
      if (t === media || (t.contains && t.contains(media))) return t;
    }
    return media;
  }

  function onGridClick(e) {
    if (!active) return;
    const tile = tileFromEvent(e);
    if (!tile) return;
    const key = sel().grid.tileKey(tile);
    if (!key) return;

    // Swallow the click so Telegram does not open the media viewer.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (chosen.has(key)) chosen.delete(key); else chosen.add(key);
    tile.classList.toggle('tgmd-selected', chosen.has(key));
    announce();
  }

  function attach() {
    const c = sel().grid.container();
    if (!c) return false;
    clickHook = onGridClick;
    c.addEventListener('click', clickHook, true);   // capture, before Telegram
    observer = new MutationObserver(() => { if (active) repaint(); });
    observer.observe(c, { childList: true, subtree: true });
    document.body.classList.add('tgmd-selecting');
    repaint();
    return true;
  }

  function detach() {
    const c = sel().grid.container();
    if (c && clickHook) c.removeEventListener('click', clickHook, true);
    clickHook = null;
    if (observer) { observer.disconnect(); observer = null; }
    for (const t of document.querySelectorAll('.tgmd-selected')) {
      t.classList.remove('tgmd-selected');
    }
    document.body.classList.remove('tgmd-selecting');
  }

  function toggle() {
    if (!active) {
      if (!attach()) return;
      active = true;
    } else {
      active = false;
      detach();
      chosen.clear();
    }
    announce();
  }

  root.TGMD.select = {
    toggle: toggle,
    chosen: () => new Set(chosen),
    clear: () => { chosen.clear(); repaint(); },
    get active() { return active; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
