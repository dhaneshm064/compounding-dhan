# Compounding Dhan — Astro + Cloudflare (comments, likes, portfolio & watchlist)

A fast, playful personal-finance blog with working **comments**, **likes**, and a
public **portfolio tracker + watchlist** — all on free tiers.

- **Blog:** [Astro](https://astro.build) — write posts as Markdown files, builds to a static site.
- **API:** a [Cloudflare Worker](https://workers.cloudflare.com) backing comments, likes, portfolio, and watchlist.
- **Storage:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (a free SQLite database in *your* account).
- **Hosting:** Cloudflare Pages (site) + Workers (API) — both have generous free tiers.

```
blog/
├─ src/
│  ├─ content/blog/        ← your posts (Markdown). Add a .md file to publish.
│  ├─ content.config.ts    ← post schema (title, description, date)
│  ├─ components/
│  │  ├─ Comments.astro     ← the comments + likes widget (client-side)
│  │  └─ Ticker.astro       ← scrolling price-move ticker (portfolio/watchlist)
│  ├─ layouts/             ← page shells
│  ├─ pages/               ← homepage, /blog/[id], /portfolio, /watchlist
│  └─ styles/global.css
├─ worker/                 ← the API backend
│  ├─ src/index.js          ← the Worker API (comments, likes, portfolio, watchlist, cron)
│  ├─ schema.sql            ← database tables
│  └─ wrangler.toml         ← Worker + D1 + Cron Trigger config
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

## Portfolio & watchlist

`/portfolio` and `/watchlist` show **percentages only** — gain/loss since buy,
today's move, portfolio weight. No rupee amounts are ever stored in a public
response; buy price, quantity, and current price stay server-side and are
only used to compute the percentages you see.

### How the data gets in

- **Holdings** are entered by hand once, when you actually make a trade —
  symbol, quantity, and buy price. Both endpoints are admin-token protected;
  re-posting the same symbol updates it (e.g. after averaging up/down):

  ```bash
  curl -X POST https://<your-worker>.workers.dev/api/admin/holdings \
    -H "Content-Type: application/json" \
    -H "x-admin-token: <ADMIN_TOKEN>" \
    -d '{"symbol":"SKYGOLD","exchange":"NSE","quantity":10,"buyPrice":540}'

  curl -X DELETE https://<your-worker>.workers.dev/api/admin/holdings \
    -H "Content-Type: application/json" \
    -H "x-admin-token: <ADMIN_TOKEN>" \
    -d '{"symbol":"SKYGOLD"}'
  ```

- **Watchlist** symbols are added the same admin-protected way, except the
  price at the time of adding is fetched automatically, not typed in:

  ```bash
  curl -X POST https://<your-worker>.workers.dev/api/admin/watchlist \
    -H "Content-Type: application/json" \
    -H "x-admin-token: <ADMIN_TOKEN>" \
    -d '{"symbol":"KMEW","exchange":"NSE"}'

  curl -X DELETE https://<your-worker>.workers.dev/api/admin/watchlist \
    -H "Content-Type: application/json" \
    -H "x-admin-token: <ADMIN_TOKEN>" \
    -d '{"symbol":"KMEW"}'
  ```

- **Daily prices** refresh automatically via a Worker **Cron Trigger** (see
  `[triggers]` in `wrangler.toml`, currently ~15:45 IST on weekdays), pulling
  from Yahoo Finance's public quote endpoint — no auth, no token to babysit.
  Adding a holding or watchlist symbol also fetches its price immediately, so
  the page isn't stale until the next cron run. The ticker and tables on
  `/portfolio` and `/watchlist` reflect whatever the last run fetched.

### Setup

1. Apply the schema (already includes the `holdings`, `watchlist`, and
   `price_snapshots` tables) via `npm run db:remote` as in step 2(a) above.
2. Set an admin secret that protects the write endpoints:
   ```bash
   cd worker
   npx wrangler secret put ADMIN_TOKEN
   ```
   For local dev, put the same value in `worker/.dev.vars` as
   `ADMIN_TOKEN=...` (already gitignored).
3. Deploy (`npm run deploy`) — the cron trigger activates automatically.

---

## Notes & next steps

- **Likes are per-browser.** A random visitor id is stored in `localStorage`, so a
  visitor can like a post once. This is the simple, no-login approach.
- **Spam:** comments are open to anyone. Before going big, consider adding a
  honeypot field, rate limiting, or a moderation step in the Worker.
- **Comments are sanitized** on display (HTML-escaped) to avoid script injection.
- **Want email notifications** when someone comments? Add a free email service
  (e.g. Resend) call inside `postComment` in `worker/src/index.js`.
