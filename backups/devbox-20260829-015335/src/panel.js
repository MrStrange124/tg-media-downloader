(function (root) {
  'use strict';

  let el = null;
  let failures = [];
  let running = false;
  // Live tallies for the progress bar and status line. Reset at each run start.
  let counts = { saved: 0, skipped: 0, found: 0, failed: 0 };

  const HTML = [
    '<div class="tgmd-head">',
    '  <span class="tgmd-title">TG Media Downloader</span>',
    '  <button class="tgmd-collapse" title="Collapse">&ndash;</button>',
    '</div>',
    '<div class="tgmd-body">',
    '  <button class="tgmd-btn" data-act="all">Download all media in this chat</button>',
    '  <button class="tgmd-btn" data-act="select">Select media&hellip;</button>',
    '  <button class="tgmd-btn tgmd-ghost" data-act="count">Count media in this chat</button>',
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
    if (el) $('.tgmd-fill').style.width = Math.round(r * 100) + '%';
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
    $('[data-act="count"]').disabled = on;
    $('[data-act="pause"]').textContent = 'Pause';
    if (on) { counts = { saved: 0, skipped: 0, found: 0, failed: 0 }; status('Starting…'); fill(0); }
  }

  // Bar and status reflect the whole run, not one file — under concurrency
  // several items download at once, so a single-file byte bar is meaningless.
  function renderProgress() {
    const completed = counts.saved + counts.skipped + counts.failed;
    const denom = Math.max(counts.found, completed, 1);
    fill(completed / denom);
    status(counts.saved + ' saved · ' + counts.skipped + ' skipped · '
           + counts.failed + ' failed · ' + counts.found + ' found');
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

  // --------------------------------------------------------------- actions
  async function runWith(tileKeys) {
    failures = [];
    showFailures();
    setRunning(true);
    try {
      await root.TGMD.run.start({ tileKeys: tileKeys, onEvent: handleEvent });
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
      await runWith(keys);

    } else if (act === 'select') {
      root.TGMD.select.toggle();

    } else if (act === 'count') {
      // A full scroll of the grid, no downloads — an explicit action, because
      // pre-counting every run would double the scrolling on large chats.
      if (running) { status('Stop the run before counting.'); return; }
      btn.disabled = true;
      status('Counting… scrolling the whole chat');
      try {
        const n = await root.TGMD.run.enumerate({
          onCount: (c) => status('Counting… ' + c + ' found so far')
        });
        status(n + ' media items in this chat');
        logLine('counted ' + n + ' media items');
      } catch (e) {
        status('Count error: ' + e.message);
      } finally {
        btn.disabled = false;
      }

    } else if (act === 'pause') {
      const pausing = btn.textContent === 'Pause';
      if (pausing) root.TGMD.run.pause(); else root.TGMD.run.resume();
      btn.textContent = pausing ? 'Resume' : 'Pause';
      status(pausing ? 'Paused' : 'Resuming…');

    } else if (act === 'stop') {
      root.TGMD.run.stop();
      status('Stopping…');

    } else if (act === 'clear') {
      // Resets the panel only. Downloaded-history is a separate, explicit
      // action — conflating them would silently destroy resume state.
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
      // Resume makes this safe: saved items are skipped, so re-running
      // retries exactly the failures.
      await runWith(null);
    }
  }

  // ---------------------------------------------------------------- events
  function handleEvent(ev) {
    if (ev.type === 'progress') {
      if (ev.enumerated != null) counts.found = ev.enumerated;
      renderProgress();
    } else if (ev.type === 'item') {
      if (ev.ok) {
        if (ev.skipped) counts.skipped++; else counts.saved++;
        let note = '';
        // Make the origin of each download visible: a save dialog on a file
        // that is not ours means the prompt is page-initiated.
        if (ev.audit && ev.audit.ok) {
          if (!ev.audit.ours) note = '  [NOT OURS: ' + (ev.audit.byExtensionId || 'page-initiated') + ']';
          else if (ev.audit.danger && ev.audit.danger !== 'safe') note = '  [danger: ' + ev.audit.danger + ']';
        }
        logLine('saved ' + (ev.filename || '') + (ev.skipped ? '  (already had it)' : '') + note);
      } else {
        counts.failed++;
        logLine('FAILED item ' + (ev.index + 1) + ': ' + ev.error);
        if (ev.mediaState) logLine('        state: ' + JSON.stringify(ev.mediaState));
        failures.push(ev);
      }
      showFailures();
      renderProgress();
    } else if (ev.type === 'done') {
      const s = ev.summary;
      status('Done — ' + s.saved + ' saved, ' + s.skipped + ' already had, ' + s.failed.length + ' failed');
      fill(1);
      // Answers the save-prompt question without anyone having to run a
      // separate audit: it names whoever Brave credits for these downloads.
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
