'use strict';

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

  // Reports what Brave actually recorded about recent downloads. The decisive
  // field is byExtensionId: if a download that prompted has none, it was
  // page-initiated and did not come from this extension at all.
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

  // Timed download probe. A blob download of 1 KB completes in milliseconds
  // unless Chromium stops to ask the user where to put it, so elapsed time is
  // a direct, objective measurement of whether a file picker appeared.
  if (msg && msg.type === 'TGMD_PROBE') {
    probeOne(msg)
      .then(sendResponse)
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
