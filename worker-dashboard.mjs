// A loopback-only HTTP surface for the root worker.
//
// The worker deliberately has no inbound cloud port: it dials the broker from
// behind NAT. This listener is a separate, local observation surface. It never
// accepts jobs, changes configuration, or proxies credentials; it serves one
// read-only HTML page, one aggregated JSON snapshot, and a health check.

import http from 'node:http';
import { renderDashboardHtml, renderSetupHtml } from './worker-dashboard-html.mjs';
import { redact } from './worker-status.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18_788;
const CLOUD_CACHE_MS = 2_500;
const CLOUD_TIMEOUT_MS = 10_000;
const WORKER_STALE_MS = 90_000;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function html(res, value) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(value);
}

function errorText(error, secrets = []) {
  return redact(String(error?.message ?? error ?? 'unknown error'), secrets)
    .replace(/https?:\/\/[^\s]+/g, '[url]')
    .slice(0, 240);
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWorkers(data, workerName, nowMs) {
  const workers = Array.isArray(data?.workers) ? data.workers : [];
  return workers.map((worker) => {
    const lastSeenAt = typeof worker?.lastSeenAt === 'string' ? worker.lastSeenAt : null;
    const parsed = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
    const ageSec = Number.isFinite(parsed) ? Math.max(0, Math.round((nowMs - parsed) / 1000)) : null;
    const workerNameValue = String(worker?.name ?? 'unknown');
    const online = ageSec !== null && ageSec * 1000 <= WORKER_STALE_MS;
    const cooldownUntil = typeof worker?.cooldownUntil === 'string' && Date.parse(worker.cooldownUntil) > nowMs
      ? worker.cooldownUntil : null;
    const state = !online ? 'offline' : cooldownUntil ? 'cooldown' : 'online';
    return {
      name: workerNameValue,
      lastSeenAt,
      ageSec,
      online: state === 'online',
      state,
      cooldownUntil,
      cooldownReason: cooldownUntil ? String(worker?.cooldownReason ?? 'Individual quota reached').slice(0, 300) : null,
      isLocal: workerNameValue === workerName || workerNameValue.startsWith(workerName + '-'),
      ip: worker?.ip ? String(worker.ip) : null,
      types: Array.isArray(worker?.types) ? worker.types.map(String) : [],
    };
  }).sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || Number(b.online) - Number(a.online) || (a.ageSec ?? Infinity) - (b.ageSec ?? Infinity) || a.name.localeCompare(b.name));
}

function publicCloud(data, { workerName, nowMs, lastSuccessAt }) {
  const counts = data?.counts ?? {};
  return {
    ok: true,
    error: null,
    fetchedAt: new Date(nowMs).toISOString(),
    lastSuccessAt,
    counts: {
      pending: finiteNumber(counts.pending),
      running: finiteNumber(counts.running),
    },
    waiting: finiteNumber(data?.waiting),
    workers: normalizeWorkers(data, workerName, nowMs),
  };
}

/**
 * Create a cached cloud reader. The worker's dashboard refreshes every three
 * seconds; this cache means a browser refresh and a second tab do not turn
 * that into a request storm against the broker.
 */
export function createCloudStatus({
  lab,
  token,
  workerName,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = CLOUD_CACHE_MS,
} = {}) {
  const secrets = [token];
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;

  const empty = (message, at) => ({
    ok: false,
    error: message,
    fetchedAt: new Date(at).toISOString(),
    lastSuccessAt: cached?.lastSuccessAt ?? null,
    counts: cached?.counts ?? { pending: 0, running: 0 },
    waiting: cached?.waiting ?? 0,
    workers: cached?.workers ?? [],
  });

  async function fetchStatus() {
    const at = now();
    if (!lab) return empty('LAB_URL is not configured', at);
    try {
      const headers = token ? { authorization: 'Bearer ' + token } : {};
      const response = await fetchImpl(lab + '/api/jobs', {
        headers,
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error('cloud broker returned HTTP ' + response.status);
      const data = await response.json();
      const result = publicCloud(data, { workerName: workerName ?? '', nowMs: now(), lastSuccessAt: new Date(now()).toISOString() });
      cached = result;
      return result;
    } catch (error) {
      return empty(errorText(error, secrets), now());
    }
  }

  async function get() {
    const at = now();
    if (cached && at - cachedAt < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = fetchStatus()
      .then((result) => {
        cached = result;
        cachedAt = now();
        return result;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { get, fetchNow: fetchStatus };
}

function safeProvider(provider, fallback) {
  try {
    const value = provider?.();
    return value && typeof value.then === 'function' ? value.catch(() => fallback) : value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Make a server without listening. This is the seam used by tests and also
 * keeps the worker's startup code from knowing anything about HTTP details.
 */
export function createDashboardServer({
  getStatus,
  cloudStatus,
  gsearchStatus,
  setupStatus,
  getHtml = renderDashboardHtml,
  getSetupHtml = renderSetupHtml,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return json(res, 400, { error: 'invalid URL' });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return html(res, getHtml());
    }
    if (req.method === 'GET' && (url.pathname === '/setup' || url.pathname === '/setup.html')) {
      return html(res, getSetupHtml());
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, dashboard: true, at: new Date(now()).toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      try {
        const local = await safeProvider(getStatus, { worker: {}, totals: {}, lanes: [], events: [] });
        const cloud = await cloudStatus?.get?.() ?? { ok: false, error: 'cloud status is not configured', workers: [], counts: { pending: 0, running: 0 }, waiting: 0 };
        const gsearch = await safeProvider(gsearchStatus, { listening: false, extension: { connected: false }, busy: false, queued: 0 });
        return json(res, 200, { at: new Date(now()).toISOString(), local, cloud, gsearch });
      } catch (error) {
        log('dashboard status failed: ' + errorText(error));
        return json(res, 503, { ok: false, error: 'status unavailable' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/setup') {
      // The deep layer starts real child processes (MCP handshakes, a LinkedIn
      // session probe) and can take minutes, so it runs only when the caller
      // asks for it with ?deep=1 — never on the page's periodic refresh.
      const wantsDeep = url.searchParams.get('deep') === '1';
      try {
        const setup = wantsDeep
          ? await setupStatus?.getWithDeep?.()
          : await setupStatus?.get?.();
        if (setup) return json(res, 200, setup);
        return json(res, 200, {
          at: new Date(now()).toISOString(),
          claimedTypes: [],
          groups: [],
          checks: [],
          overall: { state: 'unknown', reasons: ['setup status is not configured'] },
        });
      } catch (error) {
        log('dashboard setup failed: ' + errorText(error));
        return json(res, 503, { ok: false, error: 'setup unavailable' });
      }
    }
    if (url.pathname.startsWith('/api/')) return json(res, 405, { error: 'read-only dashboard' });
    return json(res, 404, { error: 'not found' });
  });
}

/** Start the listener and resolve with its actual bound address. */
export async function startDashboard(options = {}) {
  const host = options.host ?? process.env.WORKER_DASHBOARD_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.WORKER_DASHBOARD_PORT ?? DEFAULT_PORT);
  const server = createDashboardServer(options);
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, host, port: actualPort, url: 'http://' + host + ':' + actualPort };
}

export const dashboardDefaults = { host: DEFAULT_HOST, port: DEFAULT_PORT, cacheMs: CLOUD_CACHE_MS };
