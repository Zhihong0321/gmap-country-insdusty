// The x-recon X (x.com) worker as a worker job. Runs on the mini against the ego
// lite that is already signed in to grok.com here.
//
// WHY IT CANNOT RUN IN THE CONTAINER, which is the same reason gmap.scan and fb.*
// cannot: the grok.com session is a login a human performed once, inside an ego
// lite profile on this machine. There is no token to ship. A container would meet
// a sign-in wall on the first navigation.
//
// There is a second, sharper reason here. grok.com puts an age-confirmation modal
// in the way, once per ego lite task space, and x-recon will not click it — an age
// attestation is a statement about a person, not a checkbox a job may tick. That
// gate can only ever be cleared by a human at the machine, so this job type is
// bound to a machine with a human near it by construction.
//
// WHAT IT SHELLS OUT TO. `xw` (in the gmap-recon repo, not this one) pairs the
// Claude CLI with a deterministic grok.com driver: the model picks what to ask and
// judges the answer, and `lib/grok.js` enforces the x-only contract — navigation
// allowlisted to grok.com, and a FROZEN prompt template into which the caller
// supplies only a sanitised subject string. That guard stays inside the driver
// precisely so "search x.com and nothing else" is not a hope about model
// behaviour, and this handler does not get to weaken it: everything below passes
// flags, never prompt text.
//
// WE ARE NEVER ON X. Grok reads x.com on our behalf, so no session this job opens
// is ever on a page with a Like button. What that costs is directness — Grok is a
// language model reading X, not a database of X — which is why every thread comes
// back labelled `cited` and `well_formed` rather than presented as a record.
//
// ONE BROWSER, ONE JOB AT A TIME. `xw` takes a lock for the length of a run, so
// this belongs in its own lane (see macmini.mjs): serial within itself, not queued
// behind a Maps scan or a Facebook lead.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const XW = process.env.XW_BIN ?? path.join(os.homedir(), 'project/gmap-recon/x-recon/worker/xw');
const X = process.env.X_BIN ?? path.join(os.homedir(), 'project/gmap-recon/x-recon/x');
// One Grok ask is 40-120s and the default budget is four of them, so a lead that
// works the whole ladder can run six minutes. 600s leaves room for that without
// letting a wedged browser hold the lane all afternoon. This is twice fb.*'s
// timeout for exactly that reason — do not copy 300s over from there.
const DEFAULT_TIMEOUT_MS = Number(process.env.X_TIMEOUT_MS ?? 600_000);

// A job queued with no payload arrives as `payload: null`, not `undefined`, so a
// default parameter never fires and the first property read throws. Coalesce.

/** What X is saying about a subject: a brand, person, product, event or phrase. */
export const subject = (payload, job) => runMode('subject', payload ?? {}, job);

/** A gmap-recon lead: its X account, if any, and the talk about it. */
export const company = (payload, job) => runMode('company', payload ?? {}, job);

async function runMode(mode, payload, job) {
  const args = [mode, ...leadFlags(mode, payload), ...runFlags(payload)];
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const startedAt = Date.now();
  const { code, stdout, stderr, timedOut, spawnError } = await exec(XW, args, timeoutMs);
  const ms = Date.now() - startedAt;

  if (spawnError) throw Object.assign(new Error(spawnError), { code: 'engine_error' });
  if (timedOut) {
    throw Object.assign(new Error(`xw ${mode} did not finish within ${Math.round(timeoutMs / 1000)}s`), { code: 'timeout' });
  }
  // The lock is held for the length of a run, so a second job arriving early is a
  // scheduling fact, not a fault. Naming it lets the caller retry instead of
  // reading a shell error and giving up.
  if (/holds the grok space/i.test(stderr)) {
    throw Object.assign(new Error('another x-recon run holds the grok space'), { code: 'busy' });
  }
  // Someone clicked in the grok space's window. ego lite hands them control and the
  // run aborts; that is the driver refusing to fight a human for the browser.
  if (/under your control/i.test(stderr)) {
    throw Object.assign(new Error('the grok space is under a human’s control on the mini'), { code: 'busy' });
  }
  // A modal is covering grok.com. Distinct from logged_out on purpose: the
  // session is fine, a human simply has to dismiss a dialog in that task space
  // once, and a caller that cannot tell the two apart will chase the wrong fix.
  //
  // The dialog's own text rides along now. This used to answer the fixed string
  // "grok.com is showing a consent dialog that only a human may clear" and throw
  // away what x-recon had already captured -- so on 24 Aug every VIP brief
  // reported a consent dialog, and the thing actually blocking them was a "Meet
  // Grok Bot" product announcement sitting on a healthy, signed-in session. One
  // line of evidence is the difference between walking to the mini and clicking
  // once, and hunting an auth problem that does not exist.
  if (/\[gate\]/.test(stderr) || /consent dialog/i.test(stderr)) {
    const quoted = /"([^"]{4,200})"/.exec(stderr);
    throw Object.assign(
      new Error('a dialog is covering grok.com and only a human may dismiss it'
        + (quoted ? ': "' + quoted[1] + '"' : '')),
      { code: 'gated' },
    );
  }
  if (/not signed in to grok/i.test(stderr)) {
    throw Object.assign(new Error('ego lite is not signed in to grok.com on this machine'), { code: 'logged_out' });
  }

  const record = parseJson(stdout);
  if (!record) {
    const detail = firstLine(stderr) || `xw exited ${code} with no JSON on stdout`;
    throw Object.assign(new Error(detail), { code: 'engine_error' });
  }
  // xw reports a failed lead inside its own envelope and still exits 0, so the exit
  // code alone is not the verdict.
  if (record.error) throw Object.assign(new Error(String(record.error)), { code: 'engine_error' });

  return {
    engine: 'x-recon',
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

  if (mode === 'subject') {
    if (!String(p.subject ?? '').trim()) throw new Error('x.subject needs a "subject"');
    add('--subject', p.subject);
  } else {
    const name = p.name ?? p.company;
    if (!String(name ?? '').trim()) throw new Error('x.company needs a "name"');
    add('--name', name);
    add('--city', p.city ?? p.place ?? p.location);
    add('--website', p.website);
    add('--phone', p.phone);
    add('--category', p.category);
  }

  // Both modes narrow the same way. `since` in particular is worth passing: X is a
  // firehose, and a subject with years of history returns its loudest old threads
  // unless you say otherwise.
  add('--since', p.since);
  add('--lang', p.lang);
  return flags;
}

function runFlags(p) {
  const flags = [];
  // The ask budget is the real dial here, and it buys wall clock more than money:
  // each unit is one 40-120s Grok round trip. Four is the default xw ships with.
  if (Number(p.budget) > 0) flags.push('--budget', String(Math.min(Number(p.budget), 10)));
  if (Number(p.max) > 0) flags.push('--max', String(Math.min(Number(p.max), 40)));
  if (p.model) flags.push('--model', String(p.model));
  if (p.effort) flags.push('--effort', String(p.effort));
  if (Number(p.maxUsd) > 0) flags.push('--max-usd', String(p.maxUsd));
  return flags;
}

/**
 * Is grok.com usable inside ego lite on this machine?
 *
 * The same reasoning as fb.probe: "the driver is installed" and "the driver can
 * actually ask a question" are different claims, and only the second is what a
 * caller about to route a subject here needs.
 *
 * This one has a third state the others do not. A signed-in account behind an
 * unanswered age modal reports `gated`, not `ready` and not `logged_out`, because
 * the remedy is different: nobody needs to sign in again, somebody needs to dismiss
 * a dialog in that task space. Collapsing the two would send a human to fix the
 * wrong thing.
 *
 * It runs `x status` rather than a full `xw` lead, so it costs a page load and no
 * model call and no Grok ask at all.
 */
export async function probe(payload) {
  const p = payload ?? {};
  const startedAt = Date.now();
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 120_000;
  const { stdout, stderr, timedOut, spawnError } = await exec(X, ['status'], timeoutMs);
  const ms = Date.now() - startedAt;

  if (spawnError) return { status: 'unknown', detail: spawnError, ms };
  if (timedOut) return { status: 'unknown', detail: `x status did not answer within ${Math.round(timeoutMs / 1000)}s`, ms };

  // grok.js prints the payload after a ===JSON=== marker; `x` itself relies on that
  // same marker to recover a result when the app process cannot write the file.
  const state = parseAfterMarker(stdout) ?? parseAfterMarker(stderr);
  if (!state) return { status: 'unknown', detail: firstLine(stderr) || 'could not read a state from x status', ms };
  if (!state.logged_in) {
    return { status: 'logged_out', detail: 'ego lite has no grok.com session; run `./x login` on the mini and sign in by hand', ms };
  }
  if (Array.isArray(state.blocked_by) && state.blocked_by.length) {
    return {
      status: 'gated',
      detail: `grok.com is showing a dialog only a human may clear: ${firstLine(state.blocked_by[0], 120)}`,
      account: state.account ?? null,
      ms,
    };
  }
  // The age modal appears on SEND, not on load, so a clean status is good evidence
  // and not a guarantee. Say so rather than overstating it — the first ask is the
  // real test, and a caller reading `ready` should still expect a `gated` failure
  // to be possible on a space nobody has asked a question in yet.
  return { status: 'ready', detail: 'grok.com session is live in ego lite; the age modal appears on send, so the first ask is the real test', account: state.account ?? null, ms };
}

// ------------------------------------------------------------------ plumbing

function exec(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      // launchd inherits none of a login shell's PATH, and xw needs `claude` and
      // `ego-browser` from ~/.local/bin plus `jq` from /usr/bin.
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
//   node worker/x.mjs probe
//   node worker/x.mjs subject '{"subject":"Grok 5 launch","budget":1}'
if (import.meta.filename === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  const payload = arg ? JSON.parse(arg) : {};
  const fn = { subject, company, probe }[cmd] ?? probe;
  console.log(JSON.stringify(await fn(payload), null, 2));
}
