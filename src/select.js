(function (root) {
  'use strict';

  let active = false;
  const chosen = new Set();

  function announce() {
    const btn = document.querySelector('.tgmd-panel [data-act="select"], .tgmd-panel [data-act="download-selected"]');
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
    chosen.clear();
    for (const tile of root.TGMD.selectors.grid.tiles()) {
      if (tile.querySelector && tile.querySelector('.tgmd-check')) continue;
      const box = document.createElement('div');
      box.className = 'tgmd-check';
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const on = !chosen.has(tile);
        if (on) chosen.add(tile); else chosen.delete(tile);
        box.classList.toggle('tgmd-checked', on);
        announce();
      }, true);
      if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
      tile.appendChild(box);
    }
    announce();
  }

  function undecorate() {
    for (const b of document.querySelectorAll('.tgmd-check')) b.remove();
    chosen.clear();
    announce();
  }

  function toggle() {
    active = !active;
    if (active) decorate(); else undecorate();
  }

  root.TGMD.select = {
    toggle: toggle,
    chosen: () => Array.from(chosen),
    get active() { return active; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
