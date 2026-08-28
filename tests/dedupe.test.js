'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const dd = require('../src/lib/dedupe.js');

test('chatIdFromHash reads a supergroup id', () => {
  assert.equal(dd.chatIdFromHash('#-1001234567890'), '-1001234567890');
});

test('chatIdFromHash reads a positive user id', () => {
  assert.equal(dd.chatIdFromHash('#123456'), '123456');
});

test('chatIdFromHash ignores a thread suffix', () => {
  assert.equal(dd.chatIdFromHash('#-1001234567890_42'), '-1001234567890');
});

test('chatIdFromHash accepts a full URL', () => {
  assert.equal(dd.chatIdFromHash('https://web.telegram.org/a/#-100999'), '-100999');
});

test('chatIdFromHash returns null when there is no chat', () => {
  assert.equal(dd.chatIdFromHash('#'), null);
  assert.equal(dd.chatIdFromHash(''), null);
  assert.equal(dd.chatIdFromHash(null), null);
  assert.equal(dd.chatIdFromHash('https://web.telegram.org/a/'), null);
});

test('contentKey is stable for the same stream location', async () => {
  const mk = (extra) => 'https://web.telegram.org/a/stream/' + encodeURIComponent(JSON.stringify(
    Object.assign({ dcId: 5, location: { id: '99', accessHash: 'abc' },
                    size: 100, mimeType: 'video/mp4' }, extra)));
  assert.equal(await dd.contentKey(mk({})), await dd.contentKey(mk({ size: 100 })));
});

test('contentKey differs for different locations', async () => {
  const mk = (id) => 'https://web.telegram.org/a/stream/' + encodeURIComponent(JSON.stringify(
    { dcId: 5, location: { id, accessHash: 'abc' }, size: 100, mimeType: 'video/mp4' }));
  assert.notEqual(await dd.contentKey(mk('1')), await dd.contentKey(mk('2')));
});

test('contentKey falls back to the URL path for non-stream URLs', async () => {
  const a = await dd.contentKey('https://web.telegram.org/a/photo/abc?token=1');
  const b = await dd.contentKey('https://web.telegram.org/a/photo/abc?token=2');
  assert.equal(a, b, 'query strings are volatile and must not affect the key');
  const c = await dd.contentKey('https://web.telegram.org/a/photo/xyz');
  assert.notEqual(a, c);
});

test('contentKey returns 16 hex characters', async () => {
  const k = await dd.contentKey('https://web.telegram.org/a/photo/abc');
  assert.match(k, /^[0-9a-f]{16}$/);
});

test('recordKey joins chat and message', () => {
  assert.equal(dd.recordKey('-100123', 'abc'), '-100123:abc');
});
