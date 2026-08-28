(function () {
  'use strict';
  if (window.__TGMD_MAIN_FETCHER__) return;
  window.__TGMD_MAIN_FETCHER__ = true;

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.__tgmd !== 'fetch-request') return;

    try {
      const res = await fetch(msg.url, { method: 'GET', headers: msg.headers || {} });
      const blob = await res.blob();
      const headers = {};
      for (const k of ['Content-Range', 'Content-Type', 'Content-Length']) {
        headers[k] = res.headers.get(k);
      }
      // postMessage structure-clones Blobs correctly across worlds.
      window.postMessage({ __tgmd: 'fetch-response', id: msg.id,
                           ok: true, status: res.status, headers: headers, blob: blob }, '*');
    } catch (e) {
      window.postMessage({ __tgmd: 'fetch-response', id: msg.id,
                           ok: false, error: String(e && e.message || e) }, '*');
    }
  });
})();
