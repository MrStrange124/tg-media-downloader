# TG Media Downloader

Downloads photos, videos and GIFs from Telegram Web A at full original quality,
with no recurring browser download prompts.

## Install

1. Clone this repository
2. Brave or Chrome -> `brave://extensions` / `chrome://extensions` ->
   Developer mode -> **Load unpacked**
3. Select the cloned directory

There is no build step: the extension loads from source as it stands.

## Use

Open `https://web.telegram.org/a/`, open a chat, then open **chat info -> Media**.

- **Download all media in this chat** — scans the whole grid first, then
  fetches. See *How a run works* below.
- **Select media...** — tick individual tiles, then **Download selected (N)**.
  A ticked tile is always re-fetched, ledger or not.
- **Ctrl+Shift+D** — downloads whatever is currently open in the media viewer.
  A manual escape hatch that works even if the panel fails to mount.

Files land in `Downloads/Telegram/<chat title>/YYYY-MM-DD_<key>.<ext>`.

## How a run works

Three phases, in order:

1. **Scan** — sweeps the grid top to bottom recording every tile: its id, its
   kind, and the scroll position it was seen at. Nothing is opened or fetched,
   so it is cheap, and it produces an honest total before any bytes move.
2. **Plan** — drops every tile this chat's ledger already knows. On a group
   that has been run before, most of the list disappears here for free.
3. **Fetch** — walks the plan. A failure is queued rather than fatal, and the
   queue gets one more pass once the plan is drained.

### The ledger

Each chat has one record in extension storage, `led:<chatId>`, with two
indexes:

- **by tile id** — answers *"have I already done this grid cell?"* from the
  grid alone, before the viewer opens. This is what makes a second run over a
  1000-item group cheap: known tiles never get opened.
- **by content hash** — answers *"have I already saved these bytes?"*, so the
  same file forwarded into the chat twice under two message ids downloads
  once. Only decidable after the viewer resolves a URL, hence the second index.

So a group you keep re-running only ever fetches what is new. **Clear history
for this chat** in the panel wipes that chat's ledger and nothing else.

Older installs stored one storage key per item; those fold into the ledger
automatically the first time a chat is opened, and are then removed.

## Why there are no prompts

Saving goes through `chrome.downloads.download({ saveAs: false })`. Page-driven
`<a download>` clicks — what most Telegram downloaders use, including the paid
ones — trigger Chrome's "wants to download multiple files" prompt on every
batch. This extension never does that.

If a save dialog still appears, turn off
`brave://settings/downloads` -> "Ask where to save each file". That is a
browser-level setting no extension can override.

## Scope

Photos, videos and GIFs. Documents, music, voice notes and round video messages
are **not** supported in this version.

## Troubleshooting

Click the extension icon -> **Run diagnostics** -> **Copy report**. The report
says which selectors resolved, whether the service worker honours Range
requests, and whether the save path works. Read it before changing any code.

## Development

    node --test tests/*.test.js   # 77 unit tests, Node 26+, zero dependencies

Reload at `brave://extensions` and hard-refresh the Telegram tab to pick up a
change.

All Telegram DOM knowledge lives in `src/selectors.js`. If a Telegram update
breaks the extension, that should be the only file needing changes.

Architecture and rationale: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
