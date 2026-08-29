// Orchestration: fetch, save, enumerate, walk. All Telegram DOM access goes
// through TGMD.selectors — there are deliberately no Telegram class names here.
(function (root) {
  'use strict';

  const selectors = root.TGMD.selectors;
  const rangeFetch = root.TGMD.rangeFetch;
  const naming = root.TGMD.naming;
  const dedupe = root.TGMD.dedupe;

  // One record per chat, held in memory for the length of a run and flushed
  // periodically -- writing the whole ledger after every item would rewrite
  // 150 KB a thousand times over.
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
  // Extension messaging is JSON only, so the bytes are moved as base64 in
  // bounded chunks and streamed to disk by the service worker. 4 MB keeps each
  // message well inside limits while holding memory flat for large videos.
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

  // Whether a folder is granted. Cached per page load; the panel clears it
  // after the setup tab is used.
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

  // Two ways to put bytes on disk. With a granted folder we write straight
  // into it -- no browser download exists, so nothing can prompt. Otherwise
  // fall back to chrome.downloads so an unconfigured install still works.
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
      // The background worker holds its own reference until the download
      // completes; releasing ours later avoids revoking too early.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    }
  }

  async function settings() {
    const got = await chrome.storage.local.get('settings');
    const s = got.settings || {};
    return {
      subfolder: naming.sanitizeSegment(s.subfolder || 'Telegram'),
      // Nested by default. Flat was only ever a test of the subdirectory
      // hypothesis, which a controlled probe disproved: on a clean Brave
      // profile every download shape prompts, and none do once
      // prompt_for_download is false. Kept as an option, not a default.
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
      // Only trust the record when it names the same kind of file we are about
      // to save. If a key ever collided across kinds, silently skipping would
      // drop the item entirely; re-downloading is the safe direction to err in.
      const wantExt = naming.extFromMime(desc.mime);
      const hadExt = String(previous).split('.').pop().toLowerCase();
      if (hadExt === wantExt) {
        // Record the tile even so. The bytes were already known by content,
        // but knowing the *tile* is what lets the next run skip it from the
        // grid without paying to open the viewer again.
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
    // Timed because a save dialog is otherwise invisible from in here: a blob
    // save is milliseconds unless the browser stopped to ask.
    const saveStarted = Date.now();
    const saved = await saveBlob(blob, filename);
    const saveMs = Date.now() - saveStarted;
    const written = saved.path || filename;

    // Only meaningful for the downloads API: records who Brave credits for the
    // download. Writing to disk has no DownloadItem to audit.
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
  // A run has three phases, deliberately separated. Earlier versions opened
  // and downloaded each tile as the scroll reached it, which meant the total
  // was never known, and a single wedged item could end the run with most of
  // the chat still unvisited.
  //
  //   1. scan   sweep the grid top to bottom writing down every tile: its key,
  //             its kind, and the scrollTop it was first seen at. No viewer,
  //             no downloads, so it is cheap and gives an honest total.
  //   2. plan   drop the tiles this chat's ledger already knows. On a group
  //             that has been run before, most of the list disappears here
  //             without opening anything.
  //   3. fetch  walk the plan. A failure is queued, never fatal; the queue
  //             gets one more pass at the end of the run.
  //
  // The grid is virtualised, so element references never survive a scroll.
  // Identity is the tile's own id (`shared-media` + `message-<id>`, from
  // Media.tsx), and the scrollTop recorded during the scan is how a tile that
  // has since been recycled out of the DOM is brought back.

  const state = { running: false, paused: false, abort: null };
  const MAX_ITEMS = 5000;

  const tileKey = (t) => selectors.grid.tileKey(t);

  // Telegram resolves a video's URL asynchronously. Until it does,
  // MediaViewerContent paints a poster-only <video> carrying no src at all, so
  // a short deadline reports "no URL" for a video that is merely still
  // loading. Photos are ready almost immediately; videos get far longer.
  const OPEN_TIMEOUT = { image: 20000, gif: 60000, video: 180000 };

  // An item that already failed once is unlikely to need the full budget the
  // second time, and in a large run those minutes are the whole cost of a
  // handful of dead videos.
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

  // ------------------------------------------------------------ phase 1: scan
  // Records where each tile was seen as well as that it exists. `need`, when
  // given, ends the sweep as soon as those keys have all been found — a
  // handful of ticked tiles should not pay for a scan of the whole group.
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
        // First sighting wins: the earliest scrollTop that revealed a tile is
        // the position most likely to reveal it again.
        if (k && !seen.has(k)) {
          seen.set(k, { key: k, kind: selectors.grid.tileKind(t), top: c.scrollTop });
        }
      }
      if (onCount) onCount(seen.size);
      if (seen.size >= MAX_ITEMS || haveAllWanted()) break;

      const top = c.scrollTop;
      c.scrollTop = Math.min(c.scrollHeight, top + Math.max(200, c.clientHeight * 0.8));
      const bottom = (c.scrollTop + c.clientHeight) >= (c.scrollHeight - 4);
      // The bottom is where Telegram asks for the next page of shared media,
      // so it gets a longer settle. Ending the scan a second early truncates
      // the chat, and the run would then report the partial list as the whole
      // of it -- a silent, permanent-looking "everything is already saved".
      await sleep(bottom ? 900 : 350);

      // Geometry going still is not enough on its own: the grid stops growing
      // for a moment every time a page is in flight.
      if (seen.size === before && (bottom || c.scrollTop === top)) {
        if (++idle >= 3) break;
      } else {
        idle = 0;
      }
    }
    return Array.from(seen.values());
  }

  // ----------------------------------------------------------- phase 3: fetch
  // Brings a tile back into the DOM. Virtualisation may have recycled it since
  // the scan, in which case the recorded scrollTop is where to look; the grid
  // can also have reflowed, so a window either side of it is tried too.
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

  // A stuck viewer swallows the next tile click, so it must actually close --
  // but one wedged item is no reason to abandon the rest of the run. The
  // second attempt is the one that matters: a video still loading ignores
  // Escape until it settles, by which time close()'s own escalation is spent.
  async function closeViewer() {
    if (await selectors.viewer.close()) return true;
    await sleep(1500);
    return selectors.viewer.close();
  }

  async function processEntry(entry, ctx) {
    // The viewer must be gone before the click. Left open it swallows the
    // click, and openTile then sees the previous item still on screen -- its
    // URL already stable, so the two-poll guard passes -- and hands back the
    // wrong descriptor. That would record the previous file under this tile's
    // key in the ledger, hiding this tile's media from every run after.
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
    // Ticking tiles by hand is an explicit request for those files, so a
    // selection run ignores the ledger.
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

          // processEntry already exhausted closeViewer() when it reports
          // `stuck`; a third attempt here would just cost another three seconds.
          if (!res.stuck && await closeViewer()) {
            closeFails = 0;
          } else {
            closeFails++;
            onEvent({ type: 'note',
                      text: 'the media viewer would not close (' + closeFails + ' in a row)' });
            // Three consecutive failures means the page itself is wedged, not
            // this one item; everything after would fail the same way.
            if (closeFails >= 3) {
              onEvent({ type: 'note', text: 'stopping — the page has stopped responding' });
              state.running = false;
              break;
            }
          }

          // Flushing every tenth item bounds how much is lost if the tab is
          // closed mid-run, without rewriting the whole ledger a thousand times.
          if ((index % 10) === 0) await ledger.flush();
          handled++;
          await sleep(250);
        }
        return handled;
      };

      await runPass(plan, 1);

      let retried = 0;
      if (retry.length && state.running) {
        // Most failures are transient: a video whose URL had not resolved yet,
        // a tile that scrolled away mid-fetch, a fetch that timed out under
        // load. One more pass at the end costs little and recovers most.
        summary.retried = retry.length;
        summary.queued += retry.length;
        onEvent({ type: 'phase', phase: 'retry', count: retry.length });
        ctx.budget = RETRY_TIMEOUT;
        retried = await runPass(retry, 2);
      }

      // Whatever was queued for retry but never got its second pass -- the
      // user pressed Stop, or the page wedged -- is still a failure. Counting
      // it only inside runPass would let those items disappear from the
      // summary entirely and leave the panel claiming a clean run.
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

  // Write a capability snapshot to extension storage on every load. The
  // File System Access path silently did nothing on the target machine and
  // there was no way to tell "API missing" from "picker refused" after the
  // fact; this records the answer without anyone having to run a diagnostic.
  (async function recordCaps() {
    const caps = {
      at: new Date().toISOString(),
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?',
      // Expected to be undefined here: pickers are not exposed to content
      // scripts. Recorded so a regression is visible rather than inferred.
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
