// The Google Maps scan, as a worker job. Runs on the mini because it must run
// from a residential line — see docs/plan-macmini-worker.md.
//
// NO PLAYWRIGHT. This drives the Chrome already installed on the machine over
// raw CDP, using Node's global WebSocket. Zero dependencies, which for a process
// that must survive unattended for months is the point: nothing to keep updated,
// nothing that breaks on a transitive bump.
//
// TWO RULES CARRIED FROM THE PLAN, both about the same failure:
//
//   Google does not block, it DEGRADES. A throttled search returns fewer results
//   with no error and no captcha, and a town that was throttled then looks
//   identical to a town with few businesses.
//
//   1. An empty feed is NEVER `found: 0`. It is `blocked: true` with no count,
//      because during a soft block the two are indistinguishable and recording a
//      zero writes a lie into the dataset that nothing downstream can detect.
//   2. Yield is reported, never judged here. `found`, `capped` and the block
//      signals go back with the result so the caller can compare a town against
//      its own history — which is the only place a soft block is visible at all.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { saveScan, configured as dbConfigured } from './db.mjs';

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'chrome.exe';
  }
  if (process.platform === 'darwin') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(mac)) return mac;
  }
  if (process.platform === 'linux') {
    for (const l of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
      if (fs.existsSync(l)) return l;
    }
  }
  return process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const CHROME = findChrome();
const PORT = Number(process.env.GMAP_CDP_PORT ?? 9422);
/** The feed lazy-loads on scroll. Stop when the count stops moving, not at a fixed depth. */
const PLATEAU_ROUNDS = 4;
const MAX_SCROLLS = 60;
const SCROLL_PAUSE_MS = 1600;
const SETTLE_MS = 9000;
const MAPS = 'https://www.google.com/maps/search/';

/**
 * The categories a location-only sweep walks. Google Maps has no "everything
 * here" list — it only ever answers a keyword inside a viewport — so a town is
 * covered by asking several broad questions and merging the answers.
 *
 * The list is ordered widest-first and the sweep STOPS as soon as `max` is
 * reached, so the usual run is three or four queries, not ten. Override per job
 * with payload.categories when a caller wants a particular trade.
 */
const TOWN_CATEGORIES = [
  'restaurants', 'shops', 'clinic', 'car repair', 'hardware store',
  'contractor', 'beauty salon', 'grocery store', 'cafe', 'hotel',
];

/** Same key db.mjs dedupes on, so a merged sweep cannot land one shop twice. */
function dedupeKey(b) {
  const m = /!19s([A-Za-z0-9_-]+)/.exec(b.mapsUrl ?? '');
  return m ? m[1] : 'name:' + (b.name ?? '').toLowerCase().trim() + '|' + (b.address ?? '').toLowerCase().trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launchChrome(profile) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    // The automation flag is the one signal that is free to remove and is checked
    // by everything. It is not a stealth suite and does not pretend to be.
    '--disable-blink-features=AutomationControlled',
    '--window-size=1440,900',
    'about:blank',
  ];
  return spawn(CHROME, args, { stdio: 'ignore' });
}

async function connect() {
  // Chrome needs a moment before the debugging port answers; poll rather than
  // sleep a guessed amount, so a slow machine does not fail and a fast one is
  // not punished.
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('Chrome never opened a debuggable page on port ' + PORT);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('could not attach to Chrome over CDP'));
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const cdp = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error('page script failed: ' + r.result.exceptionDetails.text);
    }
    return r.result?.result?.value;
  };
  return { ws, cdp, evaluate };
}

/**
 * Runs in the page. Reads one card per result from the feed.
 *
 * Google's class names are generated and change without notice, so structure and
 * ARIA carry the meaning here: the place link identifies the card, the rating is
 * an aria-label, and the rest is the card's own text split on the separator
 * Maps uses. Where a class IS used it is a fallback behind a structural path,
 * never the only route to a field.
 */
const EXTRACT = `(() => {
  const feed = document.querySelector('[role="feed"]');
  const body = document.body.innerText || '';
  const cards = feed ? [...feed.children].filter((c) => c.querySelector('a[href*="/maps/place/"]')) : [];

  const businesses = cards.map((card) => {
    const link = card.querySelector('a[href*="/maps/place/"]');
    const text = card.innerText || '';
    const lines = text.split('\\n').map((s) => s.trim()).filter(Boolean);

    const stars = card.querySelector('[role="img"][aria-label*="star"]');
    const starsLabel = stars ? (stars.getAttribute('aria-label') || '') : '';
    const ratingFromAria = /([\\d.]+)/.exec(starsLabel);
    // Signed out, Maps serves "4.7 stars" with no count at all, so this is null far
    // more often than it is wrong. See limitedView in the result: a null here when
    // limitedView is true is missing data, not a place with no reviews.
    const reviews = /\\((\\d[\\d,]*)\\)/.exec(text) || /(\\d[\\d,]*)\\s*review/i.exec(starsLabel + ' ' + text);

    // "Air conditioning contractor · 04-02, Blok B, Jalan Petaling 1"
    const catAddr = lines.find((l) => l.includes('\u00b7') && !/^(Open|Closed|Opens|Closes)/.test(l));
    // Spacing around the separator is irregular and some slots are empty — that
    // gap is where an accessibility badge sits when the place has one.
    const parts = catAddr ? catAddr.split(/\s*\u00b7\s*/).map((s) => s.trim()).filter(Boolean) : [];

    const phone = /(\\+?\\d[\\d\\s-]{6,}\\d)/.exec(text.replace(/\\(\\d[\\d,]*\\)/g, ''));
    // A business's own website is never on a Google host. The old test ruled out
    // /maps only, so the "search Google for X" link -- which Maps renders inside
    // cards that have no website at all -- passed as the website and was carried
    // into company research as if it were the company's homepage. Five of the ten
    // rows in the 22 Aug Taman Molek scan were exactly that.
    const site = [...card.querySelectorAll('a[href]')].find((a) => {
      if (!/^https?:/.test(a.href)) return false;
      let host = '';
      try { host = new URL(a.href).hostname.toLowerCase(); } catch (err) { return false; }
      return !/(^|\\.)google\\.[a-z.]+$/.test(host) && !/(^|\\.)goo\\.gl$/.test(host);
    });

    return {
      name: link?.getAttribute('aria-label') || lines[0] || null,
      rating: ratingFromAria ? Number(ratingFromAria[1]) : null,
      reviews: reviews ? Number(reviews[1].replace(/,/g, '')) : null,
      category: parts.length > 1 ? parts[0] : null,
      address: parts.length > 1 ? parts.slice(1).join(', ').replace(/^,\s*|,\s*$/g, '') : (parts[0] ?? null),
      phone: phone ? phone[1].trim() : null,
      website: site ? site.href : null,
      mapsUrl: link ? link.href : null,
    };
  });

  return {
    businesses,
    feedPresent: !!feed,
    // Every way this page says "you are not getting the real thing".
    signals: {
      captcha: /unusual traffic|not a robot|recaptcha/i.test(body),
      consent: /before you continue|consent\\.google/i.test(body + location.href),
      limitedView: /limited view of Google Maps/i.test(body),
      signedIn: !/\\bSign in\\b/.test(body),
    },
    title: document.title,
  };
})()`;

/**
 * Runs in the page. Reads the ONE place Maps redirected us to.
 *
 * A query specific enough to match a single business -- which is every "research
 * this company" lookup -- never renders a results feed at all. Maps sends the
 * browser to /maps/place/<name> and draws that place's own detail card instead.
 * The old code saw no feed, called it `blocked: no results feed`, and returned
 * zero rows, while the name, rating, category, address, phone and website sat on
 * the screen the whole time. Four rounds of research then ran on an empty list
 * and published an empty report -- `eternalgy sdn bhd johor`, 23 Aug.
 *
 * Read through `data-item-id`, which is Maps' own hook for these rows
 * (`address`, `authority` = website, `phone:tel:...`), for the same reason the
 * feed extractor leans on ARIA: the class names are generated and change.
 */
const EXTRACT_PLACE = `(() => {
  const body = document.body.innerText || '';
  const main = document.querySelector('div[role="main"][aria-label]');
  const name = (document.querySelector('h1')?.innerText || main?.getAttribute('aria-label') || '').trim();

  const addrEl = document.querySelector('[data-item-id="address"]');
  const siteEl = document.querySelector('[data-item-id="authority"]');
  const telEl  = document.querySelector('[data-item-id^="phone:tel:"]');
  // "Address: 23-01, Jalan Mutiara Emas 10/19, ..." -- the label carries the
  // full value, the visible text is sometimes truncated.
  const clean = (s) => (s || '').replace(/^(Address|Phone|Website):\\s*/i, '').trim() || null;

  const starsLabel = document.querySelector('[role="img"][aria-label*="star"]')?.getAttribute('aria-label') || '';
  const rating = /([\\d.]+)/.exec(starsLabel);
  // Same as the feed: signed out, Maps serves "4.7 stars" with no count at all.
  const reviews = /\\((\\d[\\d,]*)\\)/.exec(starsLabel) || /(\\d[\\d,]*)\\s*review/i.exec(starsLabel);

  const lines = (main?.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  let category = document.querySelector('button[jsaction*="category"]')?.innerText.trim() || null;
  if (!category && rating) {
    const i = lines.indexOf(rating[1]);
    if (i >= 0 && lines[i + 1]) category = lines[i + 1];
  }

  const business = !name ? null : {
    name,
    rating: rating ? Number(rating[1]) : null,
    reviews: reviews ? Number(reviews[1].replace(/,/g, '')) : null,
    category: category || null,
    address: clean(addrEl?.getAttribute('aria-label') || addrEl?.innerText),
    phone: clean(telEl?.getAttribute('aria-label') || telEl?.innerText),
    // Already ruled out as a Google host by being the card's own website row.
    website: siteEl?.href || null,
    mapsUrl: location.href,
  };

  return {
    businesses: business ? [business] : [],
    // Stays false: there really was no feed, and which path produced the rows is
    // worth being able to see. placeCard is what says the page WAS read.
    feedPresent: false,
    placeCard: !!business,
    signals: {
      captcha: /unusual traffic|not a robot|recaptcha/i.test(body),
      consent: /before you continue|consent\\.google/i.test(body + location.href),
      limitedView: /limited view of Google Maps/i.test(body),
      signedIn: !/\\bSign in\\b/.test(body),
    },
    title: document.title,
  };
})()`;

/**
 * Wait for the feed to actually exist rather than sleeping a guessed amount.
 * `connect()` already polls for this reason: a slow machine must not fail and a
 * fast one must not be punished. A sweep runs several of these back to back, so
 * the difference is the whole cost of the feature.
 */
async function waitForFeed(conn, timeoutMs = SETTLE_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const n = await conn.evaluate(`document.querySelectorAll('a[href*="/maps/place/"]').length`);
    if (n > 0) return true;
    await sleep(150);
  }
  return false;
}

/** Navigate, scroll the feed to its plateau, and read it. One query's worth of work. */
async function harvest(conn, url, max) {
  await conn.cdp('Page.navigate', { url });
  await waitForFeed(conn);
  let last = -1;
  let stable = 0;
  let scrolls = 0;
  const maxScrolls = Math.max(MAX_SCROLLS, Math.ceil((max || 200) / 3));

  for (; scrolls < maxScrolls && stable < PLATEAU_ROUNDS; scrolls++) {
    const check = await conn.evaluate(`(() => {
      const f = document.querySelector('[role="feed"]');
      if (f) f.scrollTop = f.scrollHeight;
      const count = document.querySelectorAll('a[href*="/maps/place/"]').length;
      const ended = f ? Boolean(
        f.querySelector('.HlvSq') ||
        /(you've reached the end|end of the list|no more results|没有更多结果)/i.test(f.innerText || '')
      ) : false;
      return { count, ended };
    })()`);

    const n = check?.count ?? 0;
    if (check?.ended) {
      last = n;
      break;
    }
    if (n === last) stable++;
    else {
      stable = 0;
      last = n;
    }
    if (last >= max) break;

    // Adaptive wait: poll every 100ms for new cards to appear, then apply natural 400ms human pause
    const startWait = Date.now();
    let batchLoaded = false;
    while (Date.now() - startWait < 1500) {
      await sleep(100);
      const pollCheck = await conn.evaluate(`(() => {
        const f = document.querySelector('[role="feed"]');
        const count = document.querySelectorAll('a[href*="/maps/place/"]').length;
        const ended = f ? Boolean(
          f.querySelector('.HlvSq') ||
          /(you've reached the end|end of the list|no more results|没有更多结果)/i.test(f.innerText || '')
        ) : false;
        return { count, ended };
      })()`);
      if (pollCheck?.ended) {
        last = pollCheck.count;
        stable = PLATEAU_ROUNDS;
        batchLoaded = true;
        break;
      }
      if (pollCheck && pollCheck.count > last) {
        last = pollCheck.count;
        stable = 0;
        batchLoaded = true;
        await sleep(400);
        break;
      }
    }
  }
  const page = await conn.evaluate(EXTRACT);
  return { page, scrolls };
}

/**
 * Turn a page reading into a verdict. Exported and pure because this is THE rule
 * of the whole scan and it must not depend on catching Google in the act: a real
 * empty feed is rare on demand — a nonsense query still returns fuzzy matches —
 * so the branch that matters most would otherwise never be exercised.
 *
 * An empty feed returns `found: null, blocked: true`, never `found: 0`. During a
 * soft block the two readings are identical, and a 0 written into the dataset is
 * a claim about the town that nothing downstream can tell apart from the truth.
 */
export function classify(page, businesses, max) {
  const sig = page.signals;
  // A place card is a real reading of a real business, not a missing feed --
  // see EXTRACT_PLACE. Judging it a block is what published the empty report.
  const readable = page.feedPresent || page.placeCard === true;
  const blocked = sig.captcha || sig.consent || !readable || businesses.length === 0;
  return {
    found: blocked ? null : businesses.length,
    capped: !blocked && businesses.length >= max,
    blocked,
    blockedReason: !blocked
      ? null
      : sig.captcha
        ? 'captcha'
        : sig.consent
          ? 'consent wall'
          : !readable
            ? 'no results feed'
            : 'feed returned nothing — indistinguishable from a soft block, not recorded as 0',
    // Not a block on its own — Maps serves this to any signed-out session — but it
    // is what separates two runs that otherwise look the same, and it is why
    // `reviews` comes back null.
    limitedView: sig.limitedView,
    signedIn: sig.signedIn,
  };
}

/**
 * @param {{keyword?:string, place?:string, searchMode?:string, originalPlace?:string, max?:number}} payload
 * @returns {Promise<{businesses:Array, found:number|null, capped:boolean, blocked:boolean, ...}>}
 */
export async function scan(payload, job = null) {
  const locationOnly = payload?.searchMode === 'location_only';
  const keyword = locationOnly ? '' : (payload?.keyword ?? '').trim();
  const place = locationOnly
    ? (payload?.originalPlace ?? payload?.place ?? payload?.keyword ?? '').trim()
    : (payload?.place ?? '').trim();
  if (!keyword && !place) throw new Error('gmap.scan needs a keyword or place');
  const max = Number(payload?.max) > 0 ? Number(payload.max) : 200;
  const query = [keyword, place].filter(Boolean).join(' ');

  const profile = path.join(os.tmpdir(), 'gmap-worker-profile');
  const chrome = launchChrome(profile);
  const startedAt = Date.now();
  let ws = null;

  try {
    const conn = await connect();
    ws = conn.ws;
    await conn.cdp('Page.enable');
    try {
      await conn.cdp('Network.enable');
      await conn.cdp('Network.setBlockedURLs', {
        urls: [
          '*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.svg',
          '*google-analytics.com*', '*googletagmanager.com*',
          '*/maps/vt*', '*/vt/data=*', '*/khms*'
        ],
      });
    } catch {
      /* non-fatal if Network domain is unavailable */
    }

    let { page, scrolls } = await harvest(conn, MAPS + encodeURIComponent(query) + '?hl=en', max);
    let businesses = page.businesses.filter((b) => b.name);
    let categories = null;

    // A keyword specific enough to name one business is not a search either:
    // Maps redirects to that place's card and there is no feed to read. This is
    // the shape of EVERY company-research lookup, and it was returning zero.
    if (keyword && !page.feedPresent && businesses.length === 0) {
      const href = await conn.evaluate('location.href');
      if (href && href.includes('/maps/place/')) {
        page = await conn.evaluate(EXTRACT_PLACE);
        businesses = page.businesses.filter((b) => b.name);
      }
    }

    // A bare town name is not a search. Maps resolves it to the town's own map
    // card, so there is no results feed to read and the old code called that a
    // block. The redirect carries the viewport, and that is what turns the one
    // dead query into a sweep: several broad categories asked inside the town's
    // own map, merged. Google has no "everything here" list to ask for.
    if (!keyword && place && !page.feedPresent) {
      const at = /@(-?[\d.]+),(-?[\d.]+),([\d.]+)z/.exec(await conn.evaluate('location.href'));
      if (at) {
        const viewport = '@' + at[1] + ',' + at[2] + ',' + at[3] + 'z';
        const cats = Array.isArray(payload?.categories) && payload.categories.length
          ? payload.categories
          : TOWN_CATEGORIES;
        const seen = new Map();
        categories = [];
        scrolls = 0;
        for (const cat of cats) {
          const h = await harvest(conn, MAPS + encodeURIComponent(cat) + '/' + viewport + '?hl=en', max);
          const got = h.page.businesses.filter((b) => b.name);
          for (const b of got) {
            const k = dedupeKey(b);
            if (!seen.has(k)) seen.set(k, b);
          }
          categories.push({ category: cat, got: got.length, running: seen.size });
          scrolls += h.scrolls;
          // The verdict is read off the last page seen: a sweep that ends on a
          // captcha must still come back blocked rather than merely short.
          page = h.page;
          if (seen.size >= max) break;
        }
        businesses = [...seen.values()];
      }
    }

    businesses = businesses.slice(0, max);

    const result = {
      query,
      keyword,
      place: place || null,
      businesses,
      ...classify(page, businesses, max),
      categories,
      scrolls,
      tookMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    };

    // The scan is the expensive part and it has already happened. A database
    // that is down, or a token that expired overnight, must not turn a good
    // scan into a failed job — the rows come back either way and the failure is
    // reported in the result where it can be seen.
    if (dbConfigured()) {
      try {
        result.saved = await saveScan(result, {
          jobId: job?.id ?? null,
          worker: process.env.WORKER_NAME || os.hostname(),
          userId: payload?.userId ?? null,
        });
      } catch (err) {
        result.saved = null;
        result.saveError = err.message;
      }
    }

    return result;
  } finally {
    try { ws?.close(); } catch { /* already gone */ }
    chrome.kill('SIGKILL');
  }
}

if (process.argv[1] && (process.argv[1].endsWith('gmap.mjs') || process.argv[1].endsWith('gmap'))) {
  const keyword = process.argv[2] ?? '';
  const place = process.argv[3] ?? '';
  const max = Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 20;
  console.log(`[gmap.mjs CLI] Starting scan: keyword="${keyword}", place="${place}", max=${max}`);
  scan({ keyword, place, max })
    .then((r) => {
      console.log(`[gmap.mjs CLI] Completed in ${r.tookMs}ms (${(r.tookMs / 1000).toFixed(1)}s).`);
      console.log(`Results: ${r.businesses.length} businesses, found=${r.found}, capped=${r.capped}, blocked=${r.blocked}, scrolls=${r.scrolls}`);
      console.log('--- Sample Businesses ---');
      r.businesses.slice(0, 10).forEach((b, i) => {
        console.log(`${i + 1}. ${b.name} | Phone: ${b.phone || 'N/A'} | Category: ${b.category || 'N/A'} | Address: ${b.address || 'N/A'}`);
      });
      if (r.businesses.length > 10) {
        console.log(`... and ${r.businesses.length - 10} more businesses.`);
      }
    })
    .catch((err) => {
      console.error('[gmap.mjs CLI] Failed:', err);
      process.exit(1);
    });
}
