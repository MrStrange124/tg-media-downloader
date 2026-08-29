'use strict';

const out = document.getElementById('out');
const log = (m) => { out.textContent += m + '\n'; };

function formatReport(report) {
  if (!report) return 'No diagnostics have been run yet.';
  const lines = ['TGMD diagnostics — ' + report.at, ''];
  for (const s of report.steps) {
    const mark = s.ok === true ? 'PASS' : s.ok === false ? 'FAIL' : 'SKIP';
    lines.push('[' + mark + '] ' + s.name);
    lines.push('       ' + JSON.stringify(s.detail, null, 2).replace(/\n/g, '\n       '));
    lines.push('');
  }
  return lines.join('\n');
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  if (!/^https:\/\/web\.telegram\.org\/a\//.test(tab.url || '')) {
    throw new Error('open a https://web.telegram.org/a/ tab first');
  }
  return tab.id;
}

document.getElementById('selftest').addEventListener('click', async () => {
  out.textContent = '';
  try {
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const res = await chrome.runtime.sendMessage({
      type: 'TGMD_DOWNLOAD', blobUrl: blobUrl,
      filename: 'Telegram/_selftest/synthetic-1mb.bin'
    });
    log(res && res.ok
      ? 'OK — download id ' + res.id + '\nCheck Downloads/Telegram/_selftest/'
      : 'FAILED — ' + (res && res.error));
  } catch (e) {
    log('FAILED — ' + e.message);
  }
});

document.getElementById('opensetup').addEventListener('click', async () => {
  out.textContent = '';
  await chrome.runtime.sendMessage({ type: 'TGMD_OPEN_SETUP' });
  log('Opened the save-folder page. Brave ships the File System Access API\n'
    + 'disabled, so this only works in Chrome. On Brave the fix is instead:\n'
    + '  brave://settings/downloads -> turn OFF "Ask where to save each file".');
});

document.getElementById('rundiag').addEventListener('click', async () => {
  out.textContent = 'Running…\n';
  try {
    const tabId = await activeTabId();
    await chrome.storage.local.remove('diag:last');
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/diagnostics.js'] });
    // diagnostics.js writes storage asynchronously; poll briefly for the result.
    let report = null;
    for (let i = 0; i < 20 && !report; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const got = await chrome.storage.local.get('diag:last');
      report = got['diag:last'];
    }
    out.textContent = formatReport(report);
  } catch (e) {
    out.textContent = 'FAILED — ' + e.message;
  }
});

document.getElementById('copydiag').addEventListener('click', async () => {
  const got = await chrome.storage.local.get('diag:last');
  await navigator.clipboard.writeText(formatReport(got['diag:last']));
  log('\n(report copied to clipboard)');
});

// ------------------------------------------------------------------ settings
(async () => {
  const got = await chrome.storage.local.get('settings');
  const s = got.settings || { concurrency: 2, subfolder: 'Telegram' };
  document.getElementById('subfolder').value = s.subfolder || 'Telegram';
  document.getElementById('concurrency').value = s.concurrency || 2;
})();

(async function loadLayout() {
  const got = await chrome.storage.local.get('settings');
  const cur = (got.settings && got.settings.layout) === 'flat' ? 'flat' : 'nested';
  document.getElementById('layout').value = cur;
})();

document.getElementById('savesettings').addEventListener('click', async () => {
  const subfolder = document.getElementById('subfolder').value.trim() || 'Telegram';
  const raw = parseInt(document.getElementById('concurrency').value, 10);
  const concurrency = Math.min(3, Math.max(1, isNaN(raw) ? 2 : raw));
  document.getElementById('concurrency').value = concurrency;
  const layout = document.getElementById('layout').value === 'nested' ? 'nested' : 'flat';
  await chrome.storage.local.set({
    settings: { subfolder: subfolder, concurrency: concurrency, layout: layout }
  });
  log('saved — layout ' + layout + ', subfolder "' + subfolder + '", concurrency ' + concurrency);
});

document.getElementById('clearhistory').addEventListener('click', async () => {
  out.textContent = '';
  try {
    const tabId = await activeTabId();
    // Delegated: the content script holds the ledger in memory, so deleting the
    // key from here would be undone by its next flush.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: async () => {
        const core = globalThis.TGMD && globalThis.TGMD.core;
        if (!core) return { ok: false, error: 'not loaded in this tab — refresh it' };
        try {
          return { ok: true, n: await core.clearChatHistory() };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }
    });
    const r = results && results[0] && results[0].result;
    if (!r) { log('FAILED — no response from the page'); return; }
    if (!r.ok) { log('FAILED — ' + r.error); return; }
    log('cleared ' + r.n + ' records for this chat');
  } catch (e) {
    log('FAILED — ' + e.message);
  }
});

// ------------------------------------------------------- walk diagnostics
document.getElementById('runwalk').addEventListener('click', async () => {
  out.textContent = 'Probing the grid and viewer — takes about 10 seconds…\n';
  try {
    const tabId = await activeTabId();
    await chrome.storage.local.remove('diag:walk');
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/diag-walk.js'] });
    let report = null;
    for (let i = 0; i < 120 && !report; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const got = await chrome.storage.local.get('diag:walk');
      report = got['diag:walk'];
    }
    out.textContent = formatReport(report);
    await navigator.clipboard.writeText(formatReport(report)).catch(() => {});
    out.textContent += '\n(copied to clipboard)';
  } catch (e) {
    out.textContent = 'FAILED — ' + e.message;
  }
});

// -------------------------------------------------------- download audit
document.getElementById('auditdl').addEventListener('click', async () => {
  out.textContent = '';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TGMD_DOWNLOAD_AUDIT' });
    if (!res || !res.ok) { log('FAILED — ' + (res && res.error)); return; }
    const lines = ['this extension id: ' + res.self, ''];
    for (const d of res.items) {
      lines.push((d.fromOurExtension ? '[OURS]     ' : '[NOT OURS] ') +
                 (d.filename || '').split(/[\\/]/).pop());
      lines.push('   byExtensionId: ' + (d.byExtensionId || '<none — page-initiated>'));
      lines.push('   state: ' + d.state + '   danger: ' + d.danger +
                 '   mime: ' + (d.mime || '-') + (d.error ? '   error: ' + d.error : ''));
      lines.push('   url: ' + d.urlKind);
      lines.push('');
    }
    out.textContent = lines.join('\n');
    await navigator.clipboard.writeText(out.textContent).catch(() => {});
    out.textContent += '(copied to clipboard)';
  } catch (e) {
    log('FAILED — ' + e.message);
  }
});
