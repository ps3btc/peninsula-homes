# Peninsula Homes

Real-estate dashboard for **houses ≤ $6M and > 1,800 sqft** in **Los Altos, Mountain View and Palo Alto**,
scraped from Redfin daily, stored in Cloudflare D1 with full status history
(active → pending → sold), and served as a static dashboard on Cloudflare Pages
backed by a Cloudflare Workers API.

- Dashboard: https://peninsula-homes.pages.dev
- API: https://peninsula-homes-api.flyingokapi.workers.dev

## Features

- **Available / Pending / Sold tabs** — listings move between tabs automatically as
  their status changes; every transition is recorded in `status_history`.
- Per property: price, beds, baths, square footage, lot size, year built, days on
  market, **school zoning (elementary / middle / high with GreatSchools ratings)**,
  **year last sold**, and a direct link to the Redfin listing.
- Filters: city, max price, min beds, sort (recently listed / newest / price / sqft /
  recently sold), address search. **Tab counts update dynamically** to reflect the
  current filters.
- **Default city: Los Altos** — the dashboard opens with Los Altos preselected; change
  it via the city selector to see other cities or all three combined.
- **Recently listed sort** (default) — orders by Redfin's days-on-market, showing the
  newest listings first. "Newest first" (first detected by our scanner) is also available.
- **Daily automated scraping** via cron (06:00 & 18:00 UTC) plus a manual trigger.
- Only **single-family houses** at or under $6,000,000 and over 1,800 sqft are tracked.
  Condos, townhomes, duplexes, and multi-family properties are excluded at ingest and
  swept from the DB on every scan.
- **Email notifications**: when a new listing hits the market, an email is sent to
  configured recipients with full property details (address, price, beds/baths/sqft,
  school zoning, last sold year, Redfin link). Powered by Mailjet; credentials stored
  as Worker secrets.

## Architecture

```
┌─────────────── Cloudflare ───────────────┐
│                                          │
│  Pages (web/)          Workers (src/)    │
│  static dashboard ──►  /api/*  ──► D1    │
│                        cron 2×/day       │
│                        scraper ──► Redfin│
└──────────────────────────────────────────┘
```

| Piece | Where | Notes |
|---|---|---|
| Scraper | `src/redfin.js` | Redfin `stingray/api/gis` (active listings JSON), `/city/<id>/CA/<slug>/recently-sold` pages (sold), listing pages (status confirmation + schools) |
| DB layer | `src/db.js` | upserts, status transitions + history, scan log |
| API + cron | `src/index.js` | `/api/listings`, `/api/stats`, `/api/property/:id`, `/api/scans`, `POST /api/scan`, `POST /api/schools`, `scheduled()` |
| Notifications | `src/notify.js` | queue writer today; delivery stub for later |
| Schema | `schema.sql` | `properties`, `status_history`, `scan_log`, `notification_queue` |
| Dashboard | `web/` | vanilla HTML/CSS/JS, dark theme |

### How data retrieval works (and why)

**Listings** come from `stingray/api/gis` — the JSON API that powers Redfin's
own table layout. This is deliberately *not* HTML table scraping: it is
machine-readable, includes retries, and has been reachable from the Worker's
IP on every scan. There is no more reliable Redfin surface for the active
listing set; HTML scraping of the table view was evaluated and rejected as
strictly less reliable (same WAF, worse structure).

Redfin sits behind an AWS WAF JS challenge, and the HTML surfaces
(listing pages, recently-sold pages) behave empirically like this:

- The WAF alternates ~10–15 min hard blocks with short open bursts; challenges
  can arrive with status 200 too (challenge detection checks for real-page
  content markers, not just WAF script tags).
- **School zoning** (assigned elementary / middle / high + GreatSchools
  ratings) exists only on listing pages, so it is collected through two
  channels:
  1. **Worker scans** opportunistically fetch detail pages with the remaining
     fetch budget (works when the datacenter IP is allowed).
  2. **Residential backfill** — the primary workhorse: `npm run
     schools:backfill` fetches listing pages from your own machine (which
     passes the WAF in bursts), paces requests to stretch each open window,
     rests through blocks, and POSTs results to `POST /api/schools`. It runs
     unattended and is idempotent; schools are cached permanently once
     collected, so only new listings need collection day-to-day.
  Alternatives evaluated and rejected: GreatSchools public API (end-of-life
  since 2021), Redfin stingray school endpoints (403/404), rendering proxies
  (blocked), attendance-zone GIS data (no machine-readable boundaries for the
  local districts). Redfin listing pages remain the only source of
  *assigned* schools with ratings.
- Exclusions applied at ingest: price > $6M, sqft ≤ 1,800, all non-single-family
  property types (condos, townhomes, duplexes, multi-family — Redfin
  `uiPropertyType` ≠ 1 is dropped; the `uipt=1` URL param is not honored
  reliably by the gis endpoint, so the field itself is filtered), and
  new-construction "Ready to Build"/Plan listings (filtered by `mlsStatus`
  and address). Every scan re-sweeps the DB: `deleteExcludedStatuses`,
  `deleteBelowMinSqft`, `deletePlanListings`, and `deleteNonSingleFamily`
  (which also removes legacy rows with no recorded property type that match
  multi-family address patterns like unit designators or address ranges).
- Status transitions: a property that disappears from the active set is confirmed
  on its listing page when reachable (Pending/Sold); when the page is challenged
  it is conservatively marked `pending (inferred)` and upgraded to `sold` once a
  later scan confirms it. `status_source` records how each status was determined.

Region IDs: Los Altos `11018`, Mountain View `12739`, Palo Alto `14325`.

Each scan is budgeted to ≤ 48 external fetches so it stays within the Workers
free-plan subrequest limit (3 gis + 3 sold pages + the rest on per-property checks).

## Local development

```bash
npm install
npm run db:migrate:local          # create tables in local D1
npm run dev                       # worker on :8788 (local D1)

# seed a scan locally
curl -X POST http://localhost:8788/api/scan

# dashboard
cd web && python3 -m http.server 8790
# then in the page console: localStorage.setItem('peninsulaApi','http://localhost:8788')
```

## Deployment

```bash
npm run db:migrate                # remote D1 (already created: peninsula-homes)
npm run deploy                    # worker + crons
npm run deploy:pages              # Pages project: peninsula-homes

# manual production scan (token required; see .dev.vars):
curl -X POST -H "x-scan-token: $SCAN_TOKEN" https://peninsula-homes-api.flyingokapi.workers.dev/api/scan
```

Secrets: `SCAN_TOKEN` is stored as a Worker secret (`wrangler secret put`) and in
the gitignored `.dev.vars` for local use. `MAILJET_API_KEY` and `MAILJET_SECRET_KEY`
are also stored as Worker secrets for email notifications. Never commit any secrets.

## API

| Endpoint | Description |
|---|---|
| `GET /api/listings?status=active\|pending\|sold&city=&maxPrice=&minBeds=&q=&sort=` | listings (max 500). Sort options: `listed` (recently listed, default), `newest`, `price_asc`, `price_desc`, `sqft`, `sold_desc` |
| `GET /api/stats?city=&maxPrice=&minBeds=&q=` | counts per status/city + last scan. **Filters apply** so tab counts match the displayed listings |
| `GET /api/property/:id` | property + full status history |
| `GET /api/scans` | recent scan log |
| `POST /api/scan` | run a scan now (requires `x-scan-token`) |
| `POST /api/test-email` | send a test email to verify Mailjet integration (requires `x-scan-token`) |

## Email notifications

When a new listing is detected during the daily scan, an email is automatically sent to
configured recipients with full property details:

- **Recipients**: configured in `src/notify.js` (currently `hareesh.nagarajan@gmail.com`
  and `divya.ramamurthy@gmail.com`)
- **From**: `alerts@loglinearexplorations.online`
- **Subject**: "New Listing: [Address], [City] — $[Price]"
- **Content**: address, price, beds/baths/sqft, lot size, year built, days on market,
  listed date, last sold year, school zoning (with ratings), and a direct link to the
  Redfin listing

**Mailjet integration**:
- API key and secret stored as Worker secrets: `MAILJET_API_KEY` and `MAILJET_SECRET_KEY`
- Emails are sent immediately when a new listing is found (not batched)
- Each email event is logged in the `notification_queue` table for audit/reliability
- Test endpoint: `POST /api/test-email` sends a sample email to verify the integration

**Email format**: HTML email with styled layout (blue header, property details table,
  school info with color-coded ratings, "View on Redfin" button) plus plain-text fallback
  for email clients that don't render HTML.

To change recipients, edit the `RECIPIENTS` array in `src/notify.js` and redeploy.

Data © Redfin; used for personal research. Listings refresh daily.
