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
