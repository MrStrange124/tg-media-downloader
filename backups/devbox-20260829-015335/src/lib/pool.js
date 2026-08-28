(function (root) {
  'use strict';

  // A bounded-concurrency task pool with backpressure and a per-run key guard.
  //
  //   const pool = createPool({ concurrency, onResult, onError });
  //   for (const item of items) {
  //     if (!pool.reserve(item.key)) continue;   // skip in-run duplicates
  //     await pool.run(() => downloadIt(item));   // parks the producer when full
  //   }
  //   await pool.drain();                          // wait for the stragglers
  //
  // `run` resolves as soon as a slot is acquired and the task has been kicked
  // off — not when the task finishes — so awaiting it paces the producer to at
  // most `concurrency` tasks in flight. Results and failures arrive on the
  // onResult / onError callbacks, so completion order does not matter.
  function createPool(opts) {
    opts = opts || {};
    const concurrency = Math.max(1, opts.concurrency | 0 || 1);
    const onResult = typeof opts.onResult === 'function' ? opts.onResult : function () {};
    const onError = typeof opts.onError === 'function' ? opts.onError : function () {};

    let available = concurrency;   // free slots
    const waiters = [];            // producers parked waiting for a slot
    const inFlight = new Set();    // running task promises
    const seen = new Set();        // reserved keys this run

    function acquire() {
      if (available > 0) { available--; return Promise.resolve(); }
      return new Promise((resolve) => waiters.push(resolve));
    }

    function release() {
      // Hand the freed slot straight to the next waiter rather than bumping the
      // counter, so the ceiling can never be briefly exceeded.
      if (waiters.length) waiters.shift()();
      else available++;
    }

    async function run(task) {
      await acquire();
      const p = (async () => {
        try { onResult(await task()); }
        catch (e) { onError(e); }
        finally { release(); }
      })();
      inFlight.add(p);
      p.then(() => inFlight.delete(p), () => inFlight.delete(p));
      // Intentionally return here (slot acquired, task started) for backpressure.
    }

    // True the first time a key is seen this run, false afterwards. A null/undefined
    // key is never deduped (callers use it for items without a stable identity).
    function reserve(key) {
      if (key == null) return true;
      const k = String(key);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }

    function drain() { return Promise.all(Array.from(inFlight)); }

    return {
      run: run,
      reserve: reserve,
      drain: drain,
      get inFlight() { return inFlight.size; },
      get concurrency() { return concurrency; }
    };
  }

  const api = { createPool: createPool };
  root.TGMD = root.TGMD || {};
  root.TGMD.pool = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
