// Orchestration: fetch, save, scan, walk. All Telegram DOM access goes through
// TGMD.selectors — no Telegram class names here.
(function (root) {
  'use strict';

  const selectors = root.TGMD.selectors;
  const rangeFetch = root.TGMD.rangeFetch;
  const naming = root.TGMD.naming;
  const dedupe = root.TGMD.dedupe;

  // One record per chat, flushed periodically rather than per item.
  const ledger = root.TGMD.ledger.create(chrome.storage.local);

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
  // Whether content-script fetch reaches Telegram's service worker; probed once.
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
  // Extension messaging is JSON, so bytes move as base64 chunks. 4 MB keeps each
  // message inside limits and memory flat for large videos.
  const FS_CHUNK = 4 * 1024 * 1024;

  function chunkToBase64(chunk) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
      fr.onerror = () => reject(fr.error || new Error('chunk encode failed'));
      fr.readAsDataURL(chunk);
    });
  }

  async function writeToDisk(filename, blob) {
    const begin = await chrome.runtime.sendMessage({
      type: 'TGMD_FS_BEGIN', filename: filename
    });
    if (!begin || !begin.ok) throw new Error((begin && begin.error) || 'could not open file');

    try {
      for (let at = 0; at < blob.size; at += FS_CHUNK) {
        const b64 = await chunkToBase64(blob.slice(at, Math.min(at + FS_CHUNK, blob.size)));
        const res = await chrome.runtime.sendMessage({
          type: 'TGMD_FS_CHUNK', id: begin.id, b64: b64
        });
        if (!res || !res.ok) throw new Error((res && res.error) || 'chunk write failed');
      }
    } catch (e) {
      // Leaving a half-written file behind would look like a successful save.
      try {
        await chrome.runtime.sendMessage({ type: 'TGMD_FS_END', id: begin.id, abort: true });
      } catch (e2) { /* already failing */ }
      throw e;
    }

    const end = await chrome.runtime.sendMessage({ type: 'TGMD_FS_END', id: begin.id });
    if (!end || !end.ok) throw new Error((end && end.error) || 'could not close file');
    return begin.path;
  }

  // Cached per page load; cleared after the setup tab is used.
  let fsState = null;
  async function fsReady() {
    if (fsState === null) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'TGMD_FS_STATUS' });
        fsState = (r && r.ok) ? r.state : 'none';
      } catch (e) {
        fsState = 'none';
      }
    }
    return fsState === 'granted';
  }

  // A granted folder is written directly: no browser download exists, so
  // nothing can prompt. chrome.downloads is the fallback.
  async function saveBlob(blob, filename) {
    if (await fsReady()) {
      try {
        return { mode: 'disk', path: await writeToDisk(filename, blob) };
      } catch (e) {
        // Never lose the file over a disk-write problem.
        console.warn('[TGMD] disk write failed, falling back to downloads', e);
      }
    }

    const blobUrl = URL.createObjectURL(blob);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TGMD_DOWNLOAD', blobUrl: blobUrl, filename: filename
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'download rejected');
      return { mode: 'downloads', id: res.id };
    } finally {
      // The worker holds its own reference until the download completes.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    }
  }

  async function settings() {
    const got = await chrome.storage.local.get('settings');
    const s = got.settings || {};
    return {
      subfolder: naming.sanitizeSegment(s.subfolder || 'Telegram'),
      // Flat is an option, not a default: the save prompt was a Brave setting,
      // not the subdirectory.
      layout: s.layout === 'flat' ? 'flat' : 'nested'
    };
  }

  // -------------------------------------------------------- single download
  async function downloadCurrent(opts) {
    opts = opts || {};
    const desc = selectors.viewer.descriptor();
    if (!desc) return { ok: false, error: 'no media open in the viewer' };

    const chatId = selectors.chat.id();
    if (!chatId) return { ok: false, error: 'could not determine chat id' };

    await ledger.open(chatId);
    const contentKey = await dedupe.contentKey(desc.url);

    const previous = ledger.contentName(contentKey);
    if (previous && !opts.force) {
      // Only trust the record when it names the same kind of file. Against a key
      // collision, re-downloading is the safe direction to err in.
      const wantExt = naming.extFromMime(desc.mime);
      const hadExt = String(previous).split('.').pop().toLowerCase();
      if (hadExt === wantExt) {
        // Record the tile too: that is what lets the next run skip it from the
        // grid without opening the viewer.
        ledger.note(opts.tileKey, contentKey, previous);
        if (!opts.defer) await ledger.flush();
        return { ok: true, skipped: true, filename: previous };
      }
    }

    const cfg = await settings();
    let filename = naming.buildFilename({
      chatTitle: selectors.chat.title(),
      date: new Date(),
      messageKey: contentKey,
      originalName: desc.originalName,
      mime: desc.mime,
      layout: cfg.layout
    });
    if (cfg.layout === 'nested') {
      filename = filename.replace(/^Telegram\//, cfg.subfolder + '/');
    }

    const blob = await fetchMedia(desc, opts);
    // A save dialog is invisible from here except as elapsed time: a blob save
    // is milliseconds unless the browser stopped to ask.
    const saveStarted = Date.now();
    const saved = await saveBlob(blob, filename);
    const saveMs = Date.now() - saveStarted;
    const written = saved.path || filename;

    // Only the downloads API has a DownloadItem to audit.
    let audit = null;
    if (saved.mode === 'downloads') {
      try {
        audit = await chrome.runtime.sendMessage({ type: 'TGMD_DOWNLOAD_INFO', id: saved.id });
      } catch (e) { /* audit is best effort */ }
    }

    ledger.note(opts.tileKey, contentKey, written);
    if (!opts.defer) await ledger.flush();
    return { ok: true, filename: written, bytes: blob.size, audit: audit,
             via: saved.mode, saveMs: saveMs };
  }

  // ------------------------------------------------------------- run engine
  //
  //   1. scan   sweep the grid recording every tile: key, kind, and the
  //             scrollTop it was seen at. Nothing is opened, so it is cheap
  //             and yields an honest total.
  //   2. plan   drop the tiles this chat's ledger already knows.
  //   3. fetch  walk the plan; failures are queued and get one more pass.
  //
  // The grid is virtualised, so element references never survive a scroll.
  // Identity is the tile's own id (Media.tsx), and the recorded scrollTop is
  // how a recycled tile is brought back.

  const state = { running: false, paused: false, abort: null };
  const MAX_ITEMS = 5000;

  const tileKey = (t) => selectors.grid.tileKey(t);

  // Telegram resolves a video's URL asynchronously, painting a poster-only
  // <video> with no src meanwhile. Photos are ready almost immediately.
  const OPEN_TIMEOUT = { image: 20000, gif: 60000, video: 180000 };

  // An item that already failed once is unlikely to need the full budget.
  const RETRY_TIMEOUT = 45000;

  async function openTile(tile, kind, budgetMs) {
    tile.click();
    const started = Date.now();
    const budget = budgetMs || OPEN_TIMEOUT[kind] || OPEN_TIMEOUT.image;
    let last = null;

    let stable = null;
    while (Date.now() - started < budget) {
      const d = selectors.viewer.descriptor();
      if (d && d.url) {
        // Two consecutive polls on the same URL: a click can land while the
        // viewer is still showing the previous item.
        if (stable === d.url) return d;
        stable = d.url;
      } else {
        stable = null;
      }
      last = selectors.mediaState();
      // The click never landed — fail in seconds, not the full video budget.
      if (last.stage === 'viewer-closed' && Date.now() - started > 6000) break;
      await sleep(200);
    }

    // "Never opened" and "opened but no URL yet" are different faults.
    const secs = Math.round((Date.now() - started) / 1000);
    const err = new Error('no media URL after ' + secs + 's (' + (last ? last.stage : 'unknown') + ')');
    err.mediaState = last;
    throw err;
  }

  // Who Brave credits for recent downloads. A prompt on a file it does not
  // attribute to us is page-initiated — a different fault entirely.
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

  // ------------------------------------------------------------ phase 1: scan
  // Records where each tile was seen, not just that it exists. `need` ends the
  // sweep once those keys are found, so a few ticked tiles skip a full scan.
  async function scanGrid(onCount, live, need) {
    const c = selectors.grid.scroller();
    if (!c) throw new Error('shared-media grid not found — open chat info, then the Media tab');

    const seen = new Map();
    c.scrollTop = 0;
    await sleep(500);

    const haveAllWanted = () => {
      if (!need || !need.size) return false;
      for (const k of need) if (!seen.has(k)) return false;
      return true;
    };

    let idle = 0;
    for (let i = 0; i < 4000; i++) {
      await pauseGate();
      if (live && !live()) break;

      const before = seen.size;
      for (const t of selectors.grid.tiles()) {
        const k = tileKey(t);
        // First sighting wins: most likely to reveal the tile again.
        if (k && !seen.has(k)) {
          seen.set(k, { key: k, kind: selectors.grid.tileKind(t), top: c.scrollTop });
        }
      }
      if (onCount) onCount(seen.size);
      if (seen.size >= MAX_ITEMS || haveAllWanted()) break;

      const top = c.scrollTop;
      c.scrollTop = Math.min(c.scrollHeight, top + Math.max(200, c.clientHeight * 0.8));
      const bottom = (c.scrollTop + c.clientHeight) >= (c.scrollHeight - 4);
      // The bottom is where the next page is requested, so it settles longer:
      // ending early truncates the chat and reports the part as the whole.
      await sleep(bottom ? 900 : 350);

      // Still geometry is not enough: the grid pauses whenever a page is in flight.
      if (seen.size === before && (bottom || c.scrollTop === top)) {
        if (++idle >= 3) break;
      } else {
        idle = 0;
      }
    }
    return Array.from(seen.values());
  }

  // ----------------------------------------------------------- phase 3: fetch
  // Virtualisation may have recycled the tile; the recorded scrollTop is where
  // to look, with a window either side in case the grid reflowed.
  async function ensureTile(entry, c) {
    let tile = selectors.grid.byKey(entry.key);
    if (tile) return tile;

    const half = Math.max(100, c.clientHeight * 0.5);
    for (const top of [entry.top, Math.max(0, entry.top - half), entry.top + half]) {
      c.scrollTop = top;
      for (let i = 0; i < 12; i++) {
        await sleep(150);
        tile = selectors.grid.byKey(entry.key);
        if (tile) return tile;
      }
    }
    return null;
  }

  // One wedged item is no reason to abandon the run. The second attempt is the
  // one that matters: a loading video ignores Escape until it settles.
  async function closeViewer() {
    if (await selectors.viewer.close()) return true;
    await sleep(1500);
    return selectors.viewer.close();
  }

  async function processEntry(entry, ctx) {
    // The viewer must be gone before the click. Left open it swallows the click
    // and openTile returns the previous item's descriptor, which would record
    // that file under this tile's ledger key and hide this tile's media for good.
    if (selectors.viewer.isOpen() && !(await closeViewer())) {
      return { ok: false, error: 'the previous item\'s viewer would not close', stuck: true };
    }

    const tile = await ensureTile(entry, ctx.c);
    if (!tile) return { ok: false, error: 'tile scrolled out of reach' };

    try {
      await openTile(tile, entry.kind || selectors.grid.tileKind(tile), ctx.budget);
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), mediaState: e.mediaState || null };
    }

    try {
      const res = await downloadCurrent({
        tileKey: entry.key,
        defer: true,
        force: ctx.force,
        signal: state.abort.signal,
        onProgress: (p) => ctx.onEvent({
          type: 'progress', received: p.received, total: p.total
        })
      });
      if (!res.ok) throw new Error(res.error);
      return res;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  async function start(opts) {
    opts = opts || {};
    const onEvent = opts.onEvent || function () {};
    const wantKeys = opts.tileKeys || null;
    // Ticked tiles are an explicit request, so a selection run ignores the ledger.
    const force = !!opts.force;
    if (state.running) throw new Error('a run is already in progress');
    state.running = true;
    state.paused = false;
    state.abort = new AbortController();

    const summary = { scanned: 0, known: 0, queued: 0, saved: 0, skipped: 0,
                      retried: 0, failed: [] };

    try {
      const c = selectors.grid.scroller();
      if (!c) throw new Error('shared-media grid not found — open chat info, then the Media tab');
      const chatId = selectors.chat.id();
      if (!chatId) throw new Error('could not determine chat id');
      await ledger.open(chatId);

      await selectors.viewer.close();

      onEvent({ type: 'phase', phase: 'scan' });
      const all = await scanGrid(
        (n) => onEvent({ type: 'scan', found: n }),
        () => state.running,
        wantKeys);
      summary.scanned = all.length;
      if (!state.running) return summary;

      const plan = wantKeys
        ? all.filter((e) => wantKeys.has(e.key))
        : all.filter((e) => force || !ledger.hasTile(e.key));
      summary.known = wantKeys ? 0 : all.length - plan.length;
      summary.queued = plan.length;
      onEvent({ type: 'planned', mode: wantKeys ? 'selection' : 'all',
                scanned: all.length, known: summary.known, queued: plan.length });

      const ctx = { c: c, force: force || !!wantKeys, onEvent: onEvent };
      const retry = [];
      let closeFails = 0;
      let index = 0;

      const runPass = async (entries, pass) => {
        let handled = 0;
        for (const entry of entries) {
          if (!state.running) break;
          await pauseGate();
          if (!state.running) break;

          onEvent({ type: 'item-start', index: index, total: summary.queued, pass: pass });
          const res = await processEntry(entry, ctx);
          index++;

          const ev = { type: 'item', index: index - 1, total: summary.queued, pass: pass };
          if (res.ok) {
            if (res.skipped) summary.skipped++; else summary.saved++;
            onEvent(Object.assign(ev, {
              ok: true, filename: res.filename, skipped: !!res.skipped,
              audit: res.audit, via: res.via, saveMs: res.saveMs
            }));
          } else if (pass === 1) {
            retry.push(entry);
            onEvent(Object.assign(ev, {
              ok: false, error: res.error, mediaState: res.mediaState || null,
              willRetry: true
            }));
          } else {
            summary.failed.push({ key: entry.key, error: res.error });
            onEvent(Object.assign(ev, {
              ok: false, error: res.error, mediaState: res.mediaState || null,
              willRetry: false
            }));
          }

          // processEntry already exhausted closeViewer() when it reports `stuck`.
          if (!res.stuck && await closeViewer()) {
            closeFails = 0;
          } else {
            closeFails++;
            onEvent({ type: 'note',
                      text: 'the media viewer would not close (' + closeFails + ' in a row)' });
            // Three in a row means the page is wedged, not this one item.
            if (closeFails >= 3) {
              onEvent({ type: 'note', text: 'stopping — the page has stopped responding' });
              state.running = false;
              break;
            }
          }

          // Bounds what is lost if the tab closes mid-run.
          if ((index % 10) === 0) await ledger.flush();
          handled++;
          await sleep(250);
        }
        return handled;
      };

      await runPass(plan, 1);

      let retried = 0;
      if (retry.length && state.running) {
        // Most failures are transient: an unresolved URL, a tile that scrolled
        // away mid-fetch, a fetch that timed out under load.
        summary.retried = retry.length;
        summary.queued += retry.length;
        onEvent({ type: 'phase', phase: 'retry', count: retry.length });
        ctx.budget = RETRY_TIMEOUT;
        retried = await runPass(retry, 2);
      }

      // Queued but never retried — Stop, or a wedged page — is still a failure,
      // and counting it only inside runPass would lose it from the summary.
      for (const entry of retry.slice(retried)) {
        summary.failed.push({ key: entry.key, error: 'queued for retry, but the run ended first' });
        onEvent({ type: 'item', index: index++, total: summary.queued, pass: 2,
                  ok: false, willRetry: false,
                  error: 'queued for retry, but the run ended first' });
      }
    } finally {
      state.running = false;
      try { await ledger.flush(); } catch (e) { /* nothing further to do */ }
      await selectors.viewer.close();
      onEvent({ type: 'done', summary: summary, audit: await auditRecent() });
    }
    return summary;
  }

  // Counts distinct media tiles without downloading anything.
  async function enumerate(opts) {
    opts = opts || {};
    const found = await scanGrid(opts.onCount || null, () => true, null);
    return found.length;
  }

  // Wipes this chat's ledger so its media downloads again.
  async function clearChatHistory() {
    const chatId = selectors.chat.id();
    if (!chatId) throw new Error('no chat open');
    return ledger.forget(chatId);
  }

  // How many items of this chat are already recorded as downloaded.
  async function historyCount() {
    const chatId = selectors.chat.id();
    if (!chatId) return 0;
    await ledger.open(chatId);
    return ledger.size();
  }

  // ------------------------------------------------- save-prompt diagnosis
  // Vary one download argument at a time and time each: anything past ~1.5s
  // stopped to ask the user.
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
    resetFsState: function () { fsState = null; },
    fsReady: fsReady,
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

  // Capability snapshot on every load, so "API missing" and "picker refused"
  // can be told apart after the fact.
  (async function recordCaps() {
    const caps = {
      at: new Date().toISOString(),
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?',
      // Expected undefined: pickers are not exposed to content scripts.
      showDirectoryPicker: typeof root.showDirectoryPicker
    };
    try {
      const r = await chrome.runtime.sendMessage({ type: 'TGMD_FS_STATUS' });
      caps.workerFolderState = (r && r.ok) ? r.state : ('error: ' + (r && r.error));
    } catch (e) {
      caps.workerFolderState = 'error: ' + (e.message || e);
    }
    try { await chrome.storage.local.set({ 'diag:caps': caps }); } catch (e) { /* nothing to do */ }
  })();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => root.TGMD.panel.mount());
  } else {
    root.TGMD.panel.mount();
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
