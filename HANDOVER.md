# Downloader for Mac — Session Handover

Paste this entire file into a fresh Claude Code session to continue.

---

## Who/what

- **Author:** ahfoysal
- **GitHub:** https://github.com/ahfoysal/downloader-for-mac (public, MIT)
- **Local repo:** `/Users/foysal/Downloads/youtube-music-download/`
- **Current branch:** `main` — tip at commit `e87dc51`
- **Release CI:** pushes of tag `v*` trigger `.github/workflows/release.yml` (macOS arm64 DMG + Windows EXE → GitHub Release, unsigned)
- **In-app update banner:** Settings → About polls `api.github.com/repos/ahfoysal/downloader-for-mac/releases/latest` and shows a download link if newer semver

---

## Stack

- Electron **29.0.0** · `electron-builder` ^23.6.0 · Node 20
- `yt-dlp-wrap` ^2.3.2 (mostly bypassed via direct stdout parsing in main.js)
- `node-id3` ^0.2.9 (MP3 tag writer)
- `ffmpeg-static` ^5.1.0 (unused — we ship our own binaries)
- Vanilla JS renderer (no React/Vue/bundler)

---

## Repo layout

```
main.js              # Main process: IPC, yt-dlp control, native host, control socket, scheduler (~1800 lines)
preload.js           # IPC contract — every renderer↔main boundary lives here
renderer.js          # Full UI: state machine, player, library, browser, command palette (~2200 lines)
index.html           # All CSS + markup (~2500 lines, single file)
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
  history.json             # download history entries
  probe-cache.json         # yt-dlp info-json cache (24h TTL)
  download-archive.txt     # yt-dlp --download-archive (skips already-done)
  native-host-wrapper.sh   # wrapper that invokes scripts/native-host.js
  control.sock             # Unix socket for extension bidirectional messaging
```

Native messaging host JSON manifests live in `~/Library/Application Support/{Google/Chrome,BraveSoftware/Brave-Browser,Microsoft Edge,Arc,Vivaldi,Chromium,Mozilla}/NativeMessagingHosts/com.ahfoysal.downloader_for_mac.json`.

---

## Features (working)

### Downloads
- yt-dlp + ffmpeg bundled, universal binaries (arm64 + x64 ffmpeg)
- Presets: **MP3, M4A, WebM, Best/1080/720/480 MP4**
- Playlist download with per-item queue UI + drag-reorder + retry-on-fail
- Concurrent downloads (settings slider 1–5)
- Speed limit (`--limit-rate`), output template, organize-by-uploader
- SponsorBlock integration (`--sponsorblock-remove`)
- Loudness normalize (`--postprocessor-args ffmpeg:-af loudnorm`)
- Cookies-from-browser picker (None/Auto/Safari/Chrome/Firefox/Brave/Edge/Arc/Vivaldi)
- Subtitles embed (video modes)
- Clip section (`--download-sections`)
- Resume interrupted (`--continue`)
- `--download-archive` so re-running a playlist skips existing items
- Dedup prompt: "You already downloaded this, re-download?"
- Watch folder: drop `.txt`/`.urls` file → auto-import as batch download
- Channel subscriptions: cron-lite (hourly/daily/weekly) per channel URL
- Scheduled downloads (daily/weekly at HH:MM)
- Disk-space check + "Update yt-dlp" menu + auto-retry on signature failure

### Library (Download tab landing)
- Four sections: Quick browse tiles, Continue browsing (browser history), Recent downloads, Most played
- Full library tab: sections for Recently added / Audio / Video with big-thumbnail cards, play-button-on-hover, resume progress bar
- Right-click library card → Play / Show in Finder / Copy path / Edit metadata / Delete
- Metadata editor modal (title, artist, album, year, genre, track)
- Search box filters title/uploader/format/filepath
- Missing-file detection (greys out cards when file moved/deleted)
- Reconcile-library: scans download folder for orphan files on open

### Player (Spotify-style)
- Persistent **mini-player** at window bottom (always visible when playing)
- **Expanded player** with gradient-accent backdrop
- Lyrics via **LRCLIB** (free, no API key, synced + auto-scroll + click-to-seek)
- Shuffle + repeat modes (off/all/one)
- Audio visualizer (WebAudio AnalyserNode + radial canvas bars)
- 15s back/forward + prev/next + speed presets (0.75×–2×)
- Queue side-panel (always visible, drag-reorder)
- Play positions auto-saved (resume ≤95%)
- Play counts tracked per-file

### Browse tab (built-in browser)
- `<webview>` based with Chrome User-Agent
- Persistent `persist:browse` partition (logins survive restarts)
- URL bar + back/forward/reload + multi-tab + new-tab +
- Right-click → Send link/page/media to Downloader / Open in new tab / Search Google / Copy link
- **Import Chrome** button: decrypts `~/Library/Application Support/Google/Chrome/*/Cookies` via Keychain password + AES-CBC, injects into `persist:browse` session
- Floating Download-video FAB on supported video URLs → opens a Spotify-esque quality sheet
- Quality sheet: warm probe-cache for instant open, real-format chips with file sizes, preset chips (Best/1080/720/MP3/M4A/WebM)
- Browser history (max 50) → "Continue browsing" row on landing
- target=_blank links open as new tabs inside app

### Command palette, theme, system
- ⌘K command palette (fuzzy search: tabs, settings, extension install, yt-dlp update, clear history, theme toggle, accent picker × 8, play controls, toggle shuffle/lyrics)
- Keyboard help `?`
- Activity log (last 500 events)
- Theme: Dark/Light + 8 accent colors (teal/purple/pink/blue/orange/green/red/yellow)
- Keep-awake during downloads (`powerSaveBlocker`)
- Native menu: Tools → Update yt-dlp / Install Native Messaging Host / Reset / Reveal binary
- Deep link protocol: `downloader://url/<encoded>` + single-instance lock
- Bookmarklet available in installer modal

### Browser extensions (dev-load only, not published)
- Chrome/Brave/Edge/Arc/Vivaldi: Manifest V3 with stable `key` → ID `jncpnkmhbhhgjcdhgkhdgfoghnkbdnam`
- Firefox: MV3 gecko variant
- Safari: scaffold (needs Xcode wrap)
- Content script scans `<video>`/`<audio>`/known-host links and badges the toolbar icon with count
- Popup: send current tab + paste URL + auto-send on supported sites toggle + Intercept browser downloads toggle + detected media list + page thumbnail
- Native messaging host (silent handoff, no tab flash) with fallback to `downloader://` deep link
- Bidirectional: app pushes download progress → extension badge shows `42%` live, `✓` on complete

---

## The active bug 🔴

**YouTube `<webview>` cutoff.** In the Browse tab, YouTube renders only the top ~500px, rest black. Chromium's internal compositor surface stays at whatever size the element had when first attached.

### What was already tried (do NOT re-run these)

1. CSS absolute positioning, explicit heights, min-heights on `.browse-body` and ancestors — no effect
2. JS `forceSizeWebviews()`: sets pixel width/height on webview via `.style` — no effect
3. CSS **width/height -1px pulse** with RAF restore — no effect
4. `webview.executeJavaScript("window.dispatchEvent(new Event('resize'))")` — no effect
5. `webview.setZoomFactor(0.999) → 1.0` bounce — no effect
6. All three above combined in `recomposeWebview()` on every `did-finish-load` — user says still cut off (tip commit `e87dc51`)
7. **Full `BrowserView` migration** (commits `e4a5363` … `bd1bbe1`) — fixed YouTube rendering perfectly BUT introduced macOS click-intercept bug: BrowserView captured clicks on DOM elements (+ button, URL bar, FAB) regardless of `setBounds` rectangle. Removing `setAutoResize` didn't help. All 8 commits reverted (see `f1cc19f`, `eb5f71a`, and 6 others).

### Fix paths (ranked for next session)

1. **Upgrade Electron 29 → 32 and migrate to `WebContentsView`.** This is the modern replacement for `BrowserView` and does NOT have the click-intercept bug. Best long-term fix. Requires verifying app against Electron 32 breaking changes (removed sync IPC paths, `remote` module gone).
2. **Keep `BrowserView`, hack around click-intercept** via dynamic `mainWindow.contentView.setIgnoreMouseEvents(true, { forward: true })` toggled on mousemove outside the BrowserView bounds. Complex but keeps Electron 29.
3. **Destroy + recreate `<webview>` on every Browse tab activation.** Loses scroll/history but guarantees fresh compositor surface.
4. **Size-detect cutoff after dom-ready, call `webview.reload()` once.** Ugly heuristic, fastest to try.

---

## Unfinished / deferred work

### Scaffolded (backend ready, UI not wired)
- `import-local-file` IPC — drag-drop local files into library (no window drop handler)
- `detect-partial-downloads` / `clear-partial-downloads` IPC — resume banner for `.part` files
- `setDockBadge` in preload — no caller yet
- Library filter chips HTML exists (All / On disk / Missing / Audio / Video / Full history) — filter JS not wired

### Documented but never started
- Audio equalizer (WebAudio biquad)
- Sleep timer, crossfade, fullscreen video, picture-in-picture
- Listening stats dashboard
- Library export/import (JSON)
- Per-host folder rules UI ("youtube.com/@X → ~/Music/X")
- Waveform scrubber
- MusicBrainz Cover Art Archive fallback for missing thumbs
- Batch rename regex tool
- Chapter navigation (YouTube chapters)

### Blocked on user decisions / $
- **Android** — Electron can't target Android; needs Capacitor or React-Native rewrite
- **True auto-update** — requires Apple Developer cert ($99/yr) for signed self-update; current is just "new version available" banner
- **Chrome Web Store publish** — $5 + review, user skipped
- **macOS notarization** — $99 Apple Dev account; current builds are unsigned (Gatekeeper warning on first open)

### Cleanup debt
- Dead code: `_deadCode_getLiveWebviewInfo`, `_deadCode_createWebview` in renderer.js — purge
- Remove `yt-dlp-wrap` dep (mostly bypassed via direct stdout parsing)
- Remove `ffmpeg-static` dep (unused)
- Console logs in `applyActiveBounds` and FAB click — remove once webview issue is solved

---

## Commit references

| Commit | Meaning |
|--------|---------|
| `e87dc51` | **current tip** — recomposeWebview triple-trick (YouTube still cut off) |
| `f1cc19f`, `eb5f71a` | BrowserView reverts |
| `bd1bbe1` | last BrowserView commit (YouTube worked but clicks broken) |
| `e4a5363` | initial BrowserView migration |
| earlier milestones | `v1.0.0` first release, `v2.0` UI redesign, `v3.0` command palette + lyrics + theme picker + channel subs |

---

## User preferences

- **Dev-only scope** — no paid/production work (no signing, no CI publishing, no paid tiers)
- **Modern UI feel is important** — user pushed back several times on plain/template looks
- **Detailed big plans before execution** — user asked for "very big plan" multiple times, then execute
- **Commit frequently** — every meaningful change gets its own commit + push
- **Restart after commits** — user wants to see changes live immediately, not just committed
- User is non-native-English (Bengali); short, clear prose wins over verbose explanations
- User gets fatigued by long bug-fix iteration loops — if one approach fails twice, pivot to a different approach instead of tweaking the same one

---

## Suggested opening move for next session

1. Read this handover + the memory files at `/Users/foysal/.claude/projects/-Users-foysal-Documents-FOYSAL-Live-pet-hub-app/memory/project_downloader_*.md`.
2. Acknowledge the YouTube cutoff blocker and propose **Path 1 (Electron 32 + WebContentsView)** first, with the caveat that it's a 1-session project (upgrade, regression test, migrate Browse tab code).
3. Ask the user if they want to (a) tackle the blocker, (b) pick up any deferred feature, or (c) polish + ship a v4.0 release with what's there.
