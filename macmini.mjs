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
import * as chatgpt from './chatgpt-ego.mjs';
import * as agy from './agy.mjs';
import * as fb from './fb.mjs';
import * as x from './x.mjs';
import * as ads from './ads.mjs';

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
  const pinned = (process.env.WORKER_TYPES ?? '').split(',').map((t) => t.trim()).filter(Boolean);
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
    // A single-purpose pin stays one lane. This is the scan daemon
    // (WORKER_TYPES=ping,gmap.scan): nothing to split, and one scan at a time is
    // the point of it.
    if (sessions.length < 2 && !agyOnly.length) return [{ suffix: '', types: pinned, session: sessions[0] }];
    // Whatever the pin asked for that is neither chatgpt nor agy still has to be
    // claimed by somebody, or the pin silently stops serving it.
    const rest = pinned.filter((t) => !chatgptOnly.includes(t) && !agyOnly.includes(t));
    const accounts = sessions.length ? sessions : [undefined];
    const lanes = accounts.map((session, i) => ({
      suffix: i === 0 ? '' : '-' + (i + 1),
      types: i === 0 ? [...chatgptOnly, ...rest] : chatgptOnly,
      session,
    }));
    for (let i = 0; agyOnly.length && i < AGY_LANES; i++) {
      lanes.push({ suffix: '-agy' + (i + 1), types: agyOnly, session: undefined });
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
};

// ---------------------------------------------------------------- the client

async function claim(name, types) {
  const q = new URLSearchParams({ worker: name, wait: String(WAIT_SEC) });
  if (types.length) q.set('types', types.join(','));
  // Above the server's own 25s ceiling: the server is expected to answer 204
  // first, so a timeout here means the network ate it, not that it was idle.
  const r = await fetch(LAB + '/api/jobs/next?' + q, {
    headers: auth,
    signal: AbortSignal.timeout((WAIT_SEC + 15) * 1000),
  });
  // A bad token will never fix itself by retrying, and a loop that retries it
  // forever looks exactly like a worker that is running fine.
  if (r.status === 401) throw Object.assign(new Error('401 — LAB_TOKEN is wrong or was rotated'), { fatal: true });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error('/api/jobs/next answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return (await r.json()).job ?? null;
}

async function report(name, id, ok, result, error, retryAfterMs = null) {
  const r = await fetch(LAB + '/api/jobs/' + id + '/result', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ worker: name, ok, result, error, ...(retryAfterMs ? {retryAfterMs} : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error('posting the result answered ' + r.status + ': ' + (await r.text()).slice(0, 200));
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
function beat(name, types) {
  const timer = setInterval(() => {
    fetch(LAB + '/api/jobs/heartbeat', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ worker: name, types }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }, BEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function run(name, job, session) {
  const handler = handlers[job.type];
  const at = Date.now();
  if (!handler) {
    // Not a crash: an unknown type means this worker is older than whatever
    // queued the job. Saying so beats leaving it to expire as a silent timeout.
    say('job ' + job.id + ' type=' + job.type + ' — no handler on this worker');
    await report(name, job.id, false, null, 'no handler for type "' + job.type + '" on worker ' + name);
    return;
  }
  say('job ' + job.id + ' type=' + job.type + ' — running');
  try {
    // The lane's session is a default, never an override: a payload that names an
    // `id` has chosen its account deliberately.
    const payload = session && job.type.startsWith('chatgpt.')
      ? { ...(job.payload ?? {}), id: job.payload?.id ?? session }
      : job.payload;
    const result = await handler(payload, job);
    await report(name, job.id, true, result, null, job.type === 'gmap.scan' ? result?.retryAfterMs : null);
    // A scan that ran fine but did not persist is the one failure that is
    // invisible from here: the caller gets its rows and the job says done. The
    // usual cause is the pg-proxy token having expired overnight, so it is
    // named in the log rather than left inside the result JSON nobody reads.
    if (result?.saveError) say('job ' + job.id + ' ran but did NOT save: ' + result.saveError);
    say('job ' + job.id + ' done in ' + (Date.now() - at) + 'ms');
  } catch (err) {
    // The handler failing must not take the loop down with it. Report and carry on.
    say('job ' + job.id + ' FAILED after ' + (Date.now() - at) + 'ms: ' + err.message);
    // A wrapper that is merely signed out must say so in a form the gateway can
    // read, not as a stack trace: it is the difference between "fix this login"
    // and "this machine is broken".
    const detail = err.code === 'logged_out' || err.code === 'timeout' || err.code === 'print_mode_timeout'
      ? err.code + ': ' + err.message
      : (err.stack?.slice(0, 2000) ?? String(err));
    // `error` is a plain string all the way to the gateway -- there is no
    // structured channel -- so evidence that is not in this string does not
    // exist downstream. err.meta carries the run directory the engine wrote its
    // transcript to; append it rather than lose it at the last hop.
    const evidence = err.meta ? ' | evidence: ' + JSON.stringify(err.meta).slice(0, 600) : '';
    await report(name, job.id, false, null, detail + evidence).catch((e) =>
      say('could not even report the failure: ' + e.message),
    );
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    say('stopping on ' + sig);
    // A job in flight keeps its lease; the broker hands it to the next worker
    // once that lease expires, so exiting here loses time, never the job.
    process.exit(0);
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
  let backoff = 0;
  while (!stopping) {
    try {
      const job = await claim(name, types);
      backoff = 0;
      if (job) {
        const stop = beat(name, types);
        try {
          await run(name, job, session);
        } finally {
          stop();
        }
        // Human cooldown jitter between jobs to avoid machine-burst detection.
        // A real user doesn't open temporary chats or send CLI queries 2ms after finishing one.
        const cooldown = calculateCooldown(job.type);
        if (cooldown > 0 && !stopping) {
          await new Promise((r) => setTimeout(r, cooldown));
        }
      }
    } catch (err) {
      if (err.fatal) {
        say('FATAL: ' + err.message);
        process.exit(1);
      }
      backoff = Math.min(backoff ? backoff * 2 : 5_000, 60_000);
      say('[' + name + '] poll failed (' + err.message + ') — retrying in ' + backoff / 1000 + 's');
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

say('worker "' + NAME + '" -> ' + LAB);
// Promise.all rather than await in sequence: the lanes are the concurrency. If
// one ever settles the process should end, which is what a rejection here does.
await Promise.all(LANES.map((l) => lane(NAME + l.suffix, l.types, l.session)));
