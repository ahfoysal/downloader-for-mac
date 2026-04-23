#!/usr/bin/env node
// Native Messaging Host for Downloader for Mac.
//
// Wire shape:
//   Extension  <-- stdio (length-prefixed JSON) -->  Host  <-- Unix socket (newline JSON) -->  App
//
// The host is basically a bidirectional proxy. Chrome starts one host process
// per `chrome.runtime.connectNative` call and kills it when the port closes.

const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SOCK_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Downloader for Mac', 'control.sock');

let sock = null;
let sockBuf = '';
let stdinBuf = Buffer.alloc(0);

// ===== Stdio half (host <-> Chrome extension) =====
function sendToExt(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(data.length, 0);
  process.stdout.write(Buffer.concat([hdr, data]));
}

process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const json = stdinBuf.slice(4, 4 + len).toString('utf8');
    stdinBuf = stdinBuf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(json); } catch (_) { continue; }
    handleExtMessage(msg);
  }
});
process.stdin.on('end', () => {
  try { if (sock) sock.end(); } catch (_) {}
  process.exit(0);
});

// ===== Socket half (host <-> App) =====
function connectSock() {
  sock = net.createConnection(SOCK_PATH);
  sock.on('connect', () => {
    sendToExt({ type: 'hello', connected: true });
  });
  sock.on('data', (buf) => {
    sockBuf += buf.toString('utf8');
    let idx;
    while ((idx = sockBuf.indexOf('\n')) !== -1) {
      const line = sockBuf.slice(0, idx);
      sockBuf = sockBuf.slice(idx + 1);
      if (!line.trim()) continue;
      try { sendToExt(JSON.parse(line)); } catch (_) {}
    }
  });
  sock.on('error', () => { sock = null; });
  sock.on('close', () => { sock = null; });
}

function sendToApp(obj) {
  const payload = JSON.stringify(obj) + '\n';
  if (!sock) {
    // Fallback: open deep link via `open` if socket is down
    if (obj && obj.type === 'send' && obj.url) {
      const deep = 'downloader://url/' + encodeURIComponent(obj.url);
      spawn('open', [deep], { detached: true, stdio: 'ignore' }).unref();
      sendToExt({ type: 'ack', via: 'fallback-deeplink', url: obj.url });
    }
    return;
  }
  try { sock.write(payload); } catch (_) {}
}

function handleExtMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ping') {
    sendToExt({ type: 'pong', ok: true, version: '1.1.0', socketUp: !!sock });
    return;
  }
  sendToApp(msg);
}

connectSock();
