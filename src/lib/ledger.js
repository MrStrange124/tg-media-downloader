// A per-chat record of what has already been saved. Two indexes, answering
// different questions at different costs:
//
//   tiles[tileKey]      "done this grid cell?" — answerable from the grid
//                       alone, so a re-run skips it without opening anything.
//   content[contentKey] "saved these bytes?" — catches the same file forwarded
//                       twice, but only once the viewer has resolved a URL.
//
// One object per chat, not one key per item: 1000 keys made every count and
// every clear a full scan of extension storage.
(function (root) {
  'use strict';

  const VERSION = 1;
  const keyFor = (chatId) => 'led:' + chatId;

  const empty = () => ({ v: VERSION, tiles: {}, content: {} });

  function normalise(raw) {
    if (!raw || typeof raw !== 'object') return empty();
    return {
      v: VERSION,
      tiles: (raw.tiles && typeof raw.tiles === 'object') ? raw.tiles : {},
      content: (raw.content && typeof raw.content === 'object') ? raw.content : {}
    };
  }

  // The old layout: one flat key per item, `<chatId>:<contentKey>` holding the
  // filename. Folded in so upgrading never re-downloads a chat. Returns the
  // legacy keys to delete.
  function foldLegacy(data, all, chatId) {
    const prefix = chatId + ':';
    const found = [];
    for (const k of Object.keys(all || {})) {
      if (k.indexOf(prefix) !== 0) continue;
      found.push(k);
      const contentKey = k.slice(prefix.length);
      if (!data.content[contentKey]) data.content[contentKey] = String(all[k]);
    }
    return found;
  }

  function create(storage) {
    let chatId = null;
    let data = empty();
    let dirty = false;
    let legacy = [];

    async function flush() {
      if (!chatId || !dirty) return false;
      const rec = {};
      rec[keyFor(chatId)] = data;
      await storage.set(rec);
      dirty = false;
      // Only once the ledger is written: a failed set() would lose the history.
      if (legacy.length) {
        await storage.remove(legacy);
        legacy = [];
      }
      return true;
    }

    async function open(id) {
      if (!id) throw new Error('no chat open');
      if (chatId === id) return data;
      await flush();
      chatId = id;
      const got = await storage.get(keyFor(id));
      data = normalise(got && got[keyFor(id)]);
      const all = await storage.get(null);
      legacy = foldLegacy(data, all, id);
      if (legacy.length) { dirty = true; await flush(); }
      return data;
    }

    function note(tileKey, contentKey, filename) {
      if (tileKey) data.tiles[tileKey] = { c: contentKey || null, f: filename };
      if (contentKey) data.content[contentKey] = filename;
      dirty = true;
    }

    async function forget(id) {
      const target = id || chatId;
      if (!target) throw new Error('no chat open');
      const all = await storage.get(null);
      const stale = Object.keys(all || {}).filter((k) => k.indexOf(target + ':') === 0);
      // The open chat may carry notes from this run that are not flushed yet.
      const held = target === chatId ? data : normalise((all || {})[keyFor(target)]);
      const n = countIn(held) + stale.length;
      await storage.remove([keyFor(target)].concat(stale));
      if (target === chatId) { data = empty(); dirty = false; legacy = []; }
      return n;
    }

    return {
      open: open,
      flush: flush,
      note: note,
      forget: forget,
      hasTile: (k) => !!(k && data.tiles[k]),
      tileName: (k) => (k && data.tiles[k] ? data.tiles[k].f : null),
      contentName: (c) => (c && data.content[c]) || null,
      size: () => countIn(data),
      get chatId() { return chatId; }
    };
  }

  // A tile and its content are one download, not two.
  function countIn(data) {
    const seen = new Set();
    for (const k of Object.keys(data.tiles)) {
      const c = data.tiles[k].c;
      seen.add(c ? 'c:' + c : 't:' + k);
    }
    for (const c of Object.keys(data.content)) seen.add('c:' + c);
    return seen.size;
  }

  const api = { create, normalise, foldLegacy, countIn, keyFor, VERSION };
  root.TGMD = root.TGMD || {};
  root.TGMD.ledger = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
