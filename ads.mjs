// The ads-recon competitor-ads worker as a worker job. Runs on the mini against
// the ego lite that is already signed in here.
//
// WHY IT CANNOT RUN IN THE CONTAINER, same as fb.* and gmap.scan: the ad
// libraries are read through a real browser on this machine. Facebook's library
// is public, but it is a heavy SPA whose results appear ~8s after load, and
// Google's Ads Transparency Center renders every creative inside a sandboxed
// iframe. There is no API to call and no token to ship.
//
// WHAT IT SHELLS OUT TO. `ads` (in the gmap-recon repo, not this one) drives ego
// lite deterministically -- no model is on its path, so no key can fail a run.
// It writes a run directory: fb.json, google.json, ads.jsonl, and a media/ folder
// of downloaded creatives.
//
// WHY THE CREATIVES TRAVEL INLINE. The images are files on this disk and the
// gateway has no blob store, no upload route and no object storage of any kind.
// A worker returns JSON and nothing else. So the one path that gets a picture in
// front of a person on the web is to carry it in that JSON as a data URI --
// downscaled hard, capped, and counted. That is why `sips` is in here: without
// it the report is text about ads nobody can see, which is what the first
// version of this feature shipped.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ADS = process.env.ADS_BIN ?? path.join(os.homedir(), 'project/gmap-recon/ads-recon/ads');
// `kw` is the keyword/market half of the same repo. Separate binary, separate
// question: `ads` is one company across two networks, `kw` is one market across
// many advertisers on Facebook only.
const KW = process.env.KW_BIN ?? path.join(os.homedir(), 'project/gmap-recon/ads-recon/kw');
// The fetch is ~90s for three keywords and the write is ~95s. 25 minutes leaves
// room for a wider keyword set without ever being the thing that kills a run.
const KW_TIMEOUT_MS = Number(process.env.KW_TIMEOUT_MS ?? 1_500_000);
// Facebook is one page load for the whole grid; Google costs one page load PER
// AD, which is what dominates a run. 30 Google ads is roughly 4-6 minutes.
const DEFAULT_TIMEOUT_MS = Number(process.env.ADS_TIMEOUT_MS ?? 900_000);

// Creative budget. A 480px JPEG at q55 lands around 30KB, ~40KB once base64'd,
// so 40 of them is about 1.6MB -- enough to see every ad, small enough that the
// result body and the Postgres row both stay sane.
const IMG_WIDTH = Number(process.env.ADS_IMG_WIDTH ?? 480);
const IMG_QUALITY = Number(process.env.ADS_IMG_QUALITY ?? 55);
const IMG_MAX_BYTES = Number(process.env.ADS_IMG_MAX_BYTES ?? 160_000);
const IMG_TOTAL_BUDGET = Number(process.env.ADS_IMG_TOTAL_BYTES ?? 6_000_000);

/** Every live ad a company is running, on Facebook and Google, with creatives. */
export async function company(payload, job) {
  const p = payload ?? {};
  const name = String(p.name ?? p.company ?? '').trim();
  if (!name) throw new Error('ads.company needs a "name"');

  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-run-'));
  const args = ['company', name, '--out', runDir];
  if (p.region) args.push('--region', String(p.region));
  if (Number(p.fbMax) > 0) args.push('--fb-max', String(Number(p.fbMax)));
  if (Number(p.gMax) >= 0 && p.gMax != null) args.push('--g-max', String(Number(p.gMax)));
  if (p.noGoogle) args.push('--no-google');
  if (p.noFacebook) args.push('--no-facebook');

  const startedAt = Date.now();
  const { code, stdout, stderr, timedOut, spawnError } = await exec(ADS, args, timeoutMs);
  const ms = Date.now() - startedAt;

  try {
    if (spawnError) throw Object.assign(new Error(spawnError), { code: 'engine_error' });
    if (timedOut) {
      throw Object.assign(new Error(`ads did not finish within ${Math.round(timeoutMs / 1000)}s`), { code: 'timeout' });
    }
    if (/holds the browser lock/i.test(stderr)) {
      throw Object.assign(new Error('another ads-recon run holds the browser lock'), { code: 'busy' });
    }
    if (/under your control|user has taken control/i.test(stderr)) {
      throw Object.assign(new Error('the ads crawl space is under a human’s control on the mini'), { code: 'busy' });
    }

    const facebook = readJson(path.join(runDir, 'fb.json'));
    const google = readJson(path.join(runDir, 'google.json'));
    const ads = readJsonl(path.join(runDir, 'ads.jsonl'));

    // Neither capture produced a file: the run did not work, and saying so beats
    // returning an empty list that reads as "this company runs no ads".
    if (!facebook && !google) {
      throw Object.assign(new Error(firstLine(stderr) || `ads exited ${code} without writing a capture`), {
        code: 'engine_error',
        meta: { exit_code: code, stderr_head: String(stderr).slice(0, 800) },
      });
    }

    const media = attachCreatives(ads, runDir);

    return {
      engine: 'ads-recon',
      company: name,
      region: String(p.region ?? 'MY').toUpperCase(),
      facebook: facebook ? strip(facebook) : { ads_found: 0, error: 'not captured' },
      google: google ? strip(google) : { ads_found: 0, error: 'not captured' },
      ads,
      ads_found: ads.length,
      creatives_ok: media.embedded,
      creatives_skipped: media.skipped,
      meta: { ms, run_dir: runDir, image_bytes: media.bytes, exit_code: code },
      at: new Date().toISOString(),
      ...(job?.id ? { jobId: job.id } : {}),
    };
  } finally {
    // The creatives are inside the payload now; the copy on disk is scratch.
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Keyword MARKET research: every live ad matching each keyword, rolled up, then
 * one written report.
 *
 * Two shell-outs, in order, and the split is the whole point. `kw fetch` stores
 * ads in SQLite on this machine; `kw report` reads that store and spends one
 * model call. If the model half fails, the ads are still on disk and the digest
 * is still returned -- so this returns whatever it got rather than throwing away
 * a good crawl over a bad write. Only a failed FETCH is an error here.
 *
 * No creatives travel. ads.company embeds downscaled images because a company
 * report is something you look at; a market report is 500+ ads and something you
 * read, and 500 data URIs would not fit in a job result or a Postgres row.
 */
export async function market(payload, job) {
  const p = payload ?? {};
  const keywords = (Array.isArray(p.keywords) ? p.keywords : [p.keyword])
    .map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 8);
  if (!keywords.length) throw new Error('ads.market needs "keywords"');

  const region = String(p.region ?? 'MY').toUpperCase();
  const pages = Number(p.pages) > 0 ? Math.min(Number(p.pages), 40) : 12;
  const effort = ['low', 'medium', 'high'].includes(String(p.effort)) ? String(p.effort) : 'high';
  // Creatives for the teardown gallery. Capped because each is a separate CDN
  // fetch: 150 is about a minute and is more tiles than anyone scrolls.
  const media = Number.isFinite(Number(p.media)) ? Math.min(Math.max(Number(p.media), 0), 400) : 150;
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : KW_TIMEOUT_MS;

  // KW_DATA, not --db. `--db` moves only the database; the raw NDJSON, the digest
  // and the report all hang off kw's data directory, and left alone they would be
  // written into the checked-out repo and shared between concurrent runs.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-run-'));
  const env = { KW_DATA: workDir };
  const db = path.join(workDir, 'ads.db');
  const startedAt = Date.now();

  try {
    // ---------------------------------------------------------------- fetch
    const fetchArgs = ['fetch', ...keywords, '--region', region, '--pages', String(pages), '--media', String(media)];
    const fetched = await exec(KW, fetchArgs, timeoutMs, env);
    if (fetched.spawnError) throw Object.assign(new Error(fetched.spawnError), { code: 'engine_error' });
    if (fetched.timedOut) {
      throw Object.assign(new Error(`kw fetch did not finish within ${Math.round(timeoutMs / 1000)}s`), { code: 'timeout' });
    }
    if (/holds the browser lock/i.test(fetched.stderr)) {
      throw Object.assign(new Error('another ads-recon run holds the browser lock'), { code: 'busy' });
    }
    if (/under your control|user has taken control/i.test(fetched.stderr)) {
      throw Object.assign(new Error('the ads crawl space is under a human\u2019s control on the mini'), { code: 'busy' });
    }
    if (!fs.existsSync(db)) {
      throw Object.assign(new Error(firstLine(fetched.stderr) || `kw fetch exited ${fetched.code} without writing a database`), {
        code: 'engine_error',
        meta: { exit_code: fetched.code, stderr_head: String(fetched.stderr).slice(0, 800) },
      });
    }

    // Per-keyword truth, parsed from the summary the fetch writes next to the raw
    // capture. This is what carries "the cap bit and more ads exist" upward; a run
    // that lost it would read as complete coverage.
    const fetchStats = readFetchStats(workDir, fetched.stderr, keywords);

    // ---------------------------------------------------------------- report
    // The topic is the first keyword: it is the one the user actually typed, and
    // kwdigest scopes by keywords containing it.
    // teardown, not report: the deliverable is the page, and kw builds it whole.
    const reportArgs = ['teardown', keywords[0], '--keywords', keywords.join(','), '--effort', effort];
    const wrote = await exec(KW, reportArgs, timeoutMs, env);
    const built = String(wrote.stdout || '').trim().split('\n').pop();

    const digest = findDigest(path.join(workDir, 'reports')) ?? findDigest(workDir);
    const reportHtml = built && fs.existsSync(built) ? fs.readFileSync(built, 'utf8') : null;
    const ms = Date.now() - startedAt;

    return {
      engine: 'ads-recon/kw',
      keywords,
      region,
      fetch_stats: fetchStats,
      digest: digest ?? {},
      report_html: reportHtml,
      report_engine: reportHtml ? 'agy' : null,
      report_model: reportHtml ? `gemini-3.7-flash-${effort}` : null,
      // A failed WRITE is reported, not thrown: the ads and the digest are the
      // expensive half and they are already in hand.
      report_error: reportHtml ? null : (firstLine(wrote.stderr) || `kw teardown exited ${wrote.code}`),
      meta: { ms, pages, effort, media, exit_code: fetched.code },
      at: new Date().toISOString(),
      ...(job?.id ? { jobId: job.id } : {}),
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

/** Per-keyword page/ad counts and cap warnings from the fetch summary. */
function readFetchStats(rawDir, stderr, keywords) {
  // kw writes data/raw/<ts>.summary.json next to the NDJSON. Take the newest.
  try {
    const dir = path.join(rawDir, 'raw');
    const summaries = fs.readdirSync(dir).filter((f) => f.endsWith('.summary.json')).sort();
    if (summaries.length) {
      const s = readJson(path.join(dir, summaries[summaries.length - 1]));
      if (s?.per_keyword) return s.per_keyword;
    }
  } catch {}
  // Fall back to the warning lines rather than returning nothing: losing the cap
  // flag is the one loss that makes a partial crawl read as a whole market.
  const out = {};
  for (const k of keywords) out[k] = { truncated: new RegExp(`"${k}" hit --pages`).test(String(stderr)) };
  return out;
}

/** The digest kw wrote. Named <topic-slug>-digest.json, so match on the suffix. */
function findDigest(dir) {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.endsWith('-digest.json'));
    return hit ? readJson(path.join(dir, hit)) : null;
  } catch { return null; }
}

/**
 * Are both ad libraries still reachable from the browser on this machine?
 *
 * `ads doctor` drives a real navigation to each one, so this answers the
 * question a caller about to route a job here actually has -- not "is the CLI
 * installed" but "can it still see the libraries".
 */
export async function probe(payload) {
  const p = payload ?? {};
  const timeoutMs = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 180_000;
  const startedAt = Date.now();
  const { stdout, stderr, timedOut, spawnError } = await exec(ADS, ['doctor'], timeoutMs);
  const ms = Date.now() - startedAt;
  if (spawnError) return { status: 'unknown', detail: spawnError, ms };
  if (timedOut) return { status: 'unknown', detail: `ads doctor did not answer within ${Math.round(timeoutMs / 1000)}s`, ms };

  const out = `${stdout}\n${stderr}`;
  const fbOk = /facebook\s+reachable/i.test(out);
  const ggOk = /google\s+reachable/i.test(out);
  if (/LOGIN WALL/i.test(out)) return { status: 'logged_out', detail: 'the Facebook ad library is showing a login wall in ego lite', ms };
  if (fbOk && ggOk) return { status: 'ready', detail: 'both ad libraries are reachable', ms };
  return { status: 'degraded', detail: `facebook=${fbOk ? 'ok' : 'unreachable'} google=${ggOk ? 'ok' : 'unreachable'}`, ms };
}

// ------------------------------------------------------- creatives -> data URIs

/**
 * Downscale each captured creative and hang it on its ad as a data URI.
 *
 * Mutates `ads` in place. A creative that cannot be read or shrunk is recorded
 * on the ad as `image_error` and the ad still ships -- one unreadable file must
 * never cost the other twenty-nine.
 */
function attachCreatives(ads, runDir) {
  let bytes = 0;
  let embedded = 0;
  let skipped = 0;
  const tmp = path.join(runDir, '.thumb');
  fs.mkdirSync(tmp, { recursive: true });

  for (const ad of ads) {
    const file = ad?.media?.[0]?.file;
    if (!file) { skipped++; continue; }
    const src = path.join(runDir, 'media', file);
    if (!fs.existsSync(src)) { ad.image_error = 'creative missing on disk'; skipped++; continue; }
    if (bytes >= IMG_TOTAL_BUDGET) { ad.image_error = 'image budget spent'; skipped++; continue; }
    try {
      const out = path.join(tmp, file.replace(/\.[^.]+$/, '') + '.jpg');
      // sips ships with macOS, so this needs nothing installed. Failure here is
      // not fatal: fall back to the original bytes if they are small enough.
      const r = execSyncQuiet('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(IMG_QUALITY),
        '-Z', String(IMG_WIDTH), src, '--out', out]);
      const use = r && fs.existsSync(out) ? out : src;
      const buf = fs.readFileSync(use);
      if (buf.length > IMG_MAX_BYTES) { ad.image_error = `creative too large (${buf.length}B)`; skipped++; continue; }
      const mime = use.endsWith('.jpg') ? 'image/jpeg' : (ad.media[0].mime || 'image/jpeg');
      ad.image = `data:${mime};base64,${buf.toString('base64')}`;
      bytes += ad.image.length;
      embedded++;
    } catch (err) {
      ad.image_error = err.message ?? String(err);
      skipped++;
    }
  }
  return { embedded, skipped, bytes };
}

// ------------------------------------------------------------------ plumbing

function strip(capture) {
  // The per-network capture is kept for the audit record, minus the ad array --
  // the ads travel once, at the top level, with their creatives attached.
  const { ads, ...rest } = capture ?? {};
  return rest;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function execSyncQuiet(bin, args) {
  // require() does not exist in an .mjs module -- spawnSync is imported at the top.
  try { return spawnSync(bin, args, { stdio: 'ignore' }).status === 0; } catch { return false; }
}

function exec(bin, args, timeoutMs, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: path.dirname(bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      // launchd inherits none of a login shell's PATH, and `ads` needs
      // ego-browser from ~/.local/bin, node from nvm, and jq from /usr/bin.
      env: {
        ...process.env,
        PATH: [path.join(os.homedir(), '.local/bin'), path.dirname(process.execPath),
          process.env.PATH ?? '', '/usr/bin', '/bin'].filter(Boolean).join(':'),
        ...extraEnv,
      },
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

function firstLine(text, limit = 300) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) ?? String(text);
  return line.length > limit ? `${line.slice(0, limit)}...` : line.trim();
}

// Standalone, so this can be proven on the mini before anything routes to it:
//   node worker/ads.mjs probe
//   node worker/ads.mjs company '{"name":"Solarvest","gMax":3}'
if (import.meta.filename === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  const payload = arg ? JSON.parse(arg) : {};
  const fn = { company, probe }[cmd] ?? probe;
  const out = await fn(payload);
  // Images are megabytes of base64; summarise them rather than flooding a terminal.
  const shown = JSON.parse(JSON.stringify(out, (k, v) => (k === 'image' ? `<data uri ${v.length}B>` : v)));
  console.log(JSON.stringify(shown, null, 2));
}
