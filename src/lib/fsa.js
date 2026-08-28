(function (root) {
  'use strict';

  // Direct-to-disk saving via the File System Access API.
  //
  // Why this exists: chrome.downloads.download({saveAs:false}) still produced a
  // confirmation dialog for every file on the target machine, and no setting,
  // permission or argument change suppressed it. Writing through a directory
  // handle bypasses the browser download system entirely, so there is nothing
  // left to prompt. The user grants a folder once; the handle is persisted and
  // reused. Large media streams to disk instead of being buffered as a Blob.

  const DB_NAME = 'tgmd';
  const DB_VERSION = 1;
  const STORE = 'handles';
  const KEY = 'outputDir';

  // ------------------------------------------------------------ pure helpers
  // Split a relative path into directory segments plus a leaf filename.
  // Empty and dot segments are dropped: they cannot be created as directories
  // and "." would silently resolve to the parent.
  function splitPath(relPath) {
    const parts = String(relPath == null ? '' : relPath)
      .split('/')
      .map((p) => p.trim())
      .filter((p) => p && p !== '.' && p !== '..');
    const name = parts.pop() || 'untitled';
    return { dirs: parts, name: name };
  }

  // "a.jpg" -> "a (1).jpg" -> "a (2).jpg". Matches the shape of Chrome's
  // uniquify so filenames stay familiar.
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

  function idbPut(key, value) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  function idbGet(key) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    }));
  }

  function idbDelete(key) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    }));
  }

  // -------------------------------------------------------------- handles
  const supported = () => typeof root.showDirectoryPicker === 'function';

  let cached = null;

  async function handle() {
    if (cached) return cached;
    cached = await idbGet(KEY);
    return cached;
  }

  // 'granted' | 'prompt' | 'denied' | 'none'
  async function permission() {
    const h = await handle();
    if (!h) return 'none';
    try {
      return await h.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      return 'denied';
    }
  }

  // Must be called from a user gesture when the answer may be 'prompt'.
  // Chrome forgets the grant across browser restarts, so this is a once-per-
  // session click rather than a once-ever one.
  async function ensurePermission() {
    const h = await handle();
    if (!h) return false;
    try {
      if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
      return await h.requestPermission({ mode: 'readwrite' }) === 'granted';
    } catch (e) {
      return false;
    }
  }

  // Show the folder picker and remember the choice. User gesture required.
  async function choose() {
    if (!supported()) throw new Error('this browser has no File System Access API');
    const h = await root.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
    cached = h;
    await idbPut(KEY, h);
    return h;
  }

  async function forget() {
    cached = null;
    await idbDelete(KEY);
  }

  async function ready() {
    if (!supported()) return false;
    return (await permission()) === 'granted';
  }

  // ---------------------------------------------------------------- writing
  async function dirFor(rootHandle, dirs) {
    let dir = rootHandle;
    for (const seg of dirs) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
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

  // Writes `blob` at `relPath` beneath the chosen folder, creating directories
  // as needed. Returns the path actually written, which may differ from the
  // request when uniquifying around an existing file.
  async function write(relPath, blob, opts) {
    opts = opts || {};
    const h = await handle();
    if (!h) throw new Error('no output folder chosen');
    if (!await ensurePermission()) throw new Error('folder permission not granted');

    const { dirs, name } = splitPath(relPath);
    const dir = await dirFor(h, dirs);

    let finalName = name;
    if (opts.conflict !== 'overwrite') {
      for (let n = 0; n < 1000; n++) {
        const candidate = nextCandidate(name, n);
        if (!await exists(dir, candidate)) { finalName = candidate; break; }
      }
    }

    const fileHandle = await dir.getFileHandle(finalName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
    } catch (e) {
      try { await writable.abort(); } catch (e2) { /* already failing */ }
      throw e;
    }
    await writable.close();
    return dirs.concat(finalName).join('/');
  }

  const api = {
    splitPath, nextCandidate,
    supported, handle, permission, ensurePermission,
    choose, forget, ready, write
  };
  root.TGMD = root.TGMD || {};
  root.TGMD.fsa = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
