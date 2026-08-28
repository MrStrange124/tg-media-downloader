'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const naming = require('../src/lib/naming.js');

test('sanitizeSegment strips characters illegal on Windows', () => {
  assert.equal(naming.sanitizeSegment('a\\b/c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizeSegment strips control characters', () => {
  assert.equal(naming.sanitizeSegment('nul\u0000bel\u0007'), 'nulbel');
});

test('sanitizeSegment collapses whitespace and trims', () => {
  assert.equal(naming.sanitizeSegment('  My   Group \n Chat  '), 'My Group Chat');
});

test('sanitizeSegment truncates to 120 characters', () => {
  assert.equal(naming.sanitizeSegment('x'.repeat(200)).length, 120);
});

test('sanitizeSegment never returns empty', () => {
  assert.equal(naming.sanitizeSegment('///'), 'untitled');
  assert.equal(naming.sanitizeSegment(''), 'untitled');
});

test('sanitizeSegment strips trailing dots and spaces (Windows rejects them)', () => {
  assert.equal(naming.sanitizeSegment('name. .'), 'name');
});

test('extFromMime maps the common Telegram types', () => {
  assert.equal(naming.extFromMime('video/mp4'), 'mp4');
  assert.equal(naming.extFromMime('image/jpeg'), 'jpg');
  assert.equal(naming.extFromMime('image/png'), 'png');
  assert.equal(naming.extFromMime('image/webp'), 'webp');
  assert.equal(naming.extFromMime('video/webm'), 'webm');
  assert.equal(naming.extFromMime('video/quicktime'), 'mov');
});

test('extFromMime ignores codec parameters', () => {
  assert.equal(naming.extFromMime('video/mp4; codecs="avc1.42E01E"'), 'mp4');
});

test('extFromMime falls back to bin for unknown types', () => {
  assert.equal(naming.extFromMime('application/x-weird'), 'bin');
  assert.equal(naming.extFromMime(''), 'bin');
  assert.equal(naming.extFromMime(null), 'bin');
});

test('buildFilename produces the documented shape', () => {
  assert.equal(
    naming.buildFilename({
      chatTitle: 'My Group', date: new Date('2026-08-28T10:00:00Z'),
      messageKey: '12345', mime: 'video/mp4'
    }),
    'Telegram/My Group/2026-08-28_12345.mp4'
  );
});

test('buildFilename appends an album index when given', () => {
  assert.equal(
    naming.buildFilename({
      chatTitle: 'My Group', date: new Date('2026-08-28T10:00:00Z'),
      messageKey: '12345', index: 2, mime: 'image/jpeg'
    }),
    'Telegram/My Group/2026-08-28_12345_2.jpg'
  );
});

test('buildFilename prefers the original filename when present', () => {
  assert.equal(
    naming.buildFilename({
      chatTitle: 'My Group', date: new Date('2026-08-28T10:00:00Z'),
      messageKey: '12345', originalName: 'holiday clip.MP4', mime: 'video/mp4'
    }),
    'Telegram/My Group/2026-08-28_12345_holiday clip.MP4'
  );
});

test('buildFilename sanitises a hostile original filename', () => {
  const got = naming.buildFilename({
    chatTitle: 'x', date: new Date('2026-08-28T10:00:00Z'),
    messageKey: '1', originalName: '../../etc/passwd', mime: 'image/jpeg'
  });
  assert.equal(got, 'Telegram/x/2026-08-28_1_.._.._etc_passwd');
  assert.ok(!got.includes('../'), 'must not allow path traversal');
});

test('buildFilename sanitises a hostile chat title', () => {
  assert.equal(
    naming.buildFilename({
      chatTitle: '../../evil', date: new Date('2026-08-28T10:00:00Z'),
      messageKey: '1', mime: 'image/jpeg'
    }),
    'Telegram/.._.._evil/2026-08-28_1.jpg'
  );
});
