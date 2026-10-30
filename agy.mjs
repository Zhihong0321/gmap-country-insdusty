// The agy CLI as a worker job. Runs on the mini against the copy of agy that is
// already installed and already signed in here.
//
// This is the cheap half of moving the wrappers home: agy needs no browser, no
// profile and no login flow — the binary at ~/.local/bin/agy holds a Google
// session in the macOS keyring, which is the one place the container could not
// use (no D-Bus, no keyring, hence the whole OAuth-paste apparatus in agy-lab).
// On this machine it is just a command that answers.
//
// The four probe states are the same vocabulary agy-lab uses, for the same
// reason: "could not tell" and "signed out" are different problems and only one
// of them is fixed by signing in again.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { quotaCooldownMs } from './quota.mjs';

function findAgy() {
  // worker.mjs loads .env after its static imports have been evaluated, so
  // resolve this at call time (inside run), not while this module is imported.
  const configured = process.env.AGY_BIN?.trim();
  if (configured && (fs.existsSync(configured) || !/[\\/]/.test(configured))) {
    return configured;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(os.homedir(), '.local', 'bin', 'agy.cmd'),
      path.join(os.homedir(), '.local', 'bin', 'agy.exe'),
      path.join(process.env['LOCALAPPDATA'] ?? '', 'agy', 'bin', 'agy.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'antigravity', 'agy.cmd'),
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'antigravity', 'agy.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'agy.cmd'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'agy.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // Installs made with a package manager or a custom directory may only be
    // discoverable through PATH. Check the Windows executable suffixes too.
    const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      for (const name of ['agy', 'agy.exe', 'agy.cmd', 'agy.bat']) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
      for (const ext of pathExts) {
        const candidate = path.join(dir, `agy${ext.toLowerCase()}`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return configured ?? 'agy.cmd';
  }
  return configured ?? path.join(os.homedir(), '.local/bin/agy');
}

const DEFAULT_TIMEOUT_MS = Number(process.env.AGY_TIMEOUT_MS ?? 300_000);

/** Everything agy prints that means "I am not signed in" rather than "here is your answer". */
const LOGGED_OUT = /not (?:signed|logged) in|no credentials|please (?:sign|log) in|authenticate|unauthorized|oauth/i;

/**
 * Run one prompt through `agy -p`.
 *
 * -p prints once, when it is done: there is no growing text, so there is nothing
 * to stream and no settle loop. The whole call is spawn, collect, exit code.
 *
 * `tools` is opt-in per call and never inherited, because the only flag agy has
 * is --dangerously-skip-permissions — all-or-nothing tool auto-approval with
 * nobody watching. On this machine that is a shell on the home network, not on a
 * throwaway container, so the default matters more here than it does in the lab.
 */
export async function ask(payload = {}) {
  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) throw new Error('agy.ask needs a prompt');
  const timeoutMs = Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : DEFAULT_TIMEOUT_MS;

  // ALL AGY runs in YOLO mode (--dangerously-skip-permissions)
  const args = ['-p', prompt, '--dangerously-skip-permissions'];

  const startedAt = Date.now();
  const { code, stdout, stderr, timedOut } = await run(args, timeoutMs);
  const ms = Date.now() - startedAt;
  const answer = stdout.trim();

  const quotaMs = quotaCooldownMs(`${stderr}\n${answer}`);
  if (quotaMs !== null) {
    throw Object.assign(new Error(firstLine(`${stderr}\n${answer}`, 500)), {
      code: 'quota_reached', retryAfterMs: quotaMs,
    });
  }

  if (timedOut) {
    throw Object.assign(new Error(`agy did not finish within ${Math.round(timeoutMs / 1000)}s`), { code: 'timeout' });
  }
  // agy's OWN ceiling, and it is lower than any timeout we pass. `-p` polls its
  // language server and gives up around 1490 polls -- ~305 seconds -- WHILE THE
  // MODEL IS STILL STREAMING: the log shows fresh streamGenerateContent calls a
  // second before it quits, and a `printed=` count that proves text was arriving.
  // So a prompt whose answer takes longer than five minutes cannot be answered by
  // this CLI at all, no matter what timeoutMs says, and it burns the full five
  // minutes finding that out. Five of 96 runs on this machine, three of them on
  // 24 Aug alone.
  //
  // It surfaced as `Error: Error: timeout waiting for response` with a Node stack
  // and nothing else -- indistinguishable from a network problem. Name it, and
  // carry the poll and print counts, so the next person reads "agy gave up" and
  // not "the mini is broken".
  const printMode = /Print mode: timed out after (\d+) polls \(printed=(\d+)\)/.exec(stderr);
  if (printMode && !answer) {
    throw Object.assign(
      new Error(`agy's print mode gave up after ${printMode[1]} polls (~${Math.round(ms / 1000)}s) with ${printMode[2]} chunks printed and the model still streaming — the prompt needs more than one \`agy -p\` run can deliver, not a longer timeout`),
      { code: 'print_mode_timeout' },
    );
  }
  // Exit code first, then the text: agy can exit 0 having printed a sign-in
  // notice, and it can exit non-zero having printed a perfectly good answer to
  // stdout with a warning on stderr. Neither reading is safe alone.
  if (code !== 0 && !answer) {
    const detail = firstLine(stderr) || `agy exited ${code} with no output`;
    throw Object.assign(new Error(detail), { code: LOGGED_OUT.test(stderr) ? 'logged_out' : 'engine_error' });
  }
  if (!answer) {
    throw Object.assign(new Error('agy exited 0 but printed nothing'), { code: 'engine_error' });
  }
  if (LOGGED_OUT.test(answer) && answer.length < 200) {
    throw Object.assign(new Error(`agy is not signed in: ${firstLine(answer)}`), { code: 'logged_out' });
  }

  return { engine: 'agy', answer, ms, at: new Date().toISOString(), ...(stderr.trim() ? { stderr: firstLine(stderr) } : {}) };
}

/**
 * Is the local agy usable right now?
 *
 * One real model call, because nothing cheaper is honest: a binary that exists
 * and a binary whose Google session is still valid are different claims, and only
 * the second one is what a caller about to route work here needs to know.
 */
export async function probe(payload = {}) {
  const startedAt = Date.now();
  try {
    const out = await ask({ prompt: 'Reply with exactly one word: ok', timeoutMs: Number(payload.timeoutMs) || 90_000 });
    return { status: 'ready', detail: `answered in ${out.ms}ms`, sample: out.answer.slice(0, 80), ms: Date.now() - startedAt };
  } catch (err) {
    if (err.code === 'quota_reached') throw err;
    const status = err.code === 'logged_out' ? 'logged_out' : err.code === 'timeout' ? 'unknown' : 'unknown';
    return { status, detail: err.message, ms: Date.now() - startedAt };
  }
}

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    // cwd is the home directory rather than wherever the worker was started:
    // agy reads project context from cwd, and a prompt answered against whatever
    const BIN = findAgy();
    const isWin = process.platform === 'win32';
    // Only .cmd/.bat need cmd.exe; a real .exe spawns directly. With shell:true
    // Node joins the args with bare spaces, so an unquoted prompt containing
    // spaces ("Reply with exactly one word: ok") gets split and agy rejects the
    // fragments as unexpected arguments — quote defensively when the shell is
    // unavoidable.
    const needsShell = isWin && /\.(cmd|bat)$/i.test(BIN);
    const spawnArgs = needsShell ? args.map((a) => `"${String(a).replace(/"/g, '""')}"`) : args;
    const child = spawn(BIN, spawnArgs, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], shell: needsShell });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\ncould not run ${BIN}: ${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, timedOut });
    });
  });
}

function firstLine(text, limit = 300) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) ?? String(text);
  return line.length > limit ? `${line.slice(0, limit)}...` : line.trim();
}

// Standalone, so this can be proven on the mini before anything routes to it:
//   node worker/agy.mjs probe
//   node worker/agy.mjs ask "capital of Malaysia? one word"
if (import.meta.filename === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const out = cmd === 'ask' ? await ask({ prompt: rest.join(' ') }) : await probe();
  console.log(JSON.stringify(out, null, 2));
}
