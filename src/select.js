(function (root) {
  'use strict';

  let active = false;
  // Keys, not elements: the grid is virtualised, so an element selected before
  // scrolling may be detached by the time the run starts.
  const chosen = new Set();

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

  function decorate() {
    for (const tile of root.TGMD.selectors.grid.tiles()) {
      if (!tile.appendChild) continue;                       // e.g. a bare <img>
      if (tile.querySelector && tile.querySelector('.tgmd-check')) continue;

      const key = root.TGMD.selectors.grid.tileKey(tile);
      if (!key) continue;

      const box = document.createElement('div');
      box.className = 'tgmd-check';
      if (chosen.has(key)) box.classList.add('tgmd-checked');

      box.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const on = !chosen.has(key);
        if (on) chosen.add(key); else chosen.delete(key);
        box.classList.toggle('tgmd-checked', on);
        announce();
      }, true);

      try {
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
      } catch (e) { /* detached */ }
      tile.appendChild(box);
    }
    announce();
  }

  // The grid recycles nodes as you scroll, so freshly rendered tiles need
  // decorating too. Only runs while selection mode is on.
  let observer = null;
  function watch(on) {
    if (on) {
      const c = root.TGMD.selectors.grid.container();
      if (!c || observer) return;
      observer = new MutationObserver(() => { if (active) decorate(); });
      observer.observe(c, { childList: true, subtree: true });
    } else if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function undecorate() {
    for (const b of document.querySelectorAll('.tgmd-check')) b.remove();
    chosen.clear();
    announce();
  }

  function toggle() {
    active = !active;
    if (active) { decorate(); watch(true); }
    else { watch(false); undecorate(); }
  }

  root.TGMD.select = {
    toggle: toggle,
    chosen: () => new Set(chosen),
    get active() { return active; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
