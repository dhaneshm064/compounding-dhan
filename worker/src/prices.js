import { BROWSER_UA } from './newsfeeds.js';

// The 4 stocks this tool tracks, mapped to their yfinance/Yahoo ticker.
// Update this if the tracked set changes — must match the admin upload's
// TRACKED_SYMBOLS allowlist in src/pages/portfolio/admin.astro.
export const TRACKED_STOCKS = {
  SKYGOLD: 'SKYGOLD.NS',
  ANTHEM: 'ANTHEM.NS',
  KMEW: 'KMEW.NS',
  KRISHNADEF: 'KRISHNADEF.NS',
};

// Must match the BENCHMARKS map in index.js.
const BENCHMARK_TICKERS = {
  NIFTY50: '^NSEI',
  SENSEX: '^BSESN',
  NIFTY_MIDCAP: '^NSEMDCP50',
  NIFTY_SMALLCAP: 'NIFTYSMLCAP250.NS',
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
export async function fetchAndStorePrices(env) {
  const fetchedAt = new Date().toISOString();
  let rowsWritten = 0;
  const failed = [];

  for (const ticker of Object.values(TRACKED_STOCKS)) {
    const rows = await fetchYahooHistory(ticker);
    if (!rows.length) {
      failed.push(ticker);
      continue;
    }
    rowsWritten += await upsertPrices(env, ticker, 'stock', rows, fetchedAt);
  }

  for (const ticker of Object.values(BENCHMARK_TICKERS)) {
    const rows = await fetchYahooHistory(ticker);
    if (!rows.length) {
      failed.push(ticker);
      continue;
    }
    rowsWritten += await upsertPrices(env, ticker, 'benchmark', rows, fetchedAt);
  }

  return { rowsWritten, failed };
}
