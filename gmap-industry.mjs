#!/usr/bin/env node
// Resumable local industry sweep. This does not load the worker's cloud credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

// Geographic search seeds, not a complete list of towns or a coverage guarantee.
export const WEST_MALAYSIA = [
  'Kuala Lumpur', 'Putrajaya', 'Petaling Jaya Selangor', 'Shah Alam Selangor', 'Subang Jaya Selangor', 'Klang Selangor', 'Kajang Selangor', 'Puchong Selangor', 'Rawang Selangor', 'Sepang Selangor', 'Kuala Selangor Selangor', 'Hulu Selangor Selangor',
  'George Town Penang', 'Bayan Lepas Penang', 'Butterworth Penang', 'Bukit Mertajam Penang', 'Nibong Tebal Penang',
  'Johor Bahru Johor', 'Iskandar Puteri Johor', 'Kulai Johor', 'Batu Pahat Johor', 'Muar Johor', 'Kluang Johor', 'Pontian Johor', 'Segamat Johor', 'Mersing Johor', 'Kota Tinggi Johor',
  'Ipoh Perak', 'Taiping Perak', 'Manjung Perak', 'Teluk Intan Perak', 'Batu Gajah Perak', 'Kuala Kangsar Perak', 'Tapah Perak', 'Sungai Siput Perak', 'Gerik Perak',
  'Alor Setar Kedah', 'Sungai Petani Kedah', 'Kulim Kedah', 'Langkawi Kedah', 'Jitra Kedah', 'Baling Kedah', 'Kangar Perlis',
  'Seremban Negeri Sembilan', 'Port Dickson Negeri Sembilan', 'Nilai Negeri Sembilan', 'Bahau Negeri Sembilan', 'Kuala Pilah Negeri Sembilan',
  'Melaka Melaka', 'Alor Gajah Melaka', 'Jasin Melaka', 'Kuantan Pahang', 'Temerloh Pahang', 'Bentong Pahang', 'Raub Pahang', 'Pekan Pahang', 'Mentakab Pahang', 'Jerantut Pahang',
  'Kuala Terengganu Terengganu', 'Kemaman Terengganu', 'Dungun Terengganu', 'Besut Terengganu', 'Kota Bharu Kelantan', 'Pasir Mas Kelantan', 'Tanah Merah Kelantan', 'Kuala Krai Kelantan', 'Gua Musang Kelantan',
];

// Match identical Google place links first. Do not merge different branches just
// because they share a registered company name.
export function businessKey(b) {
  if (b.place_id) return 'place:' + b.place_id;
  const url = b.mapsUrl || '';
  const id = /!19s([^!?#&]+)/.exec(url)?.[1] || /!1s([^!?#&]+)/.exec(url)?.[1];
  if (id) return 'place:' + decodeURIComponent(id);
  const clean = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (b.name && b.address) return 'name-address:' + clean(b.name) + '|' + clean(b.address);
  return url ? 'url:' + url.split('?')[0] : 'name:' + clean(b.name);
}
export function mergeResults(scans) {
  const byKey = new Map();
  for (const scan of scans.filter(s => !s.blocked && !s.error)) for (const b of scan.businesses || []) {
    const key = businessKey(b);
    if (!byKey.has(key)) byKey.set(key, {...b, searches: []});
    const row = byKey.get(key);
    for (const field of ['phone','website','address','category','rating','reviews','mapsUrl']) if (!row[field] && b[field]) row[field] = b[field];
    row.searches.push({keyword:scan.keyword, place:scan.place});
  }
  return [...byKey.values()];
}
function writeCsv(file, rows) {
  const fields = ['name','category','address','phone','website','rating','reviews','mapsUrl'];
  const cell = value => { const text = String(value ?? ''); const safe = /^[=+@\-]/.test(text) ? "'" + text : text; return '"' + safe.replaceAll('"', '""') + '"'; };
  fs.writeFileSync(file + '.tmp', [fields.join(','), ...rows.map(row => fields.map(field => cell(row[field])).join(','))].join('\n') + '\n');
  fs.renameSync(file + '.tmp', file);
}
function writeAtomic(file, data) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function parseArgs(args) {
  const o = {keywords: [], places: null, output: null, max: 200, delayMs: 2000};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!['--keyword','--places','--output','--max','--delay-ms'].includes(flag) || !args[i+1]) throw new Error('Usage: node gmap-industry.mjs --keyword "advertising agency" --output results.json [--keyword synonym] [--places towns.txt] [--max 200] [--delay-ms 2000]');
    const value = args[++i];
    if (flag === '--keyword') o.keywords.push(value.trim());
    else if (flag === '--places') o.places = value;
    else if (flag === '--output') o.output = value;
    else if (flag === '--max') o.max = Number(value);
    else o.delayMs = Number(value);
  }
  if (!o.keywords.length || o.keywords.some(x => !x) || !o.output || !Number.isInteger(o.max) || o.max < 1 || !Number.isFinite(o.delayMs) || o.delayMs < 0) throw new Error('Provide at least one --keyword, --output, a positive integer --max and a nonnegative --delay-ms.');
  return o;
}
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const places = o.places ? fs.readFileSync(o.places, 'utf8').split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.startsWith('#')) : WEST_MALAYSIA;
  if (!places.length) throw new Error('The places list is empty.');
  const plan = {keywords:o.keywords, places, max:o.max};
  const output = path.resolve(o.output);
  const state = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : {version:1, plan, scans:[]};
  if (JSON.stringify(state.plan) !== JSON.stringify(plan)) throw new Error('Existing output has a different search plan; choose a new output file.');
  console.log('Resumed '+state.scans.filter(s => !s.blocked && !s.error).length+' completed searches.');
  // Each sweep has a separate Chrome profile and debugging port, isolated from
  // the installed worker. No .env is loaded; no database writes are made.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmap-industry-'));
  process.env.TMPDIR = temp;
  process.env.GMAP_CDP_PORT = String(await freePort());
  delete process.env.PG_PROXY_URL;
  const {scan} = await import('./gmap.mjs');
  try {
    for (const keyword of o.keywords) for (const place of places) {
      if (state.scans.some(s => s.keyword === keyword && s.place === place && !s.blocked && !s.error)) continue;
      console.log(`Scanning ${keyword} / ${place}`);
      let result;
      try { result = await scan({keyword, place, max:o.max}); }
      catch (error) { result = {keyword, place, error:error.message, businesses:[]}; }
      // A retry replaces a previous blocked or failed attempt for that query.
      state.scans = state.scans.filter(s => s.keyword !== keyword || s.place !== place);
      result.possibleLimit = !result.blocked && (result.found >= 120 || result.capped === true);
      state.scans.push(result);
      state.businesses = mergeResults(state.scans);
      state.updatedAt = new Date().toISOString();
      state.summary = {planned: o.keywords.length * places.length, completed: state.scans.filter(s => !s.blocked && !s.error).length, possibleLimits: state.scans.filter(s => s.possibleLimit).length, unique: state.businesses.length};
      writeAtomic(output, state);
      writeCsv(output.replace(/\.json$/i, '') + '.csv', state.businesses);
      console.log(JSON.stringify({place, found:result.found, blocked:result.blocked, reason:result.blockedReason, error:result.error, possibleLimit:result.found >= 120 || result.capped, unique:state.businesses.length}));
      if (result.blocked || result.error) { console.error('Stopped; inspect the issue and rerun the same command to retry this search.'); process.exitCode = 1; return; }
      if (o.delayMs) await new Promise(resolve => setTimeout(resolve, o.delayMs));
    }
    console.log(`Finished ${state.scans.length} searches; ${state.businesses.length} unique listings. Review each search for possible result limits and subdivide locations.`);
  } finally { fs.rmSync(temp, {recursive:true, force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode=1; });
