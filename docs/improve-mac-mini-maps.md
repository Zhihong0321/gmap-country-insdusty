# Improving the Mac mini's Google Maps scan

Note, 2026-10-30. How the Mac mini's Maps scan (`gmap.mjs`) can learn from the
Gmap Local Worker that now runs on a Windows PC for the EE Auto hub.

## Where things stand

The hub now runs country-industry research itself, with this repo's pipeline
copied into `automation-tools/agy-lab/src/country/`. Each city search is a
`gmap.scan` job on the hub queue, so any of three Maps workers can answer it:

| Worker | How it reads Google Maps |
|---|---|
| scraper.tech lanes (in the hub) | scraper.tech's paid Maps API |
| Gmap Local Worker (`pc-*`, Windows PC) | Google Maps' own result-list pages, fetched directly, no browser |
| Mac mini (`m4-mini`) | `gmap.mjs`: headless Chrome, scroll the results feed, read the cards |

The mini answers only these country city searches (jobs with
`source: 'country.industry'`), never business searches or taman scans.

## The same search on all three

"advertising agency" in "Johor Bahru, Johor, Malaysia", max 200, run at the
same time on 2026-10-30:

| | Mac mini | scraper.tech | Windows PC |
|---|---|---|---|
| Businesses | 120 | 149 | **193** |
| Time | 19 s | 12 s | 14 s |
| Phone | 98% | 95% | 94% |
| Website | **66%** | 42% | 46% |
| Rating | 81% | 47% | 51% |
| Full address (city + postcode) | **2%** | 87% | 87% |
| Review count | missing | yes | yes |
| Memory | a Chrome | none on the mini | almost none |

Overlap by Google place id:

- 40 businesses are in all three results.
- 138 are in both scraper.tech's and the PC's.
- 60 were found only by the mini, 43 only by the PC, and 6 only by scraper.tech.
- Together the three found 264.

Earlier, on this PC, the factory sweep of Taman Daya (19 searches) compared three engines:

- **Headless Chromium** with a scroll and a visit to every business page (gosom): about 374 businesses. It reached only 7 of the 19 searches in 8 minutes.
- **The list-page reader:** 818 businesses in 2.7 minutes, 128 Google requests.
- **scraper.tech:** 839.

## What the mini's scan does today, and what it costs

`gmap.mjs` drives Chrome over CDP and reads the results feed's DOM:

1. **The list stops at about 120.** Google's web feed stops there. The list
   pages below go to about 180 for the same search.
2. **Addresses are cut short.** The feed card shows only the street line
   ("19-03, 21-03, Blok B, Kompleks, Jalan Austin Perdana 2"), with no taman,
   postcode or city. Results then cannot be checked for being in the place,
   and street-by-street sweeps cannot be built from them.
3. **No review count.** Signed out, the feed shows "4.9 stars" and no count
   (`limitedView`).
4. **The scroll is slow.** Each search waits for lazy loading until the count
   stops moving, about 15–70 s per search.
5. **It uses a whole browser:** RAM, a profile, and Chrome updates to keep up with.

What it does better: 66% of its rows carry a website, against 42–46% from the
other two, and 60 businesses that neither of the others found. The signed-out
web feed seems to rank results differently. That is worth keeping, not
replacing.

## What the PC worker does instead

When you scroll the Maps result list, the page loads it from
`https://www.google.com/search?tbm=map&...&pb=...` in pages of 20. Each page
already holds every field the card shows, plus the full address, review count,
coordinates and place id. The PC worker requests those pages itself, one after
another, half a second apart. No browser is involved.

The request:

```
GET https://www.google.com/search?tbm=map&authuser=0&hl=en&gl=my&q=<query>&pb=<pb>

pb = !4m12!1m3!1d3826.902183192154!2d<lon>!3d<lat>!2m3!1f0!2f0!3f0!3m2!1i600!2i800!4f15.0
     !7i20!8i<offset>
     !10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1
     !20m3!5e2!6b1!14b1!46m1!1b0!96b1!19m4!2m3!1i360!2i120!4i8
```

- **Page size and position:** `!7i20` is the page size and `!8i<offset>` is the page start (0, 20, 40, …).
- **When to stop:** at the first page with fewer than 20 rows, or after 15 pages.
- **Map centre:** `!2d<lon>!3d<lat>` is the map centre. The query text places the search on its own, so even a Kuala Lumpur centre returns Johor Bahru for "factory in Taman Daya". The worker pins later searches to the median coordinates of the first search's in-area rows.

The response's first line is `)]}'`. The rest is JSON. The businesses are
`data[0][1][1..]`, and each business array is `item[14]`. The field positions
come from gosom/google-maps-scraper (MIT): `ParseSearchResults` in
`gmaps/multiple.go`, plus the place id from `gmaps/entry.go`.

| Field | Path in `item[14]` |
|---|---|
| name | `[11]` |
| category | `[13][0]` (all categories: `[13]`) |
| full address | `[2]` joined with ", " |
| phone | `[178][0][0]` |
| website | `[7][0]` |
| rating | `[4][7]` |
| review count | `[4][8]` |
| latitude, longitude | `[9][2]`, `[9][3]` |
| place id (ChIJ…) | `[78]` |

A Maps link can be built from the place id:
`https://www.google.com/maps/place/?q=place_id:<id>`.

On refusals:

- HTTP 429 or 403, or a page mentioning "unusual traffic" or "/sorry/", means Google refused this line.
- The PC worker then keeps what it already has, posts it, and asks the hub for a 30-minute cooldown (`retryAfterMs` on the result). The hub sends other workers the jobs meanwhile.
- About 190 requests in a row from one home line were never refused.
- The threshold for a full Business sweep (about 400–600 requests) is not yet measured.

The PC worker is `automation-tools/agy-lab/local-worker/worker.ps1`
(PowerShell).

## Suggested changes for the mini

In order, smallest first.

1. **Read the list pages from inside Chrome, as well as the feed.** Change
   nothing else. Enable `Network.enable` and keep the
   `Network.responseReceived` and `Network.getResponseBody` events for URLs
   containing `/search?tbm=map`. Parse those bodies with the paths above
   while the scroll runs as now. This gives full addresses, review counts,
   coordinates and place ids for every card already loaded. The mini keeps its
   own ranking and its 66% website rate.

2. **Page past 120 without scrolling.** From the first list request the page
   makes, take its `pb` and request offsets 20, 40, … from the same Chrome tab
   with `fetch` inside the page (`Runtime.evaluate`), so cookies and line are
   the same. Stop at the first short page. This should reach about 180 per
   search, as the PC does.

3. **Then drop the scroll.** Once step 2 is reliable, a search needs no feed
   at all: a single `fetch` loop, or plain Node `fetch` with no Chrome, as on
   the PC. A search no longer waits on lazy loading: the PC read 10 pages in
   14 s at 0.5 s per page, where the mini's scroll took 19 s for 120 rows here
   and up to about 70 s on long lists. The RAM a Chrome holds is freed too. Keep Chrome only for what still needs a page, such as a
   place card when the query names one business.

4. **Return the hub's business shape.** Return `place_id`, a full `address`,
   numeric `reviews` and `latitude`/`longitude`. The hub's copy of
   `gmap-industry.mjs` already keys `businessKey` on `place_id` first, so the
   mini's rows dedupe against the other two workers' rows. This repo's
   `businessKey` should take the same line:
   `if (b.place_id) return 'place:' + b.place_id;`. The hub's in-area filter and street sweep
   then work on its results.

5. **Treat refusal as a pause, not a zero.** Keep the current rule that an
   empty or captcha page is `blocked`, not `found: 0`. Add a result
   `retryAfterMs` of 30 minutes, so the broker cools the mini down and gives the
   next searches to the other workers.

## What to measure after each step

Run the same search used above ("advertising agency", Johor Bahru, max 200)
on the mini, scraper.tech and the PC at once, with each job pinned through
`payload.worker`. Compare:

- businesses found, and how many only the mini found
- phone, website, rating and full-address rates
- seconds per search and the mini's RAM
- any refusal from Google

If the mini's 60 unique businesses and its higher website rate survive steps
1–3, it stays a useful third source, and every country run gets the union of
all three.
