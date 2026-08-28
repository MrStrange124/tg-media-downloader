// Focused probe for two failures: "download all" timing out, and selection
// mode saving only one item. Downloads nothing.
(async function () {
  'use strict';

  const out = { at: new Date().toISOString(), steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name: name, ok: ok, detail: detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function save() {
    await chrome.storage.local.set({ 'diag:walk': out });
    console.log('[TGMD] walk diagnostics', out);
  }

  if (typeof TGMD === 'undefined' || !TGMD.selectors) {
    step('content-script', false, 'TGMD not present');
    await save();
    return;
  }

  const sel = TGMD.selectors;
  const url = () => { const d = sel.viewer.descriptor(); return d ? d.url : null; };

  // ---- 1. what does tiles() actually return? -----------------------------
  const c = sel.grid.scroller();
  if (!c) {
    step('grid-container', false, 'no .Media.scroll-item tiles visible — open chat info, then the Media tab');
    await save();
    return;
  }
  step('grid-container', true, {
    tag: c.tagName, cls: String(c.className).slice(0, 100),
    scrollHeight: c.scrollHeight, clientHeight: c.clientHeight
  });

  const tiles0 = sel.grid.tiles();
  step('tiles-initial', tiles0.length > 0, {
    count: tiles0.length,
    sample: tiles0.slice(0, 3).map((t) => ({
      tag: t.tagName, cls: String(t.className).slice(0, 80),
      id: t.id, kind: sel.grid.tileKind(t),
      w: t.clientWidth, h: t.clientHeight,
      mediaChildren: t.querySelectorAll('img, video').length
    })),
    distinctKeys: new Set(tiles0.map((t) => sel.grid.tileKey(t))).size,
    distinctElements: new Set(tiles0).size
  });

  // ---- 2. does scrolling detach previously collected tiles? --------------
  const before = sel.grid.tiles().slice(0, 10);
  const topBefore = c.scrollTop;
  c.scrollTop = c.scrollHeight;
  await sleep(1200);
  const stillAttached = before.filter((t) => document.contains(t)).length;
  const afterCount = sel.grid.tiles().length;
  c.scrollTop = topBefore;
  await sleep(600);

  step('virtualisation', null, {
    sampled: before.length,
    stillAttachedAfterScroll: stillAttached,
    detached: before.length - stillAttached,
    tileCountAfterScrollToBottom: afterCount,
    verdict: stillAttached < before.length
      ? 'GRID IS VIRTUALISED — holding tile references across scrolling is invalid'
      : 'tiles survive scrolling'
  });

  // ---- 3. does clicking a live tile open the viewer? ---------------------
  const live = sel.grid.tiles();
  if (!live.length) {
    step('click-opens-viewer', false, 'no tiles after scroll restore');
    await save();
    return;
  }
  live[0].click();
  await sleep(1500);
  const u1 = url();
  step('click-opens-viewer', !!u1, {
    viewerOpen: sel.viewer.isOpen(),
    descriptorUrl: u1 ? u1.slice(0, 110) : null
  });

  // ---- 4. how long does the opened item take to expose a URL? -----------
  if (!u1) {
    const states = [];
    for (let i = 0; i < 10; i++) {
      states.push(sel.mediaState());
      await sleep(1000);
      if (url()) break;
    }
    step('media-url-wait', !!url(), {
      resolvedAfterSeconds: url() ? states.length : null,
      stages: states.map((x) => x.stage),
      last: states[states.length - 1]
    });
  }

  await sel.viewer.close();
  await sleep(400);
  step('closed', !sel.viewer.isOpen(), null);

  await save();
})();
