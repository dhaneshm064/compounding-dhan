import { BROWSER_UA } from './newsfeeds.js';
import { TRACKED_STOCKS } from './prices.js';

// Yahoo's quoteSummary endpoint requires a session cookie + crumb (unlike the
// chart endpoint, which is open). This replicates the same handshake yfinance
// does internally: grab a cookie from fc.yahoo.com, exchange it for a crumb.
async function getYahooAuth() {
  try {
    const res1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': BROWSER_UA } });
    const setCookie = typeof res1.headers.getSetCookie === 'function' ? res1.headers.getSetCookie() : [res1.headers.get('set-cookie')];
    const cookie = setCookie.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) return null;

    const res2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': BROWSER_UA, Cookie: cookie },
    });
    if (!res2.ok) return null;
    const crumb = await res2.text();
    if (!crumb || crumb.includes('<')) return null; // sanity check — not an HTML error page

    return { cookie, crumb };
  } catch {
    return null;
  }
}

// Manual overrides — Yahoo's auto-classification lumps distinct businesses into
// coarse GICS buckets (e.g. both KMEW and KRISHNADEF land under "Industrials"),
// which isn't useful for a 4-stock personal dashboard. Researched and confirmed
// against each company's actual business (see conversation history) before overriding.
const CLASSIFICATION_OVERRIDES = {
  KRISHNADEF: { sector: 'Defence' },
  KMEW: { sector: 'Marine' },
  ANTHEM: { sector: 'CDMO' },
  SKYGOLD: { sector: 'Jewellery' },
};

async function fetchOneFundamentals(ticker, auth) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile,summaryDetail,financialData,incomeStatementHistoryQuarterly&crumb=${encodeURIComponent(auth.crumb)}`;
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Cookie: auth.cookie } });
    if (!res.ok) return null;

    const data = await res.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return null;

    const ap = result.assetProfile || {};
    const sd = result.summaryDetail || {};
    const fd = result.financialData || {};

    // Yahoo's own revenueGrowth/earningsGrowth (from financialData) are quarter-over-
    // same-quarter-last-year (YoY). For quarter-over-previous-quarter (QoQ) we need the
    // two most recent quarterly statements ourselves — index 0 is the latest quarter,
    // index 1 the one before it.
    const quarters = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const qoqGrowth = (field) => {
      const latest = quarters[0]?.[field]?.raw;
      const prior = quarters[1]?.[field]?.raw;
      if (latest == null || prior == null || prior === 0) return null;
      return (latest - prior) / Math.abs(prior);
    };

    // Best available proxy for "TTM profit at an all-time high" (from the Analyze
    // feature's 3-criteria framework) — Yahoo's free API only returns the last 4
    // quarters, not enough to reconstruct a true historical TTM series, so this
    // checks whether the most recent quarter is itself the highest of those 4
    // rather than claiming a genuine lifetime record.
    const recentNetIncomes = quarters.map((q) => q.netIncome?.raw).filter((v) => v != null);
    const latestNetIncome = quarters[0]?.netIncome?.raw ?? null;
    const recentHighNetIncome = recentNetIncomes.length >= 2 ? Math.max(...recentNetIncomes) : null;
    const profitAtRecentHigh = recentHighNetIncome != null && latestNetIncome != null ? latestNetIncome >= recentHighNetIncome : null;
    // How far below the best of the last 4 quarters the latest one is — only
    // meaningful (and only shown) when it isn't itself the high.
    const profitPctOffRecentHigh =
      recentHighNetIncome != null && latestNetIncome != null && recentHighNetIncome !== 0
        ? Math.round(((latestNetIncome - recentHighNetIncome) / Math.abs(recentHighNetIncome)) * 10000) / 100
        : null;

    return {
      profitAtRecentHigh,
      profitPctOffRecentHigh,
      sector: ap.sector ?? null,
      industry: ap.industry ?? null,
      marketCap: sd.marketCap?.raw ?? null,
      peRatio: sd.trailingPE?.raw ?? null,
      forwardPe: sd.forwardPE?.raw ?? null,
      targetMeanPrice: fd.targetMeanPrice?.raw ?? null,
      targetHighPrice: fd.targetHighPrice?.raw ?? null,
      targetLowPrice: fd.targetLowPrice?.raw ?? null,
      recommendation: fd.recommendationKey ?? null,
      debtToEquity: fd.debtToEquity?.raw ?? null,
      revenueGrowth: fd.revenueGrowth?.raw ?? null,
      earningsGrowth: fd.earningsGrowth?.raw ?? null,
      revenueGrowthQoq: qoqGrowth('totalRevenue'),
      profitGrowthQoq: qoqGrowth('netIncome'),
    };
  } catch {
    return null;
  }
}

/** Fetches + upserts a fundamentals snapshot for every tracked stock. Best-effort per stock. */
export async function fetchAndStoreFundamentals(env) {
  const auth = await getYahooAuth();
  if (!auth) return { updated: 0, failed: Object.keys(TRACKED_STOCKS) };

  const fetchedAt = new Date().toISOString();
  let updated = 0;
  const failed = [];

  for (const [symbol, ticker] of Object.entries(TRACKED_STOCKS)) {
    const f = await fetchOneFundamentals(ticker, auth);
    if (!f) {
      failed.push(symbol);
      continue;
    }

    const override = CLASSIFICATION_OVERRIDES[symbol];
    if (override) Object.assign(f, override);

    await env.DB.prepare(
      `INSERT INTO fundamentals
         (symbol, sector, industry, market_cap, pe_ratio, forward_pe, target_mean_price, target_high_price, target_low_price, recommendation, debt_to_equity, revenue_growth, earnings_growth, revenue_growth_qoq, profit_growth_qoq, profit_at_recent_high, profit_pct_off_recent_high, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         sector = excluded.sector, industry = excluded.industry, market_cap = excluded.market_cap,
         pe_ratio = excluded.pe_ratio, forward_pe = excluded.forward_pe, target_mean_price = excluded.target_mean_price,
         target_high_price = excluded.target_high_price, target_low_price = excluded.target_low_price,
         recommendation = excluded.recommendation, debt_to_equity = excluded.debt_to_equity,
         revenue_growth = excluded.revenue_growth, earnings_growth = excluded.earnings_growth,
         revenue_growth_qoq = excluded.revenue_growth_qoq, profit_growth_qoq = excluded.profit_growth_qoq,
         profit_at_recent_high = excluded.profit_at_recent_high, profit_pct_off_recent_high = excluded.profit_pct_off_recent_high,
         fetched_at = excluded.fetched_at`
    )
      .bind(
        symbol,
        f.sector,
        f.industry,
        f.marketCap,
        f.peRatio,
        f.forwardPe,
        f.targetMeanPrice,
        f.targetHighPrice,
        f.targetLowPrice,
        f.recommendation,
        f.debtToEquity,
        f.revenueGrowth,
        f.earningsGrowth,
        f.revenueGrowthQoq,
        f.profitGrowthQoq,
        f.profitAtRecentHigh == null ? null : f.profitAtRecentHigh ? 1 : 0,
        f.profitPctOffRecentHigh,
        fetchedAt
      )
      .run();
    updated++;
  }

  return { updated, failed };
}
