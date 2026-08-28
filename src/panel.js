(function (root) {
  'use strict';

  let el = null;
  let failures = [];
  let running = false;
  // Cached so a click handler can decide what to do without awaiting first:
  // opening a folder picker needs the click's transient activation.
  let folderState = 'none';

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
    '  <button class="tgmd-link" data-act="folder">Saving to Downloads/Telegram/&lt;group&gt;</button>',
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
    refreshFolderLabel();

    // Coming back from the setup tab must update this without a page reload.
    window.addEventListener('focus', () => {
      if (root.TGMD.core && root.TGMD.core.resetFsState) root.TGMD.core.resetFsState();
      refreshFolderLabel();
    });
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

  async function refreshFolderLabel() {
    const btn = el && $('[data-act="folder"]');
    if (!btn) return;
    // The state lives in the service worker: it owns the folder handle,
    // because a content script cannot even see the picker API.
    try {
      const r = await chrome.runtime.sendMessage({ type: 'TGMD_FS_STATUS' });
      folderState = (r && r.ok) ? r.state : 'none';
    } catch (e) {
      folderState = 'none';
    }
    btn.textContent =
      folderState === 'granted' ? 'Writing straight to your folder \u2014 no prompts. Change\u2026'
      : folderState === 'prompt' ? 'Folder access expired \u2014 click to re-allow'
      : 'Brave asks to save every file. Click to pick a folder and stop that.';
    btn.classList.toggle('tgmd-warn', folderState !== 'granted');
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
      refreshFolderLabel();
    }
  }

  async function onAction(act, btn) {
    if (btn.disabled) return;

    // Both of these need the click's transient activation, so they run before
    // anything else in this function awaits.
    // The picker does not exist in a content script, so open the extension's
    // own page, which can show it.
    if (act === 'folder') {
      await chrome.runtime.sendMessage({ type: 'TGMD_OPEN_SETUP' });
      status('Pick a folder in the tab that just opened, then come back here.');
      return;
    }

    // Only re-grant an already-chosen folder. Downloads must never be
    // interrupted by a folder picker: the destination is fixed at
    // Downloads/Telegram/<group> and works with no configuration at all.

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
    if (ev.type === 'progress' && ev.enumerated != null) {
      status('Working… ' + ev.enumerated + ' found so far');
    } else if (ev.type === 'progress' && ev.total) {
      fill(ev.received / ev.total);
    } else if (ev.type === 'item') {
      if (ev.ok) {
        let note = '';
        // Make the origin of each download visible: a save dialog on a file
        // that is not ours means the prompt is page-initiated.
        if (ev.audit && ev.audit.ok) {
          if (!ev.audit.ours) note = '  [NOT OURS: ' + (ev.audit.byExtensionId || 'page-initiated') + ']';
          else if (ev.audit.danger && ev.audit.danger !== 'safe') note = '  [danger: ' + ev.audit.danger + ']';
        }
        const via = ev.via === 'disk' ? '  [disk]'
                  : ev.via === 'downloads' ? '  [downloads — this one can prompt]' : '';
        logLine('saved ' + (ev.filename || '') + (ev.skipped ? '  (already had it)' : '') + via + note);
      } else {
        logLine('FAILED item ' + (ev.index + 1) + ': ' + ev.error);
        if (ev.mediaState) logLine('        state: ' + JSON.stringify(ev.mediaState));
        failures.push(ev);
      }
      showFailures();
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
