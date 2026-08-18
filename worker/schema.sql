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

-- Append-only research evidence. Unlike news_cache, these rows are never
-- replaced, so a calendar-month report can be reproduced later.
CREATE TABLE IF NOT EXISTS news_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  title         TEXT NOT NULL,
  source        TEXT,
  url           TEXT NOT NULL,
  published_at  TEXT,
  fetched_at    TEXT NOT NULL,
  category      TEXT,
  governance_severity TEXT,
  UNIQUE (symbol, url)
);

CREATE INDEX IF NOT EXISTS idx_news_items_symbol_date ON news_items (symbol, published_at DESC);

-- One row per symbol refresh, including failed upstream attempts. This makes a
-- Google 503 followed by a successful Bing fallback distinguishable from a
-- genuinely empty news search.
CREATE TABLE IF NOT EXISTS news_fetch_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  completed_at      TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  selected_provider TEXT,
  received_count    INTEGER NOT NULL DEFAULT 0,
  accepted_count    INTEGER NOT NULL DEFAULT 0,
  google_status     INTEGER,
  bing_status       INTEGER,
  attempts_json     TEXT NOT NULL,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_news_fetch_runs_symbol_time ON news_fetch_runs (symbol, completed_at DESC);

CREATE TABLE IF NOT EXISTS announcement_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  announcement_key TEXT NOT NULL,
  subject       TEXT,
  body          TEXT,
  attachment_url TEXT,
  announced_at  TEXT,
  fetched_at    TEXT NOT NULL,
  category      TEXT,
  governance_severity TEXT,
  UNIQUE (symbol, announcement_key)
);

CREATE INDEX IF NOT EXISTS idx_announcement_items_symbol_date ON announcement_items (symbol, announced_at DESC);

-- Typed, append-only exchange disclosures used by monthly fundamental and
-- governance reviews. The original response fragment is retained so parsing
-- rules can be improved without losing the evidence observed at the time.
CREATE TABLE IF NOT EXISTS exchange_filings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  isin            TEXT,
  exchange        TEXT NOT NULL,
  filing_key      TEXT NOT NULL,
  filing_type     TEXT NOT NULL,
  subject         TEXT,
  details         TEXT,
  document_url    TEXT,
  filed_at        TEXT,
  period_end      TEXT,
  fetched_at      TEXT NOT NULL,
  governance_severity TEXT,
  source_payload_json TEXT,
  UNIQUE (exchange, filing_key)
);

CREATE INDEX IF NOT EXISTS idx_exchange_filings_symbol_date ON exchange_filings (symbol, filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_filings_type_date ON exchange_filings (filing_type, filed_at DESC);

-- Extracted exchange documents. We retain a content hash and page-aware text,
-- but not the PDF binary: the exchange URL remains the canonical source.
CREATE TABLE IF NOT EXISTS filing_documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  filing_id         INTEGER NOT NULL UNIQUE,
  content_sha256    TEXT,
  mime_type         TEXT,
  byte_size         INTEGER,
  page_count        INTEGER,
  character_count   INTEGER,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_quality TEXT,
  extracted_at      TEXT,
  error             TEXT,
  FOREIGN KEY (filing_id) REFERENCES exchange_filings(id)
);

CREATE INDEX IF NOT EXISTS idx_filing_documents_status ON filing_documents (extraction_status, filing_id);

CREATE TABLE IF NOT EXISTS filing_pages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  filing_id       INTEGER NOT NULL,
  page_number     INTEGER NOT NULL,
  text_content    TEXT NOT NULL,
  character_count INTEGER NOT NULL,
  UNIQUE (filing_id, page_number),
  FOREIGN KEY (filing_id) REFERENCES exchange_filings(id)
);

CREATE INDEX IF NOT EXISTS idx_filing_pages_filing_page ON filing_pages (filing_id, page_number);

-- Multiple exchange announcements can reference the identical PDF. Aliases
-- let downstream review resolve those filings to one canonical extracted copy.
CREATE TABLE IF NOT EXISTS filing_document_aliases (
  filing_id           INTEGER PRIMARY KEY,
  canonical_filing_id INTEGER NOT NULL,
  FOREIGN KEY (filing_id) REFERENCES exchange_filings(id),
  FOREIGN KEY (canonical_filing_id) REFERENCES exchange_filings(id)
);

-- Historical copies of the otherwise latest-only fundamentals table.
CREATE TABLE IF NOT EXISTS fundamental_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  data_json     TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  UNIQUE (symbol, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_fundamental_snapshots_symbol_date ON fundamental_snapshots (symbol, snapshot_date DESC);

-- Normalized quarterly statement history. `available_from` is when our system
-- first observed the row, not necessarily the company's original filing date.
CREATE TABLE IF NOT EXISTS fundamental_periods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  period_type     TEXT NOT NULL DEFAULT 'quarterly',
  revenue         REAL,
  operating_income REAL,
  ebitda          REAL,
  net_income      REAL,
  diluted_eps     REAL,
  total_assets    REAL,
  total_debt      REAL,
  stockholder_equity REAL,
  cash            REAL,
  receivables     REAL,
  inventory       REAL,
  operating_cash_flow REAL,
  capital_expenditure REAL,
  free_cash_flow  REAL,
  available_from  TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  UNIQUE (symbol, period_end, period_type)
);

CREATE INDEX IF NOT EXISTS idx_fundamental_periods_symbol_end ON fundamental_periods (symbol, period_end DESC);

CREATE TABLE IF NOT EXISTS fundamental_source_payloads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  isin          TEXT NOT NULL,
  source        TEXT NOT NULL,
  dataset       TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  UNIQUE (symbol, source, dataset, snapshot_date)
);

CREATE TABLE IF NOT EXISTS shareholding_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  isin          TEXT NOT NULL,
  period_label  TEXT NOT NULL,
  category      TEXT NOT NULL,
  holding_pct   REAL NOT NULL,
  source        TEXT NOT NULL,
  available_from TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  UNIQUE (symbol, period_label, category, source)
);

CREATE INDEX IF NOT EXISTS idx_shareholding_symbol_period ON shareholding_history (symbol, period_label DESC);

-- One-time cleanup for installations that briefly used the retired brokerage
-- fundamentals adapter. These statements are safe on fresh databases too.
DROP TABLE IF EXISTS upstox_income_periods;
DELETE FROM fundamental_source_payloads WHERE source = 'upstox';
DELETE FROM shareholding_history WHERE source = 'upstox';

-- Immutable input/calculation snapshot plus an editable publication state.
CREATE TABLE IF NOT EXISTS monthly_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  report_month      TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'draft',
  report_json       TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  generated_at      TEXT NOT NULL,
  published_at      TEXT,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_monthly_reports_status_month ON monthly_reports (status, report_month DESC);

-- Previous versions are retained whenever an admin regenerates a month. The
-- monthly_reports row remains the current version used by the public URL.
CREATE TABLE IF NOT EXISTS monthly_report_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  report_month      TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  status            TEXT NOT NULL,
  report_json       TEXT NOT NULL,
  generator_version TEXT NOT NULL,
  generated_at      TEXT NOT NULL,
  published_at      TEXT,
  archived_at       TEXT NOT NULL,
  UNIQUE (report_month, revision)
);

CREATE INDEX IF NOT EXISTS idx_monthly_report_revisions_month ON monthly_report_revisions (report_month, revision DESC);
