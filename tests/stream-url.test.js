'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const su = require('../src/lib/stream-url.js');

test('parseContentRange reads a normal header', () => {
  assert.deepEqual(su.parseContentRange('bytes 0-524287/2097152'),
    { start: 0, end: 524287, total: 2097152 });
});

test('parseContentRange handles a mid-file range', () => {
  assert.deepEqual(su.parseContentRange('bytes 524288-1048575/2097152'),
    { start: 524288, end: 1048575, total: 2097152 });
});

test('parseContentRange handles a final partial chunk', () => {
  assert.deepEqual(su.parseContentRange('bytes 2097000-2097151/2097152'),
    { start: 2097000, end: 2097151, total: 2097152 });
});

test('parseContentRange tolerates extra whitespace', () => {
  assert.deepEqual(su.parseContentRange('  bytes 0-9/10  '),
    { start: 0, end: 9, total: 10 });
});

test('parseContentRange rejects malformed and unsatisfiable headers', () => {
  assert.equal(su.parseContentRange('bytes */2097152'), null);
  assert.equal(su.parseContentRange('items 0-9/10'), null);
  assert.equal(su.parseContentRange('bytes 0-9/*'), null);
  assert.equal(su.parseContentRange(''), null);
  assert.equal(su.parseContentRange(null), null);
});

test('parseStreamUrl extracts Telegram stream metadata', () => {
  const meta = { dcId: 5, location: { id: '99', accessHash: 'abc' },
                 size: 2097152, mimeType: 'video/mp4', fileName: 'clip.MP4' };
  const url = 'https://web.telegram.org/a/progressive/stream/' +
              encodeURIComponent(JSON.stringify(meta));
  assert.deepEqual(su.parseStreamUrl(url), meta);
});

test('parseStreamUrl handles a filename with spaces and unicode', () => {
  const meta = { dcId: 2, location: { id: '1' }, size: 10,
                 mimeType: 'video/mp4', fileName: 'my clip é.mp4' };
  const url = 'https://web.telegram.org/a/stream/' +
              encodeURIComponent(JSON.stringify(meta));
  assert.equal(su.parseStreamUrl(url).fileName, 'my clip é.mp4');
});

test('parseStreamUrl returns null for non-stream URLs', () => {
  assert.equal(su.parseStreamUrl('blob:https://web.telegram.org/abc-123'), null);
  assert.equal(su.parseStreamUrl('https://web.telegram.org/a/'), null);
  assert.equal(su.parseStreamUrl(''), null);
  assert.equal(su.parseStreamUrl(null), null);
});

test('parseStreamUrl returns null when the segment is not valid JSON', () => {
  assert.equal(su.parseStreamUrl('https://web.telegram.org/a/stream/not-json'), null);
});

test('parseStreamUrl returns null when JSON is valid but not an object', () => {
  const url = 'https://web.telegram.org/a/stream/' + encodeURIComponent('42');
  assert.equal(su.parseStreamUrl(url), null);
});
