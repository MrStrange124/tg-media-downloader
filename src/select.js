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

  // Repaint every live tile: virtualisation recycles nodes and drops the class.
  function repaint() {
    for (const tile of sel().grid.tiles()) {
      const key = sel().grid.tileKey(tile);
      if (!key) continue;
      tile.classList.toggle('tgmd-selected', chosen.has(key));
    }
    announce();
  }

  // The grid cell is a real element with its own class and id, so resolving a
  // click is just closest(). Earlier versions tried to infer the cell by
  // counting media descendants, which could never work: Media.tsx always
  // renders two <img> per tile (thumbnail + full), so a "exactly one media
  // element" test matched the wrong node or nothing at all.
  function tileFromEvent(e) {
    const node = e.target;
    return node && node.closest ? node.closest(sel().S.TILE) : null;
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
    if (!sel().grid.tiles().length) return false;
    clickHook = onGridClick;
    // Document-level capture fires before Telegram's own tile handler
    // regardless of how the grid is nested or re-created.
    document.addEventListener('click', clickHook, true);
    const watched = sel().grid.scroller() || document.body;
    observer = new MutationObserver(() => { if (active) repaint(); });
    observer.observe(watched, { childList: true, subtree: true });
    document.body.classList.add('tgmd-selecting');
    repaint();
    return true;
  }

  function detach() {
    if (clickHook) document.removeEventListener('click', clickHook, true);
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
