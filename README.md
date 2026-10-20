# Compounding Dhan

A public investing journal: a real small-cap portfolio tracked in the open, the
thesis behind every holding, and research tools built on public exchange data.
Live at **https://compounding-dhan.pages.dev**.

| Section | What it is |
|---|---|
| **My Journey** (`/`, `/posts`) | Blog posts and per-holding investment theses (`/posts/theses/<symbol>`). |
| **Portfolio** (`/portfolio`) | Holdings, weights, returns vs Nifty 50 / Smallcap 250 / Midcap, per-stock pages with price levels, fundamentals, news and exchange filings, a momentum screen (`/portfolio/analyze`) and monthly reports. Personal amounts are never published; only percentages. |
| **Capital Flows** (`/capital-flows`) | Every NSE and BSE bulk and block deal since 2022, with client and stock pages and an investor leaderboard (hit rate, median return, holding period from FIFO-matched trades). |
| **Ownership Radar** (`/ownership`) | Quarterly DII, FII, promoter and public holding changes for every NSE company, with the named mutual fund schemes behind them. |

## How it fits together

```
                 Cloudflare Pages (static Astro site)
                 ├─ pages + client-side JS
                 └─ public/data/  ← static datasets, rebuilt nightly
                          ▲
GitHub Actions (nightly)  │ commits data
 ├─ scripts/build-capital-flows.mjs ──┐ reads new deals
 └─ scripts/build-mf-ownership.mjs    │ reads NSE shareholding filings
                                      ▼
                 Cloudflare Worker `blog-api` + D1 `blog-db`
                 ├─ crons: prices, fundamentals, news, filings, bulk/block deals
                 └─ /api/portfolio/*  (portfolio, reports, admin)
```

- **Static-first.** Capital Flows and Ownership pages read JSON from
  `public/data/`, never the database. D1's Free plan allows 5M rows read per day,
  and public traffic must not use it up.
- **Worker** (`worker/`): scheduled refresh at 4:00 PM IST (prices, fundamentals,
  filings) and 8:00 PM IST (late prices, the day's NSE/BSE deals). It also serves
  the portfolio API.
- **Nightly workflow** (`.github/workflows/whales.yml`, 9:30 PM IST): rebuilds
  the static datasets incrementally and commits them, which redeploys the site.

```
src/
├─ content/blog/            posts (Markdown)
├─ pages/                   portfolio/, capital-flows/, ownership, posts, glossary
├─ lib/                     shared logic + tests (capital-flows.js, ownership.js, …)
└─ styles/
public/data/
├─ flows/                   deals by day, stock and client (Capital Flows)
├─ ownership/               quarterly holdings and screens (Ownership Radar)
└─ whales-summary.json …    leaderboard and client metadata
scripts/                    dataset builders (run nightly in GitHub Actions)
worker/                     Cloudflare Worker API, D1 schema, crons
ownership/README.md         ownership pipeline details
INVESTMENT_CHECKLIST.md     24-point checklist used before every new position
```

## Data

### Capital Flows (`public/data/flows/`)

Built by `scripts/build-capital-flows.mjs`. It loads the committed files, asks the
Worker's export API only for deals newer than the highest id it has, and rewrites
only the files those deals touch.

- `days/YYYY-MM-DD.json`: every deal that day.
- `stocks/<SYMBOL>.json`: a stock's full deal history.
- `clients/<bucket>.json`: client histories, hashed into 1,024 buckets.
- `index.json`: coverage and the list of trading days.

Client names are normalised across spellings, and client types are inferred:
mutual fund, insurance, fund, corporate, individual, and prop/HFT desks detected
from behaviour. The same run rebuilds the investor leaderboard
(`build-whale-summary.mjs`).

```bash
node scripts/build-capital-flows.mjs                    # incremental, from the API
node scripts/build-capital-flows.mjs --sqlite deals.db  # bootstrap from a SQLite copy
```

### Ownership Radar (`public/data/ownership/`)

Built by `scripts/build-mf-ownership.mjs` from each company's quarterly
shareholding-pattern filing (XBRL on NSE's archive). Both the 2022 and 2025
filing layouts are parsed by `src/lib/ownership.js`.

- `quarters/YYYY-MM-DD.json`: per company, holders, shares and % for mutual
  funds, insurance, AIFs, DII, FII/FPI, promoters, retail and public, plus named
  MF schemes above 1%.
- `screen/YYYY-MM-DD.json`: each company against the previous quarter, with
  8-quarter history and the funds' bulk/block deals.

Scheme names are standardised: trustee wrappers, fund-house aliases and names cut
off at ~50 characters are handled, so a spelling change isn't reported as a new
fund. Downloads are throttled because NSE blocks fast downloaders; to backfill,
run the workflow manually with `ownership_since`. Monthly fund portfolios are
planned (#27).

## Run locally

Node 22+ (`node --version`).

```bash
npm install
cp .env.example .env        # PUBLIC_API_URL; defaults to http://localhost:8787
npm run dev                 # site at http://localhost:4321
```

The Capital Flows and Ownership pages work without the API, since they read
`public/data/`. For the portfolio pages, run the Worker too:

```bash
cd worker
npm install
npm run db:local            # create tables in a local D1
npm run dev                 # API at http://localhost:8787
```

Tests:

```bash
npm test                    # site libraries (capital flows, ownership parser)
cd worker && npm test       # Worker
```

## Deploy

Both deploy automatically from `main` on Cloudflare.

**Site (Cloudflare Pages):** framework preset Astro, build `npm run build`, output
`dist`, environment variable `PUBLIC_API_URL` = the Worker URL.

**Worker (Workers Builds, from the repository root):**

- Build command: `npm ci --prefix worker`
- Deploy command: `npx --yes wrangler@4.149.0 deploy --config worker/wrangler.toml`
- Preview command: `npx --yes wrangler@4.149.0 preview --config worker/wrangler.toml`

Schema changes are additive; apply them with `cd worker && npm run db:remote`.
Secrets are set with `npx wrangler secret put <NAME>` and are never committed:

- `ADMIN_TOKEN` gates trade uploads and admin endpoints.
- `TOTAL_CAPITAL` is used only to derive the public deployed/cash split.

Free-plan limits shape the design: 10 ms CPU per request, 5M D1 rows read and
100k written per day, and two cron triggers. Keep heavy or ad-hoc queries off
production D1; use a local SQLite copy instead.

## Portfolio internals

- **Prices** live in `price_history` (Yahoo today, provider-neutral). Benchmarks
  use official Nifty Indices history with Yahoo as a fallback.
  `GET /api/portfolio/price-history?symbol=NIFTY50&days=1095` also accepts
  `NIFTY_SMALLCAP`, `NIFTY500`, `NIFTY_MIDCAP` and `SENSEX`.
- **Refresh:** `POST /api/portfolio/refresh` shares a D1 lease with the crons.
  Success is reused for 15 minutes, failures can retry after 2 minutes, and a
  running refresh returns HTTP 202.
- **News:** Bing RSS in production (Cloudflare egress gets HTTP 503 from Google
  News; `NEWS_GOOGLE_ENABLED=false`). Every fetch logs to `news_fetch_runs`; see
  `GET /api/portfolio/news-fetch-status`.
- **Exchange filings:** NSE/BSE disclosures (results, shareholding, pledges,
  related-party, auditor, insider trading, legal, capital raising, corporate
  actions) are stored append-only with the source URL. A pilot extracts text
  from filing PDFs (`/api/portfolio/filings/*`, admin only).
- **Monthly reports:** drafted automatically for the previous month on the first
  weekday run of days 1–3, reviewed and published from `/portfolio/admin`.
  Reports cover returns, alpha, technical context, company developments,
  governance checks and data-coverage warnings.

## Writing posts

Add a Markdown file to `src/content/blog/`:

```markdown
---
title: "My post title"
description: "A one-line summary."
pubDate: 2026-06-23
---
```

Push to `main`; it's live at `/blog/<file-name>/`. Comments and likes are stored in
D1, one like per browser.

---

Research and journaling only; nothing here is investment advice.
