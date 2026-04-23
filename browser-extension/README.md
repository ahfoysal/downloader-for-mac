# Browser Extensions

Three parallel extensions that send URLs to the Downloader for Mac app via the `downloader://` deep-link protocol.

Everything runs in **dev mode** — no publishing, no store submission, no signing.

## Chrome / Edge / Brave / Arc / Vivaldi / Opera

1. Open `chrome://extensions` (or the equivalent — `edge://extensions`, `brave://extensions`, `arc://extensions`)
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select `browser-extension/chrome/`

That's it. Toolbar icon + context-menu items appear immediately. Keyboard shortcut: `⌘⇧D` sends the current tab.

## Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `browser-extension/firefox/manifest.json`

Firefox "temporary" extensions unload when Firefox closes — reload each session. For permanent install, run `web-ext build` and sideload the signed `.xpi` via [addons.mozilla.org/developers](https://addons.mozilla.org/developers) (free, automatic signing).

## Safari

Safari requires every web extension to be wrapped in a macOS app bundle. Two options:

### Option A — Developer Mode (quick dev)
1. Open Safari → Settings → Advanced → enable **"Show Develop menu in menu bar"**
2. Develop menu → **Allow Unsigned Extensions** (only persists for the session)
3. Develop menu → **Web Extension Background Pages**
4. Follow Apple's unsigned-extension flow — this works for testing but **resets on every Safari restart**, which is painful

### Option B — Wrap with Xcode (one-time, dev build only)
Apple ships a CLI tool that turns any WebExtension folder into an Xcode project:

```bash
xcrun safari-web-extension-converter browser-extension/safari --project-location ./safari-xcode --app-name "Downloader for Mac Helper" --bundle-identifier com.ahfoysal.downloader-for-mac.helper --no-prompt --swift
```

Then:
```bash
open safari-xcode/"Downloader for Mac Helper"/"Downloader for Mac Helper".xcodeproj
```

In Xcode:
1. Select the project, set the Signing Team to your free Apple ID (any)
2. Hit ▶ Run
3. Safari → Settings → Extensions → enable "Downloader for Mac Helper"

The extension stays installed as long as the helper `.app` exists.

## How it works

All three extensions share the same deep-link mechanism:

```
downloader://url/<encoded-url>
```

The main app registers itself as handler for `downloader://` URLs (see `main.js` → `setAsDefaultProtocolClient('downloader')`). When you click the extension icon or context menu, the background worker opens a hidden tab pointing to the deep link — macOS hands it off to the app — the app picks up the URL via `open-url` / `second-instance` events and auto-fills the URL bar (and starts analyzing).

No network, no IPC, no custom native host. Just OS-level URL routing.
