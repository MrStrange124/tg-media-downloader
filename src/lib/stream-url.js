(function (root) {
  'use strict';

  // "bytes 0-524287/2097152" — a literal "*" for either side means the server
  // could not satisfy the range, which we treat as a failure, not a value.
  const CONTENT_RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/;

  function parseContentRange(header) {
    if (!header) return null;
    const m = String(header).trim().match(CONTENT_RANGE);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    const total = parseInt(m[3], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) return null;
    return { start, end, total };
  }

  // Telegram Web A encodes file metadata as URI-encoded JSON in the final
  // path segment of a service-worker stream URL.
  function parseStreamUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('blob:')) return null;
    const segments = url.split('/');
    const last = segments[segments.length - 1];
    if (!last) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(last);
    } catch (e) {
      return null;
    }
    if (!decoded.startsWith('{')) return null;
    let meta;
    try {
      meta = JSON.parse(decoded);
    } catch (e) {
      return null;
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    return meta;
  }

  const api = { parseContentRange, parseStreamUrl };
  root.TGMD = root.TGMD || {};
  root.TGMD.streamUrl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
