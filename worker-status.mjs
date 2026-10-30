// What this worker process knows about itself, in memory, for the dashboard.
//
// WHY THIS EXISTS. The worker is outbound-only, so everything anyone can
// normally see about it lives in the lab's GET /api/jobs table — a name, an IP,
// and when it last said hello. The lab knows a lane is *alive*; it cannot know
// what that lane is running, how long it has been running it, or why the last
// job failed. On a box nobody watches, those are the questions.
//
// So the process keeps its own books here and worker-dashboard.mjs serves them
// over a loopback listener. The lane loop in worker.mjs calls the mutators
// below; nothing else does.
//
// WHAT IS NOT STORED. Job payloads and job results. A `gmap.scan` result is
// megabytes of business rows and a `chatgpt.ask` payload is a prompt; neither
// belongs in something a browser can read, and neither answers a question a
// dashboard asks. Errors ARE stored — they are the whole point of a failure
// view — but redacted and truncated first: an error string is the one place a
// bearer token or a credentials blob reaches a screen.
//
// The snapshot is a plain JSON-safe object. It is rebuilt on every call rather
// than held, so a reader can never mutate what the worker is counting.

const MAX_EVENTS = 60;
const MAX_TEXT = 300;
// A lane is one claim loop. Anything the loop is not doing right now is one of
// these; the dashboard renders them as pills.
export const LANE_STATES = ['polling', 'idle', 'running', 'backoff', 'cooldown', 'stopped'];

/** Truncate to something a card can show without becoming the whole page. */
function clip(value, max = MAX_TEXT) {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Strip the things that must never reach a browser.
 *
 * Two layers, because they fail differently: the exact token is known here and
 * is `${value -> [redacted]}`; anything that merely *looks* like a credential
 * (a JWT, an Authorization header, a token= query parameter) is matched by
 * shape, which is what catches a rotated token this process was never told
 * about.
 */
export function redact(value, secrets = []) {
  let s = String(value ?? '');
  for (const secret of secrets) {
    const t = String(secret ?? '').trim();
    if (t.length >= 8) s = s.split(t).join('[redacted]');
  }
  return s
    .replace(/bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted-jwt]')
    .replace(/((?:token|password|secret|apikey|api_key|authorization)["'\s]*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1[redacted]');
}

/**
 * Build the status book for one worker process.
 *
 * `lanes` is the worker's own LANES array: the identity recorded here is the
 * broker-visible one (`NAME` + suffix), so a lane card and a row in the lab's
 * worker table are the same thing and can be lined up by name.
 */
export function createStatus({ name, lab, lanes = [], secrets = [], now = () => Date.now() } = {}) {
  const startedAt = now();
  const byName = new Map();
  const events = [];
  const totals = { jobsDone: 0, jobsFailed: 0, jobsUnknown: 0, jobsTotalMs: 0, jobsMeasured: 0 };

  for (const lane of lanes) {
    // Only the shape of a lane is kept, never the lane itself: the worker still
    // owns its types array and session string.
    byName.set(name + (lane.suffix ?? ''), {
      name: name + (lane.suffix ?? ''),
      suffix: lane.suffix ?? '',
      types: [...(lane.types ?? [])],
      session: lane.session ?? null,
      state: 'idle',
      since: startedAt,
      polls: 0,
      idlePolls: 0,
      errors: 0,
      current: null,
      last: null,
      lastError: null,
      lastErrorAt: null,
      lastHeartbeatAt: null,
      nextPollAt: null,
      cooldownUntil: null,
      cooldownReason: null,
    });
  }

  const get = (laneName) => byName.get(laneName) ?? null;

  function event(kind, message) {
    events.unshift({ at: new Date(now()).toISOString(), kind, message: clip(redact(message, secrets)) });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  }

  function setState(lane, state) {
    if (lane.state === state) return;
    lane.state = state;
    lane.since = now();
  }

  return {
    event,

    /** The claim loop is inside the long poll; the lab answers in ~25s or idle. */
    lanePolling(laneName) {
      const lane = get(laneName);
      if (!lane) return;
      lane.polls++;
      lane.nextPollAt = null;
      if (lane.cooldownUntil && Date.parse(lane.cooldownUntil) <= now()) {
        lane.cooldownUntil = null;
        lane.cooldownReason = null;
      }
      setState(lane, 'polling');
    },

    laneCooldown(laneName, { until, reason = 'Individual quota reached' } = {}) {
      const lane = get(laneName);
      const at = typeof until === 'number' ? until : Date.parse(String(until ?? ''));
      if (!lane || !Number.isFinite(at) || at <= now()) return;
      const changed = lane.cooldownUntil !== new Date(at).toISOString();
      lane.cooldownUntil = new Date(at).toISOString();
      lane.cooldownReason = clip(redact(reason, secrets));
      lane.nextPollAt = lane.cooldownUntil;
      if (!lane.current) setState(lane, 'cooldown');
      if (changed) event('warn', laneName + ': quota reached — waiting until ' + lane.cooldownUntil);
    },

    /** A 204. Not a failure and not an event: an idle lane is the normal case. */
    laneIdle(laneName) {
      const lane = get(laneName);
      if (!lane) return;
      lane.idlePolls++;
      setState(lane, 'idle');
    },

    /**
     * A poll that failed but will be retried. This is worth an event: the lane
     * going quiet for a minute is exactly the thing nobody is around to notice.
     */
    laneBackoff(laneName, { error, retryMs } = {}) {
      const lane = get(laneName);
      if (!lane) return;
      lane.errors++;
      lane.lastError = clip(redact(error, secrets));
      lane.lastErrorAt = new Date(now()).toISOString();
      lane.nextPollAt = new Date(now() + Number(retryMs || 0)).toISOString();
      setState(lane, 'backoff');
      event('warn', laneName + ': poll failed — ' + lane.lastError + ' (retry in ' + Math.round((retryMs ?? 0) / 1000) + 's)');
    },

    /** A fatal error ends the process; say so before it goes. */
    laneStopped(laneName, reason) {
      const lane = get(laneName);
      if (!lane) return;
      lane.lastError = clip(redact(reason, secrets));
      lane.lastErrorAt = new Date(now()).toISOString();
      setState(lane, 'stopped');
      event('error', laneName + ': stopped — ' + lane.lastError);
    },

    /** A job is in hand. Recorded by id and type only. */
    jobStart(laneName, job) {
      const lane = get(laneName);
      if (!lane) return;
      lane.current = { id: String(job?.id ?? ''), type: String(job?.type ?? ''), startedAt: now(), heartbeatAt: null };
      setState(lane, 'running');
      return lane.current;
    },

    /** The 30s "still here" beat fired for this lane's current job. */
    heartbeat(laneName) {
      const lane = get(laneName);
      if (!lane) return;
      lane.lastHeartbeatAt = new Date(now()).toISOString();
      if (lane.current) lane.current.heartbeatAt = now();
    },

    /**
     * The job finished, one way or the other. `ok` is the worker's own verdict
     * (the handler returned AND the result posted), not the lab's.
     */
    jobDone(laneName, { id, type, ok, durationMs, error } = {}) {
      const lane = get(laneName);
      if (!lane) return;
      const dur = Number.isFinite(durationMs) ? durationMs : null;
      lane.current = null;
      lane.last = {
        id: String(id ?? ''),
        type: String(type ?? ''),
        ok: !!ok,
        at: new Date(now()).toISOString(),
        durationMs: dur,
        error: error ? clip(redact(error, secrets)) : null,
      };
      if (ok) totals.jobsDone++;
      else totals.jobsFailed++;
      if (dur !== null) {
        totals.jobsTotalMs += dur;
        totals.jobsMeasured++;
      }
      if (ok) event('job', laneName + ': ' + type + ' done in ' + Math.round((dur ?? 0) / 1000) + 's');
      else event('error', laneName + ': ' + type + ' failed — ' + (lane.last.error ?? 'unknown error'));
      setState(lane, 'polling');
    },

    /** A job type this build has no handler for. Not the same as a failure. */
    jobUnknown(laneName, type) {
      const lane = get(laneName);
      if (!lane) return;
      totals.jobsUnknown++;
      event('warn', laneName + ': no handler for type "' + type + '"');
    },

    /** The JSON-safe view the dashboard serves, rebuilt fresh each call. */
    snapshot() {
      const at = now();
      const memory = process.memoryUsage();
      const laneList = [...byName.values()].map((lane) => ({
        name: lane.name,
        suffix: lane.suffix,
        types: [...lane.types],
        session: lane.session,
        state: lane.state,
        since: new Date(lane.since).toISOString(),
        stateForSec: Math.round((at - lane.since) / 1000),
        polls: lane.polls,
        idlePolls: lane.idlePolls,
        errors: lane.errors,
        nextPollAt: lane.nextPollAt,
        cooldownUntil: lane.cooldownUntil,
        cooldownReason: lane.cooldownReason,
        cooldownRemainingMs: lane.cooldownUntil ? Math.max(0, Date.parse(lane.cooldownUntil) - at) : 0,
        lastHeartbeatAt: lane.lastHeartbeatAt,
        lastError: lane.lastError,
        lastErrorAt: lane.lastErrorAt,
        current: lane.current
          ? {
              id: lane.current.id,
              type: lane.current.type,
              startedAt: new Date(lane.current.startedAt).toISOString(),
              elapsedMs: at - lane.current.startedAt,
              heartbeatAt: lane.current.heartbeatAt ? new Date(lane.current.heartbeatAt).toISOString() : null,
            }
          : null,
        last: lane.last,
      }));

      return {
        at: new Date(at).toISOString(),
        worker: {
          name,
          lab: redact(lab, secrets),
          startedAt: new Date(startedAt).toISOString(),
          uptimeSec: Math.round((at - startedAt) / 1000),
          pid: process.pid,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? null,
          memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
        },
        totals: {
          lanes: laneList.length,
          running: laneList.filter((l) => l.state === 'running').length,
          idle: laneList.filter((l) => l.state === 'idle' || l.state === 'polling').length,
          backoff: laneList.filter((l) => l.state === 'backoff').length,
          cooldown: laneList.filter((l) => l.state === 'cooldown').length,
          stopped: laneList.filter((l) => l.state === 'stopped').length,
          claimed: totals.jobsDone + totals.jobsFailed,
          jobsDone: totals.jobsDone,
          jobsFailed: totals.jobsFailed,
          jobsUnknown: totals.jobsUnknown,
          avgJobMs: totals.jobsMeasured ? Math.round(totals.jobsTotalMs / totals.jobsMeasured) : null,
        },
        lanes: laneList,
        events: [...events],
      };
    },
  };
}
