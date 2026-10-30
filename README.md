# Google Maps country-industry research worker

A local worker that accepts a country and industry from a compatible hub, searches Google Maps by location, visits listed websites for public contacts, and returns a CSV to the hub. The Maps and website stages are scripts; they do not require an LLM or an LLM quota. This repository contains the worker; the hub UI and broker are maintained separately.

## Requirements

- Node.js 22 or newer and an installed Google Chrome or Chromium browser.
- Network access to the hub, Google Maps, company websites, and the city dataset.
- A compatible hub with the `country.industry` job type and a hub token.

## Run as a hub worker

```sh
cp .env.example .env
# Edit .env: set LAB_TOKEN and give WORKER_NAME a unique name.
npm start
```

On Windows, copy `.env.example` to `.env` and edit it before running `npm start`. The worker loads `.env` in its current directory; if absent it also checks `~/.gmap-worker.env`. Environment variables take precedence. Set `WORKER_TYPES=country.industry` to restrict the worker to this pipeline. `LAB_URL` selects the hub. Do not run a second worker with the same name and browser profile as an existing service.

From the hub, create a country-industry job with country and industry. The worker claims it, reports progress and heartbeats while running, and submits the finished CSV and summary to the hub. Each job has a local checkpoint under `~/.gmap-worker/country-industry/` by default; `COUNTRY_INDUSTRY_JOB_ROOT` changes that directory. The hub must support the long-running job lease and accept the result payload. Do not put tokens or generated research results in the repository.

## Run locally without a hub

```sh
node country-industry-research.mjs --country "Malaysia" --industry "advertising agency"
```

Outputs are written to `country-industry-results/<country>-<industry>/`, including `locations.txt`, Maps checkpoints, website-contact checkpoints and `companies.csv`. Re-run the same command to resume. To provide a list of locations, use `--places towns.txt`; use a new output directory when changing the search plan. Other options include `--output directory`, `--max 200` and `--delay-ms 2000`. `--limit` limits the number of website checks, so omit it for a complete run.

The default city list comes from [World Cities](https://github.com/datasets/world-cities), derived from [GeoNames](https://www.geonames.org/). Country names must match its English names. This list and Google Maps results are not an exhaustive census; searches can be capped or incomplete. Website checks fetch the homepage and up to three same-host contact, team or about pages, extracting published emails, phones, social links and structured person details where present. The CSV includes source links and research status. Sites needing JavaScript or login may yield incomplete results, and email deliverability and business relevance are not verified.

## Tests

```sh
npm test
```

The tests include a local simulated hub handshake and do not run a nationwide Maps search.

## Mac mini Maps scans

For keyword-and-place scans, the scanner combines the Chrome feed with paginated Maps list responses. It merges rows by place ID, keeps feed website values when available, and fills full addresses, coordinates, and review counts from list data. The requested maximum still caps the returned rows. `paginatedFound`, `paginatedPages`, and `listError` describe the additional list-page pass; a Google refusal preserves the rows already fetched and requests a 30-minute worker cooldown. If the list request fails, the feed remains available and the error is reported. List response fields are undocumented and can change; coverage and the relevance of results are not guaranteed.

The Mac mini's existing `macmini.mjs` service uses `gmap.mjs` for `gmap.scan`; updating a separate checkout alone does not update that running service.
