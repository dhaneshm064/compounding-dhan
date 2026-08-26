import { BROWSER_UA } from './newsfeeds.js';

// The stocks this tool tracks, mapped to their yfinance/Yahoo ticker.
// Update this if the tracked set changes — must match the admin upload's
// TRACKED_SYMBOLS allowlist in src/pages/portfolio/admin.astro.
export const TRACKED_STOCKS = {
  SKYGOLD: 'SKYGOLD.NS',
  ANTHEM: 'ANTHEM.NS',
  KMEW: 'KMEW.NS',
  KRISHNADEF: 'KRISHNADEF.NS',
  CREDITACC: 'CREDITACC.NS',
};

// Must match the BENCHMARKS map in index.js.
export const MARKET_BENCHMARKS = {
  NIFTY500: { ticker: '^CRSLDX', label: 'Nifty 500' },
  NIFTY50: { ticker: '^NSEI', label: 'Nifty 50' },
  SENSEX: { ticker: '^BSESN', label: 'Sensex' },
  NIFTY_MIDCAP: { ticker: '^NSEMDCP50', label: 'Nifty Midcap 50' },
  NIFTY_SMALLCAP: { ticker: 'NIFTYSMLCAP250.NS', label: 'Nifty Smallcap 250' },
};

export const BENCHMARK_TICKERS = Object.fromEntries(
  Object.entries(MARKET_BENCHMARKS).filter(([key]) => key !== 'NIFTY500').map(([key, benchmark]) => [key, benchmark.ticker])
);

export const BENCHMARK_LABELS = Object.fromEntries(
  Object.entries(MARKET_BENCHMARKS).map(([key, benchmark]) => [key, benchmark.label])
);

// Indices used only by the "Analyze" 3-criteria signal (see analyze.js) — is a
// holding beating Nifty 500 and its own sector over the trailing year? Not shown
// on the public benchmark-comparison chart, so kept separate from BENCHMARK_TICKERS.
export const NIFTY_500_TICKER = MARKET_BENCHMARKS.NIFTY500.ticker;

// No sector-index ticker exists for every holding (SKYGOLD/Jewellery, KMEW/Marine
// have no clean NSE sector index on Yahoo) — those are left out and the analyze
// endpoint treats "sector outperformance" as not-applicable for them, rather than
// guessing a loose proxy. DEFENCE.NS is an ETF (Mirae Asset BSE India Defence),
// the closest available stand-in for an actual defence sector index. FINIETF.NS
// (ICICI Prudential Nifty Financial Services Ex-Bank ETF) replaces the raw
// ^CNXFIN index ticker, which Yahoo only carries a single day of price history
// for — useless for a 1-year comparison, unlike this ETF's ~1.5 years.
export const SECTOR_INDEX_TICKERS = {
  ANTHEM: '^CNXPHARMA',
  KRISHNADEF: 'DEFENCE.NS',
  CREDITACC: 'FINIETF.NS',
};

// Human-readable label for whichever ticker above is actually being compared
// against — shown in the Analyze UI so "vs Sector" doesn't leave it a mystery
// which index/ETF that number came from.
export const SECTOR_INDEX_NAMES = {
  ANTHEM: 'Nifty Pharma',
  KRISHNADEF: 'BSE India Defence (ETF)',
  CREDITACC: 'Nifty Financial Services Ex-Bank (ETF)',
};

const YEAR_SECONDS = 365 * 24 * 60 * 60;

// Yahoo's own chart JSON endpoint (the one yfinance wraps) — no session/cookie
// needed, just a browser User-Agent. Unofficial and can break without notice;
// callers treat an empty result as "skip this ticker today," not fatal.
// Uses explicit period1/period2 (not the range=1y/2y/5y shorthand) so we get an
// exact N-year window — Yahoo has no "3y" bucket in the shorthand set.
async function fetchYahooHistory(ticker, years = 3) {
  try {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - years * YEAR_SECONDS;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
    if (!res.ok) return [];

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const round = (n) => (n == null ? null : Math.round(n * 100) / 100);
    const rows = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quote.close?.[i] == null) continue;
      rows.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: round(quote.open?.[i]),
        high: round(quote.high?.[i]),
        low: round(quote.low?.[i]),
        close: round(quote.close[i]),
        volume: quote.volume?.[i] ?? null,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

async function upsertPrices(env, ticker, kind, rows, fetchedAt) {
  if (!rows.length) return 0;
  // ON CONFLICT DO UPDATE (not INSERT OR IGNORE) so a schema change like adding
  // open/high/low backfills existing rows on the next run, rather than leaving
  // them permanently null because the date was already stored.
  const stmts = rows.map((r) =>
    env.DB
      .prepare(
        `INSERT INTO price_history (symbol, kind, price_date, open, high, low, close, volume, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, price_date) DO UPDATE SET
           open = excluded.open, high = excluded.high, low = excluded.low,
           close = excluded.close, volume = excluded.volume, fetched_at = excluded.fetched_at`
      )
      .bind(ticker, kind, r.date, r.open, r.high, r.low, r.close, r.volume, fetchedAt)
  );
  await env.DB.batch(stmts);
  return stmts.length;
}

/**
 * Fetches a year of daily closes for every tracked stock + benchmark and upserts
 * into price_history. Runs the full range every time (not just "today") so the
 * table self-heals if a day was ever missed — cheap at this data volume, and
 * INSERT OR IGNORE (UNIQUE(symbol, price_date)) makes it a no-op for days already stored.
 */
export async function fetchAndStorePrices(env, { years = 3 } = {}) {
  const fetchedAt = new Date().toISOString();
  let rowsWritten = 0;
  const failed = [];

  for (const ticker of Object.values(TRACKED_STOCKS)) {
    const rows = await fetchYahooHistory(ticker, years);
    if (!rows.length) {
      failed.push(ticker);
      continue;
    }
    rowsWritten += await upsertPrices(env, ticker, 'stock', rows, fetchedAt);
  }

  const analysisIndices = [NIFTY_500_TICKER, ...Object.values(SECTOR_INDEX_TICKERS)];
  for (const ticker of [...Object.values(BENCHMARK_TICKERS), ...analysisIndices]) {
    const rows = await fetchYahooHistory(ticker, years);
    if (!rows.length) {
      failed.push(ticker);
      continue;
    }
    rowsWritten += await upsertPrices(env, ticker, 'benchmark', rows, fetchedAt);
  }

  return { rowsWritten, failed };
}
