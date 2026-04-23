#!/usr/bin/env node
// Fetches yt-dlp and ffmpeg binaries into bin/ for mac (arm64 + x64) / win.
// Runs via `npm install` postinstall. Idempotent.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');

const SOURCES = {
  darwin: [
    { name: 'yt-dlp',       url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', chmod: true },
    { name: 'ffmpeg-arm64', url: 'https://www.osxexperts.net/ffmpeg81arm.zip', zip: 'ffmpeg', chmod: true },
    { name: 'ffmpeg-x64',   url: 'https://evermeet.cx/ffmpeg/getrelease/zip',  zip: 'ffmpeg', chmod: true },
  ],
  win32: [
    { name: 'yt-dlp.exe', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' },
  ],
};

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function main() {
  const srcs = SOURCES[process.platform];
  if (!srcs) {
    console.log(`[fetch-binaries] no sources for platform ${process.platform}; skipping.`);
    return;
  }
  fs.mkdirSync(BIN, { recursive: true });

  for (const s of srcs) {
    const final = path.join(BIN, s.name);
    if (fs.existsSync(final)) {
      console.log(`[fetch-binaries] ${s.name} already present, skipping.`);
      continue;
    }
    const tmp = path.join(BIN, `.${s.name}.tmp`);
    console.log(`[fetch-binaries] downloading ${s.name}…`);
    try {
      await download(s.url, tmp);
      if (s.zip) {
        // Extract a specific file from zip, rename to final name
        execSync(`unzip -o -j "${tmp}" -d "${BIN}"`, { stdio: 'inherit' });
        fs.renameSync(path.join(BIN, s.zip), final);
        fs.unlinkSync(tmp);
        const junk = path.join(BIN, '__MACOSX');
        if (fs.existsSync(junk)) fs.rmSync(junk, { recursive: true });
      } else {
        fs.renameSync(tmp, final);
      }
      if (s.chmod) fs.chmodSync(final, 0o755);
      console.log(`[fetch-binaries] ${s.name} ✓`);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      console.error(`[fetch-binaries] ${s.name} FAILED: ${err.message}`);
    }
  }
}

main();
