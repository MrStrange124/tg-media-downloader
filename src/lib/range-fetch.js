(function (root) {
  'use strict';

  const parseContentRange = (typeof module !== 'undefined' && module.exports)
    ? require('./stream-url.js').parseContentRange
    : root.TGMD.streamUrl.parseContentRange;

  function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchRanged(url, opts) {
    const {
      fetchImpl,
      onProgress = null,
      maxRetries = 3,
      signal = null
    } = opts || {};

    const parts = [];
    let offset = 0;
    let total = null;
    let mimeType = 'application/octet-stream';

    while (total === null || offset < total) {
      if (signal && signal.aborted) throw fail('ABORTED', 'download aborted');

      let res;
      let lastErr = null;
      let ok = false;

      // Retry only the current chunk; earlier chunks stay in `parts`.
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal && signal.aborted) throw fail('ABORTED', 'download aborted');
        try {
          res = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=' + offset + '-' } });
          if (res.status !== 200 && res.status !== 206) {
            lastErr = fail('BAD_STATUS', 'unexpected status ' + res.status);
          } else {
            ok = true;
            break;
          }
        } catch (e) {
          lastErr = fail('BAD_STATUS', e && e.message ? e.message : String(e));
        }
        if (attempt < maxRetries) await sleep(250 * Math.pow(2, attempt));
      }
      if (!ok) throw lastErr;

      const cr = parseContentRange(res.headers.get('Content-Range'));
      if (!cr) throw fail('NO_RANGE', 'server did not return a usable Content-Range');
      if (cr.start !== offset) {
        throw fail('GAP', 'expected byte ' + offset + ', server sent ' + cr.start);
      }
      if (total !== null && cr.total !== total) {
        throw fail('SIZE_MISMATCH', 'total changed from ' + total + ' to ' + cr.total);
      }

      const ct = res.headers.get('Content-Type');
      if (ct) mimeType = String(ct).split(';')[0].trim();

      // Blob (not ArrayBuffer) so Chrome can spill large media to disk.
      parts.push(await res.blob());
      total = cr.total;
      offset = cr.end + 1;

      if (onProgress) onProgress({ received: offset, total });
      if (signal && signal.aborted) throw fail('ABORTED', 'download aborted');
    }

    return { blob: new Blob(parts, { type: mimeType }), total, mimeType };
  }

  const api = { fetchRanged };
  root.TGMD = root.TGMD || {};
  root.TGMD.rangeFetch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
