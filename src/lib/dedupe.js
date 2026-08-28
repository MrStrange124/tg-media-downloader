(function (root) {
  'use strict';

  const parseStreamUrl = (typeof module !== 'undefined' && module.exports)
    ? require('./stream-url.js').parseStreamUrl
    : root.TGMD.streamUrl.parseStreamUrl;

  function chatIdFromHash(input) {
    if (!input) return null;
    const s = String(input);
    const i = s.indexOf('#');
    const hash = i >= 0 ? s.slice(i + 1) : '';
    if (!hash) return null;
    const m = hash.match(/^(-?\d+)/);
    return m ? m[1] : null;
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Content-addressed so the same file forwarded twice downloads once.
  async function contentKey(url) {
    const meta = parseStreamUrl(url);
    let basis;
    if (meta && meta.location) {
      basis = 'loc:' + JSON.stringify(meta.location);
    } else {
      // Strip query and fragment: Telegram rotates tokens there.
      basis = 'url:' + String(url || '').split('?')[0].split('#')[0];
    }
    return (await sha256Hex(basis)).slice(0, 16);
  }

  const recordKey = (chatId, messageKey) => chatId + ':' + messageKey;

  const api = { chatIdFromHash, contentKey, recordKey };
  root.TGMD = root.TGMD || {};
  root.TGMD.dedupe = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
