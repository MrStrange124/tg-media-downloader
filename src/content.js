// Orchestration: fetch, save, enumerate, walk. All Telegram DOM access goes
// through TGMD.selectors — there are deliberately no Telegram class names here.
(function (root) {
  'use strict';

  const selectors = root.TGMD.selectors;
  const rangeFetch = root.TGMD.rangeFetch;
  const naming = root.TGMD.naming;
  const dedupe = root.TGMD.dedupe;
  const scroll = root.TGMD.scroll;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------- MAIN-world fetch bridge
  let mainWorldReady = false;
  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.__tgmd !== 'fetch-response') return;
    const resolver = pending.get(m.id);
    if (!resolver) return;
    pending.delete(m.id);
    resolver(m);
  });

  async function ensureMainWorld() {
    if (mainWorldReady) return;
    const res = await chrome.runtime.sendMessage({ type: 'TGMD_INJECT_MAIN' });
    if (!res || !res.ok) throw new Error('could not inject MAIN-world fetcher');
    mainWorldReady = true;
    await sleep(50);
  }

  // Presents the same shape as fetch() to rangeFetch.fetchRanged.
  async function mainWorldFetch(url, init) {
    await ensureMainWorld();
    const id = ++seq;
    const reply = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('main-world fetch timed out'));
      }, 120000);
    });
    window.postMessage({ __tgmd: 'fetch-request', id: id, url: url,
                         headers: (init && init.headers) || {} }, '*');
    const m = await reply;
    if (!m.ok) throw new Error(m.error);
    return {
      status: m.status,
      headers: { get: (k) => (m.headers[k] === undefined ? null : m.headers[k]) },
      blob: async () => m.blob
    };
  }

  // ------------------------------------------------------------------ fetch
  // Whether the content-script fetch reaches Telegram's service worker.
  // Determined once per page, then cached.
  let swFetchWorks = null;

  async function probeSwFetch(url) {
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-127' } });
      return res.status === 206 && !!res.headers.get('Content-Range');
    } catch (e) {
      return false;
    }
  }

  async function fetchMedia(desc, opts) {
    opts = opts || {};
    // blob: URLs are already fully buffered — one plain fetch.
    if (desc.url.startsWith('blob:')) {
      const res = await fetch(desc.url);
      if (!res.ok) throw new Error('blob fetch failed: ' + res.status);
      return res.blob();
    }

    if (swFetchWorks === null) swFetchWorks = await probeSwFetch(desc.url);

    const fetchImpl = swFetchWorks ? fetch.bind(window) : mainWorldFetch;
    const result = await rangeFetch.fetchRanged(desc.url, {
      fetchImpl: fetchImpl,
      onProgress: opts.onProgress || null,
      signal: opts.signal || null,
      maxRetries: 3
    });
    return result.blob;
  }

  // ------------------------------------------------------------------- save
  async function saveBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TGMD_DOWNLOAD', blobUrl: blobUrl, filename: filename
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'download rejected');
      return res.id;
    } finally {
      // The background worker holds its own reference until the download
      // completes; releasing ours later avoids revoking too early.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    }
  }

  async function subfolder() {
    const got = await chrome.storage.local.get('settings');
    const s = got.settings || {};
    return naming.sanitizeSegment(s.subfolder || 'Telegram');
  }

  // -------------------------------------------------------- single download
  async function downloadCurrent(opts) {
    opts = opts || {};
    const desc = selectors.viewer.descriptor();
    if (!desc) return { ok: false, error: 'no media open in the viewer' };

    const chatId = selectors.chat.id();
    if (!chatId) return { ok: false, error: 'could not determine chat id' };

    const messageKey = await dedupe.contentKey(desc.url);
    const record = dedupe.recordKey(chatId, messageKey);

    const seen = await chrome.storage.local.get(record);
    if (seen[record] && !opts.force) {
      return { ok: true, skipped: true, filename: seen[record] };
    }

    const folder = await subfolder();
    const filename = naming.buildFilename({
      chatTitle: selectors.chat.title(),
      date: new Date(),
      messageKey: messageKey,
      originalName: desc.originalName,
      mime: desc.mime
    }).replace(/^Telegram\//, folder + '/');

    const blob = await fetchMedia(desc, opts);
    await saveBlob(blob, filename);
    const rec = {};
    rec[record] = filename;
    await chrome.storage.local.set(rec);
    return { ok: true, filename: filename, bytes: blob.size };
  }

  // ------------------------------------------------------------- run engine
  const state = { running: false, paused: false, abort: null };

  async function enumerate(opts) {
    opts = opts || {};
    const c = selectors.grid.container();
    if (!c) throw new Error('shared-media grid not found — open chat info then Media');

    const tracker = scroll.makeStabilityTracker({ needed: 3 });
    for (let i = 0; i < 2000; i++) {
      c.scrollTop = c.scrollHeight;
      await sleep(350);
      if (opts.onCount) opts.onCount(selectors.grid.tiles().length);
      if (tracker.push({ scrollTop: c.scrollTop, scrollHeight: c.scrollHeight })) break;
    }
    return selectors.grid.tiles().length;
  }

  async function waitForMedia(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    while (Date.now() < deadline) {
      const d = selectors.viewer.descriptor();
      if (d && d.url) return d;
      await sleep(200);
    }
    return null;
  }

  async function start(opts) {
    opts = opts || {};
    const onEvent = opts.onEvent || function () {};
    if (state.running) throw new Error('a run is already in progress');
    state.running = true;
    state.paused = false;
    state.abort = new AbortController();

    const summary = { total: 0, saved: 0, skipped: 0, failed: [] };
    try {
      let list = opts.tiles;
      if (!list) {
        await enumerate({ onCount: (n) => onEvent({ type: 'progress', enumerated: n }) });
        list = selectors.grid.tiles();
      }
      summary.total = list.length;
      if (!list.length) throw new Error('no media tiles found');

      list[0].click();
      await sleep(600);

      for (let i = 0; i < list.length && state.running; i++) {
        while (state.paused && state.running) await sleep(300);
        if (!state.running) break;

        const desc = await waitForMedia();
        if (!desc) {
          summary.failed.push({ filename: 'item ' + (i + 1), error: 'media did not load in 20s' });
          onEvent({ type: 'item', index: i, ok: false, error: 'timeout' });
        } else {
          try {
            const res = await downloadCurrent({
              signal: state.abort.signal,
              onProgress: (p) => onEvent({ type: 'progress', index: i, received: p.received, total: p.total })
            });
            if (!res.ok) throw new Error(res.error);
            if (res.skipped) summary.skipped++; else summary.saved++;
            onEvent({ type: 'item', index: i, ok: true, filename: res.filename, skipped: !!res.skipped });
          } catch (e) {
            const msg = String(e && e.message || e);
            summary.failed.push({ filename: 'item ' + (i + 1), error: msg });
            onEvent({ type: 'item', index: i, ok: false, error: msg });
          }
        }

        if (i < list.length - 1 && state.running) {
          selectors.viewer.advance();
          await sleep(400);
        }
      }
    } finally {
      state.running = false;
      selectors.viewer.close();
      onEvent({ type: 'done', summary: summary });
    }
    return summary;
  }

  root.TGMD.core = {
    downloadCurrent: downloadCurrent,
    fetchMedia: fetchMedia,
    saveBlob: saveBlob,
    get swFetchWorks() { return swFetchWorks; }
  };

  root.TGMD.run = {
    enumerate: enumerate,
    start: start,
    pause: function () { state.paused = true; },
    resume: function () { state.paused = false; },
    stop: function () { state.running = false; if (state.abort) state.abort.abort(); },
    get isRunning() { return state.running; }
  };

  // Ctrl+Shift+D downloads whatever is open — a manual escape hatch that works
  // even if the panel fails to mount.
  document.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      console.log('[TGMD] downloading current…');
      try {
        console.log('[TGMD]', await downloadCurrent());
      } catch (err) {
        console.error('[TGMD] failed', err);
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => root.TGMD.panel.mount());
  } else {
    root.TGMD.panel.mount();
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
