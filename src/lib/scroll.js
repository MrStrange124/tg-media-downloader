(function (root) {
  'use strict';

  function isScrollable(m) {
    if (!m) return false;
    const overflow = String(m.overflowY || '');
    if (!/^(auto|scroll|overlay)$/.test(overflow)) return false;
    return Number(m.scrollHeight) > Number(m.clientHeight);
  }

  function makeStabilityTracker({ needed = 3 } = {}) {
    let prev = null;
    let run = 0;
    return {
      push(sample) {
        const same = prev !== null &&
          prev.scrollTop === sample.scrollTop &&
          prev.scrollHeight === sample.scrollHeight;
        run = same ? run + 1 : 0;
        prev = { scrollTop: sample.scrollTop, scrollHeight: sample.scrollHeight };
        return run >= needed;
      },
      reset() { prev = null; run = 0; }
    };
  }

  const api = { isScrollable, makeStabilityTracker };
  root.TGMD = root.TGMD || {};
  root.TGMD.scroll = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
