# Compounding Dhan — Astro + Cloudflare (comments & likes)

A fast, playful personal-finance blog with working **comments** and **likes**, all on free tiers.

- **Blog:** [Astro](https://astro.build) — write posts as Markdown files, builds to a static site.
- **Comments & likes API:** a [Cloudflare Worker](https://workers.cloudflare.com).
- **Storage:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (a free SQLite database in *your* account).
- **Hosting:** Cloudflare Pages (site) + Workers (API) — both have generous free tiers.

```
blog/
├─ src/
│  ├─ content/blog/        ← your posts (Markdown). Add a .md file to publish.
│  ├─ content.config.ts    ← post schema (title, description, date)
│  ├─ components/
│  │  └─ Comments.astro     ← the comments + likes widget (client-side)
│  ├─ layouts/             ← page shells
│  ├─ pages/               ← homepage + /blog/[id] post pages
│  └─ styles/global.css
├─ worker/                 ← the comments + likes backend
│  ├─ src/index.js          ← the Worker API
│  ├─ schema.sql            ← database tables
│  └─ wrangler.toml         ← Worker + D1 config
└─ .env.example            ← point the site at your Worker URL
```

---

## 1. Run it locally

You need [Node.js](https://nodejs.org) 22+ installed.

**Terminal A — the API (Worker + database):**

```bash
cd worker
npm install
npm run db:local          # create the tables in a local database
npm run dev               # starts the API at http://localhost:8787
```

**Terminal B — the blog:**

```bash
# from the project root
npm install
cp .env.example .env       # default already points at localhost:8787
npm run dev               # starts the site at http://localhost:4321
```

Open http://localhost:4321, click a post, and try the like button and comment box.

---

## 2. Deploy for real (free)

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

### a) Create the database

```bash
cd worker
npx wrangler login
npx wrangler d1 create blog-db
```

This prints a `database_id`. Paste it into `worker/wrangler.toml` (replace
`PASTE_YOUR_DATABASE_ID_HERE`). Then create the tables in the live database:

```bash
npm run db:remote
```

### b) Deploy the API

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://blog-api.<you>.workers.dev`.
Copy it. (Optional but recommended: set `ALLOWED_ORIGIN` in `wrangler.toml` to
your site's URL once you have it, then `npm run deploy` again.)

### c) Deploy the blog

Push this project to a GitHub repo, then in the Cloudflare dashboard:
**Workers & Pages → Create → Pages → Connect to Git**, pick the repo, and use:

- **Framework preset:** Astro
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Environment variable:** `PUBLIC_API_URL` = your Worker URL from step (b)

Every `git push` now rebuilds and redeploys the site automatically.

---

## Writing posts

Create a new file in `src/content/blog/`, e.g. `my-post.md`:

```markdown
---
title: "My post title"
description: "A one-line summary."
pubDate: 2026-06-23
---

Your post content in Markdown.
```

Commit and push — that's it. The URL will be `/blog/my-post/`.

---

## Notes & next steps

- **Likes are per-browser.** A random visitor id is stored in `localStorage`, so a
  visitor can like a post once. This is the simple, no-login approach.
- **Spam:** comments are open to anyone. Before going big, consider adding a
  honeypot field, rate limiting, or a moderation step in the Worker.
- **Comments are sanitized** on display (HTML-escaped) to avoid script injection.
- **Want email notifications** when someone comments? Add a free email service
  (e.g. Resend) call inside `postComment` in `worker/src/index.js`.

## Monthly portfolio reports

The portfolio admin page can generate a calendar-month report as a private
draft and publish it after review. Reports include portfolio/holding returns,
alpha, technical context, stored company developments, conservative governance
keyword checks, linked evidence, and explicit data-coverage warnings.

Before deploying the feature, apply the additive D1 schema changes:

```bash
cd worker
npm run db:remote
```

The weekday cron stores news and NSE announcements instead of only keeping the
latest response. Google News RSS is attempted first and Bing News RSS is used
when Cloudflare receives an empty/error response. On the first weekday run in
days 1–3, the Worker creates a draft for the previous calendar month; publishing
remains a manual admin action.

Every news refresh also writes a `news_fetch_runs` telemetry row per symbol. It
records the selected provider, Google/Bing HTTP statuses, received and accepted
item counts, fallback outcome, timestamps and bounded error details. Failed or
empty upstream responses never overwrite a healthy cached news list. The latest
per-symbol result is available to admins at
`GET /api/portfolio/news-fetch-status`.

Price calculations read the provider-neutral `price_history` table. Yahoo is
still the current writer, but missing candles can be populated later from an
NSE/BSE bhavcopy importer without changing the report engine.

NSE and BSE corporate disclosures are collected without a brokerage account.
They are stored as typed, append-only evidence covering financial results,
shareholding, promoter pledges, related-party transactions, auditor changes,
insider-trading disclosures, regulatory/legal events, capital raising and
corporate actions. The original exchange response and document URL are retained
for auditability. Yahoo remains the fallback for normalized current metrics
until numeric tables in exchange-filed documents have been extracted.

### Filing document extraction pilot

The Worker can download material exchange-filed PDFs in bounded batches, verify
their official NSE/BSE host, hash and deduplicate them, and store page-aware text
in D1. PDF binaries are not retained. Scanned documents are marked `needs-ocr`,
invalid links and non-PDF responses remain visible as failures, and no document
is considered reviewed merely because its metadata was collected.

The initial reproducible window is Q2 2026 (`2026-04-01` through `2026-07-01`).
Admin-only endpoints are:

- `POST /api/portfolio/filings/extract-quarter` with `{ "from", "to", "limit" }`
- `GET /api/portfolio/filings/extraction-status?from=...&to=...`
- `POST /api/portfolio/filings/cleanup` with `{ "from", "to" }`

The pilot produced 27 unique text-extracted documents, four deduplicated filing
aliases, six explicit OCR requirements, two invalid exchange URLs and one
non-PDF response. These statuses form the coverage boundary for the subsequent
AI review layer.
