(function (root) {
  'use strict';

  // Direct-to-disk saving via the File System Access API.
  //
  // The pickers are not exposed to content scripts, so picking a folder must
  // happen in an extension page while writing happens in the service worker,
  // which can read the stored handle. Loaded in both, offering what each can do.

  const DB_NAME = 'tgmd-fs';
  const DB_VERSION = 1;
  const STORE = 'handles';
  const KEY = 'outputDir';

  // ------------------------------------------------------------ pure helpers
  // Directory segments plus a leaf. Empty, "." and ".." are dropped — ".."
  // would escape the granted folder.
  function splitPath(relPath) {
    const parts = String(relPath == null ? '' : relPath)
      .split('/')
      .map((p) => p.trim())
      .filter((p) => p && p !== '.' && p !== '..');
    const name = parts.pop() || 'untitled';
    return { dirs: parts, name: name };
  }

  // "a.jpg" -> "a (1).jpg". Mirrors Chrome's uniquify so names stay familiar.
  function nextCandidate(name, n) {
    if (n <= 0) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return stem + ' (' + n + ')' + ext;
  }

  // ------------------------------------------------------------------- idb
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let out;
      try { out = fn(t.objectStore(STORE)); } catch (e) { reject(e); return; }
      t.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = () => { db.close(); reject(t.error); };
    }));
  }

  // -------------------------------------------------------------- handles
  // Pickers exist only in extension pages.
  const canPick = () => typeof root.showDirectoryPicker === 'function';

  let cached;

  async function getHandle() {
    if (cached !== undefined) return cached;
    try {
      cached = (await tx('readonly', (s) => s.get(KEY))) || null;
    } catch (e) {
      cached = null;
    }
    return cached;
  }

  async function setHandle(h) {
    cached = h;
    await tx('readwrite', (s) => s.put(h, KEY));
  }

  async function clearHandle() {
    cached = null;
    await tx('readwrite', (s) => s.delete(KEY));
  }

  // 'none' | 'granted' | 'prompt' | 'denied'
  async function permission() {
    const h = await getHandle();
    if (!h) return 'none';
    try {
      return await h.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'denied';
    }
  }

  // Extension pages only: requestPermission needs transient activation.
  async function requestPermission() {
    const h = await getHandle();
    if (!h) return false;
    try {
      if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
      return await h.requestPermission({ mode: 'readwrite' }) === 'granted';
    } catch (e) {
      return false;
    }
  }

  // Extension pages only. Must be called directly from a user gesture.
  async function pick() {
    if (!canPick()) throw new Error('no folder picker in this context');
    const h = await root.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
    await setHandle(h);
    return h;
  }

  // ---------------------------------------------------------------- writing
  async function dirFor(rootHandle, dirs) {
    let dir = rootHandle;
    for (const seg of dirs) dir = await dir.getDirectoryHandle(seg, { create: true });
    return dir;
  }

  async function exists(dir, name) {
    try {
      await dir.getFileHandle(name, { create: false });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Opens a writable stream beneath the granted folder, creating directories as
  // needed. The returned path may differ from the request after uniquifying.
  async function openWriter(relPath, opts) {
    opts = opts || {};
    const h = await getHandle();
    if (!h) throw new Error('no output folder chosen');
    if (await permission() !== 'granted') throw new Error('folder permission not granted');

    const parts = splitPath(relPath);
    const dir = await dirFor(h, parts.dirs);

    let finalName = parts.name;
    if (opts.conflict !== 'overwrite') {
      for (let n = 0; n < 1000; n++) {
        const candidate = nextCandidate(parts.name, n);
        if (!await exists(dir, candidate)) { finalName = candidate; break; }
      }
    }

    const fileHandle = await dir.getFileHandle(finalName, { create: true });
    const writable = await fileHandle.createWritable();
    return { writable: writable, path: parts.dirs.concat(finalName).join('/') };
  }

  const api = {
    splitPath, nextCandidate,
    canPick, getHandle, setHandle, clearHandle,
    permission, requestPermission, pick, openWriter
  };
  root.TGMD = root.TGMD || {};
  root.TGMD.fsa = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
