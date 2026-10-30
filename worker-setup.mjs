#!/usr/bin/env node
// Device setup & health checks for the local worker.
//
// WHY THIS EXISTS. The worker spans a dozen external pieces — Chrome, CLIs with
// their own logins, a Chrome extension, a Python venv, MCP servers — and a new
// device fails at job time, one piece at a time, with no map of what else is
// missing. This module turns that into one checklist: every dependency is
// probed on four axes (installed / process / connected / session) and judged
// against the job types THIS device actually claims, so "all setup completed"
// means ready for the claimed work, not "every optional tool exists".
//
// TWO SPEEDS. The fast checks are file and PATH lookups plus in-process state —
// safe to run on every page refresh. The deep checks start real child processes
// (an MCP handshake, a CLI version call, a LinkedIn session probe) and can take
// minutes in the worst case, so they never run on the 3-second auto-refresh:
// they run on demand, behind a TTL cache, through the dashboard's explicit
// "re-run deep checks" action.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentInvocation, resolveSkillDir } from './research-contact.mjs';
import { resolveDeepSkillDir, resolveOpencodeInvocation } from './research-deep.mjs';
import { redact } from './worker-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_SCRAPLING_MCP = path.join(HERE, 'scrapling-deep', '.venv', 'Scripts', 'scrapling-mcp.exe');
const DEEP_TTL_MS = 60_000;

// ---------------------------------------------------------------- path lookup

/**
 * First existing executable for a bare command name, Windows npm shims included.
 * Mirrors the resolution rules in research-contact.mjs so the checklist and the
 * handler agree on what "installed" means.
 */
export function findOnPath(name, { env = process.env, platform = process.platform, extraDirs = [] } = {}) {
  const requested = String(name ?? '').trim();
  if (!requested) return null;
  const pathLike = path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\');
  if (pathLike) return existsSync(requested) ? requested : null;
  // Prefer the .cmd launcher over the extensionless POSIX shim on Windows:
  // with shell:false the shim is not executable there.
  const names = platform === 'win32' ? [`${requested}.cmd`, `${requested}.exe`, `${requested}.bat`, requested] : [requested];
  const dirs = [...extraDirs, ...(env.PATH ?? '').split(path.delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        // A stale PATH entry is not an error; keep looking.
      }
    }
  }
  return null;
}

/** Chrome candidates, mirroring findChrome() in gmap.mjs (not exported there). */
export function findChrome({ env = process.env, platform = process.platform, home = os.homedir(), exists = existsSync } = {}) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH;
  if (platform === 'win32') {
    const candidates = [
      path.join(env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find(exists) ?? null;
  }
  if (platform === 'darwin') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return exists(mac) ? mac : null;
  }
  const linux = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return linux.find(exists) ?? null;
}

/** Antigravity CLI candidates, mirroring findAgy() in agy.mjs (not exported there). */
export function findAgy({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const configured = env.AGY_BIN?.trim();
  if (configured && (existsSync(configured) || !/[\\/]/.test(configured))) return configured;
  if (platform === 'win32') {
    const candidates = [
      path.join(home, '.local', 'bin', 'agy.cmd'),
      path.join(home, '.local', 'bin', 'agy.exe'),
      path.join(env['LOCALAPPDATA'] ?? '', 'agy', 'bin', 'agy.exe'),
      path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    ];
    return candidates.find(existsSync) ?? findOnPath('agy', { env, platform });
  }
  const unix = path.join(home, '.local', 'bin', 'agy');
  return existsSync(unix) ? unix : findOnPath('agy', { env, platform });
}

// ------------------------------------------------------------ check registry

const GROUPS = [
  { id: 'core', label: 'Core' },
  { id: 'browser', label: 'Browser & search' },
  { id: 'research', label: 'Research stack' },
  { id: 'engines', label: 'Optional engines' },
];

const CHECK_DEFS = [
  {
    id: 'node', group: 'core', label: 'Node.js >= 20', requiredFor: ['*'],
    detail: 'the worker process itself',
    check: ({ nodeVersion }) => {
      const major = Number((nodeVersion ?? '').replace(/^v/, '').split('.')[0]);
      return major >= 20
        ? { state: 'ok', detail: nodeVersion }
        : { state: 'bad', detail: `${nodeVersion} — engines require >= 20`, remediation: 'Install Node.js 20+ from https://nodejs.org/' };
    },
  },
  {
    id: 'env-file', group: 'core', label: 'Environment file', requiredFor: ['*'],
    check: ({ env, envFile, home, exists }) => {
      const files = [envFile, path.resolve('.env'), path.join(home, '.gmap-worker.env')].filter(Boolean);
      const found = files.find((f) => exists(f));
      return found
        ? { state: 'ok', detail: found }
        : { state: 'bad', detail: 'no .env found', remediation: 'Copy .env.example to .env and fill in LAB_URL, LAB_TOKEN, WORKER_NAME' };
    },
  },
  {
    id: 'lab-config', group: 'core', label: 'Broker connection config', requiredFor: ['*'],
    check: ({ env }) => {
      const lab = (env.LAB_URL ?? '').trim();
      const token = (env.LAB_TOKEN ?? '').trim();
      if (lab && token) return { state: 'ok', detail: lab };
      const missing = [!lab && 'LAB_URL', !token && 'LAB_TOKEN'].filter(Boolean);
      return { state: 'bad', detail: `missing ${missing.join(' + ')}`, remediation: `Set ${missing.join(' and ')} in .env` };
    },
  },
  {
    id: 'worker-name', group: 'core', label: 'Worker identity', optionalFor: ['*'],
    check: ({ env }) => {
      const name = (env.WORKER_NAME ?? '').trim();
      return name
        ? { state: 'ok', detail: name }
        : { state: 'warn', detail: 'WORKER_NAME unset — falls back to hostname', remediation: 'Set WORKER_NAME in .env so this device is identifiable in GET /api/jobs' };
    },
  },
  {
    id: 'chrome', group: 'browser', label: 'Google Chrome', requiredFor: ['gmap.'],
    check: (ctx) => {
      const found = findChrome(ctx);
      return found
        ? { state: 'ok', detail: found }
        : { state: 'bad', detail: 'no Chrome executable found', remediation: 'Install Google Chrome, or set CHROME_PATH in .env' };
    },
  },
  {
    id: 'gsearch', group: 'browser', label: 'Google Search bridge', requiredFor: ['gsearch.'], optionalFor: ['research.', 'research-deep.'],
    detail: 'real-Chrome Google search via the unpacked extension',
    check: ({ gsearch }) => {
      if (!gsearch) return { state: 'unknown', detail: 'no bridge snapshot' };
      if (gsearch.listening === false) {
        return {
          state: 'warn', detail: 'listener disabled in this process',
          remediation: 'GSEARCH_DISABLE is set or the port is taken; searches will be served by another worker',
        };
      }
      if (gsearch.extension?.connected) {
        return { state: 'ok', detail: `extension connected${gsearch.extension.version ? ' · ' + gsearch.extension.version : ''}` };
      }
      return {
        state: gsearch.listening ? 'warn' : 'bad',
        detail: gsearch.listening ? 'listening on ' + (gsearch.port ?? '?') + ' but no extension connected' : 'listener is down',
        remediation: 'Open Chrome → chrome://extensions → Developer mode → Load unpacked → pick scrapling-deep/gsearch-extension',
      };
    },
  },
  {
    id: 'pi', group: 'research', label: 'Pi CLI', requiredFor: ['research.'],
    detail: 'runs the research-contact skill headlessly',
    check: ({ resolveAgent }) => {
      const invocation = resolveAgent();
      return invocation.available
        ? { state: 'ok', detail: invocation.bin ?? invocation.command }
        : { state: 'bad', detail: invocation.reason, remediation: 'npm install -g @earendil-works/pi-coding-agent (or set RESEARCH_AGENT_BIN)' };
    },
  },
  {
    id: 'opencode', group: 'research', label: 'OpenCode CLI', requiredFor: ['research-deep.'],
    detail: 'runs the research-deep skill headlessly',
    check: ({ resolveOpencode }) => {
      const invocation = resolveOpencode();
      return invocation.available
        ? { state: 'ok', detail: invocation.bin ?? invocation.command }
        : { state: 'bad', detail: invocation.reason, remediation: 'Install OpenCode (npm install -g opencode) and authenticate once via `opencode auth`, or set OPENCODE_BIN' };
    },
  },
  {
    id: 'research-skill', group: 'research', label: 'research-contact skill', requiredFor: ['research.', 'research-deep.'],
    check: ({ resolveSkill, resolveDeepSkill }) => {
      const dir = resolveSkill() ?? resolveDeepSkill?.() ?? null;
      return dir
        ? { state: 'ok', detail: dir }
        : { state: 'bad', detail: 'skill directory not found', remediation: 'node scrapling-deep/agent-skill/research-contact/install.mjs' };
    },
  },
  {
    id: 'pdftotext', group: 'research', label: 'pdftotext (poppler)', optionalFor: ['research.', 'research-deep.'],
    detail: 'annual-report PDF extraction',
    check: (ctx) => {
      const found = findOnPath(ctx.env.PDFTOTEXT_BIN ?? 'pdftotext', ctx);
      return found
        ? { state: 'ok', detail: found }
        : { state: 'warn', detail: 'not found — PDF step is skipped', remediation: 'Install poppler-utils (pdftotext) for the annual-report step' };
    },
  },
  {
    id: 'linkedin-toolchain', group: 'research', label: 'LinkedIn toolchain (uvx + mcporter)', optionalFor: ['research.', 'research-deep.'],
    detail: 'decision-maker enrichment channel',
    check: (ctx) => {
      const uvx = findOnPath(ctx.env.UVX_BIN ?? 'uvx', { ...ctx, extraDirs: windowsPythonScripts(ctx) });
      const mcporter = findOnPath(ctx.env.MCPORTER_BIN ?? 'mcporter', { ...ctx, extraDirs: [path.join(ctx.home, 'AppData', 'Roaming', 'npm')] });
      if (uvx && mcporter) return { state: 'ok', detail: `${uvx} · ${mcporter}` };
      const missing = [!uvx && 'uvx', !mcporter && 'mcporter'].filter(Boolean);
      return { state: 'warn', detail: `missing ${missing.join(' + ')}`, remediation: 'See scrapling-deep/agent-skill/research-contact/INSTALL.md → LinkedIn channel' };
    },
  },
  {
    id: 'linkedin-profile', group: 'research', label: 'LinkedIn session profile', optionalFor: ['research.', 'research-deep.'],
    detail: 'installed trace only — session validity needs the deep check',
    check: ({ home, exists }) => {
      const dir = path.join(home, '.linkedin-mcp', 'profile');
      return exists(dir)
        ? { state: 'ok', detail: dir + ' (run the deep check to verify the session)' }
        : { state: 'warn', detail: 'no profile directory', remediation: 'Run linkedin-login.cmd (uvx mcp-server-linkedin@latest --no-headless --login)' };
    },
  },
  {
    id: 'scrapling-mcp', group: 'research', label: 'Scrapling MCP server', optionalFor: ['research.', 'research-deep.'],
    detail: 'stealth HTTP / browser scraping for the research agent',
    check: ({ env, exists }) => {
      const found = env.SCRAPLING_MCP_BIN && exists(env.SCRAPLING_MCP_BIN)
        ? env.SCRAPLING_MCP_BIN
        : exists(REPO_SCRAPLING_MCP) ? REPO_SCRAPLING_MCP : null;
      return found
        ? { state: 'ok', detail: found }
        : { state: 'warn', detail: 'scrapling venv not found', remediation: 'cd scrapling-deep && python -m venv .venv && .venv/Scripts/pip install "scrapling[all]" && scrapling install' };
    },
  },
  {
    id: 'obscura', group: 'research', label: 'Obscura browser', optionalFor: ['research.', 'research-deep.'],
    detail: 'browser escalation for JS-rendered pages',
    check: ({ env, home, exists }) => {
      const candidates = [env.OBSCURA_BIN, 'D:/Tools/obscura/obscura.exe', path.join(home, 'bin', 'obscura.cmd')].filter(Boolean);
      const found = candidates.find((c) => exists(c));
      return found
        ? { state: 'ok', detail: found }
        : { state: 'warn', detail: 'not found — the agent escalates to other browser tools', remediation: 'Set OBSCURA_BIN in .env if Obscura is installed elsewhere' };
    },
  },
  {
    id: 'agy', group: 'engines', label: 'Antigravity CLI (agy)', requiredFor: ['agy.'],
    check: (ctx) => {
      const found = findAgy(ctx);
      return found
        ? { state: 'ok', detail: found }
        : { state: 'bad', detail: 'agy not found', remediation: 'Install the Antigravity CLI and sign in, or set AGY_BIN in .env' };
    },
  },
  {
    id: 'ego-browser', group: 'engines', label: 'ego-browser + spaces', requiredFor: ['chatgpt.'],
    check: (ctx) => {
      const bin = findOnPath('ego-browser', ctx);
      const spaces = path.join(ctx.home, '.gmap-worker', 'spaces.json');
      const hasSpaces = ctx.exists(spaces);
      if (bin && hasSpaces) return { state: 'ok', detail: bin };
      const missing = [!bin && 'ego-browser binary', !hasSpaces && 'spaces.json'].filter(Boolean);
      return { state: 'bad', detail: `missing ${missing.join(' + ')}`, remediation: 'Install ego-browser and register profiles in ~/.gmap-worker/spaces.json' };
    },
  },
  {
    id: 'fb-recon', group: 'engines', label: 'fb-recon binaries', requiredFor: ['fb.'],
    check: gmapReconCheck('fb-recon', ['fbw', 'fb'], 'fb.mjs'),
  },
  {
    id: 'x-recon', group: 'engines', label: 'x-recon binaries', requiredFor: ['x.'],
    check: gmapReconCheck('x-recon', ['xw', 'x'], 'x.mjs'),
  },
  {
    id: 'ads-recon', group: 'engines', label: 'ads-recon binaries', requiredFor: ['ads.'],
    check: gmapReconCheck('ads-recon', ['ads', 'kw'], 'ads.mjs'),
  },
  {
    id: 'deepseek-build', group: 'engines', label: 'deepseek-web-api build', requiredFor: [], optionalFor: [],
    detail: 'informational — not a worker job type',
    check: ({ exists }) => {
      const dist = path.join(HERE, 'deepseek-web-api', 'dist', 'index.js');
      return exists(dist)
        ? { state: 'ok', detail: dist }
        : { state: 'warn', detail: 'dist/index.js not built', remediation: 'cd deepseek-web-api && pnpm install && pnpm build (only needed for the DeepSeek side service)' };
    },
  },
];

function gmapReconCheck(repoDir, binaries, reference) {
  return ({ home, env, exists }) => {
    // fb.mjs / x.mjs / ads.mjs default to ~/project/gmap-recon/... and are not
    // part of this repository; mirror their FBW/XW/ADS/KW env overrides.
    const envNames = { fbw: 'FBW_BIN', fb: 'FB_BIN', xw: 'XW_BIN', x: 'X_BIN', ads: 'ADS_BIN', kw: 'KW_BIN' };
    const dir = path.join(home, 'project', 'gmap-recon', repoDir);
    const found = {};
    const missing = [];
    for (const bin of binaries) {
      const override = env[envNames[bin]];
      const candidate = override ?? path.join(dir, bin);
      if (exists(candidate)) found[bin] = candidate;
      else missing.push(bin);
    }
    if (!missing.length) return { state: 'ok', detail: Object.values(found).join(' · ') };
    return {
      state: 'bad',
      detail: `missing ${missing.join(', ')} (expected under ${dir})`,
      remediation: `Clone gmap-recon with its ${repoDir} worker (see ${reference}), or set the *_BIN override in .env`,
    };
  };
}

function windowsPythonScripts({ platform, home }) {
  if (platform !== 'win32') return [];
  return [path.join(home, 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts')];
}

// ------------------------------------------------------------ classification

function typeMatches(prefix, claimedTypes) {
  if (prefix === '*') return claimedTypes.length > 0;
  return claimedTypes.some((type) => type === prefix || type.startsWith(prefix));
}

export function severityFor(def, claimedTypes) {
  if ((def.requiredFor ?? []).some((prefix) => typeMatches(prefix, claimedTypes))) return 'required';
  if ((def.optionalFor ?? []).some((prefix) => typeMatches(prefix, claimedTypes))) return 'optional';
  return 'inactive';
}

/**
 * Overall verdict from checks: not_ready when anything the claimed work needs is
 * broken, degraded when it is questionable or an optional-but-relevant piece is
 * missing, ready otherwise. Inactive checks never count — a device that does
 * not claim fb.* is not broken for lacking fb-recon.
 */
export function classifyOverall(checks) {
  const reasons = [];
  let state = 'ready';
  for (const check of checks) {
    if (check.severity === 'inactive') continue;
    if (check.severity === 'required' && check.state === 'bad') {
      reasons.push(`${check.label}: ${check.detail}`);
      state = 'not_ready';
    } else if (check.severity === 'required' && check.state !== 'ok') {
      reasons.push(`${check.label}: ${check.detail}`);
      if (state === 'ready') state = 'degraded';
    } else if (check.severity === 'optional' && check.state === 'bad') {
      reasons.push(`${check.label} (optional): ${check.detail}`);
      if (state === 'ready') state = 'degraded';
    }
  }
  return { state, reasons };
}

function buildCheck(def, ctx, claimedTypes) {
  const severity = severityFor(def, claimedTypes);
  let outcome;
  try {
    outcome = def.check(ctx) ?? {};
  } catch (error) {
    outcome = { state: 'unknown', detail: redact(String(error?.message ?? error)) };
  }
  return {
    id: def.id,
    group: def.group,
    label: def.label,
    severity,
    state: outcome.state ?? 'unknown',
    detail: outcome.detail ?? '',
    remediation: outcome.remediation,
    requiredFor: claimedTypes.length ? (def.requiredFor ?? []) : [],
  };
}

// ------------------------------------------------------------- fast snapshot

/**
 * Run every file/PATH/in-process check. No child processes, no network: safe on
 * every page refresh.
 */
export function runSetupChecks({
  claimedTypes = [],
  env = process.env,
  gsearchStatus,
  home = os.homedir(),
  platform = process.platform,
  envFile = process.env.WORKER_ENV_FILE,
  nodeVersion = process.version,
  resolveAgent = resolveAgentInvocation,
  resolveSkill = resolveSkillDir,
  resolveOpencode = resolveOpencodeInvocation,
  resolveDeepSkill = resolveDeepSkillDir,
  exists = existsSync,
  now = () => Date.now(),
} = {}) {
  // The bridge snapshot arrives either as the status object (createSetupStatus
  // calls it) or as the provider function (tests, setup.mjs) — normalise, so a
  // raw function never leaks into the check and reads undefined fields.
  const gsearch = typeof gsearchStatus === 'function' ? gsearchStatus() : gsearchStatus;
  const ctx = { env, home, platform, envFile, nodeVersion, resolveAgent, resolveSkill, resolveOpencode, resolveDeepSkill, gsearch, exists };
  const checks = CHECK_DEFS.map((def) => buildCheck(def, ctx, claimedTypes));
  return {
    at: new Date(now()).toISOString(),
    claimedTypes,
    groups: GROUPS,
    checks,
    overall: classifyOverall(checks),
  };
}

// ------------------------------------------------------------- deep probes

function execCapture(command, args, timeoutMs, { cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout?.on('data', (chunk) => { if (stdout.length < 8_000) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { stderr += String(error?.message ?? error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function parseJsonLoose(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch {}
  const a = source.indexOf('{');
  const b = source.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(source.slice(a, b + 1)); } catch {}
  }
  return null;
}

async function probePiVersion() {
  const invocation = resolveAgentInvocation();
  if (!invocation.available) return { state: 'bad', detail: invocation.reason };
  const run = await execCapture(invocation.command, [...invocation.prefixArgs, '--version'], 20_000);
  const version = (run.stdout || run.stderr).trim().split(/\r?\n/)[0];
  if (run.code === 0 && version) return { state: 'ok', detail: version };
  return { state: 'bad', detail: `pi --version failed${run.timedOut ? ' (timed out)' : ''}: ${version || 'no output'}` };
}

async function probeOpencodeVersion() {
  const invocation = resolveOpencodeInvocation();
  if (!invocation.available) return { state: 'bad', detail: invocation.reason };
  const run = await execCapture(invocation.command, [...invocation.prefixArgs, '--version'], 20_000);
  const version = (run.stdout || run.stderr).trim().split(/\r?\n/)[0];
  if (run.code === 0 && version) return { state: 'ok', detail: version };
  return { state: 'bad', detail: `opencode --version failed${run.timedOut ? ' (timed out)' : ''}: ${version || 'no output'}` };
}

/** Minimal MCP stdio handshake: initialize, then tools/list. */
function mcpHandshake(command, args, { cwd, timeoutMs = 20_000, listTimeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      resolve({ stage: 'spawn', error: String(error?.message ?? error) });
      return;
    }
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    const send = (method, params) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return id;
    };
    const timers = {};
    const finish = (result) => {
      clearTimeout(timers.all);
      try { child.kill(); } catch {}
      resolve(result);
    };
    timers.all = setTimeout(() => finish({ stage: 'timeout' }), timeoutMs);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === pending.get('initialize')) {
          pending.delete('initialize');
          clearTimeout(timers.init);
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          const listId = send('tools/list', {});
          pending.set('tools/list', listId);
          timers.list = setTimeout(() => finish({ stage: 'tools_list_timeout', initialized: true }), listTimeoutMs);
        } else if (message.id === pending.get('tools/list')) {
          const tools = Array.isArray(message.result?.tools) ? message.result.tools : null;
          finish(tools ? { stage: 'ready', toolCount: tools.length } : { stage: 'tools_list_empty', initialized: true });
        }
      }
    });
    child.on('error', (error) => finish({ stage: 'spawn', error: String(error?.message ?? error) }));
    child.on('close', () => finish({ stage: 'exited', initialized: pending.size === 0 && !!timers.list }));

    const initId = send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'worker-setup', version: '1.0.0' },
    });
    pending.set('initialize', initId);
    timers.init = setTimeout(() => finish({ stage: 'initialize_timeout' }), 8_000);
  });
}

function scraplingBin(env) {
  if (env.SCRAPLING_MCP_BIN && existsSync(env.SCRAPLING_MCP_BIN)) return env.SCRAPLING_MCP_BIN;
  return existsSync(REPO_SCRAPLING_MCP) ? REPO_SCRAPLING_MCP : null;
}

async function probeScrapling(env = process.env) {
  const bin = scraplingBin(env);
  if (!bin) return { state: 'warn', detail: 'scrapling venv not found (fast check already reports this)' };
  const result = await mcpHandshake(bin, [], { cwd: path.dirname(bin) });
  if (result.stage === 'ready') return { state: 'ok', detail: `MCP handshake ok · ${result.toolCount} tools` };
  return { state: 'warn', detail: `MCP handshake failed at ${result.stage}` };
}

async function probeObscura(env = process.env) {
  const bin = env.OBSCURA_BIN && existsSync(env.OBSCURA_BIN)
    ? env.OBSCURA_BIN
    : existsSync('D:/Tools/obscura/obscura.exe') ? 'D:/Tools/obscura/obscura.exe' : null;
  if (!bin) return { state: 'warn', detail: 'obscura binary not found' };
  const result = await mcpHandshake(bin, ['mcp', '--stealth'], { timeoutMs: 15_000, listTimeoutMs: 4_000 });
  if (result.stage === 'ready') return { state: 'ok', detail: `MCP handshake ok · ${result.toolCount} tools` };
  if (result.stage === 'tools_list_timeout' || result.initialized) {
    // Known defect in obscura 0.2.2: the built-in MCP server answers initialize
    // but never answers tools/list (see D:/Tools/obscura/mcp-bridge/README.md).
    // Report it as the known defect it is, not as an unknown failure.
    return { state: 'warn', detail: 'known obscura 0.2.2 defect: MCP initialize ok but tools/list never answers', remediation: 'The pi mcp-bridge may hang on this server; use the obscura mcp-bridge workaround or upgrade obscura' };
  }
  return { state: 'warn', detail: `MCP handshake failed at ${result.stage}` };
}

async function probeLinkedin() {
  const skillDir = resolveSkillDir();
  if (!skillDir) return { state: 'warn', detail: 'research-contact skill not installed' };
  const script = path.join(skillDir, 'scripts', 'linkedin.mjs');
  if (!existsSync(script)) return { state: 'warn', detail: 'linkedin.mjs missing from the skill' };
  const run = await execCapture(process.execPath, [script, 'status'], 150_000);
  const parsed = parseJsonLoose(run.stdout);
  if (parsed?.session_valid) return { state: 'ok', detail: 'LinkedIn session is valid' };
  const hint = parsed?.hint ?? firstLine(run.stderr || run.stdout);
  return { state: 'warn', detail: hint || 'LinkedIn session is not valid', remediation: 'Run linkedin-login.cmd to re-login' };
}

function firstLine(text, limit = 240) {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.trim().slice(0, limit);
}

const DEEP_DEFS = [
  {
    id: 'broker', group: 'core', label: 'Broker reachability', requiredFor: ['*'],
    detail: 'ee-auto /api/jobs answers an authenticated request',
    run: async ({ cloudStatus }) => {
      const cloud = await cloudStatus?.get?.();
      if (!cloud) return { state: 'unknown', detail: 'cloud status is not configured' };
      return cloud.ok
        ? { state: 'ok', detail: `${cloud.counts?.pending ?? 0} pending · ${cloud.workers?.length ?? 0} workers` }
        : { state: 'warn', detail: redact(String(cloud.error ?? 'broker unreachable')) };
    },
  },
  {
    id: 'pi-process', group: 'research', label: 'Pi process check', requiredFor: ['research.'],
    detail: 'spawns pi --version (no model call)',
    run: async () => probePiVersion(),
  },
  {
    id: 'opencode-process', group: 'research', label: 'OpenCode process check', requiredFor: ['research-deep.'],
    detail: 'spawns opencode --version (no model call)',
    run: async () => probeOpencodeVersion(),
  },
  {
    id: 'scrapling-mcp-process', group: 'research', label: 'Scrapling MCP handshake', optionalFor: ['research.', 'research-deep.'],
    run: async ({ env }) => probeScrapling(env),
  },
  {
    id: 'obscura-mcp-process', group: 'research', label: 'Obscura MCP handshake', optionalFor: ['research.', 'research-deep.'],
    run: async ({ env }) => probeObscura(env),
  },
  {
    id: 'linkedin-session', group: 'research', label: 'LinkedIn session validity', optionalFor: ['research.', 'research-deep.'],
    run: async () => probeLinkedin(),
  },
];

/**
 * Run the expensive probes: real child processes, real MCP handshakes, a real
 * LinkedIn session check. Opt-in by design — never wire this into a periodic
 * refresh.
 */
export async function runDeepChecks({
  claimedTypes = [],
  env = process.env,
  cloudStatus,
  probes = {},
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const defaults = {
    broker: DEEP_DEFS[0].run,
    'pi-process': DEEP_DEFS[1].run,
    'opencode-process': DEEP_DEFS[2].run,
    'scrapling-mcp-process': DEEP_DEFS[3].run,
    'obscura-mcp-process': DEEP_DEFS[4].run,
    'linkedin-session': DEEP_DEFS[5].run,
  };
  const checks = [];
  for (const def of DEEP_DEFS) {
    const runner = probes[def.id] ?? defaults[def.id];
    let outcome;
    try {
      outcome = await runner({ env, cloudStatus }) ?? {};
    } catch (error) {
      outcome = { state: 'unknown', detail: redact(String(error?.message ?? error)) };
    }
    checks.push({
      id: def.id,
      group: def.group,
      label: def.label,
      note: def.detail,
      severity: severityFor(def, claimedTypes),
      state: outcome.state ?? 'unknown',
      detail: outcome.detail ?? '',
      remediation: outcome.remediation,
    });
  }
  return {
    ranAt: new Date(startedAt).toISOString(),
    durationMs: now() - startedAt,
    checks,
  };
}

// ------------------------------------------------------------- status provider

/**
 * The provider the dashboard consumes. `get()` is cheap and cached briefly so a
 * refresh storm cannot rescan PATH; `getWithDeep()` additionally returns the
 * deep result, running it only when there is none or the TTL has expired.
 */
export function createSetupStatus({
  lanes = [],
  env = process.env,
  cloudStatus,
  gsearchStatus,
  deepTtlMs = DEEP_TTL_MS,
  fastTtlMs = 2_000,
  probes,
  envFile = process.env.WORKER_ENV_FILE,
  resolveAgent = resolveAgentInvocation,
  resolveSkill = resolveSkillDir,
  resolveOpencode = resolveOpencodeInvocation,
  resolveDeepSkill = resolveDeepSkillDir,
  exists = existsSync,
  now = () => Date.now(),
} = {}) {
  const claimedTypes = [...new Set(lanes.flatMap((lane) => lane.types ?? []))];
  let fastCache = null;
  let fastCacheAt = 0;
  let deepCache = null;
  let deepCacheAt = 0;
  let deepInFlight = null;

  const get = () => {
    const at = now();
    if (fastCache && at - fastCacheAt < fastTtlMs) return fastCache;
    fastCache = runSetupChecks({ claimedTypes, env, gsearchStatus: gsearchStatus?.(), envFile, resolveAgent, resolveSkill, resolveOpencode, resolveDeepSkill, exists, now });
    fastCacheAt = at;
    return fastCache;
  };

  const ensureDeep = () => {
    const at = now();
    if (deepCache && at - deepCacheAt < deepTtlMs) return Promise.resolve(deepCache);
    if (deepInFlight) return deepInFlight;
    deepInFlight = runDeepChecks({ claimedTypes, env, cloudStatus, probes, now })
      .then((result) => {
        deepCache = result;
        deepCacheAt = now();
        return result;
      })
      .finally(() => { deepInFlight = null; });
    return deepInFlight;
  };

  const getWithDeep = async () => {
    const fast = get();
    const deep = await ensureDeep().catch((error) => ({
      ranAt: new Date(now()).toISOString(),
      durationMs: 0,
      checks: [],
      error: redact(String(error?.message ?? error)),
    }));
    const combined = classifyOverall([...fast.checks, ...deep.checks]);
    return { ...fast, overall: combined, deep };
  };

  return { get, getWithDeep, ensureDeep, claimedTypes };
}
