/**
 * ChatGPT engine on top of ego lite (https://github.com/citrolabs/ego-lite).
 *
 * Replaces the raw-CDP `chatgpt.mjs`. Everything that file hand-rolled — launching
 * Chrome on a derived debugging port, attach-first, the persistent profile dir, the
 * CDP socket and its uncleared 60s reject timer — is ego lite's job now. What is
 * left here is the only part that was ever ChatGPT-specific: put text in the
 * composer, press send once, and know when the answer is finished.
 *
 * ego lite gives two things the old design could not:
 *   - a *task space*, an isolated browsing context that inherits the user's login
 *     state, so the hand-login survives without a Chrome process being babysat;
 *   - many task spaces at once, which is the parallelism the mini was stood up for.
 *     The old "one Chrome per profile" forced a serial lane.
 *
 *   node worker/chatgpt-ego.mjs probe [id]
 *   node worker/chatgpt-ego.mjs ask   [id] "prompt"
 *   node worker/chatgpt-ego.mjs login [id]      hand the space over to sign in
 *
 * UNPROVEN: not yet run against a live ego lite. See HANDOFF notes.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_SESSION = 'mini-main';
const TEMP_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true';
const ASK_TIMEOUT_MS = Number(process.env.CGPT_ASK_TIMEOUT_MS ?? 180_000);
const EGO_BIN = process.env.EGO_BROWSER_BIN ?? 'ego-browser';

// Onboarding puts ego-browser in ~/.local/bin, which a launchd job does not inherit.
const PATH_WITH_LOCAL = `${process.env.HOME}/.local/bin:${process.env.PATH ?? ''}`;

// cliLog is the only channel out of a heredoc, and the runtime prints other things
// on the same stream. A sentinel makes our one result line unambiguous.
const MARK = '@@EGO_RESULT@@';

/**
 * Every ChatGPT selector this file depends on, old DOM and new side by side.
 *
 * In Oct 2026 ChatGPT shipped a redesign that removed every hook this file used:
 * no `#prompt-textarea`, no `data-testid` on send or stop, no
 * `data-message-author-role`, no `.markdown`. Nothing threw. The gate saw no
 * composer and no sign-in control and reported `signed_out` on three accounts
 * that were signed in, so the outage read as a login problem for weeks.
 *
 * Each entry is a selector LIST, the old hook first. ChatGPT rolls UI out by
 * cohort, so a profile can be served either DOM; matching both costs nothing.
 * Selectors go into browser-side template literals inside the generated script,
 * so they must not contain a backtick, a backslash or a single quote.
 */
const SEL = {
  composer: '#prompt-textarea, [data-composer-input] [contenteditable="true"]',
  send: '[data-testid="send-button"], form button[aria-label="Send"]',
  stop: '[data-testid="stop-button"], button[aria-label*="Stop answering" i], form button[aria-label="Stop"]',
  user: '[data-message-author-role="user"], [data-user-message-bubble="true"]',
  // New DOM: the prose root itself, the successor to `.markdown`.
  assistant: '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]',
  login: '[data-testid="login-button"], a[href*="/auth/login"]',
  account: '[data-testid="profile-button"], button[aria-label*="Account" i]',
};

// A task space is bound to a browser profile when it is created, and the profile
// IS choosable — `ego.createTaskSpace(name, profileId)` takes it as a positional
// second argument and honours it. What does not honour it is the convenience
// wrapper `useOrCreateTaskSpace(nameOrId)`, which takes one argument and creates
// on whatever profile is default; passing it a `{ profileId }` object looks like
// it is being ignored, but the object was never a parameter of that function.
// (This file previously recorded the opposite as fact and built the registry
// around it. It was wrong; `ego.listProfiles()` and `ego.createTaskSpace` are the
// real surface. Verified: createTaskSpace('x', 'Profile 2') -> ZhiHong 三专.)
//
// So a space made under the wrong profile still has the wrong cookie jar, but it
// is no longer unfixable: create it on the right profile instead of adopting a
// default one. CGPT_SPACE still pins an existing space by numeric id; a digit-only
// string resolves as an id, anything else as a name.
const REGISTRY = `${process.env.HOME}/.gmap-worker/spaces.json`;

/**
 * Resolve a session id to a task space.
 *
 * The registry is session id -> { space, profile, profileId }. `space` is the
 * durable name, `profile` is the display name the guard checks, and `profileId`
 * ("Profile 2", "Default", ...) is what `ego.createTaskSpace` needs to put a NEW
 * space on the right account. With profileId present a missing space is created
 * correctly; without it, the old behaviour stands and a miss fails the guard.
 *
 * PREFER A NAME OVER A NUMERIC ID. Space ids do not survive a browser restart:
 * after the mini rebooted, listTaskSpaces() came back empty and the id 12 this
 * registry had pinned was simply gone, so every chatgpt call failed with "task
 * space not found: 12" while the worker itself looked perfectly healthy. A name
 * is the durable handle — useOrCreateTaskSpace recreates it on demand, and the
 * login it needs lives in the profile's cookie jar on disk, which does survive.
 *
 * A name is only safe because of the profile guard below. On its own it would
 * silently create a fresh space on whatever profile happens to be default, i.e.
 * answer as the wrong account; guarded, that case fails loudly as wrong_profile.
 * A miss in the registry is still an error rather than a default.
 */
function spaceFor(id, override) {
  if (override) return typeof override === 'object' ? override : { space: override, profile: null, profileId: null };
  if (process.env.CGPT_SPACE) {
    return {
      space: Number(process.env.CGPT_SPACE),
      profile: process.env.CGPT_PROFILE ?? null,
      profileId: process.env.CGPT_PROFILE_ID ?? null,
    };
  }
  try {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const e = reg[id];
    if (e !== undefined) {
      return typeof e === 'object'
        ? { profileId: null, ...e }
        : { space: e, profile: null, profileId: null };
    }
  } catch { /* no registry yet — fall through to the throw */ }
  throw Object.assign(
    new Error(`no task space for session "${id}" — add it to ${REGISTRY}, or pass CGPT_SPACE`),
    { code: 'no_space' },
  );
}

/**
 * The browser-side snippet that lands us in the right space on the right account.
 *
 * Order matters. Look for the space by name first: if it exists it already has the
 * account's cookie jar and recreating it would be wrong. Only when it is absent do
 * we create one, and then we create it ON THE NAMED PROFILE via
 * `ego.createTaskSpace(name, profileId)` rather than letting the convenience
 * wrapper adopt whatever profile happens to be default.
 *
 * The guard stays, and stays fatal. Creating on the right profile makes the wrong
 * one much less likely; it does not make verifying it optional, because the
 * profile is the only thing that identifies which account will answer.
 */
function spaceScript({ space, profile, profileId }) {
  const wanted = typeof space === 'number' ? space : JSON.stringify(space);
  const create = profileId
    ? `
  let task = null;
  {
    const existing = (await listTaskSpaces()).find(
      (x) => x.id === ${wanted} || x.name === ${wanted} || x.taskId === ${wanted});
    if (existing) {
      task = await useOrCreateTaskSpace(existing.id);
    } else {
      // createTaskSpace CREATES; it does not SELECT. useOrCreateTaskSpace does both,
      // which is why nothing downstream ever had to think about it -- and why the
      // first version of this failed with "listTabs: Task space not selected" the
      // moment a space had to be rebuilt. Select it, then take control: a freshly
      // made space comes back agentDelegatedToUser, with control parked on the user
      // side, and every page call fails until it is taken.
      task = await ego.createTaskSpace(${wanted}, ${JSON.stringify(profileId)});
      await ego.useTaskSpace(task.id);
      await takeOverTaskSpace(task.id);
    }
  }`
    : `
  const task = await useOrCreateTaskSpace(${wanted});`;

  const guard = profile
    ? `
  {
    const all = await listTaskSpaces();
    const found = all.find((x) => x.id === task.id);
    if (!found || found.profileName !== ${JSON.stringify(profile)}) {
      emit({ ok: false, code: 'wrong_profile', space: task.id,
             expected: ${JSON.stringify(profile)}, actual: found ? found.profileName : null });
      throw new Error('wrong profile');
    }
  }`
    : '';

  return create + guard;
}

/**
 * Run a script in ego-browser's Node runtime and return the marked result.
 *
 * The script goes in on stdin rather than through a shell heredoc, so the prompt
 * never touches shell quoting — it is embedded as a JS string literal by
 * JSON.stringify at the call site and nothing re-parses it.
 */
function egoRun(script, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(EGO_BIN, ['nodejs'], {
      env: { ...process.env, PATH: PATH_WITH_LOCAL },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('ego-browser did not finish in time'), { code: 'timeout' }));
    }, timeoutMs + 15_000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.on('error', (e) => {
      clearTimeout(killer);
      if (e.code === 'ENOENT') {
        return reject(Object.assign(
          new Error('ego-browser is not on PATH — install ego lite, finish onboarding, then retry'),
          { code: 'not_installed' },
        ));
      }
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(killer);       // the bug that cost chatgpt.mjs 60s a call: always clear the timer
      // cliLog writes to stderr, not stdout — scan both streams for the sentinel.
      const line = `${out}\n${err}`.split(/\r?\n/).find((l) => l.includes(MARK));
      if (line) {
        try { return resolve(JSON.parse(line.slice(line.indexOf(MARK) + MARK.length))); }
        catch { return reject(new Error('unparseable result line: ' + line.slice(0, 200))); }
      }
      const detail = (err.trim() || out.trim() || `exited ${code}`).slice(0, 400);
      // A hard stop, per the skill's ownership policy — never retry around this.
      if (/user is controlling/i.test(detail)) {
        return reject(Object.assign(new Error('the user has taken control of this task space'), { code: 'user_controlling' }));
      }
      if (/command not found|not recognized/i.test(detail)) {
        return reject(Object.assign(new Error('ego-browser is not installed'), { code: 'not_installed' }));
      }
      reject(Object.assign(new Error(detail), { code: 'engine_error' }));
    });

    child.stdin.end(script);
  });
}

/**
 * The one browser-side read, as an IIFE returning once — `js()` takes a string and
 * captures no closures, so everything it needs is baked in.
 *
 * `streaming` is re-queried from `document` on every call rather than held as a
 * node handle. React swaps the stop button mid-stream, so a captured handle reports
 * "gone" early and yields a truncated answer that looks complete — the worst
 * failure mode available here, because it is silent.
 *
 * The text comes from `.markdown` and not the whole assistant node. The old wrapper
 * cloned the entire `[data-message-author-role="assistant"]` subtree and stripped
 * `button, [role=button], svg`; everything else ChatGPT renders in there — the
 * footer chrome that arrives seconds after the prose — stayed in the string, kept
 * changing, and kept resetting the "text stopped changing" half of the rule. That
 * is where the measured 18s answer phase went. `.markdown` is prose only.
 */
const DISMISS_MODAL = `(() => {
  // A native <dialog> traps focus, and it matches neither [role="dialog"] nor
  // [aria-modal] — the two things an overlay check normally looks for. The
  // temporary-chat URL shows a "Temporary Chat" explainer on a profile's first
  // visit; while it is open every input path fails SILENTLY, landing no text and
  // raising nothing. Dismiss before touching the composer.
  const dl = [...document.querySelectorAll('dialog')].find((e) => e.open && e.matches(':modal'));
  if (!dl) return 'none';
  const btn = [...dl.querySelectorAll('button')].find((b) => /continue|got it|okay|ok/i.test(b.innerText || ''));
  if (btn) { btn.click(); return 'clicked:' + btn.innerText.trim(); }
  dl.close();
  return 'closed';
})()`;

const READ_EXPR = `(() => {
  const asst = document.querySelectorAll('${SEL.assistant}');
  const users = document.querySelectorAll('${SEL.user}');
  const el = asst.length > __BASELINE__ ? asst[asst.length - 1] : null;
  const md = el ? el.querySelector('.markdown') : null;
  return {
    users: users.length,
    present: !!el,
    streaming: !!document.querySelector('${SEL.stop}'),
    text: md ? md.innerText.trim() : (el ? el.innerText.trim() : ''),
  };
})()`;

const READ_SRC = `
const readExpr = (b) => ${JSON.stringify(READ_EXPR)}.replace('__BASELINE__', String(b));
`;

function askScript({ id, prompt, space: override, timeoutMs }) {
  const resolved = spaceFor(id, override);
  return `
${READ_SRC}
const t0 = Date.now();
const phases = {};
let mark = t0;
const phase = (n) => { phases[n] = Date.now() - mark; mark = Date.now(); };
const emit = (o) => cliLog(${JSON.stringify(MARK)} + JSON.stringify(o));

try {
  ${spaceScript(resolved)}
  phase('space');

  await openOrReuseTab(${JSON.stringify(TEMP_CHAT_URL)}, { wait: true, timeout: 30 });
  // Navigate even on a reused tab: a temporary chat keeps its thread, and a stale
  // assistant node from the previous ask would satisfy the completion rule at once.
  await gotoAndWait(${JSON.stringify(TEMP_CHAT_URL)}, { timeout: 30, settle: 1 });
  phase('load');

  await js(${JSON.stringify(DISMISS_MODAL)});

  // Signed-out pages here render a sign-in control; on some builds they also render
  // a working composer. A visible sign-in control outranks a live composer.
  const gate = await js(\`(() => ({
    login: !!document.querySelector('${SEL.login}'),
    composer: !!document.querySelector('${SEL.composer}'),
  }))()\`);
  // No sign-in control AND no composer is not a logout: it is a page this file no
  // longer recognises. Calling it signed_out is what hid the Oct 2026 redesign.
  if (gate.login || !gate.composer) {
    emit({ ok: false, code: gate.login ? 'signed_out' : 'no_composer', space: task.id, phases });
  } else {

  // Interactive, not merely present: the composer accepts text well before its
  // keydown handler is wired. The send button rendering is the cheapest proof the
  // composer is live rather than drawn.
  await waitForElement(${JSON.stringify(SEL.send)}, { timeout: 20 });

  // Dismiss modals HERE, not merely after load. The "Temporary Chat" dialog renders
  // after the composer does, so a single shot at load time misses it on a profile's
  // first visit — and a modal that arrives late is indistinguishable from one that
  // never came, because the failure is silent: input lands nowhere and throws
  // nothing. Poll until the page has been modal-free for two consecutive checks.
  let clear = 0;
  for (let i = 0; i < 24 && clear < 2; i++) {
    const r = await js(${JSON.stringify(DISMISS_MODAL)});
    if (r === 'none') clear++; else clear = 0;
    if (clear < 2) await wait(0.25);
  }
  phase('interactive');

  const baseline = await js(\`document.querySelectorAll('${SEL.assistant}').length\`);
  const usersBefore = await js(\`document.querySelectorAll('${SEL.user}').length\`);

  // ProseMirror is a rich editor; fillInput is explicitly unreliable on those.
  // Input.insertText into the focused composer is the mechanism already measured
  // to work on this exact page, so it is the one used.
  await click(${JSON.stringify(SEL.composer)}, { label: 'focus the composer' });
  await cdp('Input.insertText', { text: ${JSON.stringify(prompt)} });
  const typed = await js(\`(document.querySelector('${SEL.composer}') || {}).innerText || ''\`);
  phase('type');
  if (!typed.trim()) {
    emit({ ok: false, code: 'compose_failed', space: task.id, phases });
  } else {

  // Click send once. No Enter, no fallback: the old wrapper pressed Enter, waited
  // for proof, then clicked when proof was late — so a working Enter got a second
  // submit on top of it, which is what left an assistant node streaming forever.
  await click(${JSON.stringify(SEL.send)}, { label: 'send the prompt' });

  // The app's own record that it accepted the message. The composer emptying is
  // not proof — it empties on a failed submit too.
  let accepted = false;
  for (let i = 0; i < 40 && !accepted; i++) {
    await wait(0.25);
    accepted = (await js(\`document.querySelectorAll('${SEL.user}').length\`)) > usersBefore;
  }
  phase('submit');
  if (!accepted) {
    emit({ ok: false, code: 'submit_failed', space: task.id, phases });
  } else {

  // Two independent signals must agree: the stop control is gone AND the answer
  // text has stopped changing. Five quiet polls at 250ms is ~1.25s of settle.
  const deadline = Date.now() + ${timeoutMs};
  const trace = [];
  let quiet = 0, sawStream = false, prev = '', text = '', done = false;
  while (Date.now() < deadline) {
    await wait(0.25);
    const r = await js(readExpr(baseline));
    if (process.env.CGPT_TRACE) trace.push([Date.now() - t0, r.present ? 1 : 0, r.streaming ? 1 : 0, (r.text || '').length]);
    if (r.streaming) { sawStream = true; quiet = 0; prev = r.text; continue; }
    // Do not let a poll that lands before the stream starts count as quiet.
    if (!(sawStream || r.text)) continue;
    if (r.text && r.text === prev) quiet++; else quiet = 0;
    prev = r.text;
    if (quiet >= 5 && r.text) { text = r.text; done = true; break; }
  }
  phase('answer');

  // No partial returns. A budget that runs out mid-stream is a failure, not a
  // short answer — handing the on-screen fragment back as if it were complete is
  // how a truncated reply gets stored as the real one.
  emit(done
    ? { ok: true, engine: 'chatgpt', id: ${JSON.stringify(id)}, answer: text, space: task.id, ms: Date.now() - t0, phases, trace }
    : { ok: false, code: 'answer_timeout', space: task.id, ms: Date.now() - t0, phases, trace });

  } } }
} catch (e) {
  emit({ ok: false, code: 'engine_error', error: String((e && e.message) || e) });
}
`;
}

function probeScript({ id, space: override }) {
  const resolved = spaceFor(id, override);
  return `
const t0 = Date.now();
const emit = (o) => cliLog(${JSON.stringify(MARK)} + JSON.stringify(o));
try {
  ${spaceScript(resolved)}
  await openOrReuseTab(${JSON.stringify(TEMP_CHAT_URL)}, { wait: true, timeout: 30 });
  // Sample only after the app hydrates. A load event is not readiness: the marketing
  // shell paints first, and reading signals there reports a signed-in account as
  // signed out. Wait for the composer, and treat the wait timing out as the answer
  // rather than an error — a signed-out page never renders one.
  try { await waitForElement(${JSON.stringify(SEL.composer)}, { timeout: 20 }); } catch (e) { /* read the signals below and let them say why */ }
  await js(${JSON.stringify(DISMISS_MODAL)});
  const info = await pageInfo();
  const s = await js(\`(() => ({
    login: !!document.querySelector('${SEL.login}'),
    composer: !!document.querySelector('${SEL.composer}'),
    account: !!document.querySelector('${SEL.account}'),
  }))()\`);
  const ready = !s.login && (s.composer || s.account);
  const status = ready ? 'ready' : s.login ? 'signed_out' : 'no_composer';
  emit({ ok: true, id: ${JSON.stringify(id)}, space: task.id, status,
         url: info.url, title: info.title, signals: s, ms: Date.now() - t0 });
} catch (e) {
  emit({ ok: false, code: 'engine_error', error: String((e && e.message) || e) });
}
`;
}

/** Hand the space to the user so they can sign in by hand, once. */
function loginScript({ id }) {
  // `spaceFor` returns a record, and this used to hand the whole record to
  // useOrCreateTaskSpace as if it were a name -- so login opened a space called
  // `[object Object]`/the JSON text rather than the session's own. It now takes
  // the same path as ask and probe.
  //
  // The guard is deliberately dropped here and only here: login is what you run
  // when the space does not exist or is signed out, so refusing to proceed until
  // the account checks out would make it impossible to ever get the account in.
  // Creating on `profileId` is what puts the sign-in in the right cookie jar.
  const resolved = spaceFor(id);
  return `
const emit = (o) => cliLog(${JSON.stringify(MARK)} + JSON.stringify(o));
${spaceScript({ ...resolved, profile: null })}
await openOrReuseTab('https://chatgpt.com/', { wait: true, timeout: 30 });
const r = await handOffTaskSpace(task.id);
emit({ ok: true, handedOff: r.done, space: task.id, profile: ${JSON.stringify(resolved.profile ?? null)},
       next: 'sign in to ChatGPT in that space, then run: probe' });
`;
}

/**
 * A session with no registry entry is a configuration gap, not a crash, and
 * spaceFor throws it before any browser work happens. Left as a throw it reaches
 * the broker as a *failed job*, and the gateway renders any failed job as a flat
 * 502 with the stack trace as the message — which is how a missing one-line
 * mapping came to look like a broken machine. Returned in the shape the gateway
 * already reads ({ok:false, code}) it maps to 503 and names the session that
 * needs a space.
 */
function configFailure(err) {
  if (err.code !== 'no_space') throw err;
  return { ok: false, code: err.code, error: err.message };
}

export async function ask({ id = DEFAULT_SESSION, prompt, space, timeoutMs = ASK_TIMEOUT_MS }) {
  if (!prompt?.trim()) throw Object.assign(new Error('no prompt'), { code: 'bad_request' });
  let script;
  try { script = askScript({ id, prompt, space, timeoutMs }); } catch (e) { return configFailure(e); }
  return egoRun(script, { timeoutMs });
}
export async function probe({ id = DEFAULT_SESSION, space }) {
  let script;
  try { script = probeScript({ id, space }); } catch (e) { return configFailure(e); }
  return egoRun(script, { timeoutMs: 90_000 });
}
export async function login({ id = DEFAULT_SESSION }) {
  return egoRun(loginScript({ id }), { timeoutMs: 90_000 });
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const id = rest[0] && !rest[0].includes(' ') && rest.length > 1 ? rest.shift() : DEFAULT_SESSION;
  try {
    const out =
      cmd === 'ask' ? await ask({ id, prompt: rest.join(' ') })
      : cmd === 'login' ? await login({ id: rest[0] ?? id })
      : await probe({ id: rest[0] ?? id });
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok === false ? 1 : 0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e.code ?? 'engine_error', error: e.message }, null, 2));
    process.exit(1);
  }
}
