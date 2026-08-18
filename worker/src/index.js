/**
 * Comments + Likes + Portfolio API — a Cloudflare Worker backed by a D1 (SQLite) database.
 *
 * Routes:
 *   GET    /api/comments?post=ID            -> { comments: [...] }
 *   POST   /api/comments  {post,name,body}  -> { ok: true, comment: {...} }
 *   GET    /api/likes?post=ID&visitor=VID   -> { count, liked }
 *   POST   /api/likes     {post,visitor}    -> { count, liked: true }
 *   DELETE /api/likes     {post,visitor}    -> { count, liked: false }
 *
 *   GET    /api/portfolio/holdings                    -> { holdings: [...] }        (public, no amounts)
 *   GET    /api/portfolio/summary                      -> { ...portfolio + benchmarks + deployedPct/cashPct } (public, no amounts)
 *   GET    /api/portfolio/price-history?symbol=X&days=N -> { prices: [...] }         (public)
 *   GET    /api/portfolio/levels?symbol=X                -> { currentPrice, levels } (public) — fast, our own DB
 *   GET    /api/portfolio/fundamentals?symbol=X          -> { fundamentals }         (public) — fast, our own DB
 *   GET    /api/portfolio/news?symbol=X                  -> { news }                 (public) — cached daily, not fetched live (see fetchAndStoreNews)
 *   GET    /api/portfolio/announcements?symbol=X         -> { announcements }        (public) — slow, external
 *   (levels/fundamentals/news/announcements used to be one bundled /insights route;
 *   split so a slow external fetch can't hold up the fast DB-only ones — see index.astro/[symbol].astro)
 *   GET    /api/portfolio/allocation                    -> { bySector, byCapTier }       (public)
 *   GET    /api/portfolio/analyze?symbol=X&period=1m|2m|3m|6m|1y -> { criteria, verdict, ... } (public) — on-demand 3-criteria momentum signal, see analyze.js
 *   GET    /api/portfolio/analyze-all?period=1m|2m|3m|6m|1y      -> { results: [...] }        (public) — same signal, run for every held symbol
 *   POST   /api/portfolio/trades       {trades: [...]}  -> { ok, inserted, skipped } (admin)
 *   POST   /api/portfolio/refresh                       -> { ok, prices, fundamentals, news } (admin) — manual price/fundamentals/news fetch, same work as the daily cron
 *
 * The D1 database is bound as `env.DB` (see wrangler.toml).
 *
 * A Cron Trigger (see [triggers] in wrangler.toml) fires scheduled() daily to
 * refresh price_history for the tracked stocks + benchmarks (src/prices.js).
 */

import {
  deriveHoldingsFromTrades,
  avgBuyPrice,
  computeSymbolReturns,
  computePortfolioReturns,
  computeBenchmarkReturns,
  toTicker,
  buildPriceLookup,
} from './portfolio.js';
import { computeLevels } from './levels.js';
import { fetchAnnouncements, fetchAndStoreNews } from './newsfeeds.js';
import { fetchAndStorePrices, TRACKED_STOCKS, NIFTY_500_TICKER, SECTOR_INDEX_TICKERS } from './prices.js';
import { fetchAndStoreFundamentals } from './fundamentals.js';
import { computeAllTimeHighSignal, computeReturnOverDays, verdictFor } from './analyze.js';

const MAX_NAME = 60;
const MAX_BODY = 2000;

const BENCHMARKS = {
  NIFTY50: '^NSEI',
  SENSEX: '^BSESN',
  NIFTY_MIDCAP: '^NSEMDCP50',
  NIFTY_SMALLCAP: 'NIFTYSMLCAP250.NS',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/comments') {
        if (request.method === 'GET') return getComments(url, env, cors);
        if (request.method === 'POST') return postComment(request, env, cors);
      }
      if (url.pathname === '/api/likes') {
        if (request.method === 'GET') return getLikes(url, env, cors);
        if (request.method === 'POST') return addLike(request, env, cors);
        if (request.method === 'DELETE') return removeLike(request, env, cors);
      }
      if (url.pathname === '/api/portfolio/holdings') {
        if (request.method === 'GET') return getHoldings(env, cors);
      }
      if (url.pathname === '/api/portfolio/summary') {
        if (request.method === 'GET') return getSummary(env, cors);
      }
      if (url.pathname === '/api/portfolio/price-history') {
        if (request.method === 'GET') return getPriceHistory(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/levels') {
        if (request.method === 'GET') return getLevels(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/fundamentals') {
        if (request.method === 'GET') return getFundamentals(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/news') {
        if (request.method === 'GET') return getNews(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/announcements') {
        if (request.method === 'GET') return getAnnouncements(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/allocation') {
        if (request.method === 'GET') return getAllocation(env, cors);
      }
      if (url.pathname === '/api/portfolio/analyze') {
        if (request.method === 'GET') return getAnalyze(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/analyze-all') {
        if (request.method === 'GET') return getAnalyzeAll(url, env, cors);
      }
      if (url.pathname === '/api/portfolio/trades') {
        if (request.method === 'POST') {
          if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
          return postTrades(request, env, cors);
        }
      }
      if (url.pathname === '/api/portfolio/refresh') {
        if (request.method === 'POST') {
          if (!requireAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
          const [prices, fundamentals, news] = await Promise.all([
            fetchAndStorePrices(env),
            fetchAndStoreFundamentals(env),
            fetchAndStoreNews(env, Object.keys(TRACKED_STOCKS)),
          ]);
          return json({ ok: true, prices, fundamentals, news }, 200, cors);
        }
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error', detail: String(err) }, 500, cors);
    }
  },

  // Cloudflare Cron Trigger (see [triggers] in wrangler.toml) — runs the daily
  // price + fundamentals + news fetch. ctx.waitUntil keeps the Worker alive until
  // it finishes instead of tearing down the isolate the instant this function returns.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([fetchAndStorePrices(env), fetchAndStoreFundamentals(env), fetchAndStoreNews(env, Object.keys(TRACKED_STOCKS))])
    );
  },
};

// ---------- Comments ----------

async function getComments(url, env, cors) {
  const post = url.searchParams.get('post');
  if (!post) return json({ error: 'Missing post' }, 400, cors);

  const { results } = await env.DB
    .prepare('SELECT id, name, body, created_at FROM comments WHERE post_slug = ? ORDER BY created_at DESC LIMIT 500')
    .bind(post)
    .all();

  return json({ comments: results || [] }, 200, cors);
}

async function postComment(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const post = String(data.post || '').trim();
  let name = String(data.name || '').trim().slice(0, MAX_NAME);
  const body = String(data.body || '').trim().slice(0, MAX_BODY);

  if (!post) return json({ error: 'Missing post' }, 400, cors);
  if (!body) return json({ error: 'Comment body is required' }, 400, cors);
  if (!name) name = 'Anonymous';

  const created_at = new Date().toISOString();
  const result = await env.DB
    .prepare('INSERT INTO comments (post_slug, name, body, created_at) VALUES (?, ?, ?, ?)')
    .bind(post, name, body, created_at)
    .run();

  return json(
    { ok: true, comment: { id: result.meta.last_row_id, name, body, created_at } },
    201,
    cors
  );
}

// ---------- Likes ----------

async function likeCount(env, post) {
  const row = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM likes WHERE post_slug = ?')
    .bind(post)
    .first();
  return row ? row.n : 0;
}

async function hasLiked(env, post, visitor) {
  const row = await env.DB
    .prepare('SELECT 1 FROM likes WHERE post_slug = ? AND visitor_id = ? LIMIT 1')
    .bind(post, visitor)
    .first();
  return !!row;
}

async function getLikes(url, env, cors) {
  const post = url.searchParams.get('post');
  const visitor = url.searchParams.get('visitor') || '';
  if (!post) return json({ error: 'Missing post' }, 400, cors);

  const [count, liked] = await Promise.all([
    likeCount(env, post),
    visitor ? hasLiked(env, post, visitor) : Promise.resolve(false),
  ]);
  return json({ count, liked }, 200, cors);
}

async function addLike(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const post = String(data.post || '').trim();
  const visitor = String(data.visitor || '').trim();
  if (!post || !visitor) return json({ error: 'Missing post or visitor' }, 400, cors);

  // INSERT OR IGNORE makes a repeated like a no-op (the table has a UNIQUE constraint).
  await env.DB
    .prepare('INSERT OR IGNORE INTO likes (post_slug, visitor_id, created_at) VALUES (?, ?, ?)')
    .bind(post, visitor, new Date().toISOString())
    .run();

  return json({ count: await likeCount(env, post), liked: true }, 200, cors);
}

async function removeLike(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const post = String(data.post || '').trim();
  const visitor = String(data.visitor || '').trim();
  if (!post || !visitor) return json({ error: 'Missing post or visitor' }, 400, cors);

  await env.DB
    .prepare('DELETE FROM likes WHERE post_slug = ? AND visitor_id = ?')
    .bind(post, visitor)
    .run();

  return json({ count: await likeCount(env, post), liked: false }, 200, cors);
}

// ---------- Portfolio ----------

const REQUIRED_TRADE_FIELDS = [
  'symbol',
  'exchange',
  'isin',
  'trade_type',
  'quantity',
  'price',
  'trade_date',
  'order_exec_time',
  'broker_trade_id',
];

// Loads every trade, derives per-symbol net qty/cashflows, and fetches the latest
// known price for each currently-held symbol. Shared by the holdings and summary
// endpoints so they agree on totalMarketValue/asOfDate. Real qty/price stay in this
// function's local scope — callers must only extract percentages from the result.
async function loadPortfolioState(env) {
  const { results: trades } = await env.DB
    .prepare('SELECT symbol, exchange, trade_type, quantity, price, trade_date FROM trades ORDER BY trade_date')
    .all();

  const bySymbol = deriveHoldingsFromTrades(trades || []);
  const allCashflows = (trades || []).map((t) => ({
    date: t.trade_date,
    amount: t.trade_type === 'buy' ? -t.price * t.quantity : t.price * t.quantity,
  }));

  let asOfDate = null;
  let totalMarketValue = 0;
  let totalInvested = 0;
  const holdings = [];

  for (const [symbol, h] of bySymbol) {
    if (h.netQty <= 0) continue; // fully exited (or short, which shouldn't happen for a long-only equity book)

    const ticker = toTicker(symbol, h.exchange);
    const priceRow = await env.DB
      .prepare('SELECT price_date, close FROM price_history WHERE symbol = ? AND kind = ? ORDER BY price_date DESC LIMIT 1')
      .bind(ticker, 'stock')
      .first();
    const latestPrice = priceRow ? priceRow.close : null;
    if (priceRow && (!asOfDate || priceRow.price_date > asOfDate)) asOfDate = priceRow.price_date;

    const avgBuy = avgBuyPrice(h);
    holdings.push({ symbol, exchange: h.exchange, netQty: h.netQty, cashflows: h.cashflows, latestPrice, avgBuyPrice: avgBuy });
    if (latestPrice != null) totalMarketValue += h.netQty * latestPrice;
    if (avgBuy != null) totalInvested += h.netQty * avgBuy;
  }

  if (!asOfDate) asOfDate = new Date().toISOString().slice(0, 10);

  return { holdings, allCashflows, totalMarketValue, totalInvested, asOfDate };
}

// Starter/Standard/High-conviction — sized against TOTAL_CAPITAL (the total
// planned book, private secret), not against currently-deployed value. A
// position's weightPct among *current* holdings looks huge early on simply
// because little else is deployed yet; weight against the full target book is
// what actually reflects conviction. Uses cost basis (what was actually
// deliberately allocated), not current market value — a stock shouldn't
// "graduate" to High-conviction just because its price went up; that's price
// drift, not a sizing decision. Thresholds are approximate percentage-of-book
// bands, not tied to any specific rupee figure.
function sizeTierFor(capitalWeightPct) {
  if (capitalWeightPct == null) return null;
  if (capitalWeightPct >= 7) return 'High-conviction';
  if (capitalWeightPct >= 4) return 'Standard';
  return 'Starter';
}

async function getHoldings(env, cors) {
  const { holdings, totalMarketValue, asOfDate } = await loadPortfolioState(env);
  const totalCapital = Number(env.TOTAL_CAPITAL);

  const response = holdings.map((h) => {
    const weightPct =
      totalMarketValue > 0 && h.latestPrice != null ? round2(((h.netQty * h.latestPrice) / totalMarketValue) * 100) : null;
    const { xirrPct, simpleReturnPct } = computeSymbolReturns(h.cashflows, h.netQty, h.latestPrice, asOfDate);

    const capitalWeightPct =
      totalCapital > 0 && h.avgBuyPrice != null ? (h.netQty * h.avgBuyPrice) / totalCapital * 100 : null;

    // Explicit whitelist — never spread a raw row. No qty, no marketValue, ever.
    // avgBuyPrice is a per-share price (not tied to position size), same category as currentPrice.
    return {
      symbol: h.symbol,
      weightPct,
      xirrPct,
      simpleReturnPct,
      currentPrice: h.latestPrice,
      avgBuyPrice: h.avgBuyPrice,
      sizeTier: sizeTierFor(capitalWeightPct),
    };
  });

  return json({ holdings: response, asOfDate }, 200, cors);
}

async function getSummary(env, cors) {
  const { allCashflows, totalMarketValue, totalInvested, asOfDate } = await loadPortfolioState(env);
  const portfolio = computePortfolioReturns(allCashflows, totalMarketValue, asOfDate);

  const benchmarks = [];
  for (const [name, ticker] of Object.entries(BENCHMARKS)) {
    const { results: rows } = await env.DB
      .prepare('SELECT price_date, close FROM price_history WHERE symbol = ? AND kind = ?')
      .bind(ticker, 'benchmark')
      .all();

    if (!rows || rows.length === 0) {
      benchmarks.push({ symbol: name, xirrPct: null, simpleReturnPct: null });
      continue;
    }

    const lookup = buildPriceLookup(rows);
    const { xirrPct, simpleReturnPct } = computeBenchmarkReturns(allCashflows, lookup, asOfDate);
    benchmarks.push({ symbol: name, xirrPct, simpleReturnPct });
  }

  // TOTAL_CAPITAL is a private Wrangler secret (never committed, never returned
  // directly) — only the derived percentage split is public, same discipline as
  // every other amount-vs-price boundary in this API.
  // Uses totalInvested (cost basis — what was actually paid), not totalMarketValue,
  // so this reflects capital committed, not the fluctuating market value of the
  // positions. A stock doubling shouldn't make "deployed %" rise on its own.
  const totalCapital = Number(env.TOTAL_CAPITAL);
  let deployedPct = null;
  let cashPct = null;
  if (totalCapital > 0) {
    deployedPct = round2(Math.min((totalInvested / totalCapital) * 100, 100));
    cashPct = round2(Math.max(100 - deployedPct, 0));
  }

  return json(
    {
      portfolioXirrPct: portfolio.xirrPct,
      portfolioSimpleReturnPct: portfolio.simpleReturnPct,
      asOfDate,
      benchmarks,
      deployedPct,
      cashPct,
    },
    200,
    cors
  );
}

// A symbol can be dual-listed (NSE + BSE) — resolve to whichever exchange its
// trades were actually booked on (preferring NSE), since price_history is keyed
// by the full ticker (e.g. "ANTHEM.NS"), not the bare symbol.
async function resolveTicker(symbol, env) {
  const exchangeRow = await env.DB
    .prepare("SELECT exchange FROM trades WHERE symbol = ? ORDER BY (exchange = 'NSE') DESC LIMIT 1")
    .bind(symbol)
    .first();
  return toTicker(symbol, exchangeRow ? exchangeRow.exchange : 'NSE');
}

async function getPriceHistory(url, env, cors) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '180', 10) || 180, 1), 1825);

  const ticker = await resolveTicker(symbol, env);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { results } = await env.DB
    .prepare('SELECT price_date AS date, open, high, low, close, volume FROM price_history WHERE symbol = ? AND price_date >= ? ORDER BY price_date ASC')
    .bind(ticker, since)
    .all();

  return json({ symbol, prices: results || [] }, 200, cors);
}

// Split into 4 independent endpoints (levels/fundamentals are our own DB —
// fast; news/announcements are best-effort fetches from unofficial upstream
// sources that can take several seconds). Bundling them into one response used
// to mean the whole stock page waited on the slowest of the four; now the
// client fires all four in parallel and renders each section as its own
// fetch resolves, so a slow NSE announcements fetch no longer blocks the chart.
async function getLevels(url, env, cors) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);

  const ticker = await resolveTicker(symbol, env);

  // 3 years + buffer — matches how far back the price fetch now goes (see prices.js).
  const since = new Date(Date.now() - 1100 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { results: priceRows } = await env.DB
    .prepare('SELECT price_date, open, high, low, close, volume FROM price_history WHERE symbol = ? AND price_date >= ? ORDER BY price_date ASC')
    .bind(ticker, since)
    .all();

  const currentPrice = priceRows && priceRows.length ? priceRows[priceRows.length - 1].close : null;
  const levels = computeLevels(priceRows || [], currentPrice);

  return json({ symbol, currentPrice, levels }, 200, cors);
}

async function getFundamentals(url, env, cors) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);

  const fundamentalsRow = await env.DB.prepare('SELECT * FROM fundamentals WHERE symbol = ?').bind(symbol).first();
  const fundamentals = fundamentalsRow
    ? {
        sector: fundamentalsRow.sector,
        industry: fundamentalsRow.industry,
        marketCapTier: marketCapTier(fundamentalsRow.market_cap),
        peRatio: fundamentalsRow.pe_ratio,
        forwardPe: fundamentalsRow.forward_pe,
        targetMeanPrice: fundamentalsRow.target_mean_price,
        targetHighPrice: fundamentalsRow.target_high_price,
        targetLowPrice: fundamentalsRow.target_low_price,
        debtToEquity: fundamentalsRow.debt_to_equity,
        revenueGrowth: fundamentalsRow.revenue_growth,
        earningsGrowth: fundamentalsRow.earnings_growth,
        revenueGrowthQoq: fundamentalsRow.revenue_growth_qoq,
        profitGrowthQoq: fundamentalsRow.profit_growth_qoq,
      }
    : null;

  return json({ symbol, fundamentals }, 200, cors);
}

// Allowed periods for the Analyze signal, in days — 1/2/3/6 months and 1 year.
// A fixed menu rather than an arbitrary number keeps the price_history window
// (below) bounded and the UI a simple set of buttons rather than a free input.
export const ANALYZE_PERIODS = { '1m': 30, '2m': 60, '3m': 90, '6m': 180, '1y': 365 };
const DEFAULT_ANALYZE_PERIOD = '1m';

// On-demand 3-criteria momentum signal (see analyze.js for the full rationale
// and data-quality caveats). All DB-backed, no live external calls, so this
// stays fast even though it's not pre-cached like levels/fundamentals.
// `days` drives all three checks: has the all-time high been touched in that
// window, and is the stock outperforming Nifty 500 + sector over that window.
// Profit is the exception — it's judged off quarterly data, not a day window.
async function computeAnalysisForSymbol(symbol, env, days = ANALYZE_PERIODS[DEFAULT_ANALYZE_PERIOD]) {
  const ticker = await resolveTicker(symbol, env);
  // 1100 days (~3yr) comfortably covers every ANALYZE_PERIODS option (max 365)
  // plus computeReturnOverDays' tolerance, regardless of which `days` is picked.
  const since = new Date(Date.now() - 1100 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const priceRowsFor = async (sym) => {
    const { results } = await env.DB
      .prepare('SELECT price_date, close FROM price_history WHERE symbol = ? AND price_date >= ? ORDER BY price_date ASC')
      .bind(sym, since)
      .all();
    return results || [];
  };

  const sectorTicker = SECTOR_INDEX_TICKERS[symbol] || null;
  const [stockRows, nifty500Rows, sectorRows, fundamentalsRow] = await Promise.all([
    priceRowsFor(ticker),
    priceRowsFor(NIFTY_500_TICKER),
    sectorTicker ? priceRowsFor(sectorTicker) : Promise.resolve(null),
    env.DB.prepare('SELECT profit_at_recent_high, profit_pct_off_recent_high FROM fundamentals WHERE symbol = ?').bind(symbol).first(),
  ]);

  const atHigh = computeAllTimeHighSignal(stockRows, days);
  const stockReturn = computeReturnOverDays(stockRows, days);
  const nifty500Return = computeReturnOverDays(nifty500Rows, days);
  const sectorReturn = sectorRows ? computeReturnOverDays(sectorRows, days) : null;

  // Outperformance is judged over the same window the price/high check uses,
  // so the pass/fail icon always agrees with the alpha figures shown next to it.
  const beatsNifty500 = stockReturn != null && nifty500Return != null ? stockReturn > nifty500Return : null;
  const beatsSector = sectorTicker ? (stockReturn != null && sectorReturn != null ? stockReturn > sectorReturn : null) : null;
  const outperformanceMet = sectorTicker
    ? beatsNifty500 != null && beatsSector != null
      ? beatsNifty500 && beatsSector
      : null
    : beatsNifty500;

  const profitAtRecentHigh =
    fundamentalsRow && fundamentalsRow.profit_at_recent_high != null ? Boolean(fundamentalsRow.profit_at_recent_high) : null;
  const profitPctOffRecentHigh = fundamentalsRow ? fundamentalsRow.profit_pct_off_recent_high : null;

  const criteria = [
    { key: 'priceAtAllTimeHigh', met: atHigh.hitWithinWindow, applicable: true },
    { key: 'profitAtRecentHigh', met: profitAtRecentHigh, applicable: profitAtRecentHigh != null },
    { key: 'outperformance', met: outperformanceMet, applicable: outperformanceMet != null },
  ];
  const applicableCount = criteria.filter((c) => c.applicable).length;
  const metCount = criteria.filter((c) => c.applicable && c.met).length;

  return {
    symbol,
    days,
    criteria,
    metCount,
    applicableCount,
    verdict: verdictFor(metCount, applicableCount),
    daysSinceHigh: atHigh.daysSinceHigh,
    observedHigh: atHigh.observedHigh,
    pctOffHigh: atHigh.pctOffHigh,
    profitPctOffRecentHigh,
    stockReturnPct: stockReturn,
    nifty500ReturnPct: nifty500Return,
    sectorReturnPct: sectorReturn,
    alphaVsNifty500Pct: stockReturn != null && nifty500Return != null ? round2(stockReturn - nifty500Return) : null,
    alphaVsSectorPct: sectorTicker && stockReturn != null && sectorReturn != null ? round2(stockReturn - sectorReturn) : null,
    sectorIndexAvailable: Boolean(sectorTicker),
    priceHistoryYears: 3,
  };
}

// ?period=1m|2m|3m|6m|1y (see ANALYZE_PERIODS); falls back to 1 month for a
// missing or unrecognized value.
function periodDaysFrom(url) {
  const period = url.searchParams.get('period');
  return ANALYZE_PERIODS[period] || ANALYZE_PERIODS[DEFAULT_ANALYZE_PERIOD];
}

async function getAnalyze(url, env, cors) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  return json(await computeAnalysisForSymbol(symbol, env, periodDaysFrom(url)), 200, cors);
}

// Same signal, run across every currently-held symbol in one request — powers
// the portfolio page's "Analyze portfolio" button instead of one fetch per stock.
async function getAnalyzeAll(url, env, cors) {
  const { holdings } = await loadPortfolioState(env);
  const days = periodDaysFrom(url);
  const results = await Promise.all(holdings.map((h) => computeAnalysisForSymbol(h.symbol, env, days)));
  return json({ results }, 200, cors);
}

// Served from news_cache (refreshed daily by scheduled()/the refresh route) rather
// than fetched live — Google blocks live news.google.com fetches from Cloudflare
// Workers' shared IPs, see fetchAndStoreNews() in newsfeeds.js.
async function getNews(url, env, cors) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  const row = await env.DB.prepare('SELECT items FROM news_cache WHERE symbol = ?').bind(symbol).first();
  const news = row ? JSON.parse(row.items) : [];
  return json({ symbol, news }, 200, cors);
}

async function getAnnouncements(url, env, cors) {
  const symbol = url.searchParams.get('symbol');
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  const announcements = await fetchAnnouncements(symbol);
  return json({ symbol, announcements }, 200, cors);
}

// AMFI's actual rank-based cutoffs (rank #100 / #250 by 6-month avg market cap),
// not a fixed formula — these drift and AMFI republishes them every Jan/Jul.
// Hardcoded to the July 2026 cutoffs; update when AMFI issues a new list.
const LARGE_CAP_CUTOFF_CR = 106300;
const MID_CAP_CUTOFF_CR = 33500;
// "Micro cap" isn't an official AMFI/SEBI tier — everything below Mid Cap is
// officially just "Small Cap" — but that bucket is too coarse to be useful
// (spans 7x+ in this portfolio), so we split it informally at Rs 5,000cr.
const SMALL_CAP_CUTOFF_CR = 5000;

function marketCapTier(marketCap) {
  if (marketCap == null) return null;
  const crore = marketCap / 1e7;
  if (crore >= LARGE_CAP_CUTOFF_CR) return 'Large';
  if (crore >= MID_CAP_CUTOFF_CR) return 'Mid';
  if (crore >= SMALL_CAP_CUTOFF_CR) return 'Small';
  return 'Micro';
}

// Sector + market-cap-tier allocation, weighted by current holdings' market value
// (computed in-memory only, never returned — only the resulting weight percentages are).
async function getAllocation(env, cors) {
  const { holdings, totalMarketValue } = await loadPortfolioState(env);
  const { results: fundamentalsRows } = await env.DB.prepare('SELECT symbol, sector, market_cap FROM fundamentals').all();
  const fundamentalsBySymbol = new Map((fundamentalsRows || []).map((r) => [r.symbol, r]));

  const bySector = new Map();
  const byCapTier = new Map();

  for (const h of holdings) {
    if (h.latestPrice == null || totalMarketValue <= 0) continue;
    const weightPct = ((h.netQty * h.latestPrice) / totalMarketValue) * 100;
    const f = fundamentalsBySymbol.get(h.symbol);

    const sector = f?.sector || 'Unknown';
    bySector.set(sector, (bySector.get(sector) || 0) + weightPct);

    const tier = f ? marketCapTier(f.market_cap) || 'Unknown' : 'Unknown';
    byCapTier.set(tier, (byCapTier.get(tier) || 0) + weightPct);
  }

  const toSortedArray = (map) =>
    [...map.entries()].map(([name, weightPct]) => ({ name, weightPct: round2(weightPct) })).sort((a, b) => b.weightPct - a.weightPct);

  return json({ bySector: toSortedArray(bySector), byCapTier: toSortedArray(byCapTier) }, 200, cors);
}

async function postTrades(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  if (!Array.isArray(data.trades) || data.trades.length === 0) {
    return json({ error: 'Missing trades' }, 400, cors);
  }

  for (let i = 0; i < data.trades.length; i++) {
    const t = data.trades[i];
    for (const field of REQUIRED_TRADE_FIELDS) {
      if (t[field] === undefined || t[field] === null || t[field] === '') {
        return json({ error: `Trade ${i}: missing ${field}` }, 400, cors);
      }
    }
    if (t.trade_type !== 'buy' && t.trade_type !== 'sell') {
      return json({ error: `Trade ${i}: trade_type must be 'buy' or 'sell'` }, 400, cors);
    }
    if (!(Number(t.quantity) > 0) || !(Number(t.price) > 0)) {
      return json({ error: `Trade ${i}: quantity and price must be positive numbers` }, 400, cors);
    }
  }

  const created_at = new Date().toISOString();
  const stmts = data.trades.map((t) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO trades
       (symbol, exchange, isin, trade_type, quantity, price, trade_date, order_exec_time, broker_trade_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      t.symbol,
      t.exchange,
      t.isin,
      t.trade_type,
      Number(t.quantity),
      Number(t.price),
      t.trade_date,
      t.order_exec_time,
      String(t.broker_trade_id),
      created_at
    )
  );

  const results = await env.DB.batch(stmts);
  const inserted = results.filter((r) => r.meta.changes === 1).length;

  return json({ ok: true, inserted, skipped: data.trades.length - inserted }, 200, cors);
}

// ---------- Helpers ----------

function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return !!env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`;
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
