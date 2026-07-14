-- Database schema for comments and likes.
-- Apply with:
--   npx wrangler d1 execute blog-db --local --file=./schema.sql   (local dev)
--   npx wrangler d1 execute blog-db --remote --file=./schema.sql  (production)

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug   TEXT NOT NULL,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_slug, created_at);

CREATE TABLE IF NOT EXISTS likes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_slug   TEXT NOT NULL,
  visitor_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- One like per visitor per post. Lets INSERT OR IGNORE / DELETE act as a toggle.
  UNIQUE (post_slug, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_post ON likes (post_slug);

-- Portfolio holdings, synced from the Dhan API. Quantity and avg_buy_price
-- are never returned by the public API — only used server-side to derive
-- percentages (gain %, allocation %). A sync replaces the full table.
CREATE TABLE IF NOT EXISTS holdings (
  symbol        TEXT PRIMARY KEY,
  exchange      TEXT NOT NULL DEFAULT 'NSE',
  quantity      REAL NOT NULL,
  avg_buy_price REAL NOT NULL,
  synced_at     TEXT NOT NULL
);

-- Watchlist symbols. added_price is captured automatically from the price
-- feed at the moment a symbol is added — never entered by hand.
CREATE TABLE IF NOT EXISTS watchlist (
  symbol        TEXT PRIMARY KEY,
  exchange      TEXT NOT NULL DEFAULT 'NSE',
  added_price   REAL NOT NULL,
  added_at      TEXT NOT NULL
);

-- Latest price snapshot per symbol, refreshed daily by a Worker Cron Trigger
-- pulling from Yahoo Finance (no auth needed, unlike the Dhan price feed).
CREATE TABLE IF NOT EXISTS price_snapshots (
  symbol      TEXT PRIMARY KEY,
  price       REAL NOT NULL,
  prev_close  REAL,
  fetched_at  TEXT NOT NULL
);
