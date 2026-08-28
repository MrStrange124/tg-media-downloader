'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const sc = require('../src/lib/scroll.js');

test('isScrollable accepts auto and scroll with overflowing content', () => {
  assert.equal(sc.isScrollable({ overflowY: 'auto', scrollHeight: 500, clientHeight: 200 }), true);
  assert.equal(sc.isScrollable({ overflowY: 'scroll', scrollHeight: 500, clientHeight: 200 }), true);
});

test('isScrollable rejects non-overflowing content', () => {
  assert.equal(sc.isScrollable({ overflowY: 'auto', scrollHeight: 200, clientHeight: 200 }), false);
});

test('isScrollable rejects hidden and visible overflow', () => {
  assert.equal(sc.isScrollable({ overflowY: 'hidden', scrollHeight: 500, clientHeight: 200 }), false);
  assert.equal(sc.isScrollable({ overflowY: 'visible', scrollHeight: 500, clientHeight: 200 }), false);
});

test('isScrollable tolerates missing input', () => {
  assert.equal(sc.isScrollable(null), false);
  assert.equal(sc.isScrollable({}), false);
});

test('tracker reports stable only after the required run', () => {
  const t = sc.makeStabilityTracker({ needed: 3 });
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 1000 }), false); // first sample
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 1000 }), false); // run of 1
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 1000 }), false); // run of 2
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 1000 }), true);  // run of 3
});

test('tracker resets when the container grows (lazy load arrived)', () => {
  const t = sc.makeStabilityTracker({ needed: 2 });
  t.push({ scrollTop: 0, scrollHeight: 1000 });
  t.push({ scrollTop: 0, scrollHeight: 1000 });
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 2000 }), false, 'growth must reset the run');
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 2000 }), false);
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 2000 }), true);
});

test('tracker resets when scroll position moves', () => {
  const t = sc.makeStabilityTracker({ needed: 2 });
  t.push({ scrollTop: 0, scrollHeight: 1000 });
  t.push({ scrollTop: 0, scrollHeight: 1000 });
  assert.equal(t.push({ scrollTop: 500, scrollHeight: 1000 }), false);
});

test('tracker reset() clears the run', () => {
  const t = sc.makeStabilityTracker({ needed: 2 });
  t.push({ scrollTop: 0, scrollHeight: 1000 });
  t.push({ scrollTop: 0, scrollHeight: 1000 });
  t.reset();
  assert.equal(t.push({ scrollTop: 0, scrollHeight: 1000 }), false);
});
