'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const rf = require('../src/lib/range-fetch.js');

// Builds a fake fetch that serves `size` bytes in `chunk`-sized pieces.
function makeServer({ size, chunk, mime = 'video/mp4', failures = {} }) {
  const calls = [];
  const attempts = {};

  function resp(start, end, total) {
    const headers = new Map([
      ['Content-Range', `bytes ${start}-${end}/${total}`],
      ['Content-Type', mime]
    ]);
    return {
      status: 206,
      headers: { get: (k) => headers.get(k) ?? null },
      blob: async () => new Blob([new Uint8Array(end - start + 1)])
    };
  }

  const fetchImpl = async (url, init) => {
    const range = init.headers.Range;
    const start = parseInt(/bytes=(\d+)-/.exec(range)[1], 10);
    calls.push(start);
    attempts[start] = (attempts[start] || 0) + 1;

    const plan = failures[start];
    if (plan && attempts[start] <= plan.times) {
      if (plan.kind === 'status') return { status: 500, headers: { get: () => null } };
      if (plan.kind === 'throw') throw new Error('network down');
      if (plan.kind === 'gap') {
        const bad = start + 10;
        return resp(bad, Math.min(bad + chunk, size) - 1, size);
      }
      if (plan.kind === 'sizeshift') {
        return resp(start, Math.min(start + chunk, size) - 1, size + 1);
      }
    }
    const end = Math.min(start + chunk, size) - 1;
    return resp(start, end, size);
  };

  return { fetchImpl, calls };
}

test('assembles a file that needs several chunks', async () => {
  const { fetchImpl, calls } = makeServer({ size: 1000, chunk: 300 });
  const out = await rf.fetchRanged('u', { fetchImpl });
  assert.equal(out.total, 1000);
  assert.equal(out.blob.size, 1000);
  assert.equal(out.mimeType, 'video/mp4');
  assert.deepEqual(calls, [0, 300, 600, 900]);
});

test('handles a file served whole in one response', async () => {
  const { fetchImpl, calls } = makeServer({ size: 500, chunk: 5000 });
  const out = await rf.fetchRanged('u', { fetchImpl });
  assert.equal(out.blob.size, 500);
  assert.deepEqual(calls, [0]);
});

test('reports progress monotonically up to the total', async () => {
  const { fetchImpl } = makeServer({ size: 1000, chunk: 250 });
  const seen = [];
  await rf.fetchRanged('u', { fetchImpl, onProgress: (p) => seen.push(p.received) });
  assert.deepEqual(seen, [250, 500, 750, 1000]);
});

test('retries a transient network throw then succeeds', async () => {
  const { fetchImpl, calls } = makeServer({
    size: 600, chunk: 300, failures: { 300: { kind: 'throw', times: 2 } }
  });
  const out = await rf.fetchRanged('u', { fetchImpl, maxRetries: 3 });
  assert.equal(out.blob.size, 600);
  assert.deepEqual(calls, [0, 300, 300, 300]);
});

test('retries a non-2xx status then succeeds', async () => {
  const { fetchImpl } = makeServer({
    size: 600, chunk: 300, failures: { 0: { kind: 'status', times: 1 } }
  });
  const out = await rf.fetchRanged('u', { fetchImpl, maxRetries: 3 });
  assert.equal(out.blob.size, 600);
});

test('gives up with BAD_STATUS after exhausting retries', async () => {
  const { fetchImpl } = makeServer({
    size: 600, chunk: 300, failures: { 0: { kind: 'status', times: 99 } }
  });
  await assert.rejects(
    () => rf.fetchRanged('u', { fetchImpl, maxRetries: 2 }),
    (e) => e.code === 'BAD_STATUS'
  );
});

test('detects a gap between responses', async () => {
  const { fetchImpl } = makeServer({
    size: 900, chunk: 300, failures: { 300: { kind: 'gap', times: 99 } }
  });
  await assert.rejects(
    () => rf.fetchRanged('u', { fetchImpl, maxRetries: 1 }),
    (e) => e.code === 'GAP'
  );
});

test('detects the total size changing mid-download', async () => {
  const { fetchImpl } = makeServer({
    size: 900, chunk: 300, failures: { 300: { kind: 'sizeshift', times: 99 } }
  });
  await assert.rejects(
    () => rf.fetchRanged('u', { fetchImpl, maxRetries: 1 }),
    (e) => e.code === 'SIZE_MISMATCH'
  );
});

test('fails with NO_RANGE when the server ignores Range', async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: (k) => (k === 'Content-Type' ? 'video/mp4' : null) },
    blob: async () => new Blob([new Uint8Array(10)])
  });
  await assert.rejects(
    () => rf.fetchRanged('u', { fetchImpl }),
    (e) => e.code === 'NO_RANGE'
  );
});

test('aborts promptly when the signal is already aborted', async () => {
  const { fetchImpl } = makeServer({ size: 1000, chunk: 100 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => rf.fetchRanged('u', { fetchImpl, signal: ac.signal }),
    (e) => e.code === 'ABORTED'
  );
});

test('aborts part-way through a multi-chunk download', async () => {
  const ac = new AbortController();
  const { fetchImpl } = makeServer({ size: 1000, chunk: 100 });
  const wrapped = async (u, i) => {
    const r = await fetchImpl(u, i);
    ac.abort();
    return r;
  };
  await assert.rejects(
    () => rf.fetchRanged('u', { fetchImpl: wrapped, signal: ac.signal }),
    (e) => e.code === 'ABORTED'
  );
});
