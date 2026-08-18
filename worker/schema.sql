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

-- Portfolio: raw trade rows parsed from Zerodha tradebook xlsx uploads.
-- Real quantities/prices — NEVER returned by public API endpoints.
CREATE TABLE IF NOT EXISTS trades (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  exchange          TEXT NOT NULL,
  isin              TEXT NOT NULL,
  trade_type        TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  price             REAL NOT NULL,
  trade_date        TEXT NOT NULL,
  order_exec_time   TEXT NOT NULL,
  broker_trade_id   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (broker_trade_id)
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol, trade_date);

-- Portfolio: daily OHLC price history for both held stocks and benchmark indexes.
-- open/high/low are nullable since older rows (fetched before candlesticks were
-- added) only have `close` — see the one-time ALTER TABLE migration in README/git
-- history for existing databases; a fresh install gets these columns from the start.
CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  price_date  TEXT NOT NULL,
  open        REAL,
  high        REAL,
  low         REAL,
  close       REAL NOT NULL,
  volume      INTEGER,
  fetched_at  TEXT NOT NULL,
  UNIQUE (symbol, price_date)
);

CREATE INDEX IF NOT EXISTS idx_price_history_symbol_date ON price_history (symbol, price_date DESC);

-- Portfolio: fundamentals snapshot per tracked symbol, refreshed daily alongside
-- prices. Sector/industry/market cap/valuation — all public company data, fine
-- to expose (no relation to the amount-vs-price privacy constraint on trades).
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol            TEXT PRIMARY KEY,
  sector            TEXT,
  industry          TEXT,
  market_cap        REAL,
  pe_ratio          REAL,
  forward_pe        REAL,
  target_mean_price REAL,
  target_high_price REAL,
  target_low_price  REAL,
  recommendation    TEXT,
  debt_to_equity    REAL,
  revenue_growth    REAL,
  earnings_growth   REAL,
  revenue_growth_qoq REAL,
  profit_growth_qoq  REAL,
  profit_at_recent_high INTEGER,
  profit_pct_off_recent_high REAL,
  latest_quarter_profit_cr REAL,
  recent_high_quarter_profit_cr REAL,
  fetched_at        TEXT NOT NULL
);

-- Portfolio: cached news headlines per symbol, refreshed daily alongside prices/
-- fundamentals. Google blocks live news.google.com fetches from Cloudflare Workers'
-- shared IPs (returns a 503 bot-block page), so this is fetched once via cron
-- instead of live per page view — a blocked cron run just leaves yesterday's
-- cache in place rather than showing nothing. `items` is the fetchNews() array
-- serialized as JSON (title/link/pubDate/source per headline).
CREATE TABLE IF NOT EXISTS news_cache (
  symbol      TEXT PRIMARY KEY,
  items       TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
