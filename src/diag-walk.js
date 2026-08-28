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
  const c = sel.grid.container();
  if (!c) {
    step('grid-container', false, 'no scrollable container found in #RightColumn');
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
      w: t.clientWidth, h: t.clientHeight,
      // if many tiles share one ancestor, closest() picked too high
      isSameAsNext: t === tiles0[1]
    })),
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

  // ---- 4. does advance() actually move to the next item? ----------------
  if (u1) {
    sel.viewer.advance();
    await sleep(1800);
    const u2 = url();
    step('advance-arrowright', u2 !== null && u2 !== u1, {
      before: u1.slice(0, 60), after: u2 ? u2.slice(0, 60) : null,
      changed: u2 !== u1
    });

    // 4b. if ArrowRight did nothing, find out what does.
    if (u2 === u1) {
      const alts = [];

      const onWindow = () => {
        const init = { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true };
        window.dispatchEvent(new KeyboardEvent('keydown', init));
      };
      onWindow();
      await sleep(1500);
      alts.push({ method: 'keydown on window', changed: url() !== u1 });

      if (url() === u1) {
        const buttons = Array.from(document.querySelectorAll('#MediaViewer button'));
        alts.push({
          method: 'inventory of viewer buttons',
          buttons: buttons.map((b) => ({
            aria: b.getAttribute('aria-label'),
            title: b.getAttribute('title'),
            cls: String(b.className).slice(0, 70)
          }))
        });
        const next = buttons.find((b) => /next|forward/i.test(
          (b.getAttribute('aria-label') || '') + ' ' +
          (b.getAttribute('title') || '') + ' ' + b.className));
        if (next) {
          next.click();
          await sleep(1500);
          alts.push({ method: 'click next-like button', changed: url() !== u1 });
        }
      }
      step('advance-alternatives', null, alts);
    }
  }

  await sel.viewer.close();
  await sleep(400);
  step('closed', !sel.viewer.isOpen(), null);

  await save();
})();
