// The scan's one rule, tested without needing Google to misbehave on cue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './gmap.mjs';

const page = (over = {}) => ({
  feedPresent: true,
  signals: { captcha: false, consent: false, limitedView: false, signedIn: true, ...(over.signals ?? {}) },
  ...over,
});
const list = (n) => Array.from({ length: n }, (_, i) => ({ name: 'biz ' + i }));

test('an empty feed is blocked with a null count, never found: 0', () => {
  const r = classify(page(), [], 50);
  assert.equal(r.found, null, 'found must be null, not 0');
  assert.equal(r.blocked, true);
  assert.match(r.blockedReason, /soft block/);
});

test('a missing feed is blocked and named as such', () => {
  const r = classify(page({ feedPresent: false }), [], 50);
  assert.equal(r.found, null);
  assert.equal(r.blockedReason, 'no results feed');
});

test('captcha and consent are reported distinctly, results discarded', () => {
  assert.equal(classify(page({ signals: { captcha: true } }), list(9), 50).blockedReason, 'captcha');
  assert.equal(classify(page({ signals: { consent: true } }), list(9), 50).blockedReason, 'consent wall');
  // Results present but the page is compromised: the count is still withheld.
  assert.equal(classify(page({ signals: { captcha: true } }), list(9), 50).found, null);
});

test('a real result set counts, and caps only at the limit', () => {
  const ok = classify(page(), list(12), 50);
  assert.deepEqual([ok.found, ok.blocked, ok.capped], [12, false, false]);
  assert.equal(classify(page(), list(50), 50).capped, true);
});

test('a blocked scan is never also capped', () => {
  assert.equal(classify(page({ feedPresent: false }), [], 0).capped, false);
});

test('limitedView is carried through, and is not itself a block', () => {
  const r = classify(page({ signals: { limitedView: true, signedIn: false } }), list(30), 50);
  assert.equal(r.limitedView, true);
  assert.equal(r.blocked, false);
  assert.equal(r.found, 30);
});

// The failure this file did not cover: a keyword specific enough to name one
// business gets no feed at all, because Maps redirects to that place's own card.
// It was scored as a block and published as an empty report.
test('a place card with no feed is a reading, not a block', () => {
  const r = classify(page({ feedPresent: false, placeCard: true }), list(1), 10);
  assert.equal(r.blocked, false);
  assert.equal(r.found, 1);
  assert.equal(r.blockedReason, null);
  assert.equal(r.capped, false);
});

test('a place card that read nothing is still a block', () => {
  const r = classify(page({ feedPresent: false, placeCard: false }), [], 10);
  assert.equal(r.blocked, true);
  assert.equal(r.found, null);
  assert.equal(r.blockedReason, 'no results feed');
});

test('a captcha over a place card still blocks', () => {
  const r = classify(page({ feedPresent: false, placeCard: true, signals: { captcha: true } }), list(1), 10);
  assert.equal(r.blocked, true);
  assert.equal(r.blockedReason, 'captcha');
});

// Company identity. Google issues a place id per branch, so one registered
// company arrives as several rows; a storefront name is not unique at all.
import { placeKey, isRegisteredName } from './db.mjs';

test('a registered company name is the identity, whatever branch was scanned', () => {
  const hq     = { name: 'ERS Energy Sdn Bhd',   mapsUrl: 'x!19sChIJtSkymAA2zDERkMgdt9O8WV0' };
  const branch = { name: 'ERS Energy Sdn. Bhd.', mapsUrl: 'x!19sChIJ48t7BslLzDERLZoBKeYqomQ' };
  assert.equal(placeKey(hq), placeKey(branch));
  assert.equal(placeKey(hq), 'name:ers energy sdn bhd');
});

test('the same company from a feed row and a place card is one row', () => {
  const feed = { name: 'Eternalgy Sdn Bhd', address: '23-01, Jalan Mutiara Emas 10/19', mapsUrl: 'x!19sChIJj9bg8rlt2jERcLzNDSYhD-M' };
  const card = { name: 'Eternalgy Sdn Bhd', address: "23-01, Jalan Mutiara Emas 10/19, Taman Mount Austin, 81100 Johor Bahru, Johor Darul Ta'zim", mapsUrl: 'https://www.google.com/maps/place/Eternalgy+Sdn+Bhd/@1.55,103.78,17z/data=!16s%2Fg%2F11l5l59cd3' };
  assert.equal(placeKey(feed), placeKey(card));
});

test('a storefront name is NOT unique and keeps its per-branch place id', () => {
  const a = { name: 'The Store', address: ', 41, Jalan Radin Tengah',  mapsUrl: 'x!19sChIJpXZn5ohKzDERH2C4A_RWWYI' };
  const b = { name: 'The Store', address: ', Jalan Pandan Indah 1/25', mapsUrl: 'x!19sChIJczAti182zDER_dLODe-bPmM' };
  assert.notEqual(placeKey(a), placeKey(b));
  assert.equal(placeKey(a), 'ChIJpXZn5ohKzDERH2C4A_RWWYI');
});

test('the suffix test does not fire on a word that merely ends in one', () => {
  assert.equal(isRegisteredName('Klinik Mediviron'), false);
  assert.equal(isRegisteredName('Restoran Kesavan'), false);
  assert.equal(isRegisteredName('MR.DIY'), false);
  assert.equal(isRegisteredName('Ali Shopping Centre Sdn. Bhd.'), true);
  assert.equal(isRegisteredName('Verdant Solar Holdings Berhad'), true);
});
