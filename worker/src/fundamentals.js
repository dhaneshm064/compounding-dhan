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
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile,summaryDetail,financialData,incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly&crumb=${encodeURIComponent(auth.crumb)}`;
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
    const balanceSheets = result.balanceSheetHistoryQuarterly?.balanceSheetStatements || [];
    const cashFlows = result.cashflowStatementHistoryQuarterly?.cashflowStatements || [];
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
    // Company-level financials (not the user's own position size), same
    // category as market cap or revenue growth — safe to show in rupees.
    // Stored in crore, the standard unit Indian markets report profit in.
    const toCrore = (n) => (n == null ? null : Math.round((n / 1e7) * 100) / 100);
    const latestQuarterProfitCr = toCrore(latestNetIncome);
    const recentHighQuarterProfitCr = toCrore(recentHighNetIncome);

    const periodKey = (statement) => statement?.endDate?.fmt || (statement?.endDate?.raw ? new Date(statement.endDate.raw * 1000).toISOString().slice(0, 10) : null);
    const byPeriod = (statements) => new Map(statements.map((statement) => [periodKey(statement), statement]).filter(([key]) => key));
    const balanceByPeriod = byPeriod(balanceSheets);
    const cashByPeriod = byPeriod(cashFlows);
    const raw = (statement, field) => statement?.[field]?.raw ?? null;
    const quarterlyStatements = quarters.map((income) => {
      const periodEnd = periodKey(income);
      const balance = balanceByPeriod.get(periodEnd) || {};
      const cashFlow = cashByPeriod.get(periodEnd) || {};
      const operatingCashFlow = raw(cashFlow, 'totalCashFromOperatingActivities');
      const capex = raw(cashFlow, 'capitalExpenditures');
      return {
        periodEnd,
        revenue: raw(income, 'totalRevenue'),
        operatingIncome: raw(income, 'operatingIncome'),
        ebitda: raw(income, 'ebitda'),
        netIncome: raw(income, 'netIncome'),
        dilutedEps: raw(income, 'dilutedEPS'),
        totalAssets: raw(balance, 'totalAssets'),
        totalDebt: raw(balance, 'totalDebt') ?? raw(balance, 'longTermDebt'),
        stockholderEquity: raw(balance, 'totalStockholderEquity'),
        cash: raw(balance, 'cash') ?? raw(balance, 'cashAndCashEquivalents'),
        receivables: raw(balance, 'netReceivables'),
        inventory: raw(balance, 'inventory'),
        operatingCashFlow,
        capitalExpenditure: capex,
        freeCashFlow: operatingCashFlow != null && capex != null ? operatingCashFlow + capex : null,
      };
    }).filter((statement) => statement.periodEnd);

    return {
      profitAtRecentHigh,
      profitPctOffRecentHigh,
      latestQuarterProfitCr,
      recentHighQuarterProfitCr,
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
      quarterlyStatements,
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

    const { quarterlyStatements: _quarterlyStatements, ...snapshotData } = f;
    await env.DB.prepare(
      `INSERT INTO fundamentals
         (symbol, sector, industry, market_cap, pe_ratio, forward_pe, target_mean_price, target_high_price, target_low_price, recommendation, debt_to_equity, revenue_growth, earnings_growth, revenue_growth_qoq, profit_growth_qoq, profit_at_recent_high, profit_pct_off_recent_high, latest_quarter_profit_cr, recent_high_quarter_profit_cr, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         sector = excluded.sector, industry = excluded.industry, market_cap = excluded.market_cap,
         pe_ratio = excluded.pe_ratio, forward_pe = excluded.forward_pe, target_mean_price = excluded.target_mean_price,
         target_high_price = excluded.target_high_price, target_low_price = excluded.target_low_price,
         recommendation = excluded.recommendation, debt_to_equity = excluded.debt_to_equity,
         revenue_growth = excluded.revenue_growth, earnings_growth = excluded.earnings_growth,
         revenue_growth_qoq = excluded.revenue_growth_qoq, profit_growth_qoq = excluded.profit_growth_qoq,
         profit_at_recent_high = excluded.profit_at_recent_high, profit_pct_off_recent_high = excluded.profit_pct_off_recent_high,
         latest_quarter_profit_cr = excluded.latest_quarter_profit_cr, recent_high_quarter_profit_cr = excluded.recent_high_quarter_profit_cr,
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
        f.latestQuarterProfitCr,
        f.recentHighQuarterProfitCr,
        fetchedAt
      )
      .run();

    for (const statement of f.quarterlyStatements || []) {
      await env.DB.prepare(
        `INSERT INTO fundamental_periods
           (symbol, period_end, period_type, revenue, operating_income, ebitda, net_income, diluted_eps,
            total_assets, total_debt, stockholder_equity, cash, receivables, inventory,
            operating_cash_flow, capital_expenditure, free_cash_flow, available_from, fetched_at)
         VALUES (?, ?, 'quarterly', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, period_end, period_type) DO UPDATE SET
           revenue = excluded.revenue, operating_income = excluded.operating_income, ebitda = excluded.ebitda,
           net_income = excluded.net_income, diluted_eps = excluded.diluted_eps, total_assets = excluded.total_assets,
           total_debt = excluded.total_debt, stockholder_equity = excluded.stockholder_equity, cash = excluded.cash,
           receivables = excluded.receivables, inventory = excluded.inventory,
           operating_cash_flow = excluded.operating_cash_flow, capital_expenditure = excluded.capital_expenditure,
           free_cash_flow = excluded.free_cash_flow, fetched_at = excluded.fetched_at`
      ).bind(
        symbol, statement.periodEnd, statement.revenue, statement.operatingIncome, statement.ebitda,
        statement.netIncome, statement.dilutedEps, statement.totalAssets, statement.totalDebt,
        statement.stockholderEquity, statement.cash, statement.receivables, statement.inventory,
        statement.operatingCashFlow, statement.capitalExpenditure, statement.freeCashFlow, fetchedAt, fetchedAt
      ).run();
    }

    await env.DB.prepare(
      `INSERT INTO fundamental_snapshots (symbol, snapshot_date, data_json, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol, snapshot_date) DO UPDATE SET
         data_json = excluded.data_json, fetched_at = excluded.fetched_at`
    )
      .bind(symbol, fetchedAt.slice(0, 10), JSON.stringify(snapshotData), fetchedAt)
      .run();
    updated++;
  }

  return { updated, failed };
}

/** Creates a baseline snapshot from latest-only rows when enabling history. */
export async function snapshotCurrentFundamentals(env) {
  const { results } = await env.DB.prepare('SELECT * FROM fundamentals').all();
  let inserted = 0;
  for (const row of results || []) {
    const data = {
      sector: row.sector,
      industry: row.industry,
      marketCap: row.market_cap,
      peRatio: row.pe_ratio,
      forwardPe: row.forward_pe,
      targetMeanPrice: row.target_mean_price,
      debtToEquity: row.debt_to_equity,
      revenueGrowth: row.revenue_growth,
      earningsGrowth: row.earnings_growth,
      revenueGrowthQoq: row.revenue_growth_qoq,
      profitGrowthQoq: row.profit_growth_qoq,
      profitAtRecentHigh: row.profit_at_recent_high == null ? null : Boolean(row.profit_at_recent_high),
      latestQuarterProfitCr: row.latest_quarter_profit_cr,
    };
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO fundamental_snapshots (symbol, snapshot_date, data_json, fetched_at)
       VALUES (?, ?, ?, ?)`
    ).bind(row.symbol, row.fetched_at.slice(0, 10), JSON.stringify(data), row.fetched_at).run();
    inserted += result.meta.changes || 0;
  }
  return { inserted };
}
