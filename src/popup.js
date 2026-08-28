'use strict';

const out = document.getElementById('out');
const log = (m) => { out.textContent += m + '\n'; };

document.getElementById('selftest').addEventListener('click', async () => {
  out.textContent = '';
  try {
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));

    const res = await chrome.runtime.sendMessage({
      type: 'TGMD_DOWNLOAD',
      blobUrl,
      filename: 'Telegram/_selftest/synthetic-1mb.bin'
    });

    log(res && res.ok
      ? `OK — download id ${res.id}\nCheck Downloads/Telegram/_selftest/`
      : `FAILED — ${res && res.error}`);
  } catch (e) {
    log('FAILED — ' + e.message);
  }
});
