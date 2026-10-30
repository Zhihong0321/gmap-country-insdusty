// The fb-recon Facebook worker as a worker job. Runs on the mini against the
// ego lite that is already signed in to Facebook here.
//
// WHY IT CANNOT RUN IN THE CONTAINER, which is the same reason gmap.scan cannot:
// the Facebook session is a login a human performed once, inside an ego lite
// profile on this machine. There is no token to ship. A container would meet a
// login wall on the first navigation, and `fb status` says so rather than
// returning thin results — so unlike Maps, this one fails loudly.
//
// WHAT IT SHELLS OUT TO. `fbw` (in the gmap-recon repo, not this one) pairs the
// Claude CLI with a deterministic read-only crawler: the model picks which rung
// of a search ladder to try and when to stop, and `lib/crawl.js` enforces
// read-only — URL allowlist, click whitelist, never types into a field. That
// guard stays inside the crawler precisely so it is not a hope about model
// behaviour, and this handler does not get to weaken it. It passes a lead in and
// reads a JSON record out.
//
// ONE BROWSER, ONE JOB AT A TIME. ego lite has a single crawl space and `fbw`
// takes a lock for the length of a run. That is why this belongs in its own lane
// (see macmini.mjs): serial within itself, not queued behind a Maps scan.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const FBW = process.env.FBW_BIN ?? path.join(os.homedir(), 'project/gmap-recon/fb-recon/worker/fbw');
const FB = process.env.FB_BIN ?? path.join(os.homedir(), 'project/gmap-recon/fb-recon/fb');
// A company lookup lands in ~60s and a discover run in ~100s, both dominated by
// page loads the crawler deliberately paces. 300s leaves room for the slow tail
// without letting a wedged browser hold the lane all afternoon.
const DEFAULT_TIMEOUT_MS = Number(process.env.FB_TIMEOUT_MS ?? 300_000);

const LOGIN_WALL = /login wall|not logged in|logged_in"?\s*:\s*false/i;

// A job queued with no payload arrives as `payload: null`, not `undefined`, so a
// default parameter never fires and the first property read throws. Coalesce.
/** Find the business's own Facebook Page or Place. */
export const company = (payload, job) => runMode('company', payload ?? {}, job);

/** Given a person's name AND their company, find that person's profile. */
export const person = (payload, job) => runMode('person', payload ?? {}, job);

/** Given only a company, find named humans publicly attached to it. */
export const discover = (payload, job) => runMode('discover', payload ?? {}, job);

async function runMode(mode, payload, job) {
  const args = [mode, ...leadFlags(mode, payload), ...runFlags(payload)];
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const startedAt = Date.now();
  const { code, stdout, stderr, timedOut, spawnError } = await exec(FBW, args, timeoutMs);
  const ms = Date.now() - startedAt;

  if (spawnError) throw Object.assign(new Error(spawnError), { code: 'engine_error' });
  if (timedOut) {
    throw Object.assign(new Error(`fbw ${mode} did not finish within ${Math.round(timeoutMs / 1000)}s`), { code: 'timeout' });
  }
  // The lock is held for the length of a run, so a second job arriving early is
  // a scheduling fact, not a fault. Naming it lets the caller retry instead of
  // reading a shell error and giving up.
  if (/holds the browser lock/i.test(stderr)) {
    throw Object.assign(new Error('another fb-recon run holds the browser lock'), { code: 'busy' });
  }
  // Someone clicked in the crawl space's window. ego lite hands them control and
  // the run aborts; that is the crawler refusing to fight a human for the browser.
  if (/under your control/i.test(stderr)) {
    throw Object.assign(new Error('the crawl space is under a human’s control on the mini'), { code: 'busy' });
  }
  if (LOGIN_WALL.test(stderr)) {
    throw Object.assign(new Error('ego lite is not signed in to Facebook on this machine'), { code: 'logged_out' });
  }

  const record = parseJson(stdout);
  if (!record) {
    const detail = firstLine(stderr) || `fbw exited ${code} with no JSON on stdout`;
    throw Object.assign(new Error(detail), {
      code: 'engine_error',
      meta: { exit_code: code, stdout_head: String(stdout).slice(0, 800), stderr_head: String(stderr).slice(0, 800) },
    });
  }
  // fbw reports a failed lead inside its own envelope and still exits 0, so the
  // exit code alone is not the verdict.
  // The envelope carries meta.run_dir -- the folder holding claude.json, the
  // crawl log and every tool call the engine made. Dropping it here is what
  // turned "403: your organization has disabled Claude subscription access",
  // written to disk in 416ms, into the bare string "claude exited 1" on screen.
  // The pointer rides the error so the round record can name the evidence.
  if (record.error) throw Object.assign(new Error(String(record.error)), { code: 'engine_error', meta: record.meta ?? null });

  return {
    engine: 'fb-recon',
    mode,
    lead: record.lead ?? null,
    result: record.result ?? null,
    meta: { ...(record.meta ?? {}), ms },
    at: new Date().toISOString(),
    ...(job?.id ? { jobId: job.id } : {}),
  };
}

function leadFlags(mode, p) {
  const flags = [];
  const add = (flag, value) => {
    const v = value == null ? '' : String(value).trim();
    if (v) flags.push(flag, v);
  };

  if (mode === 'person') {
    if (!String(p.person ?? '').trim()) throw new Error('fb.person needs a "person" name');
    add('--person', p.person);
    // `company` is the field name a caller reaches for; fbw takes it as --company.
    add('--company', p.company ?? p.name);
  } else {
    const name = p.name ?? p.company;
    if (!String(name ?? '').trim()) throw new Error(`fb.${mode} needs a "name"`);
    add('--name', name);
  }

  add('--city', p.city ?? p.place ?? p.location);
  add('--address', p.address);
  add('--phone', p.phone);
  add('--website', p.website);
  add('--category', p.category);
  return flags;
}

function runFlags(p) {
  const flags = [];
  // The crawl-call budget is the real cost dial: each unit is one page load and
  // one round of model context. Ten is the default fbw ships with.
  if (Number(p.budget) > 0) flags.push('--budget', String(Math.min(Number(p.budget), 25)));
  if (p.model) flags.push('--model', String(p.model));
  if (p.effort) flags.push('--effort', String(p.effort));
  if (Number(p.maxUsd) > 0) flags.push('--max-usd', String(p.maxUsd));
  return flags;
}

/**
 * Is Facebook still signed in inside ego lite on this machine?
 *
 * The same reasoning as agy.probe: "the crawler is installed" and "the crawler
 * has a session" are different claims, and only the second one is what a caller
 * about to route a lead here needs. This drives a real navigation to
 * facebook.com — there is nothing cheaper that is honest.
 *
 * It runs `fb status` rather than a full `fbw` lead, so it costs a page load and
 * no model call at all.
 */
export async function probe(payload) {
  const p = payload ?? {};
  const startedAt = Date.now();
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 120_000;
  const { stdout, stderr, timedOut, spawnError } = await exec(FB, ['status'], timeoutMs);
  const ms = Date.now() - startedAt;

  if (spawnError) return { status: 'unknown', detail: spawnError, ms };
  if (timedOut) return { status: 'unknown', detail: `fb status did not answer within ${Math.round(timeoutMs / 1000)}s`, ms };

  // crawl.js prints the payload after a ===JSON=== marker; `fb` itself relies on
  // that same marker to recover a result when the app process cannot write the file.
  const state = parseAfterMarker(stdout) ?? parseAfterMarker(stderr);
  if (!state) return { status: 'unknown', detail: firstLine(stderr) || 'could not read a login state from fb status', ms };
  if (state.login_wall || !state.logged_in) {
    return { status: 'logged_out', detail: 'ego lite has no Facebook session; run `./fb login` on the mini and sign in by hand', ms };
  }
  return { status: 'ready', detail: 'Facebook session is live in ego lite', ms };
}

// ------------------------------------------------------------------ plumbing

function exec(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      // launchd inherits none of a login shell's PATH, and fbw needs `claude`
      // and `ego-browser` from ~/.local/bin plus `jq` from /usr/bin.
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local/bin')}:${process.env.PATH ?? ''}:/usr/bin:/bin` },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr, timedOut, spawnError: `could not run ${bin}: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

function parseJson(text) {
  const t = String(text).trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  // Fall back to the outermost brace pair, in case anything shared stdout.
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function parseAfterMarker(text) {
  const i = String(text).indexOf('===JSON===');
  if (i < 0) return parseJson(text);
  return parseJson(String(text).slice(i + '===JSON==='.length));
}

function firstLine(text, limit = 300) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) ?? String(text);
  return line.length > limit ? `${line.slice(0, limit)}...` : line.trim();
}

// Standalone, so this can be proven on the mini before anything routes to it:
//   node worker/fb.mjs probe
//   node worker/fb.mjs company '{"name":"Masbina Technology","city":"Johor Bahru"}'
if (import.meta.filename === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  const payload = arg ? JSON.parse(arg) : {};
  const fn = { company, person, discover, probe }[cmd] ?? probe;
  console.log(JSON.stringify(await fn(payload), null, 2));
}
