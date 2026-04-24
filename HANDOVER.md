# Downloader for Mac — Session Handover

Paste this entire file into a fresh Claude Code session to continue.

---

## Who/what

- **Author:** ahfoysal
- **GitHub:** https://github.com/ahfoysal/downloader-for-mac (public, MIT)
- **Local repo:** `/Users/foysal/Downloads/youtube-music-download/`
- **Current branch:** `main`
- **Last release:** `v4.0.0` (tagged from this session — see CI)
- **Release CI:** pushes of tag `v*` trigger `.github/workflows/release.yml` (macOS arm64 DMG + Windows EXE → GitHub Release, unsigned)
- **In-app update banner:** Settings → About polls `api.github.com/repos/ahfoysal/downloader-for-mac/releases/latest` and shows a download link if newer semver

---

## Stack

- Electron **32.3.3** · `electron-builder` ^25 · Node 20
- `yt-dlp-wrap` ^2.3.2 (actively used for exec/execPromise — not bypassed despite old HANDOVER claim)
- `node-id3` ^0.2.9 (MP3 tag writer)
- Vanilla JS renderer (no React/Vue/bundler)

---

## What shipped in v4.0.0 (this session)

### Cleanup
- Dropped unused `ffmpeg-static` dep (we ship our own `bin/ffmpeg-arm64` + `bin/ffmpeg-x64`)
- Metadata updated: author/repo/homepage/bugs → ahfoysal, appId → `com.ahfoysal.downloader-for-mac`
- Kept package.json `name: youtube-music-downloader` so `~/Library/Application Support/youtube-music-downloader/` user-data path is preserved across upgrade
- Version 1.0.0 → 4.0.0

### Scaffolded items wired up
- **Drag-drop local files into library** — window-level listeners, dashed overlay, extension filter, toast feedback. `renderer.js` near line 780.
- **Resume-partial-downloads banner** — top of Library view, calls `detect-partial-downloads` / `clear-partial-downloads`, per-session dismiss via sessionStorage.
- **Dock badge for active downloads** — `setDockBadge` handler added in main.js, wired into the existing `onQueueState` callback in renderer.
- **Library filter chips** — All / On disk / Missing / Audio / Video / History, combined with existing search.

### New features
- **Sleep timer** — end-of-track mode (pauses on `ended` event); live mm:ss countdown badge in mini-player; cleaner cleanup that cancels the fade-start setTimeout and countdown interval.
- **Visible PiP + Fullscreen buttons** in expanded player (previously only in ⌘K palette).
- **Library export/import JSON** — `export-library` / `import-library` IPC handlers; Export + Import buttons in Library view header; supports merge (default) or replace mode.
- **YouTube chapter navigation** — yt-dlp `info.chapters` captured during probe and persisted in history entries; Chapters button in music-sub-controls (hidden when no chapters); popover with timestamps + click-to-seek; thin white ticks on the seek bar at each chapter start.

### Already implemented (HANDOVER was stale on these)
- Listening stats dashboard (`openStats()` in renderer.js:2880 — accessible via ⌘K → "Listening stats")
- Audio equalizer (WebAudio biquad bank with presets)
- Command palette entries for sleep timer, fullscreen, PiP, EQ already existed

### Infrastructure
- **Electron 29 → 32** and **electron-builder 23 → 25**. No source changes required (all APIs used remain compatible).

---

## The active bug 🔴 — YouTube `<webview>` cutoff

Still present as of v4.0.0. Electron 32 upgrade alone may or may not improve compositor behavior — **test first** before committing to a large rewrite.

### What was already tried (documented in `memory/feedback_downloader_webview_history.md`)

1. CSS absolute positioning, explicit heights, min-heights — no effect
2. JS `forceSizeWebviews()` pixel width/height — no effect
3. CSS **width/height -1px pulse** with RAF restore — no effect
4. `webview.executeJavaScript("window.dispatchEvent(new Event('resize'))")` — no effect
5. `webview.setZoomFactor(0.999) → 1.0` bounce — no effect
6. All three above combined in `recomposeWebview()` on every `did-finish-load` — still cut off
7. **Full `BrowserView` migration** — fixed YouTube but broke macOS clicks (intercept-outside-bounds bug). Reverted 8 commits.

### Fix paths (ranked for next session)

1. **First: verify whether Electron 32's `<webview>` behaves differently.** Launch app, open Browse tab, load YouTube. If cutoff is gone, nothing more to do.
2. **If still broken: migrate Browse tab to `WebContentsView`.** The modern replacement for `BrowserView` — Electron 30+, does NOT have BrowserView's click-intercept bug.
   - Keep tabs UI in renderer
   - Main process manages one `WebContentsView` per tab, swaps visibility on tab activation
   - Renderer reports bounds via IPC on resize
   - IPC contract: `tab-create`, `tab-nav`, `tab-back/fwd/reload/close/activate`, `tab-set-bounds`
   - Events back: `tab-title`, `tab-url`, `tab-loading`
   - Use the same `persist:browse` partition; cookies-import flow stays identical
   - Preserve: context menu, Download FAB injection, "open link in new tab", `target=_blank` handling
3. **If WCV is too disruptive:** destroy-and-recreate `<webview>` on every Browse tab activation (brute force, loses scroll/history, but guarantees fresh compositor surface).

---

## Backlog (not started)

### Blocked on external decisions / $
- **Android** — Electron can't target Android; needs Capacitor or React-Native rewrite
- **True auto-update** — requires Apple Developer cert ($99/yr) for signed self-update
- **Chrome Web Store publish** — $5 + review
- **macOS notarization** — $99 Apple Dev account

### Still deferred
- Crossfade between tracks (WebAudio gain ramp)
- Waveform scrubber (requires pre-computed peaks per file)
- MusicBrainz Cover Art Archive fallback for missing thumbs
- Batch rename with regex preview
- Per-host folder rules UI ("youtube.com/@X → ~/Music/X")

---

## Repo layout

```
main.js              # Main process: IPC, yt-dlp control, native host, control socket, scheduler (~2100 lines)
preload.js           # IPC contract — every renderer↔main boundary lives here
renderer.js          # Full UI: state machine, player, library, browser, command palette (~2900 lines)
index.html           # All CSS + markup (~2900 lines, single file)
scripts/
  fetch-binaries.js  # postinstall: downloads yt-dlp, ffmpeg-arm64, ffmpeg-x64 into bin/
  native-host.js     # stdio proxy between browser extension and app
browser-extension/
  chrome/            # MV3, stable key → extension ID jncpnkmhbhhgjcdhgkhdgfoghnkbdnam
  firefox/           # MV3 gecko variant
  safari/            # needs Xcode wrapping (see browser-extension/README.md)
.github/workflows/
  release.yml        # tag-push CI → mac+win installers attached to GitHub Release
bin/                 # .gitignore'd; populated by scripts/fetch-binaries.js
```

### User data at runtime

```
~/Library/Application Support/youtube-music-downloader/
  settings.json            # appSettings (every feature's prefs)
  history.json             # download history entries (+ now: chapters per entry)
  probe-cache.json         # yt-dlp info-json cache (24h TTL)
  download-archive.txt     # yt-dlp --download-archive (skips already-done)
  native-host-wrapper.sh   # wrapper that invokes scripts/native-host.js
  control.sock             # Unix socket for extension bidirectional messaging
```

---

## User preferences

- **Dev-only scope** — no paid/production work
- **Modern UI feel is important**
- **Detailed big plans before execution**
- **Commit frequently** — every meaningful change gets its own commit + push to `main`
- **Restart after commits** — user wants to see changes live immediately
- User is non-native-English (Bengali); short clear prose wins over verbose explanations
- User gets fatigued by long bug-fix iteration loops — if one approach fails twice, pivot

---

## Suggested opening move for next session

1. Read this handover + the memory files at `/Users/foysal/.claude/projects/-Users-foysal-Documents-FOYSAL-Live-pet-hub-app/memory/project_downloader_*.md`.
2. **Verify whether the Electron 32 upgrade alone fixed the YouTube cutoff.** Launch app, open Browse tab, load YouTube. Report to user.
3. If still broken, propose WebContentsView migration with a concrete IPC contract sketch before touching code.
