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
