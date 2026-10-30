// Google search through the real Chrome on this machine, via the gsearch
// extension (scrapling-deep/gsearch-extension).
//
// WHY AN EXTENSION. Every headless/automated browser we tried (Playwright,
// Scrapling, stealth patches) is met with Google's /sorry/ CAPTCHA within a few
// queries — on Google, Brave and Yahoo alike. What they are detecting is the
// automation (webdriver flag, attached CDP, fresh profile), not the searching.
// An extension runs inside the Chrome a human already uses: real fingerprint,
// real signed-in profile, home IP, no CDP. To Google it is a person opening a
// tab.
//
// NO SECOND SERVER. This module lives inside the worker process. start() opens
// one listener on 127.0.0.1 that does two things:
//   /ext      WebSocket the extension dials out to (it cannot be dialled into)
//   /search   POST {query,...} for local callers that do not go through the lab
//   /status   is the extension connected
// and the worker's `gsearch.search` job type calls the same search() below.
//
// ONE QUERY AT A TIME, WITH A GAP. The extension removes the bot signals, not
// the rate signal: fire queries in a burst and Google will CAPTCHA the real
// browser too. So every caller — lab job or local POST — goes through one serial
// queue with a jittered gap between queries.
//
// The WebSocket server is hand-rolled (text frames, ping/close) because this
// repo has no dependencies and a single trusted local client does not justify
// adding one.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.GSEARCH_PORT ?? 18787);
const HOST = '127.0.0.1';
// Optional bearer token for POST /search. The listener is loopback-only and
// /search requires a JSON POST (which a web page cannot send cross-origin
// without a preflight we never answer), so this is belt-and-braces.
const TOKEN = (process.env.GSEARCH_TOKEN ?? '').trim();
const GAP_MIN_MS = Number(process.env.GSEARCH_GAP_MIN_MS ?? 3000);
const GAP_MAX_MS = Number(process.env.GSEARCH_GAP_MAX_MS ?? 6000);
// An MV3 service worker that Chrome put to sleep is woken by a 30s alarm, so a
// query arriving while it sleeps waits up to that long for it to dial back in.
const CONNECT_WAIT_MS = Number(process.env.GSEARCH_CONNECT_WAIT_MS ?? 35_000);
// Long enough to cover a CAPTCHA the human has to solve in the tab (the
// extension waits up to captchaWaitMs, default 180s) plus multi-page queries.
const SEARCH_TIMEOUT_MS = Number(process.env.GSEARCH_TIMEOUT_MS ?? 240_000);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let ext = null; // { socket, send, hello, since }
const connectWaiters = new Set();
const pending = new Map(); // id -> { resolve, reject, timer }
let queue = Promise.resolve();
let lastDoneAt = 0;
let queued = 0;
let server = null;

const log = (msg) => console.log('[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] [gsearch] ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });

// ------------------------------------------------------------------ public API

/**
 * Search Google through the extension.
 *
 * payload: { query (required), pages=1 (max 5), hl, gl, tbs, captchaWaitMs }
 * returns: { query, url, results:[{position,title,url,snippet}], featured,
 *            knowledge, peopleAlsoAsk, related, stats, tookMs }
 */
export async function search(payload) {
  const p = payload ?? {};
  const query = String(p.query ?? p.q ?? '').trim();
  if (!query) throw fail('bad_request', 'query is required');
  const opts = {
    pages: Math.min(5, Math.max(1, Number(p.pages) || 1)),
    hl: p.hl ? String(p.hl) : undefined,
    gl: p.gl ? String(p.gl) : undefined,
    tbs: p.tbs ? String(p.tbs) : undefined,
    captchaWaitMs: Number(p.captchaWaitMs) > 0 ? Number(p.captchaWaitMs) : undefined,
  };

  queued++;
  const turn = queue.then(async () => {
    queued--;
    const wait = lastDoneAt + GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS) - Date.now();
    if (wait > 0) await sleep(wait);
    const at = Date.now();
    try {
      const data = await ask(query, opts);
      return { query, ...data, tookMs: Date.now() - at };
    } finally {
      lastDoneAt = Date.now();
    }
  });
  // The chain must survive a failed query, or one CAPTCHA wedges every caller behind it.
  queue = turn.catch(() => {});
  return turn;
}

/** Is the extension connected. Never throws. */
export async function probe() {
  return status();
}

export function status() {
  return {
    listening: !!server?.listening,
    port: PORT,
    extension: ext ? { connected: true, since: ext.since, ...ext.hello } : { connected: false },
    busy: pending.size > 0,
    queued,
  };
}

/** Open the loopback listener. Safe to call once; a busy port is logged, not fatal. */
export function start() {
  if (server) return server;
  server = http.createServer(onRequest);
  server.on('upgrade', onUpgrade);
  server.on('error', (err) => {
    // A second worker on the same box, most likely. The worker's other lanes
    // must keep running, so say so and carry on without gsearch.
    log('listener failed on ' + HOST + ':' + PORT + ' — ' + err.message + ' (gsearch disabled in this process)');
  });
  server.listen(PORT, HOST, () => log('listening on http://' + HOST + ':' + PORT + ' — waiting for the extension'));
  return server;
}

// ---------------------------------------------------------- extension bridge

async function ask(query, opts) {
  const conn = await waitForExtension();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(fail('timeout', 'extension did not answer within ' + SEARCH_TIMEOUT_MS / 1000 + 's'));
    }, SEARCH_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    conn.send({ type: 'search', id, query, opts });
  });
}

function waitForExtension() {
  if (ext) return Promise.resolve(ext);
  return new Promise((resolve, reject) => {
    const w = (conn) => { clearTimeout(timer); connectWaiters.delete(w); resolve(conn); };
    const timer = setTimeout(() => {
      connectWaiters.delete(w);
      reject(fail('extension_offline', 'gsearch extension is not connected — is Chrome open with the extension enabled?'));
    }, CONNECT_WAIT_MS);
    connectWaiters.add(w);
  });
}

function onExtMessage(conn, msg) {
  if (msg.type === 'ping') return conn.send({ type: 'pong' });
  if (msg.type === 'hello') {
    conn.hello = { version: msg.version, userAgent: msg.userAgent };
    return;
  }
  if (msg.type === 'result') {
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.ok) job.resolve(msg.data);
    else job.reject(fail(msg.code ?? 'extension_error', msg.error ?? 'extension reported a failure'));
  }
}

function onExtClose(conn) {
  if (ext !== conn) return;
  ext = null;
  log('extension disconnected');
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.reject(fail('extension_offline', 'extension disconnected mid-search'));
    pending.delete(id);
  }
}

// ----------------------------------------------------------------- HTTP side

function onRequest(req, res) {
  const url = new URL(req.url, 'http://' + HOST);
  const reply = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && url.pathname === '/status') return reply(200, status());

  if (req.method === 'POST' && url.pathname === '/search') {
    if (TOKEN && req.headers.authorization !== 'Bearer ' + TOKEN) return reply(401, { error: 'bad token' });
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      return reply(415, { error: 'content-type must be application/json' });
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return reply(400, { error: 'invalid JSON' }); }
      try {
        reply(200, await search(payload));
      } catch (err) {
        const code = { bad_request: 400, extension_offline: 503, captcha: 429, timeout: 504 }[err.code] ?? 500;
        reply(code, { error: err.message, code: err.code ?? 'error' });
      }
    });
    return;
  }

  reply(404, { error: 'not found', routes: ['GET /status', 'POST /search {query,pages,hl,gl,tbs}'] });
}

// ------------------------------------------------------- minimal WebSocket

function onUpgrade(req, socket) {
  const url = new URL(req.url, 'http://' + HOST);
  const origin = String(req.headers.origin ?? '');
  // Any web page can open ws://127.0.0.1, but it cannot forge its Origin. Only
  // an extension gets to be the search backend.
  if (url.pathname !== '/ext' || !origin.startsWith('chrome-extension://') || !req.headers['sec-websocket-key']) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
  );
  socket.setNoDelay(true);

  const conn = {
    socket,
    since: new Date().toISOString(),
    hello: {},
    send: (obj) => { if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(obj)))); },
  };
  // Newest connection wins: a reloaded extension reconnects before the old
  // socket has noticed it is dead.
  if (ext && ext.socket !== socket) ext.socket.destroy();
  ext = conn;
  log('extension connected (' + origin + ')');
  for (const w of connectWaiters) w(conn);

  let buf = Buffer.alloc(0);
  let fragments = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = parseFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.length);
      if (f.opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); return; }
      if (f.opcode === 0x9) { socket.write(frame(0xA, f.payload)); continue; }
      if (f.opcode === 0xA) continue;
      if (f.opcode === 0x1 || f.opcode === 0x0) {
        fragments.push(f.payload);
        if (!f.fin) continue;
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        try { onExtMessage(conn, JSON.parse(text)); } catch (err) { log('bad message from extension: ' + err.message); }
      }
    }
  });
  socket.on('close', () => onExtClose(conn));
  socket.on('error', () => socket.destroy());
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  const maskOff = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
  return { fin, opcode, payload, length: off + len };
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}
