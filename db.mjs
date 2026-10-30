// Writing a scan into Postgres, through the pg-proxy.
//
// The proxy is an HTTP endpoint that takes parameterised SQL, so there is no pg
// driver here and no connection pool to keep alive across a 25s idle poll —
// which suits a worker that spends almost all its life doing nothing.
//
// WHAT IS PRESERVED HERE. The scan's one rule survives into storage rather than
// being re-decided: a blocked scan writes `found = null`, never 0, and the table
// carries a CHECK constraint saying so. If this code ever regresses, the insert
// fails loudly instead of writing a quiet lie about a town.
const URL_ = () => (process.env.PG_PROXY_URL ?? '').replace(/\/+$/, '');
const DB = () => process.env.PG_DB_NAME ?? '';
const TOKEN = () => process.env.PG_PROXY_TOKEN ?? '';

export function configured() {
  return Boolean(URL_() && DB() && TOKEN());
}

export async function sql(text, params = []) {
  const r = await fetch(URL_() + '/api/sql', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN(), 'content-type': 'application/json' },
    body: JSON.stringify({ db_name: DB(), sql: text, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await r.text();
  if (!r.ok) {
    // The token is short-lived and the proxy reports a bad one as 400 with a
    // message, not as 401 — so status alone is not enough to recognise it. Left
    // unnamed this reads like a query bug at 3am, when it is only ever "paste a
    // new token into ~/.gmap-worker.env".
    if (r.status === 401 || r.status === 403 || /token|jwt|expired|signature/i.test(body)) {
      throw new Error(
        'pg-proxy rejected the token (' + r.status + ': ' + body.slice(0, 120) +
        ') — refresh PG_PROXY_TOKEN in ~/.gmap-worker.env',
      );
    }
    throw new Error('pg-proxy ' + r.status + ': ' + body.slice(0, 300));
  }
  return JSON.parse(body);
}

/**
 * A REGISTERED COMPANY NAME IS THE IDENTITY. No registry will hold two live
 * "Eternalgy Sdn Bhd" at once, so two rows carrying that name are one company
 * seen twice -- which is exactly what happened: a feed scan stored it on 21 Aug
 * as ChIJj9bg8rlt2jERcLzNDSYhD-M, a place-card scan stored the same business
 * again on 23 Aug, and the second dossier could not see the first three.
 *
 * A SHOP NAME IS NOT. This table holds five separate "The Store" branches with
 * five different phone numbers, and two "MR.DIY". Keying those by name would
 * merge real, distinct places into one row and lose four of them.
 *
 * So the rule follows the fact rather than overriding it: a name carrying a
 * registered-entity suffix is country-unique and keys on the name; everything
 * else keeps Google's place id, which is per-branch and correct for branches.
 */
const REGISTERED_SUFFIX =
  /\b(?:sdn\.?\s*bhd|sendirian\s+berhad|berhad|bhd|plt|llp|pte\.?\s*ltd|ltd|limited|inc|incorporated|corp|corporation|gmbh|pty|gida)\.?$/i;

/** Lowercase, punctuation-free, single-spaced — so "MR.DIY" and "Mr. DIY" agree. */
function normaliseName(name) {
  return (name ?? '')
    .toLowerCase()
    .replace(/[.,'"`’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the name names a registered legal entity rather than a storefront. */
export function isRegisteredName(name) {
  return REGISTERED_SUFFIX.test(normaliseName(name));
}

/** The dedupe key for one business row. See the note above for why it branches. */
export function placeKey(b) {
  const norm = normaliseName(b.name);
  if (norm && isRegisteredName(b.name)) return 'name:' + norm;
  const m = /!19s([A-Za-z0-9_-]+)/.exec(b.mapsUrl ?? '');
  if (m) return m[1];
  // A result with no id is rare but must still dedupe, or a weekly scan of the
  // same town grows a duplicate row every run.
  return 'name:' + norm + '|' + (b.address ?? '').toLowerCase().trim();
}

/**
 * Persist one scan: the companies it found, the report itself, and the link
 * between them. Returns the report id.
 */
export async function saveScan(result, { jobId = null, worker = null, userId = null } = {}) {
  const businesses = result.businesses ?? [];

  // 1. Companies, upserted on Google's place id. A company seen in an earlier
  //    search is refreshed and re-linked, never duplicated.
  const byKey = new Map();
  for (const b of businesses) if (!byKey.has(placeKey(b))) byKey.set(placeKey(b), b);
  const rows = [...byKey.entries()];

  let idByKey = new Map();
  if (rows.length) {
    const cols = 9;
    const values = rows
      .map((_, i) => '(' + Array.from({ length: cols }, (_, j) => '$' + (i * cols + j + 1)).join(',') + ')')
      .join(',');
    const params = rows.flatMap(([key, b]) => [
      key, b.name, b.rating, b.reviews, b.category, b.address, b.phone, b.website, b.mapsUrl,
    ]);
    const out = await sql(
      `insert into company_data (place_id,name,rating,reviews,category,address,phone,website,maps_url)
       values ${values}
       on conflict (place_id) do update set
         name     = excluded.name,
         rating   = coalesce(excluded.rating,   company_data.rating),
         reviews  = coalesce(excluded.reviews,  company_data.reviews),
         category = coalesce(excluded.category, company_data.category),
         -- The place card carries the full postal address; a feed card carries a
         -- truncated one. Merging the same company from both must not shorten it.
         address  = case
                      when length(coalesce(excluded.address, '')) > length(coalesce(company_data.address, ''))
                      then excluded.address else company_data.address
                    end,
         phone    = coalesce(excluded.phone,    company_data.phone),
         website  = coalesce(excluded.website,  company_data.website),
         maps_url = excluded.maps_url,
         last_seen_at = now()
       returning id, place_id`,
      params,
    );
    idByKey = new Map(out.rows.map((r) => [r.place_id, r.id]));
  }

  // 2. The report. `found` is null for a blocked scan — the constraint enforces it.
  const report = await sql(
    `insert into search_report
       (user_id, keyword, place, query, found, blocked, blocked_reason, capped, limited_view, job_id, worker, took_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id`,
    [
      userId, result.keyword, result.place, result.query,
      result.blocked ? null : result.found,
      Boolean(result.blocked), result.blockedReason, Boolean(result.capped),
      result.limitedView ?? null, jobId, worker, result.tookMs ?? null,
    ],
  );
  const reportId = report.rows[0].id;

  // 3. The list, in the order Maps returned it — rank is the feed position, which
  //    is the only ranking signal a scan actually observes.
  const links = businesses
    .map((b, i) => [idByKey.get(placeKey(b)), i + 1])
    .filter(([id]) => id != null);
  if (links.length) {
    const values = links.map((_, i) => '($' + (i * 3 + 1) + ',$' + (i * 3 + 2) + ',$' + (i * 3 + 3) + ')').join(',');
    await sql(
      `insert into search_report_company (report_id, company_id, rank)
       values ${values} on conflict (report_id, company_id) do nothing`,
      links.flatMap(([companyId, rank]) => [reportId, companyId, rank]),
    );
  }

  return { reportId, companies: rows.length, linked: links.length };
}
