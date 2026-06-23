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
