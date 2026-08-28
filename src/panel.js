(function (root) {
  'use strict';

  let el = null;
  let failures = [];

  const HTML = [
    '<div class="tgmd-head">',
    '  <span class="tgmd-title">TG Media Downloader</span>',
    '  <button class="tgmd-collapse" title="Collapse">&ndash;</button>',
    '</div>',
    '<div class="tgmd-body">',
    '  <button class="tgmd-btn" data-act="all">Download all media in this chat</button>',
    '  <button class="tgmd-btn" data-act="select">Select media&hellip;</button>',
    '  <div class="tgmd-status">Idle</div>',
    '  <div class="tgmd-bar"><div class="tgmd-fill"></div></div>',
    '  <div class="tgmd-controls tgmd-hidden">',
    '    <button class="tgmd-btn" data-act="pause">Pause</button>',
    '    <button class="tgmd-btn" data-act="stop">Stop</button>',
    '  </div>',
    '  <div class="tgmd-failures tgmd-hidden">',
    '    <div class="tgmd-fail-count"></div>',
    '    <button class="tgmd-btn" data-act="retry">Retry failed</button>',
    '  </div>',
    '  <details class="tgmd-log"><summary>Log</summary><pre></pre></details>',
    '</div>'
  ].join('\n');

  function mount() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'tgmd-panel';
    el.innerHTML = HTML;
    document.body.appendChild(el);

    el.querySelector('.tgmd-collapse').addEventListener('click', () => {
      el.classList.toggle('tgmd-collapsed');
    });
    el.addEventListener('click', (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act) onAction(act, e.target);
    });
  }

  const status = (t) => { if (el) el.querySelector('.tgmd-status').textContent = t; };
  const fill = (r) => {
    if (el) el.querySelector('.tgmd-fill').style.width = Math.round(r * 100) + '%';
  };
  const logLine = (t) => {
    if (!el) return;
    const pre = el.querySelector('.tgmd-log pre');
    pre.textContent += t + '\n';
    pre.scrollTop = pre.scrollHeight;
  };

  function setRunning(on) {
    el.querySelector('.tgmd-controls').classList.toggle('tgmd-hidden', !on);
    if (on) { status('Starting…'); fill(0); }
  }

  function showFailures() {
    const box = el.querySelector('.tgmd-failures');
    box.classList.toggle('tgmd-hidden', failures.length === 0);
    el.querySelector('.tgmd-fail-count').textContent = failures.length + ' failed';
  }

  async function runWith(tileKeys) {
    failures = [];
    showFailures();
    setRunning(true);
    try {
      await root.TGMD.run.start({ tileKeys: tileKeys, onEvent: handleEvent });
    } catch (e) {
      status('Error: ' + e.message);
    } finally {
      setRunning(false);
    }
  }

  async function onAction(act, btn) {
    if (act === 'all') {
      await runWith(null);
    } else if (act === 'download-selected') {
      const keys = root.TGMD.select.chosen();
      if (!keys.size) return;
      root.TGMD.select.toggle();
      await runWith(keys);
    } else if (act === 'select') {
      root.TGMD.select.toggle();
    } else if (act === 'pause') {
      const pausing = btn.textContent === 'Pause';
      if (pausing) root.TGMD.run.pause(); else root.TGMD.run.resume();
      btn.textContent = pausing ? 'Resume' : 'Pause';
    } else if (act === 'stop') {
      root.TGMD.run.stop();
    } else if (act === 'retry') {
      // Resume makes this safe: already-saved items are skipped, so simply
      // running again retries exactly the failures.
      await runWith(null);
    }
  }

  function handleEvent(ev) {
    if (ev.type === 'progress' && ev.enumerated != null) {
      status('Working… ' + ev.enumerated + ' found so far');
    } else if (ev.type === 'progress' && ev.total) {
      fill(ev.received / ev.total);
    } else if (ev.type === 'item') {
      if (ev.ok) {
        logLine('saved ' + (ev.filename || '') + (ev.skipped ? '  (already had it)' : ''));
      } else {
        logLine('FAILED item ' + (ev.index + 1) + ': ' + ev.error);
        failures.push(ev);
      }
      showFailures();
    } else if (ev.type === 'done') {
      const s = ev.summary;
      status('Done — ' + s.saved + ' saved, ' + s.skipped + ' already had, ' + s.failed.length + ' failed');
      fill(1);
    }
  }

  root.TGMD.panel = { mount: mount, handleEvent: handleEvent };
})(typeof globalThis !== 'undefined' ? globalThis : self);
