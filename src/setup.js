'use strict';

const fsa = globalThis.TGMD.fsa;
const stateEl = document.getElementById('state');
// Cached so the handler can branch without awaiting: the picker and
// requestPermission both need the click's transient activation.
let cachedState = 'none';
const noteEl = document.getElementById('note');

async function render() {
  if (!fsa.canPick()) {
    stateEl.innerHTML = '<span class="warn">This page cannot show a folder picker.</span>';
    return;
  }
  const state = await fsa.permission();
  cachedState = state;
  const handle = await fsa.getHandle();
  const name = (handle && handle.name) || '';

  if (state === 'granted') {
    stateEl.innerHTML = '<span class="ok">Saving to &ldquo;' + name +
      '&rdquo;.</span> Downloads will not prompt.';
    noteEl.textContent = 'You can close this tab.';
  } else if (state === 'prompt') {
    stateEl.innerHTML = '<span class="warn">Access to &ldquo;' + name +
      '&rdquo; needs re-confirming.</span> Brave drops folder permission when it restarts.';
    noteEl.textContent = 'Click "Choose folder" and re-allow the same folder.';
  } else {
    stateEl.innerHTML = '<span class="warn">No folder chosen.</span> ' +
      'Media is going through Brave’s download system, which is what shows the save dialog.';
    noteEl.textContent = '';
  }
}

document.getElementById('choose').addEventListener('click', async () => {
  // Issued before any await, so the click's activation is still live.
  const pending = cachedState === 'prompt' ? fsa.requestPermission() : fsa.pick();
  try {
    const granted = await pending;
    if (granted !== false) await fsa.requestPermission();
  } catch (e) {
    if (!/abort/i.test(String(e.name) + String(e.message))) {
      noteEl.textContent = 'Could not set the folder: ' + (e.message || e);
    }
  }
  await render();
});

document.getElementById('forget').addEventListener('click', async () => {
  await fsa.clearHandle();
  await render();
});

render();
