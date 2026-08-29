(function (root) {
  'use strict';

  let el = null;
  let failures = [];
  let running = false;

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
    '  <div class="tgmd-controls">',
    '    <button class="tgmd-btn tgmd-sm" data-act="pause" disabled>Pause</button>',
    '    <button class="tgmd-btn tgmd-sm" data-act="stop" disabled>Stop</button>',
    '    <button class="tgmd-btn tgmd-sm tgmd-ghost" data-act="clear">Clear</button>',
    '  </div>',
    '  <div class="tgmd-failures tgmd-hidden">',
    '    <div class="tgmd-fail-count"></div>',
    '    <button class="tgmd-btn tgmd-sm" data-act="retry">Retry failed</button>',
    '  </div>',
    '  <details class="tgmd-log"><summary>Log</summary><pre></pre></details>',
    '  <div class="tgmd-hint tgmd-hidden"></div>',
    '  <button class="tgmd-link" data-act="clearhistory">Clear history for this chat</button>',
    '  <button class="tgmd-link" data-act="probeprompt">Diagnose the save prompt</button>',
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

    refreshHistoryLabel();
  }

  // ------------------------------------------------------------- rendering
  const $ = (s) => el.querySelector(s);
  const status = (t) => { if (el) $('.tgmd-status').textContent = t; };
  const fill = (r) => {
    // Late failures can be appended past the planned total.
    if (el) $('.tgmd-fill').style.width = Math.round(Math.min(1, Math.max(0, r)) * 100) + '%';
  };
  const logLine = (t) => {
    if (!el) return;
    const pre = $('.tgmd-log pre');
    pre.textContent += t + '\n';
    pre.scrollTop = pre.scrollHeight;
  };

  function setRunning(on) {
    running = on;
    $('[data-act="pause"]').disabled = !on;
    $('[data-act="stop"]').disabled = !on;
    $('[data-act="all"]').disabled = on;
    $('[data-act="select"]').disabled = on;
    $('[data-act="pause"]').textContent = 'Pause';
    if (on) { status('Starting…'); fill(0); }
  }

  function showFailures() {
    const box = $('.tgmd-failures');
    box.classList.toggle('tgmd-hidden', failures.length === 0);
    $('.tgmd-fail-count').textContent = failures.length + ' failed';
  }

  async function refreshHistoryLabel() {
    const btn = el && $('[data-act="clearhistory"]');
    if (!btn) return;
    try {
      const n = await root.TGMD.core.historyCount();
      btn.textContent = n
        ? 'Clear history for this chat (' + n + ' recorded)'
        : 'Clear history for this chat';
    } catch (e) {
      btn.textContent = 'Clear history for this chat';
    }
  }

  // Brave defaults "Ask where to save each file" to ON, and the pref is absent
  // from Preferences while at that default, so it can only be measured: a blob
  // download finishes in tens of milliseconds unless a dialog opened.
  const SLOW_SAVE_MS = 1500;

  function warnIfPrompting(ms) {
    if (!el || typeof ms !== 'number' || ms < SLOW_SAVE_MS) return;
    const hint = $('.tgmd-hint');
    if (!hint || !hint.classList.contains('tgmd-hidden')) return;
    hint.classList.remove('tgmd-hidden');
    hint.textContent =
      'That save took ' + (Math.round(ms / 100) / 10) + 's — Brave is asking where to put '
      + 'each file. Turn it off: brave://settings/downloads → "Ask where to save each '
      + 'file before downloading".';
  }

  // --------------------------------------------------------------- actions
  async function runWith(tileKeys, force) {
    failures = [];
    showFailures();
    setRunning(true);
    try {
      await root.TGMD.run.start({
        tileKeys: tileKeys, force: !!force, onEvent: handleEvent
      });
    } catch (e) {
      status('Error: ' + e.message);
      logLine('ERROR ' + e.message);
    } finally {
      setRunning(false);
      refreshHistoryLabel();
    }
  }

  async function onAction(act, btn) {
    if (btn.disabled) return;

    if (act === 'all') {
      await runWith(null);

    } else if (act === 'download-selected') {
      const keys = root.TGMD.select.chosen();
      if (!keys.size) return;
      root.TGMD.select.toggle();
      await runWith(keys, true);

    } else if (act === 'select') {
      root.TGMD.select.toggle();

    } else if (act === 'pause') {
      const pausing = btn.textContent === 'Pause';
      if (pausing) root.TGMD.run.pause(); else root.TGMD.run.resume();
      btn.textContent = pausing ? 'Resume' : 'Pause';
      status(pausing ? 'Paused' : 'Resuming…');

    } else if (act === 'stop') {
      root.TGMD.run.stop();
      status('Stopping…');

    } else if (act === 'clear') {
      // Panel only: clearing download history is a separate, explicit action.
      if (running) { status('Stop the run before clearing.'); return; }
      failures = [];
      showFailures();
      $('.tgmd-log pre').textContent = '';
      fill(0);
      status('Idle');
      if (root.TGMD.select.active) root.TGMD.select.toggle();

    } else if (act === 'clearhistory') {
      if (running) { status('Stop the run before clearing history.'); return; }
      try {
        const n = await root.TGMD.core.clearChatHistory();
        status(n ? 'Cleared ' + n + ' records — this chat will download again' : 'No history for this chat');
        logLine('cleared ' + n + ' download records');
      } catch (e) {
        status('Error: ' + e.message);
      }
      refreshHistoryLabel();

    } else if (act === 'probeprompt') {
      if (running) { status('Stop the run before probing.'); return; }
      $('.tgmd-log').open = true;
      $('.tgmd-log pre').textContent = '';
      status('Probing the save prompt…');
      try {
        await root.TGMD.core.probePrompt(logLine);
        status('Probe finished — see the log');
      } catch (e) {
        status('Probe error: ' + e.message);
        logLine('ERROR ' + e.message);
      }

    } else if (act === 'retry') {
      // The ledger skips saved tiles during the scan, so this visits only gaps.
      await runWith(null);
    }
  }

  // ---------------------------------------------------------------- events
  // The bar tracks items completed against the total the scan found; byte
  // progress goes in the status line.
  let queued = 0;
  let atItem = '';

  const mb = (n) => (Math.round(n / 104857.6) / 10) + ' MB';

  function handleEvent(ev) {
    if (ev.type === 'phase' && ev.phase === 'scan') {
      queued = 0;
      status('Scanning the grid…');
      fill(0);

    } else if (ev.type === 'scan') {
      status('Scanning… ' + ev.found + ' media found');

    } else if (ev.type === 'planned') {
      queued = ev.queued;
      // A selection run leaves out unticked tiles, not ones the ledger knows,
      // so it has no "already saved" number to report.
      if (ev.mode === 'selection') {
        logLine('scan: ' + ev.scanned + ' tiles · ' + ev.queued + ' selected');
        status(ev.queued
          ? ev.queued + ' selected to fetch'
          : 'none of the selected tiles are in this grid');
      } else {
        logLine('scan: ' + ev.scanned + ' tiles · ' + ev.known + ' already saved · '
                + ev.queued + ' queued');
        status(ev.queued
          ? ev.scanned + ' media · ' + ev.known + ' already saved · ' + ev.queued + ' to fetch'
          : ev.scanned + ' media — every one of them is already saved');
      }
      fill(0);

    } else if (ev.type === 'phase' && ev.phase === 'retry') {
      logLine('retrying ' + ev.count + ' failed item' + (ev.count === 1 ? '' : 's'));
      status('Retrying ' + ev.count + ' failed…');

    } else if (ev.type === 'item-start') {
      atItem = (ev.pass === 2 ? 'Retry ' : '') + (ev.index + 1) + ' of ' + (ev.total || queued);
      status(atItem);

    } else if (ev.type === 'note') {
      logLine(ev.text);

    } else if (ev.type === 'progress' && ev.total) {
      status(atItem + ' · ' + mb(ev.received) + ' of ' + mb(ev.total));

    } else if (ev.type === 'item') {
      if (ev.total) fill((ev.index + 1) / ev.total);
      if (ev.ok) {
        let note = '';
        // A save dialog on a file that is not ours means a page-initiated prompt.
        if (ev.audit && ev.audit.ok) {
          if (!ev.audit.ours) note = '  [NOT OURS: ' + (ev.audit.byExtensionId || 'page-initiated') + ']';
          else if (ev.audit.danger && ev.audit.danger !== 'safe') note = '  [danger: ' + ev.audit.danger + ']';
        }
        const via = ev.via === 'disk' ? '  [disk]' : '';
        const took = typeof ev.saveMs === 'number' ? '  (' + ev.saveMs + 'ms)' : '';
        logLine('saved ' + (ev.filename || '') + (ev.skipped ? '  (already had it)' : '')
                + via + took + note);
        warnIfPrompting(ev.saveMs);
      } else if (ev.willRetry) {
        // Not a failure yet — it gets another go once the queue is drained.
        logLine('deferred item ' + (ev.index + 1) + ': ' + ev.error);
        if (ev.mediaState) logLine('        state: ' + JSON.stringify(ev.mediaState));
      } else {
        logLine('FAILED item ' + (ev.index + 1) + ': ' + ev.error);
        if (ev.mediaState) logLine('        state: ' + JSON.stringify(ev.mediaState));
        failures.push(ev);
        showFailures();
      }

    } else if (ev.type === 'done') {
      const s = ev.summary;
      const bits = [s.saved + ' saved'];
      if (s.skipped) bits.push(s.skipped + ' already had');
      if (s.known) bits.push(s.known + ' skipped from history');
      if (s.failed.length) bits.push(s.failed.length + ' failed');
      status('Done — ' + bits.join(', '));
      fill(1);
      if (s.retried) {
        logLine('retry pass recovered ' + (s.retried - s.failed.length) + ' of ' + s.retried);
      }
      // Names whoever Brave credits for these downloads.
      if (ev.audit) {
        if (!ev.audit.foreign.length) {
          logLine('AUDIT: all ' + ev.audit.checked + ' recent downloads came from this extension '
                  + '(saveAs:false) — a save dialog here is not ours to suppress.');
        } else {
          logLine('AUDIT: ' + ev.audit.foreign.length + ' of ' + ev.audit.checked
                  + ' recent downloads were started by: ' + ev.audit.foreign.join(', ')
                  + ' — THESE are what prompt you.');
        }
      }
    }
  }

  root.TGMD.panel = { mount: mount, handleEvent: handleEvent };
})(typeof globalThis !== 'undefined' ? globalThis : self);
