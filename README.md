# TG Media Downloader

Downloads photos, videos and GIFs from Telegram Web A at full original quality,
with no recurring browser download prompts.

## Install

1. `./deploy.sh` from a Mac that can `ssh devbox`
2. Brave -> `brave://extensions` -> Developer mode -> Load unpacked
3. Select `C:\Users\AJ\Projects\tg-media-downloader`

## Use

Open `https://web.telegram.org/a/`, open a chat, then open **chat info -> Media**.

- **Download all media in this chat** — enumerates the grid, then walks every
  item through the media viewer at full quality. Resumable: close the tab and
  run it again later, and it picks up where it stopped.
- **Select media...** — tick individual tiles, then **Download selected (N)**.
- **Ctrl+Shift+D** — downloads whatever is currently open in the media viewer.
  A manual escape hatch that works even if the panel fails to mount.

Files land in `Downloads/Telegram/<chat title>/YYYY-MM-DD_<key>.<ext>`.

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

    node --test tests/*.test.js   # 53 unit tests, Node 26+, zero dependencies
    ./deploy.sh                   # push to devbox

All Telegram DOM knowledge lives in `src/selectors.js`. If a Telegram update
breaks the extension, that should be the only file needing changes.

Architecture and rationale: `docs/superpowers/specs/`, `docs/superpowers/plans/`.
