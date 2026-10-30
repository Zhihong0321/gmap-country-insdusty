#!/usr/bin/env node
// The home worker. Runs on the Mac mini; talks only outbound.
//
// WHY THIS EXISTS. The Google Maps scan has to come from a residential IP —
// Google answers a datacenter profile with a thinner result page rather than an
// error, so a scan run in the Railway container is quietly incomplete. The mini
// is on a home line and is always on. It has no public address, so it dials the
// lab rather than the lab dialling it.
//
// THE LOOP IS THE WHOLE PROGRAM:
//
//   GET /api/jobs/next?worker=…   held open ~25s
//     204  -> ask again immediately
//     200  -> run the handler, POST the result, ask again
//     err  -> wait (backing off to 60s), ask again — never exit
//
//   POST /api/jobs/heartbeat        every 30s, but only while a job is running
//     The loop above is silent for as long as the handler takes, and a deep
//     research round takes minutes. See beat().
//
// A gmap.scan holds the loop for minutes while it runs; that is intended. One
// machine, one scan at a time, is what a residential line can do without
// looking like something other than a person.
//
// It never exits on purpose. A worker that quits on a network blip is a worker
// that is offline until someone notices, and the whole point of this machine is
// that nobody is watching it.
//
// Usage:
//   LAB_TOKEN=… node worker/macmini.mjs
// or put LAB_TOKEN in ~/.gmap-worker.env and just run it. See worker/README.md.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { scan as gmapScan } from './gmap.mjs';
import { contacts as websiteContacts } from './website-contacts.mjs';
import { countryIndustry } from './country-industry-job.mjs';
import * as chatgpt from './chatgpt-ego.mjs';
import * as agy from './agy.mjs';
import * as fb from './fb.mjs';
import * as x from './x.mjs';
import * as ads from './ads.mjs';
import * as gsearch from './gsearch.mjs';
import * as research from './research-contact.mjs';
import * as researchDeep from './research-deep.mjs';
import { createStatus } from './worker-status.mjs';
import { createCloudStatus, startDashboard } from './worker-dashboard.mjs';
import { createSetupStatus } from './worker-setup.mjs';
import { quotaCooldownMs } from './quota.mjs';

// Config from a local .env file or ~/.gmap-worker.env
const localEnv = path.resolve('.env');
const defaultEnv = fs.existsSync(localEnv) ? localEnv : path.join(os.homedir(), '.gmap-worker.env');
const ENV_FILE = process.env.WORKER_ENV_FILE ?? defaultEnv;
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.error('[worker] could not read ' + ENV_FILE + ': ' + err.message);
  }
}

const LAB = (process.env.LAB_URL ?? 'https://ee-auto.up.railway.app').replace(/\/+$/, '');
const TOKEN = (process.env.LAB_TOKEN ?? '').trim();
const NAME = (process.env.WORKER_NAME ?? os.hostname()).trim();
const WAIT_SEC = 25;
// The lab calls a worker gone after 90s without a check-in. Beating every 30s
// while a job runs gives three chances to be heard before that window closes.
const BEAT_MS = 30_000;

/**
 * LANES. One claim loop per lane, running side by side in this one process.
 *
 * A single loop was right while the only job was a scan. It stops being right
 * the moment a 15-second ChatGPT call can end up queued behind a 60-second Maps
 * scan: the caller of the first is an HTTP request somebody is waiting on, and
 * the second holds the loop for minutes by design.
 *
 * The split is by duration, not by engine. `scan` is the slow residential-line
 * work that must stay one-at-a-time — that is what a home connection can do
 * without looking like something other than a person. `ask` is everything that
 * answers in seconds. Each lane is serial within itself, which is also what
 * keeps one Chrome per profile true for ChatGPT without any lock of our own.
 *
 * Each lane checks in under its own name, so a lane that dies is visible in
 * GET /api/jobs instead of being covered for by its neighbour still polling.
 */
const LANES = (() => {
  // WORKER_TYPES collapses the whole worker back to one lane taking exactly
  // those types. It predates lanes and is kept because it is the switch that
  // pins a machine to one kind of work — the reason to reach for it now is to
  // run the wrappers on one box and the scan on another.
  const pinned = (process.env.WORKER_TYPES ?? 'country.industry').split(',').map((t) => t.trim()).filter(Boolean);
  // WORKER_SESSIONS widens a pinned worker without unpinning it. A pin is one
  // lane by definition, and that is still right for `gmap.scan`; it stopped being
  // right for `chatgpt.ask` the moment the machine had three signed-in accounts.
  // The ask job is pinned in its plist precisely so it does not inherit the scan
  // daemon's WORKER_TYPES from ~/.gmap-worker.env, so unpinning it is not an
  // option -- it has to widen in place.
  //
  // One lane per signed-in ChatGPT account, and AGY_LANES of agy's OWN beside
  // them. agy does not ride an account's lane: a lane is serial, so an agy call
  // sitting on one is an idle ChatGPT account for as long as it runs -- and an
  // agy deep-research round runs for three to five minutes while a ChatGPT audit
  // runs for twenty seconds. agy needs no session; it is a CLI, not a browser
  // profile, which is exactly why it can have lanes of its own for free.
  //
  // agy used to be pinned to the first lane alone, on the reasoning that it is
  // one CLI against one credential and three claim loops would just race the
  // same binary. That was never measured, and the single lane is what made it
  // unmeasurable: 96 agy runs in ~/.gemini/antigravity-cli/log, not one
  // concurrent pair among them. Measured on 24 Aug: three `agy -p` at once
  // answered in 7s/9s/12s against a 9s solo baseline, three correct distinct
  // answers, ~170MB RSS each on a 16GB box. There is no race. agy is a Go
  // binary spawned fresh per call, with a presence lock, a conversation
  // directory and a log file PER INSTANCE and no global lock anywhere.
  //
  // What the one lane cost: Round 04 of a company report is an agy call, and so
  // is the first act of the auto-VIP brief the same report kicks off ~30ms
  // earlier. On one lane the parent's own synthesis queues behind its child,
  // every time. Measured on report 2rO7nzyANyjYDpfOf0mQ: 306 seconds of a
  // 13m38s run spent with nothing running at all.
  //
  // Two, not three. The ceiling here is not the binary, it is that all of them
  // are one Google account -- three lanes is 3x the request rate against one
  // personal Antigravity credential, and a rate-limit refusal is a FAILED round
  // rather than a slow one. Two clears the parent/child collision, which is the
  // one that was actually costing time. Raise it with AGY_LANES if the account
  // proves it can take it.
  const sessions = (process.env.WORKER_SESSIONS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const AGY_LANES = Math.max(1, Number(process.env.AGY_LANES ?? 2));
  if (pinned.length) {
    const chatgptOnly = pinned.filter((t) => t.startsWith('chatgpt.'));
    const agyOnly = pinned.filter((t) => t.startsWith('agy.'));
    // Research work is split out even when pinned, and this is the one family
    // where leaving it on the base lane would be actively wrong: the base lane is
    // where a `gmap.scan` or a `ping` waits, a research run holds an agent for
    // minutes, and it can end in a CAPTCHA that only a human can clear. Sharing a
    // lane would let a stuck report block a job that answers in seconds.
    // `research-deep.*` (the same Skill under the OpenCode CLI) splits the same
    // way on its own lane, so a stuck run on one engine never stalls the other.
    const researchOnly = pinned.filter((t) => t.startsWith('research.'));
    const researchDeepOnly = pinned.filter((t) => t.startsWith('research-deep.'));
    // A single-purpose pin stays one lane. This is the scan daemon
    // (WORKER_TYPES=ping,gmap.scan): nothing to split, and one scan at a time is
    // the point of it.
    if (sessions.length < 2 && !agyOnly.length && !researchOnly.length && !researchDeepOnly.length) {
      return [{ suffix: '', types: pinned, session: sessions[0] }];
    }
    // Whatever the pin asked for that is neither chatgpt, agy nor research still
    // has to be claimed by somebody, or the pin silently stops serving it.
    const rest = pinned.filter(
      (t) => !chatgptOnly.includes(t) && !agyOnly.includes(t) && !researchOnly.includes(t) && !researchDeepOnly.includes(t),
    );
    const accounts = sessions.length ? sessions : [undefined];
    const lanes = accounts.map((session, i) => ({
      suffix: i === 0 ? '' : '-' + (i + 1),
      types: i === 0 ? [...chatgptOnly, ...rest] : chatgptOnly,
      session,
    }));
    for (let i = 0; agyOnly.length && i < AGY_LANES; i++) {
      lanes.push({ suffix: '-agy' + (i + 1), types: agyOnly, session: undefined });
    }
    if (researchOnly.length) {
      lanes.push({ suffix: '-research', types: researchOnly, session: undefined });
    }
    if (researchDeepOnly.length) {
      lanes.push({ suffix: '-opencode', types: researchDeepOnly, session: undefined });
    }
    return lanes.filter((l) => l.types.length);
  }
  return [
    { suffix: '', types: ['ping', 'gmap.scan'] },
    // Three ChatGPT lanes, one per signed-in account, because that is what the
    // machine actually has: Profile 3 (Zhihong PRO), Profile 2 (三专) and
    // Profile 5 (gan gemini) are three separate ChatGPT logins in three separate
    // ego lite task spaces. One lane meant Round 02's three audit calls queued
    // behind each other on one account while the other two sat idle.
    //
    // `session` is the lane's identity, not the job's: nothing upstream knows or
    // should know which account answers, so the lane supplies it when the payload
    // does not. A job that names its own `id` still wins -- that is how a caller
    // pins a specific account on purpose.
    //
    { suffix: '-ask', types: ['chatgpt.ask', 'chatgpt.probe'], session: 'mini-main' },
    { suffix: '-ask2', types: ['chatgpt.ask', 'chatgpt.probe'], session: 'mini-2' },
    { suffix: '-ask3', types: ['chatgpt.ask', 'chatgpt.probe'], session: 'mini-3' },
    // agy's own, AGY_LANES of them, for the reasons written out at the top of
    // this block. Two by default: enough that a report's own Round 04 never
    // queues behind the VIP brief it just started, not so many that one Google
    // account is answering three deep-research calls at once. Separate from the
    // ChatGPT lanes so a five-minute agy round never idles a ChatGPT account.
    ...Array.from({ length: AGY_LANES }, (_, i) => ({
      suffix: '-agy' + (i + 1), types: ['agy.ask', 'agy.probe'],
    })),
    // Its own lane for the same reason `-ask` is not the scan lane, one step
    // further out: a lead takes 1-2 minutes of paced page loads, so it would sit
    // in front of every wrapper call if it shared theirs -- and it holds ego
    // lite's single crawl space for that whole time, which the scan lane's
    // Chrome does not care about but a `chatgpt.ask` in the same process would.
    { suffix: '-fb', types: ['fb.company', 'fb.person', 'fb.discover', 'fb.probe'] },
    // Its own lane again, and for a stronger version of the fb reason: one Grok
    // ask is 40-120s and a lead may spend four of them, so an x.* job can hold a
    // lane for six minutes. It drives a DIFFERENT ego lite task space from fb.*
    // ("grok x-search" vs the crawl space), so the two do not contend for a
    // browser and can be in flight at once.
    { suffix: '-x', types: ['x.subject', 'x.company', 'x.probe'] },
    // Its own lane, hardest case of all: Google's transparency centre costs one
    // page load PER AD, so a 30-ad advertiser is 4-6 minutes of paced loads with
    // ego lite's ads crawl space held throughout. It uses a THIRD task space
    // ("ads-recon"), distinct from fb.*'s crawl space and x.*'s grok space, so
    // all three can be in flight without contending for a browser.
    // ads.market shares this lane rather than getting its own, and that is
    // deliberate: both hold the SAME "ads-recon" task space in ego lite, and
    // ads-recon serialises on runs/.lock anyway. A second lane would only produce
    // two jobs discovering they cannot both have the browser.
    { suffix: '-ads', types: ['ads.company', 'ads.market', 'ads.probe'] },
    // Google search through the gsearch Chrome extension. Its own lane because
    // gsearch.mjs paces queries seconds apart and may wait minutes on a CAPTCHA
    // a human has to solve -- neither should hold up anyone else's work.
    { suffix: '-gs', types: ['gsearch.search', 'gsearch.probe'] },
    // Contact research via the research-contact Agent Skill. Its own lane for the
    // reasons the fb.* and x.* lanes have theirs, plus one more: a full run drives
    // an agent that may itself call the gsearch bridge AND the LinkedIn channel,
    // so it is both minutes long and a consumer of two other lanes' resources. A
    // run bouncing off a CAPTCHA or an expired login also stops for a human, which
    // must never stall a lane that answers in seconds.
    { suffix: '-research', types: ['research.contact', 'research.probe'] },
    // Second research lane: the same Skill driven by the OpenCode CLI against
    // the scrapling-deep checkout instead of Pi (see research-deep.mjs). Its own
    // `-opencode` worker-name suffix so every job result shows which engine did
    // the work (Pi vs OpenCode) for quality benchmarking; both share the
    // gsearch bridge (which serialises searches itself) and the LinkedIn channel.
    { suffix: '-opencode', types: ['research-deep.contact', 'research-deep.probe'] },
  ];
})();

if (!TOKEN) {
  console.error('LAB_TOKEN is not set. Put it in ' + ENV_FILE + ' as LAB_TOKEN=… or pass it in the environment.');
  process.exit(1);
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (msg) => console.log('[' + stamp() + '] ' + msg);

const auth = { authorization: 'Bearer ' + TOKEN };
const jsonHeaders = { ...auth, 'content-type': 'application/json' };
const status = createStatus({ name: NAME, lab: LAB, lanes: LANES, secrets: [TOKEN] });
const quotaCooldowns = new Map();
const groupFor = (name, types) => types.some((type) => type.startsWith('agy.')) ? NAME + ':agy' : name;
function rememberQuota(group, until, reason = 'Individual quota reached') {
  const parsed = Date.parse(String(until));
  if (!Number.isFinite(parsed) || parsed <= Date.now()) return;
  const deadline = Math.max(quotaCooldowns.get(group)?.until ?? 0, parsed);
  quotaCooldowns.set(group, { until: deadline, reason });
  for (const lane of LANES) {
    const name = NAME + lane.suffix;
    if (groupFor(name, lane.types) === group) status.laneCooldown(name, { until: deadline, reason });
  }
}
const cloudStatus = createCloudStatus({ lab: LAB, token: TOKEN, workerName: NAME });
// The setup checklist the dashboard's /setup page serves. Fast layer only when
// polled; the deep layer (real MCP handshakes, a LinkedIn session probe) runs
// strictly behind the page's explicit button, cached with a TTL.
const setupStatus = createSetupStatus({ lanes: LANES, cloudStatus, gsearchStatus: () => gsearch.status() });

// ------------------------------------------------------------------ handlers

/**
 * The proof job, and the reason Phase 1 exists.
 *
 * `publicIp` is the field that matters: it is what the internet sees when THIS
 * machine makes a request. If it is the home line, the scan will be served the
 * full result page. If it ever comes back as a Railway address, the job ran in
 * the container and the entire premise is gone — so it is reported, never
 * assumed, and a failure to determine it is recorded rather than swallowed.
 */
async function ping(payload) {
  let publicIp = null;
  let publicIpError = null;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error('ipify answered ' + r.status);
    publicIp = (await r.json()).ip ?? null;
  } catch (err) {
    publicIpError = err.message;
  }
  return {
    hostname: os.hostname(),
    platform: os.platform() + ' ' + os.release() + ' ' + os.arch(),
    node: process.version,
    uptimeSec: Math.round(os.uptime()),
    publicIp,
    publicIpError,
    echo: payload ?? null,
    at: new Date().toISOString(),
  };
}

const handlers = {
  ping,
  'gmap.scan': gmapScan,
  'website.contacts': websiteContacts,
  'country.industry': countryIndustry,
  // The wrappers this machine now runs alongside the cloud's. Different account
  // for ChatGPT, and the agy that is already signed in here — so these are a
  // second lane rather than a copy of the container's one.
  'chatgpt.ask': chatgpt.ask,
  'chatgpt.probe': chatgpt.probe,
  // No `meta.*` / `muse.*` here any more. Meta AI was never activated on this
  // machine (no ego lite profile ever held a meta.ai cookie), and the muse 1.2
  // stand-in that answered under those names is retired. A lane that no longer
  // claims a type is how the gateway learns it is gone: `meta@mini` stops being
  // listed `ready` in GET /v1/models and a pinned call 503s up front instead of
  // queueing a job nothing will ever take.
  'agy.ask': agy.ask,
  'agy.probe': agy.probe,
  // Facebook lead enrichment through fb-recon: the Claude CLI picks which rung
  // of the search ladder to try, a read-only crawler drives ego lite. Same
  // reason as gmap.scan for living here -- the Facebook session is a login a
  // human performed once in a profile on this machine, not a token to ship.
  'fb.company': fb.company,
  'fb.person': fb.person,
  'fb.discover': fb.discover,
  'fb.probe': fb.probe,
  // X research through x-recon: the Claude CLI decides what to ask Grok and how
  // much of the answer to believe, a grok.com driver does the asking. Lives here
  // for the gmap.scan reason plus one of its own -- grok.com's age modal can only
  // ever be dismissed by a human at the machine, so this work is bound to a box
  // with a person near it.
  'x.subject': x.subject,
  'x.company': x.company,
  'x.probe': x.probe,
  // Competitor ads through ads-recon. No model is on its path at all -- it is a
  // deterministic crawl of two public ad libraries -- so it is the one handler
  // here that cannot be broken by a dead key. It returns its creatives inline as
  // data URIs because the images are files on this disk and the gateway has no
  // blob store; see ads.mjs for why that is the only route.
  'ads.company': ads.company,
  // Keyword market research. Talks to the Ad Library's own GraphQL pagination
  // instead of scraping the rendered grid, so it returns hundreds of ads in the
  // time ads.company takes for a few dozen -- and returns no creatives at all,
  // because 500 data URIs fit in neither a job result nor a Postgres row.
  'ads.market': ads.market,
  'ads.probe': ads.probe,
  // Google search via the extension in this machine's own Chrome. See gsearch.mjs.
  'gsearch.search': gsearch.search,
  'gsearch.probe': gsearch.probe,
  // Agent-backed public contact research. See research-contact.mjs; the handler
  // owns payload validation and the JSON result contract, while the Skill owns
  // the fetch/search/LinkedIn escalation policy.
  'research.contact': research.contact,
  'research.probe': research.probe,
  // Same Skill and contract, different driver: the OpenCode CLI against the
  // scrapling-deep checkout. See research-deep.mjs.
  'research-deep.contact': researchDeep.contact,
  'research-deep.probe': researchDeep.probe,
};

// ---------------------------------------------------------------- the client

async function claim(name, types, group) {
  const q = new URLSearchParams({ worker: name, wait: String(WAIT_SEC) });
  if (types.length) q.set('types', types.join(','));
  q.set('cooldownGroup', group);
  // Above the server's own 25s ceiling: the server is expected to answer 204
  // first, so a timeout here means the network ate it, not that it was idle.
  const r = await fetch(LAB + '/api/jobs/next?' + q, {
    headers: auth,
    signal: AbortSignal.timeout((WAIT_SEC + 15) * 1000),
  });
  // A bad token will never fix itself by retrying, and a loop that retries it
  // forever looks exactly like a worker that is running fine.
  if (r.status === 401) throw Object.assign(new Error('401 — LAB_TOKEN is wrong or was rotated'), { fatal: true });
  if (r.status === 204) {
    const until = r.headers.get('x-worker-cooldown-until');
    if (until) rememberQuota(group, until);
    return null;
  }
  if (!r.ok) throw new Error('/api/jobs/next answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return (await r.json()).job ?? null;
}

async function report(name, id, ok, result, error, quotaMs = null) {
  const r = await fetch(LAB + '/api/jobs/' + id + '/result', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ worker: name, ok, result, error,
      ...(quotaMs ? { errorCode: 'quota_reached', retryAfterMs: quotaMs } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error('posting the result answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

/**
 * Say "still here" while this lane is busy.
 *
 * The claim loop is the check-in, and the claim loop does not come back around
 * until the job in hand is finished. That is fine for a job measured in seconds
 * and wrong for one measured in minutes: the lab drops a worker from its live
 * table after 90s of silence, so a lane grinding through a 149s `agy.ask` goes
 * missing halfway through, and the gateway starts refusing every engine this
 * machine serves — instantly failing a second research run that was never given
 * a chance to queue. The beat only runs while a job does; an idle lane is
 * already checking in ~every 25s through its long poll.
 *
 * A missed beat is not worth a line in the log or a failed job: the next one is
 * 30s away and the window is 90s. A lab too old to know the route answers 404,
 * which is also nothing to say about — this file and the lab deploy separately.
 */
async function checkIn(name, types, group, jobId = null) {
  status.heartbeat(name);
  const quota = quotaCooldowns.get(group);
  const r = await fetch(LAB + '/api/jobs/heartbeat', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ worker: name, types, cooldownGroup: group, ...(jobId ? { jobId } : {}),
      ...(quota?.until > Date.now() ? {
        cooldownUntil: new Date(quota.until).toISOString(), cooldownReason: quota.reason,
      } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error('heartbeat answered ' + r.status);
}

function beat(name, types, group, jobId = null) {
  const timer = setInterval(() => {
    checkIn(name, types, group, jobId).catch(() => {});
  }, BEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Failure codes a handler throws to mean "the world is in a known state a human
 * or a caller can act on", as opposed to "this code is broken".
 *
 * These travel to the gateway as `<code>: <message>` rather than as a stack,
 * because the gateway has no structured channel — the string is the whole
 * message, so the first token has to be the thing a reader routes on. The
 * research.* handlers add bad_request, not_installed and needs_human;
 * the latter covers a Google CAPTCHA, a closed Chrome/gsearch extension and an
 * expired LinkedIn session, which share a remedy ("a human, at this machine")
 * and nothing else.
 */
const OPERATIONAL_CODES = new Set([
  'logged_out',
  'timeout',
  'print_mode_timeout',
  'bad_request',
  'not_installed',
  'needs_human',
  'busy',
  'gated',
  'quota_reached',
]);

/**
 * Run one job and say how it went.
 *
 * Returns `{ ok, durationMs, error }` so the lane can count the job without
 * re-reading the log. `ok` means the handler returned AND the result reached
 * the lab — a job whose result never posted is a job the caller never got.
 */
async function run(name, job, session, group) {
  const handler = handlers[job.type];
  const at = Date.now();
  if (!handler) {
    // Not a crash: an unknown type means this worker is older than whatever
    // queued the job. Saying so beats leaving it to expire as a silent timeout.
    status.jobUnknown(name, job.type);
    say('job ' + job.id + ' type=' + job.type + ' — no handler on this worker');
    await report(name, job.id, false, null, 'no handler for type "' + job.type + '" on worker ' + name);
    return { ok: false, durationMs: Date.now() - at, error: 'no handler for type "' + job.type + '"' };
  }
  say('job ' + job.id + ' type=' + job.type + ' — running');
  try {
    // The lane's session is a default, never an override: a payload that names an
    // `id` has chosen its account deliberately.
    const payload = session && job.type.startsWith('chatgpt.')
      ? { ...(job.payload ?? {}), id: job.payload?.id ?? session }
      : job.payload;
    let progressPending = Promise.resolve();
    let progressLastAt = 0, progressPhase = '';
    const onProgress = job.type === 'country.industry' ? progress => {
      const now = Date.now();
      if (progress.phase === progressPhase && now - progressLastAt < 1000 && progress.completed !== progress.total) return;
      progressLastAt = now; progressPhase = progress.phase;
      progressPending = progressPending.then(async () => {
        const r = await fetch(LAB + '/api/jobs/' + job.id + '/progress', {method:'POST',headers:jsonHeaders,body:JSON.stringify({worker:name,progress}),signal:AbortSignal.timeout(10_000)});
        if (!r.ok) throw new Error('progress answered '+r.status);
      }).catch(() => {});
    } : undefined;
    const result = await handler(payload, job, {onProgress});
    if (onProgress) await progressPending;
    await report(name, job.id, true, result, null, job.type === 'gmap.scan' ? result?.retryAfterMs : null);
    // A scan that ran fine but did not persist is the one failure that is
    // invisible from here: the caller gets its rows and the job says done. The
    // usual cause is the pg-proxy token having expired overnight, so it is
    // named in the log rather than left inside the result JSON nobody reads.
    if (result?.saveError) {
      status.event('warn', name + ': job ' + job.id + ' ran but did NOT save — ' + result.saveError);
      say('job ' + job.id + ' ran but did NOT save: ' + result.saveError);
    }
    const durationMs = Date.now() - at;
    say('job ' + job.id + ' done in ' + durationMs + 'ms');
    return { ok: true, durationMs, error: null };
  } catch (err) {
    // The handler failing must not take the loop down with it. Report and carry on.
    say('job ' + job.id + ' FAILED after ' + (Date.now() - at) + 'ms: ' + err.message);
    // A wrapper that is merely signed out must say so in a form the gateway can
    // read, not as a stack trace: it is the difference between "fix this login"
    // and "this machine is broken". `engine_error` is deliberately not in
    // OPERATIONAL_CODES — that one means the handler itself is broken, and its
    // stack is the only useful thing anyone downstream will ever see.
    const detail = OPERATIONAL_CODES.has(err.code)
      ? err.code + ': ' + err.message
      : (err.stack?.slice(0, 2000) ?? String(err));
    // `error` is a plain string all the way to the gateway -- there is no
    // structured channel -- so evidence that is not in this string does not
    // exist downstream. err.meta carries the run directory the engine wrote its
    // transcript to; append it rather than lose it at the last hop.
    const evidence = err.meta ? ' | evidence: ' + JSON.stringify(err.meta).slice(0, 600) : '';
    const failure = detail + evidence;
    const quotaMs = err.code === 'quota_reached' ? err.retryAfterMs : quotaCooldownMs(failure);
    if (Number.isFinite(quotaMs) && quotaMs > 0) {
      const until = new Date(Date.now() + quotaMs).toISOString();
      rememberQuota(group, until);
      say('[' + name + '] quota reached — waiting until ' + until);
    }
    const response = await report(name, job.id, false, null, failure, quotaMs).catch((e) =>
      say('could not even report the failure: ' + e.message),
    );
    if (response?.cooldownUntil) rememberQuota(group, response.cooldownUntil);
    return { ok: false, durationMs: Date.now() - at, error: failure };
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    say('stopping on ' + sig + ' after active jobs finish');
    // Do not exit while a handler owns a Pi child. Each lane finishes and
    // reports its current job, then the claim loop observes `stopping`.
  });
}

const DEFAULT_CGPT_COOLDOWN_MIN = 2500;
const DEFAULT_CGPT_COOLDOWN_MAX = 4500;
const DEFAULT_AGY_COOLDOWN_MIN = 1500;
const DEFAULT_AGY_COOLDOWN_MAX = 2500;

function calculateCooldown(type) {
  if (process.env.WORKER_COOLDOWN_MS !== undefined) {
    const override = Number(process.env.WORKER_COOLDOWN_MS);
    return Number.isFinite(override) && override >= 0 ? override : 0;
  }
  if (typeof type === 'string') {
    if (type.startsWith('chatgpt.')) {
      return DEFAULT_CGPT_COOLDOWN_MIN + Math.floor(Math.random() * (DEFAULT_CGPT_COOLDOWN_MAX - DEFAULT_CGPT_COOLDOWN_MIN));
    }
    if (type.startsWith('agy.')) {
      return DEFAULT_AGY_COOLDOWN_MIN + Math.floor(Math.random() * (DEFAULT_AGY_COOLDOWN_MAX - DEFAULT_AGY_COOLDOWN_MIN));
    }
  }
  return 0;
}

/**
 * One lane's claim loop. Never exits on purpose: a worker that quits on a
 * network blip is a worker that is offline until someone notices, and the whole
 * point of this machine is that nobody is watching it.
 *
 * The backoff is per lane. A lane whose engine is sick should not slow the one
 * beside it that is fine.
 */
async function lane(name, types, session) {
  say('lane "' + name + '" -> ' + LAB + ' (' + types.join(', ') + ')' + (session ? ' as ' + session : ''));
  const group = groupFor(name, types);
  let backoff = 0;
  let currentJob = null;
  let currentStartedAt = 0;
  while (!stopping) {
    try {
      const quota = quotaCooldowns.get(group);
      if (quota?.until > Date.now()) {
        status.laneCooldown(name, { until: quota.until, reason: quota.reason });
        await checkIn(name, types, group).catch((err) =>
          say('[' + name + '] quota check-in failed: ' + err.message));
        await new Promise((r) => setTimeout(r, Math.min(BEAT_MS, quota.until - Date.now())));
        continue;
      }
      if (quota) quotaCooldowns.delete(group);
      status.lanePolling(name);
      const job = await claim(name, types, group);
      backoff = 0;
      if (!job) {
        if (quotaCooldowns.get(group)?.until > Date.now()) status.laneCooldown(name, { until: quotaCooldowns.get(group).until });
        else status.laneIdle(name);
        continue;
      }

      currentJob = job;
      currentStartedAt = Date.now();
      status.jobStart(name, job);
      const stop = beat(name, types, group, job.type === 'country.industry' ? job.id : null);
      try {
        const outcome = await run(name, job, session, group);
        status.jobDone(name, {
          id: job.id,
          type: job.type,
          ok: outcome.ok,
          durationMs: outcome.durationMs,
          error: outcome.error,
        });
        if (quotaCooldowns.get(group)?.until > Date.now()) {
          status.laneCooldown(name, { until: quotaCooldowns.get(group).until });
        }
      } finally {
        stop();
      }
      currentJob = null;
      // Human cooldown jitter between jobs to avoid machine-burst detection.
      // A real user doesn't open temporary chats or send CLI queries 2ms after finishing one.
      const cooldown = calculateCooldown(job.type);
      if (cooldown > 0 && !stopping) {
        await new Promise((r) => setTimeout(r, cooldown));
      }
    } catch (err) {
      if (currentJob) {
        status.jobDone(name, {
          id: currentJob.id,
          type: currentJob.type,
          ok: false,
          durationMs: Date.now() - currentStartedAt,
          error: err.message,
        });
        currentJob = null;
      }
      if (err.fatal) {
        status.laneStopped(name, err.message);
        say('FATAL: ' + err.message);
        process.exit(1);
      }
      backoff = Math.min(backoff ? backoff * 2 : 5_000, 60_000);
      status.laneBackoff(name, { error: err.message, retryMs: backoff });
      say('[' + name + '] poll failed (' + err.message + ') — retrying in ' + backoff / 1000 + 's');
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

say('worker "' + NAME + '" -> ' + LAB);
// The loopback listener the gsearch extension dials into, also serving
// POST /search to local callers. In this process, not a second server.
if (process.env.GSEARCH_DISABLE !== '1') gsearch.start();
// The read-only dashboard. Loopback-only like the gsearch listener, and
// deliberately non-fatal: a dashboard that cannot bind its port must never be
// the reason a worker stops claiming jobs.
if (process.env.WORKER_DASHBOARD_DISABLE !== '1') {
  try {
    const dashboard = await startDashboard({
      getStatus: () => status.snapshot(),
      cloudStatus,
      gsearchStatus: () => gsearch.status(),
      setupStatus,
      log: (msg) => say('[dashboard] ' + msg),
    });
    say('dashboard on ' + dashboard.url + ' (loopback only)');
  } catch (err) {
    say('[dashboard] listener failed — ' + err.message + ' (dashboard disabled in this process)');
  }
}
// Promise.all rather than await in sequence: the lanes are the concurrency. If
// one ever settles the process should end, which is what a rejection here does.
await Promise.all(LANES.map((l) => lane(NAME + l.suffix, l.types, l.session)));
