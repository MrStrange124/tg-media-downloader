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
  // Two ways to put bytes on disk. When the user has granted a folder we write
  // straight into it, which involves no browser download and therefore cannot
  // be interrupted by a save dialog. Otherwise fall back to chrome.downloads so
  // the extension still works with no folder configured.
  async function saveBlob(blob, filename) {
    const fsa = root.TGMD.fsa;
    if (fsa && await fsa.ready()) {
      const path = await fsa.write(filename, blob);
      return { mode: 'disk', path: path };
    }

    const blobUrl = URL.createObjectURL(blob);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TGMD_DOWNLOAD', blobUrl: blobUrl, filename: filename
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'download rejected');
      return { mode: 'downloads', id: res.id };
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
    const previous = seen[record];
    if (previous && !opts.force) {
      // Only trust the record when it names the same kind of file we are about
      // to save. If a key ever collided across kinds, silently skipping would
      // drop the item entirely; re-downloading is the safe direction to err in.
      const wantExt = naming.extFromMime(desc.mime);
      const hadExt = String(previous).split('.').pop().toLowerCase();
      if (hadExt === wantExt) return { ok: true, skipped: true, filename: previous };
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
    const saved = await saveBlob(blob, filename);
    const written = saved.path || filename;

    // Only meaningful for the downloads API: records who Brave credits for the
    // download. Writing to disk has no DownloadItem to audit.
    let audit = null;
    if (saved.mode === 'downloads') {
      try {
        audit = await chrome.runtime.sendMessage({ type: 'TGMD_DOWNLOAD_INFO', id: saved.id });
      } catch (e) { /* audit is best effort */ }
    }
    const rec = {};
    rec[record] = written;
    await chrome.storage.local.set(rec);
    return { ok: true, filename: written, bytes: blob.size, audit: audit, via: saved.mode };
  }

  // ------------------------------------------------------------- run engine
  //
  // The shared-media grid is virtualised: scrolling recycles tile elements out
  // of the DOM. So we never hold element references across a scroll. Identity
  // is the tile's own id (`shared-media` + `message-<id>`, from Media.tsx),
  // which stays correct even when the underlying node is reused.
  //
  // Navigation is click-per-tile rather than ArrowRight. ArrowRight walks every
  // media item in the chat, which is simply wrong for a selected subset, and it
  // depends on synthetic key events being honoured.

  const state = { running: false, paused: false, abort: null };
  const MAX_ITEMS = 5000;

  const tileKey = (t) => selectors.grid.tileKey(t);

  // Telegram resolves a video's URL asynchronously. Until it does,
  // MediaViewerContent paints a poster-only <video> carrying no src at all, so
  // a short deadline reports "no URL" for a video that is merely still
  // loading. Photos are ready almost immediately; videos get far longer.
  const OPEN_TIMEOUT = { image: 20000, gif: 60000, video: 180000 };

  async function openTile(tile, kind) {
    tile.click();
    const started = Date.now();
    const budget = OPEN_TIMEOUT[kind] || OPEN_TIMEOUT.image;
    let last = null;

    let stable = null;
    while (Date.now() - started < budget) {
      const d = selectors.viewer.descriptor();
      if (d && d.url) {
        // Require the same URL on two consecutive polls. A click can land while
        // the viewer is still showing the previous item, and accepting that
        // would download the wrong media -- or dedupe against it and skip.
        if (stable === d.url) return d;
        stable = d.url;
      } else {
        stable = null;
      }
      last = selectors.mediaState();
      // The click never landed at all — fail in seconds rather than burning a
      // three-minute video budget waiting on a viewer that never opened.
      if (last.stage === 'viewer-closed' && Date.now() - started > 6000) break;
      await sleep(200);
    }

    // Distinguish "never opened" from "opened but the media had no URL yet" —
    // reporting both as a generic timeout hides which layer actually failed.
    const secs = Math.round((Date.now() - started) / 1000);
    const err = new Error('no media URL after ' + secs + 's (' + (last ? last.stage : 'unknown') + ')');
    err.mediaState = last;
    throw err;
  }

  // Asks Brave who it thinks started the recent downloads. A save dialog on a
  // file Brave does not attribute to this extension means the prompt is
  // page-initiated — a completely different fault from anything in our own
  // download call, which always passes saveAs:false.
  async function auditRecent() {
    try {
      const a = await chrome.runtime.sendMessage({ type: 'TGMD_DOWNLOAD_AUDIT' });
      if (!a || !a.ok) return null;
      const foreign = a.items.filter((d) => !d.fromOurExtension);
      return {
        checked: a.items.length,
        ours: a.items.length - foreign.length,
        foreign: foreign.map((d) => d.byExtensionName || d.byExtensionId || 'the page itself')
      };
    } catch (e) {
      return null;
    }
  }

  async function pauseGate() {
    while (state.paused && state.running) await sleep(300);
  }

  // Sweeps the grid top to bottom, processing every tile it can reach. When
  // `wantKeys` is given, only those tiles are downloaded — everything else is
  // skipped, but the sweep still runs so selections anywhere in the grid are
  // reachable.
  async function start(opts) {
    opts = opts || {};
    const onEvent = opts.onEvent || function () {};
    const wantKeys = opts.tileKeys || null;
    // Ticking tiles by hand is an explicit request for those files, so a
    // selection run ignores the downloaded-already history.
    const force = !!opts.force;
    if (state.running) throw new Error('a run is already in progress');
    state.running = true;
    state.paused = false;
    state.abort = new AbortController();

    const summary = { total: 0, saved: 0, skipped: 0, failed: [] };
    const done = new Set();

    try {
      // The tiles' grid div does not scroll; its .custom-scroll ancestor does.
      const c = selectors.grid.scroller();
      if (!c) throw new Error('shared-media grid not found — open chat info, then the Media tab');

      await selectors.viewer.close();
      c.scrollTop = 0;
      await sleep(700);

      let idleRounds = 0;

      while (state.running && summary.total < MAX_ITEMS) {
        await pauseGate();
        if (!state.running) break;

        let progressed = false;

        // Snapshot keys, not elements: the element list goes stale the moment
        // the viewer opens and the grid re-renders behind it.
        const keysThisPass = selectors.grid.tiles()
          .map(tileKey)
          .filter((k) => k && !done.has(k) && (!wantKeys || wantKeys.has(k)));

        for (const key of keysThisPass) {
          if (!state.running) break;
          await pauseGate();
          if (!state.running) break;

          // Re-find the tile by id — it may have been recycled since the snapshot.
          const tile = selectors.grid.byKey(key);
          if (!tile) continue;

          done.add(key);
          progressed = true;
          summary.total++;
          onEvent({ type: 'progress', enumerated: summary.total });

          let desc = null;
          try {
            desc = await openTile(tile, selectors.grid.tileKind(tile));
          } catch (e) {
            const msg = String(e && e.message || e);
            summary.failed.push({ filename: 'item ' + summary.total, error: msg });
            onEvent({ type: 'item', index: summary.total - 1, ok: false,
                      error: msg, mediaState: e.mediaState || null });
          }
          if (desc) {
            try {
              const res = await downloadCurrent({
                force: force,
                signal: state.abort.signal,
                onProgress: (p) => onEvent({
                  type: 'progress', index: summary.total - 1,
                  received: p.received, total: p.total
                })
              });
              if (!res.ok) throw new Error(res.error);
              if (res.skipped) summary.skipped++; else summary.saved++;
              onEvent({
                type: 'item', index: summary.total - 1, ok: true,
                filename: res.filename, skipped: !!res.skipped, audit: res.audit,
                via: res.via
              });
            } catch (e) {
              const msg = String(e && e.message || e);
              summary.failed.push({ filename: 'item ' + summary.total, error: msg });
              onEvent({ type: 'item', index: summary.total - 1, ok: false, error: msg });
            }
          }

          // A viewer left open swallows the next tile click.
          const closed = await selectors.viewer.close();
          if (!closed) {
            onEvent({ type: 'item', index: summary.total - 1, ok: false,
                      error: 'could not close the media viewer — stopping' });
            state.running = false;
            break;
          }
          await sleep(250);
        }

        if (wantKeys && done.size >= wantKeys.size) break;
        if (!state.running) break;

        // Advance the grid window by most of a viewport.
        const before = c.scrollTop;
        c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + Math.max(200, c.clientHeight * 0.8));
        await sleep(800);
        const atBottom = (c.scrollTop + c.clientHeight) >= (c.scrollHeight - 4);
        const stuck = c.scrollTop === before;

        if (!progressed && (atBottom || stuck)) {
          idleRounds++;
          if (idleRounds >= 3) break;
        } else {
          idleRounds = 0;
        }
      }
    } finally {
      state.running = false;
      await selectors.viewer.close();
      onEvent({ type: 'done', summary: summary, audit: await auditRecent() });
    }
    return summary;
  }

  // Counts distinct media tiles by sweeping the grid. Kept for the diagnostics
  // and for anyone wanting a total before committing to a run.
  async function enumerate(opts) {
    opts = opts || {};
    const c = selectors.grid.scroller();
    if (!c) throw new Error('shared-media grid not found — open chat info, then the Media tab');

    const keys = new Set();
    const tracker = scroll.makeStabilityTracker({ needed: 3 });
    c.scrollTop = 0;
    await sleep(500);

    for (let i = 0; i < 2000; i++) {
      for (const t of selectors.grid.tiles()) {
        const k = tileKey(t);
        if (k) keys.add(k);
      }
      if (opts.onCount) opts.onCount(keys.size);
      c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + Math.max(200, c.clientHeight * 0.8));
      await sleep(350);
      if (tracker.push({ scrollTop: c.scrollTop, scrollHeight: c.scrollHeight })) break;
    }
    return keys.size;
  }

  // Wipes this chat's download records so its media downloads again.
  async function clearChatHistory() {
    const chatId = selectors.chat.id();
    if (!chatId) throw new Error('no chat open');
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.indexOf(chatId + ':') === 0);
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  // How many items of this chat are already recorded as downloaded.
  async function historyCount() {
    const chatId = selectors.chat.id();
    if (!chatId) return 0;
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.indexOf(chatId + ':') === 0).length;
  }

  // ------------------------------------------------- save-prompt diagnosis
  //
  // Every production download passes saveAs:false, and Brave's
  // prompt_for_download is unset, yet a file picker appears. Rather than guess
  // which argument provokes it, vary one thing at a time and time each one:
  // anything past ~1.5s stopped to ask the user.
  const PROBE_VARIANTS = [
    { label: 'A  subdir + uniquify + blob   (what downloads use now)',
      filename: 'TGMDProbe/a-subdir.txt',    conflictAction: 'uniquify',  kind: 'blob' },
    { label: 'B  flat filename + uniquify + blob',
      filename: 'tgmd-probe-b-flat.txt',     conflictAction: 'uniquify',  kind: 'blob' },
    { label: 'C  subdir + overwrite + blob',
      filename: 'TGMDProbe/c-overwrite.txt', conflictAction: 'overwrite', kind: 'blob' },
    { label: 'D  no filename at all + blob',
      filename: null,                        conflictAction: 'uniquify',  kind: 'blob' },
    { label: 'E  flat filename + data: URL',
      filename: 'tgmd-probe-e-data.txt',     conflictAction: 'uniquify',  kind: 'data' }
  ];

  async function probePrompt(onLine) {
    const say = onLine || function () {};
    const payload = 'A'.repeat(1024);
    const blob = new Blob([payload], { type: 'text/plain' });
    const results = [];

    say('Probing… a picker may appear for each of the 5 tests.');
    say('Save or Cancel each one — either answers the question.');

    for (const v of PROBE_VARIANTS) {
      const url = v.kind === 'data'
        ? 'data:text/plain;base64,' + btoa(payload)
        : URL.createObjectURL(blob);
      let r;
      try {
        r = await chrome.runtime.sendMessage({
          type: 'TGMD_PROBE', url: url,
          filename: v.filename, conflictAction: v.conflictAction
        });
      } catch (e) {
        r = { ok: false, error: String(e.message || e) };
      }
      if (v.kind === 'blob') setTimeout(() => URL.revokeObjectURL(url), 60000);

      const ms = r && r.ms;
      const verdict = !r || !r.ok ? 'ERROR ' + (r && r.error)
        : r.settled === 'timeout' ? 'STILL WAITING after 60s'
        : ms > 1500 ? 'PROMPTED (' + Math.round(ms / 100) / 10 + 's)'
        : 'no prompt (' + ms + 'ms)';
      say(v.label + '\n      -> ' + verdict);
      results.push({ variant: v.label, ms: ms, settled: r && r.settled, verdict: verdict });
    }

    const clean = results.filter((x) => /^no prompt/.test(x.verdict));
    say(clean.length
      ? 'RESULT: ' + clean.length + ' variant(s) saved with no prompt.'
      : 'RESULT: every variant prompted — the trigger is not in our arguments.');
    return results;
  }

  root.TGMD.core = {
    downloadCurrent: downloadCurrent,
    probePrompt: probePrompt,
    clearChatHistory: clearChatHistory,
    historyCount: historyCount,
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
