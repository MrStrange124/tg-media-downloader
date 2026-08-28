(async function () {
  'use strict';

  const report = { at: new Date().toISOString(), steps: [] };
  const step = (name, ok, detail) => report.steps.push({ name: name, ok: ok, detail: detail });

  async function save() {
    await chrome.storage.local.set({ 'diag:last': report });
    console.log('[TGMD] diagnostics', report);
  }

  // 1. Are we even on Web A, with our content script loaded?
  if (typeof TGMD === 'undefined' || !TGMD.selectors) {
    step('content-script', false, 'TGMD not present — is this a web.telegram.org/a/ tab?');
    await save();
    return;
  }
  step('content-script', true, 'TGMD loaded');

  // 2. What does the DOM look like right now?
  let probe = null;
  try {
    probe = TGMD.selectors.probe();
    step('selectors', !!probe.chatId, probe);
  } catch (e) {
    step('selectors', false, String(e && e.message || e));
  }

  // 3. Does a content-script fetch reach Telegram's service worker?
  //    This decides whether the MAIN-world fallback is needed.
  const desc = probe && probe.descriptor;
  if (desc && desc.url && !desc.url.startsWith('blob:')) {
    try {
      const res = await fetch(desc.url, { headers: { Range: 'bytes=0-1023' } });
      const cr = res.headers.get('Content-Range');
      step('sw-range-fetch', res.status === 206 && !!cr, {
        status: res.status,
        contentRange: cr,
        contentType: res.headers.get('Content-Type')
      });
    } catch (e) {
      step('sw-range-fetch', false, String(e && e.message || e));
    }
  } else {
    step('sw-range-fetch', null,
      desc ? 'active media is a blob: URL — open a video to test the stream path'
           : 'no media open — open a video in the viewer and rerun');
  }

  // 4. Does the prompt-free save path work from a content script?
  try {
    const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(1024)]));
    const res = await chrome.runtime.sendMessage({
      type: 'TGMD_DOWNLOAD',
      blobUrl: blobUrl,
      filename: 'Telegram/_selftest/diag-1kb.bin'
    });
    step('download-path', !!(res && res.ok), res);
  } catch (e) {
    step('download-path', false, String(e && e.message || e));
  }

  await save();
})();
