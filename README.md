# ChatGPT Chat Exporter – Complete Markdown & File Bundle
By aipieksel.

Version: 1.0.0 (unpublished).

## Overview

ChatGPT Chat Exporter – Complete Markdown & File Bundle is a local-first Chrome extension that exports the currently open ChatGPT conversation as readable Markdown. It can optionally create a ZIP with user-supplied and ChatGPT-produced media in separate folders.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Choose the `extension/` folder inside the extracted ChatGPT Chat Exporter package.
5. Open a rendered conversation on `https://chatgpt.com/`, select the extension to open its floating panel, and choose **Export Markdown**.

## Export

The extension first stabilizes the true latest turn, repeatedly loads earlier history until turn 1 and the visible conversation-root sentinel settle at the top, then scans the entire virtualized surface back to the latest turn. It revisits persistent turn slots when late-loaded history shifts positions or messages unmount. A repeatedly observed empty on-screen slot is retained at its actual position and identity as "ChatGPT renders no message content for this turn," without an invented author or timestamp. A nonempty loading placeholder is not treated as an empty turn. Genuine unresolved gaps, duplicate positions and missing boundary proof still prevent completeness.

The page is covered while collecting or downloading. History discovery has no percentage; the top-to-bottom scan then reports nondecreasing progress. History-edge probes leave the virtualizer's overscan area and compare persistent message identities and settled content, not fluctuating heights or recreated expansion buttons. A completed transcript downloads automatically. The retained result uses **Download** for retries, without rescanning. Accessible media downloads automatically when its host permission is already granted; a new permission or protected-file selection still needs a user action. Genuine capture gaps remain visible.

Timestamps come from exposed `time[datetime]` elements or date separators immediately before the matching message. Today/Yesterday labels are resolved in the browser's local timezone and exported as UTC. Weekday-only labels remain exactly as displayed because they do not prove a calendar date. A message never inherits another message's timestamp.

## Media and attachments

With **Include media** enabled, file matching and ZIP creation continue inside the same floating panel. Publicly accessible assets can be fetched after a narrow optional-origin grant. ChatGPT-protected files must first be downloaded through ChatGPT's normal controls and then explicitly selected in the panel. The extension never opens a separate archive tab and never reads ChatGPT tokens or private request headers.

## Output

- Markdown: the sanitized conversation title followed by `.md`.
- ZIP: the conversation title followed by `.zip`, containing `conversation.md`, `manifest.md`, and files under `media/user/` and `media/chatgpt/`.
- Turn headings keep the author, turn number and available timestamp on one line.
- Deliberately downloaded incomplete results retain completeness warnings and a `-partial` filename suffix.
- ZIP entries use current local modification time. No normalized JSON snapshot is published.

## Troubleshooting

- If the floating panel says no conversation is available, open a rendered `chatgpt.com` chat rather than the home or library page, then retry.
- If ChatGPT is still generating, wait for the response to finish. The exporter deliberately stops instead of saving a moving transcript.
- If completeness cannot be proven, the reason remains visible. **Download** can save the retained incomplete result; it does not make that result complete. Reload to collect again after resolving the cause.
- If protected attachments are missing from a ZIP, download them with ChatGPT's own file buttons and select those local files in the floating panel.
- If optional media access is denied or a media URL expires, the ZIP manifest reports the missing item and transcript-only export remains available.
- After updating source files, reload the unpacked extension on `chrome://extensions` and refresh the ChatGPT tab so the current content scripts are active.

## Limits

The initial safety limits are 5,000 turns, 300 upward-load cycles, eight minutes of history loading, 25 MiB of Markdown, 10 MiB for inline text, 50 MiB per media file, 500 media entries, and 250 MiB aggregate archive input.

## Privacy

All transcript processing is local. There is no telemetry, analytics, remote backend, account API, token interception, or bulk conversation-library access.

## Project layout

`extension/` is the complete browser runtime. `tooling/` contains useful regression tests and packaging scripts. `dist/` holds the single unpublished 1.0.0 package. Workspace `../tooling/` groups shared panel code, synchronization scripts and verification evidence.

Both exporters use `panel.js` for their main UI controller and the same shared panel shell. ChatGPT builds its main panel in JavaScript; Slack embeds `panel.html`. ChatGPT's `media.html`, `media.css` and `media.js` are a separate media-bundle view, not a second main popup. Its `markdown.js`, `contracts.js` and `content-entry.js` separate formatting, validation and startup; Slack groups the corresponding responsibilities in its own platform adapter, core and content modules.

## Development

```bash
node tooling/scripts/verify.js
node tooling/scripts/package.js
# Optional simulated panel/media integration (development-only jsdom):
node tooling/scripts/verify.js --integration
# Rendered DOM regression (development-only Playwright/Chromium):
node tooling/tests/browser.cjs
```

The package script creates `dist/chatgpt-chat-exporter-1.0.0.zip` from a strict runtime allowlist. It proves manifest/HTML/service-worker dependency closure, icon dimensions, per-file byte equality, archive integrity, version identity, size, and SHA-256. The ZIP includes the MIT license notice while excluding docs, task records, screenshots, tests, tooling, profiles, exports, and repository metadata. Release-package ZIP entries use a fixed date for reproducible bytes; user-export ZIP entries retain current local modification time. The manifest is at the ZIP root, as Chrome requires.

## Attribution

The icon is the Chat Exporter's member of the aipieksel icon family. Its transparent, edge-to-edge square mark uses purple/black on light browser chrome and purple/white on dark browser chrome, without a background tile or padding. It deliberately differs from the neon HTML Extractor mark and does not reproduce ChatGPT's logo.

Independent extension by aipieksel, not affiliated with OpenAI.

## License

Copyright (c) 2026 aipieksel. Licensed under the [MIT License](LICENSE).
