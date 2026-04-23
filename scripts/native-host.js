#!/usr/bin/env node
// Native Messaging Host for Downloader for Mac.
// Chrome/Firefox invoke this binary with stdio connected. Protocol:
//  - Each message is prefixed by a 4-byte little-endian length
//  - Followed by UTF-8 JSON of that length
// We read messages, act on them (open the downloader:// deep link),
// and respond with a JSON ack.

const { spawn } = require('child_process');

let buf = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const json = buf.slice(4, 4 + len).toString('utf8');
    buf = buf.slice(4 + len);
    try {
      const msg = JSON.parse(json);
      handle(msg).then((reply) => send(reply)).catch((err) => send({ ok: false, error: err.message }));
    } catch (err) {
      send({ ok: false, error: 'bad json: ' + err.message });
    }
  }
});

process.stdin.on('end', () => process.exit(0));

function send(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(data.length, 0);
  process.stdout.write(Buffer.concat([hdr, data]));
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'no message' };
  if (msg.type === 'ping') return { ok: true, pong: true, version: '1.0.0' };
  if (msg.type === 'send' && msg.url) {
    openApp(msg.url);
    return { ok: true, received: msg.url };
  }
  if (msg.type === 'send-many' && Array.isArray(msg.urls)) {
    msg.urls.forEach((u, i) => setTimeout(() => openApp(u), i * 400));
    return { ok: true, count: msg.urls.length };
  }
  return { ok: false, error: 'unknown type ' + msg.type };
}

function openApp(url) {
  const deep = 'downloader://url/' + encodeURIComponent(url);
  // `open` on macOS dispatches to the registered protocol handler without
  // flashing a tab or window in the calling browser.
  spawn('open', [deep], { detached: true, stdio: 'ignore' }).unref();
}
