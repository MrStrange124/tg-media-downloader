(function (root) {
  'use strict';

  const ILLEGAL = /[\\/:*?"<>|]/g;
  const CONTROL = /[\u0000-\u001f\u007f]/g;
  const MAX_SEGMENT = 120;

  const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'video/x-matroska': 'mkv'
  };

  function sanitizeSegment(s) {
    let out = String(s == null ? '' : s)
      .replace(CONTROL, '')
      .replace(ILLEGAL, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');       // Windows rejects trailing dots and spaces
    if (out.length > MAX_SEGMENT) out = out.slice(0, MAX_SEGMENT);
    out = out.replace(/[. ]+$/, '');
    // An input made entirely of separators/padding carries no information —
    // "///" and "..." are equally meaningless and must not become "___".
    if (/^[_\s.]*$/.test(out)) return 'untitled';
    return out;
  }

  function extFromMime(mime) {
    if (!mime) return 'bin';
    const base = String(mime).split(';')[0].trim().toLowerCase();
    return MIME_EXT[base] || 'bin';
  }

  function isoDate(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    return d.toISOString().slice(0, 10);
  }

  function buildFilename({ chatTitle, date, messageKey, index, originalName, mime, layout }) {
    const folder = sanitizeSegment(chatTitle);
    const parts = [isoDate(date) + '_' + sanitizeSegment(messageKey)];
    if (index != null) parts.push(String(index));
    if (originalName) parts.push(sanitizeSegment(originalName));
    let name = parts.join('_');
    if (!originalName) name += '.' + extFromMime(mime);

    // 'flat' emits no directory component at all. On the target machine every
    // download whose path contained a subdirectory stopped for a save dialog,
    // while flat-path downloads completed at normal speed -- so the group is
    // folded into the filename instead of becoming a folder.
    if (layout === 'flat') {
      return sanitizeSegment('Telegram - ' + folder + ' - ' + name);
    }
    return 'Telegram/' + folder + '/' + name;
  }

  const api = { sanitizeSegment, extFromMime, buildFilename };
  root.TGMD = root.TGMD || {};
  root.TGMD.naming = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
