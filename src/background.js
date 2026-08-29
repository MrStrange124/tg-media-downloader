'use strict';

// The worker can open writable streams from the stored handle even though it
// cannot show a picker. Granting happens in src/setup.html.
importScripts('lib/fsa.js');

// downloadId -> { blobUrl, filename, retried }
const inFlight = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'TGMD_DOWNLOAD') {
    startDownload(msg.blobUrl, msg.filename)
      .then((id) => sendResponse({ ok: true, id }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // keep the message channel open for the async response
  }

  // Single-item audit, used inline by the run engine.
  if (msg && msg.type === 'TGMD_DOWNLOAD_INFO') {
    chrome.downloads.search({ id: msg.id })
      .then((items) => {
        const d = items && items[0];
        sendResponse(d ? {
          ok: true,
          byExtensionId: d.byExtensionId || null,
          ours: d.byExtensionId === chrome.runtime.id,
          state: d.state,
          danger: d.danger,
          mime: d.mime,
          error: d.error || null
        } : { ok: false, error: 'download ' + msg.id + ' not found' });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // byExtensionId is the decisive field: a prompted download with none was
  // page-initiated and did not come from this extension.
  if (msg && msg.type === 'TGMD_DOWNLOAD_AUDIT') {
    chrome.downloads.search({ limit: 10, orderBy: ['-startTime'] })
      .then((items) => sendResponse({
        ok: true,
        self: chrome.runtime.id,
        items: items.map((d) => ({
          id: d.id,
          filename: d.filename,
          state: d.state,
          danger: d.danger,
          mime: d.mime,
          error: d.error,
          byExtensionId: d.byExtensionId || null,
          byExtensionName: d.byExtensionName || null,
          fromOurExtension: d.byExtensionId === chrome.runtime.id,
          urlKind: !d.url ? null : (d.url.startsWith('blob:') ? 'blob' : d.url.slice(0, 40)),
          startTime: d.startTime
        }))
      }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // A 1 KB blob download completes in milliseconds unless Chromium stopped to
  // ask, so elapsed time measures whether a picker appeared.
  if (msg && msg.type === 'TGMD_PROBE') {
    probeOne(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'TGMD_FS_STATUS') {
    self.TGMD.fsa.permission()
      .then((state) => sendResponse({ ok: true, state: state }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'TGMD_OPEN_SETUP') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/setup.html') })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'TGMD_FS_BEGIN') {
    fsBegin(msg.filename)
      .then((r) => sendResponse({ ok: true, id: r.id, path: r.path }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'TGMD_FS_CHUNK') {
    fsChunk(msg.id, msg.b64)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'TGMD_FS_END') {
    fsEnd(msg.id, msg.abort)
      .then((path) => sendResponse({ ok: true, path: path }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (msg && msg.type === 'TGMD_INJECT_MAIN') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      files: ['src/fetcher-main.js']
    }).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  return false;
});

async function startDownload(blobUrl, filename) {
  const id = await chrome.downloads.download({
    url: blobUrl,
    filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });
  inFlight.set(id, { blobUrl, filename, retried: false });
  return id;
}

// Path-related failures fall back once to the plain Downloads folder, so a
// bad chat title can never abort a long run.
const PATH_ERRORS = new Set([
  'FILE_ACCESS_DENIED', 'FILE_NO_SPACE', 'FILE_NAME_TOO_LONG',
  'FILE_TOO_LARGE', 'FILE_FAILED', 'FILE_TRANSIENT_ERROR'
]);

chrome.downloads.onChanged.addListener(async (delta) => {
  const rec = inFlight.get(delta.id);
  if (!rec) return;

  if (delta.state && delta.state.current === 'complete') {
    URL.revokeObjectURL(rec.blobUrl);
    inFlight.delete(delta.id);
    return;
  }

  if (delta.error && delta.error.current) {
    const code = delta.error.current;
    if (!rec.retried && PATH_ERRORS.has(code)) {
      rec.retried = true;
      const basename = rec.filename.split('/').pop();
      try {
        const newId = await chrome.downloads.download({
          url: rec.blobUrl, filename: basename,
          saveAs: false, conflictAction: 'uniquify'
        });
        inFlight.set(newId, { ...rec, filename: basename });
      } catch (e) {
        URL.revokeObjectURL(rec.blobUrl);
      }
    } else {
      URL.revokeObjectURL(rec.blobUrl);
    }
    inFlight.delete(delta.id);
  }
});

// ------------------------------------------------------ save-prompt probe
function waitForSettled(id, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (r) => {
      chrome.downloads.onChanged.removeListener(handler);
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ settled: 'timeout' }), timeoutMs);
    const handler = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish({ settled: 'complete' });
      if (delta.state.current === 'interrupted') {
        finish({ settled: 'interrupted', reason: delta.error && delta.error.current });
      }
    };
    chrome.downloads.onChanged.addListener(handler);
  });
}

async function probeOne(msg) {
  const opts = { url: msg.url, saveAs: false, conflictAction: msg.conflictAction };
  if (msg.filename) opts.filename = msg.filename;

  const t0 = Date.now();
  let id;
  try {
    id = await chrome.downloads.download(opts);
  } catch (e) {
    return { ok: false, error: String(e.message || e), ms: Date.now() - t0 };
  }
  const settled = await waitForSettled(id, 60000);
  return { ok: true, id, ms: Date.now() - t0, ...settled };
}

// ------------------------------------------------- direct-to-disk writing
// Extension messaging is JSON, so the content script sends base64 chunks and
// each is streamed to disk here, keeping memory bounded.
const writers = new Map();
let writerSeq = 0;

async function fsBegin(filename) {
  const { writable, path } = await self.TGMD.fsa.openWriter(filename);
  const id = ++writerSeq;
  writers.set(id, writable);
  return { id, path };
}

async function fsChunk(id, b64) {
  const writable = writers.get(id);
  if (!writable) throw new Error('no open writer ' + id);
  // Decoding via fetch avoids a multi-megabyte atob + per-byte copy loop.
  const buf = await (await fetch('data:application/octet-stream;base64,' + b64)).arrayBuffer();
  await writable.write(buf);
}

async function fsEnd(id, abort) {
  const writable = writers.get(id);
  if (!writable) throw new Error('no open writer ' + id);
  writers.delete(id);
  if (abort) {
    try { await writable.abort(); } catch (e) { /* already failing */ }
    return null;
  }
  await writable.close();
  return true;
}
