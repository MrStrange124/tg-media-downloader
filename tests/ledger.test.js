const test = require('node:test');
const assert = require('node:assert');
const ledger = require('../src/lib/ledger.js');

// Stands in for chrome.storage.local: get(null) returns everything, get(key)
// returns just that key, and both are async like the real API.
function fakeStorage(initial) {
  const store = Object.assign({}, initial);
  return {
    store: store,
    async get(key) {
      if (key === null || key === undefined) return Object.assign({}, store);
      return Object.prototype.hasOwnProperty.call(store, key)
        ? { [key]: store[key] } : {};
    },
    async set(obj) { Object.assign(store, obj); },
    async remove(keys) { for (const k of [].concat(keys)) delete store[k]; }
  };
}

test('a fresh chat starts empty', async () => {
  const led = ledger.create(fakeStorage({}));
  await led.open('-100123');
  assert.strictEqual(led.size(), 0);
  assert.strictEqual(led.hasTile('shared-mediamessage-7'), false);
});

test('a noted tile is known without reopening it', async () => {
  const led = ledger.create(fakeStorage({}));
  await led.open('-100123');
  led.note('shared-mediamessage-7', 'abc123', 'Telegram/Cats/cat.jpg');
  assert.strictEqual(led.hasTile('shared-mediamessage-7'), true);
  assert.strictEqual(led.tileName('shared-mediamessage-7'), 'Telegram/Cats/cat.jpg');
  assert.strictEqual(led.contentName('abc123'), 'Telegram/Cats/cat.jpg');
});

test('the same bytes forwarded under a new message id are still known', async () => {
  const led = ledger.create(fakeStorage({}));
  await led.open('-100123');
  led.note('shared-mediamessage-7', 'abc123', 'cat.jpg');
  assert.strictEqual(led.hasTile('shared-mediamessage-9'), false);
  assert.strictEqual(led.contentName('abc123'), 'cat.jpg');
});

test('flush persists under one key and reloads', async () => {
  const storage = fakeStorage({});
  const a = ledger.create(storage);
  await a.open('-100123');
  a.note('shared-mediamessage-7', 'abc123', 'cat.jpg');
  await a.flush();
  assert.deepStrictEqual(Object.keys(storage.store), ['led:-100123']);

  const b = ledger.create(storage);
  await b.open('-100123');
  assert.strictEqual(b.hasTile('shared-mediamessage-7'), true);
});

test('flush is a no-op when nothing changed', async () => {
  const storage = fakeStorage({});
  const led = ledger.create(storage);
  await led.open('-100123');
  assert.strictEqual(await led.flush(), false);
});

test('legacy per-item keys fold into the content index and are removed', async () => {
  const storage = fakeStorage({
    '-100123:aaa': 'Telegram/Cats/one.jpg',
    '-100123:bbb': 'Telegram/Cats/two.mp4',
    '-100999:ccc': 'Telegram/Dogs/three.jpg',
    'settings': { subfolder: 'Telegram' }
  });
  const led = ledger.create(storage);
  await led.open('-100123');

  assert.strictEqual(led.contentName('aaa'), 'Telegram/Cats/one.jpg');
  assert.strictEqual(led.contentName('bbb'), 'Telegram/Cats/two.mp4');
  assert.strictEqual(led.size(), 2);
  // Another chat's records and unrelated settings are untouched.
  assert.strictEqual(storage.store['-100123:aaa'], undefined);
  assert.strictEqual(storage.store['-100999:ccc'], 'Telegram/Dogs/three.jpg');
  assert.ok(storage.store['settings']);
});

test('a tile and its content count as one download, not two', async () => {
  const led = ledger.create(fakeStorage({}));
  await led.open('-100123');
  led.note('shared-mediamessage-7', 'abc123', 'cat.jpg');
  led.note('shared-mediamessage-8', 'def456', 'dog.jpg');
  assert.strictEqual(led.size(), 2);
});

test('forget clears this chat and leaves others alone', async () => {
  const storage = fakeStorage({ '-100999:ccc': 'Telegram/Dogs/three.jpg' });
  const led = ledger.create(storage);
  await led.open('-100123');
  led.note('shared-mediamessage-7', 'abc123', 'cat.jpg');
  await led.flush();

  assert.strictEqual(await led.forget(), 1);
  assert.strictEqual(led.hasTile('shared-mediamessage-7'), false);
  assert.strictEqual(storage.store['led:-100123'], undefined);
  assert.strictEqual(storage.store['-100999:ccc'], 'Telegram/Dogs/three.jpg');
});

test('forget also sweeps unmigrated legacy keys for the chat', async () => {
  const storage = fakeStorage({ '-100123:aaa': 'one.jpg', '-100123:bbb': 'two.jpg' });
  const led = ledger.create(fakeStorage({}));   // never opened this chat
  const other = ledger.create(storage);
  assert.strictEqual(await other.forget('-100123'), 2);
  assert.deepStrictEqual(Object.keys(storage.store), []);
  assert.ok(led);
});

test('switching chats flushes the previous one', async () => {
  const storage = fakeStorage({});
  const led = ledger.create(storage);
  await led.open('-100123');
  led.note('shared-mediamessage-7', 'abc123', 'cat.jpg');
  await led.open('-100999');
  assert.ok(storage.store['led:-100123'], 'first chat was written before switching');
  assert.strictEqual(led.hasTile('shared-mediamessage-7'), false);
});

test('a corrupt stored value degrades to empty rather than throwing', async () => {
  const led = ledger.create(fakeStorage({ 'led:-100123': 'not an object' }));
  await led.open('-100123');
  assert.strictEqual(led.size(), 0);
});

test('forget counts notes that have not been flushed yet', async () => {
  const storage = fakeStorage({});
  const led = ledger.create(storage);
  await led.open('-100123');
  led.note('shared-mediamessage-7', 'abc123', 'cat.jpg');
  led.note('shared-mediamessage-8', 'def456', 'dog.jpg');
  // Deliberately no flush: mid-run this is the normal state.
  assert.strictEqual(await led.forget(), 2);
  assert.strictEqual(led.size(), 0);
});
