import { computeLevels } from './levels.js';
import { TRACKED_STOCKS, BENCHMARK_TICKERS, BENCHMARK_LABELS, SECTOR_INDEX_TICKERS, SECTOR_INDEX_NAMES } from './prices.js';
import { analyzeFilingsForReport, analyzePortfolioForReport, FILING_REVIEW_MODEL, FILING_REVIEW_PROMPT_VERSION } from './ai-review.js';

export const REPORT_GENERATOR_VERSION = '1.2.0';

export function monthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('Month must use YYYY-MM');
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${month}-01`;
  const next = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { start, end, next };
}

export async function buildMonthlyReport(env, month) {
  const range = monthRange(month);
  const generatedAt = new Date().toISOString();
  const { results: trades } = await env.DB.prepare(
    'SELECT symbol, trade_type, quantity, trade_date FROM trades WHERE trade_date < ? ORDER BY trade_date'
  ).bind(range.next).all();

  const startQty = quantitiesAt(trades || [], range.start, false);
  const endQty = quantitiesAt(trades || [], range.next, false);
  const symbols = [...endQty.entries()].filter(([, qty]) => qty > 0).map(([symbol]) => symbol);

  const [nifty50Rows, niftyMidcapRows, niftySmallcapRows] = await Promise.all([
    pricesFor(env, BENCHMARK_TICKERS.NIFTY50, range),
    pricesFor(env, BENCHMARK_TICKERS.NIFTY_MIDCAP, range),
    pricesFor(env, BENCHMARK_TICKERS.NIFTY_SMALLCAP, range),
  ]);
  const benchmarkReturns = {
    nifty50: periodReturn(nifty50Rows, range),
    niftyMidcap: periodReturn(niftyMidcapRows, range),
    niftySmallcap: periodReturn(niftySmallcapRows, range),
  };
  const holdings = [];

  for (const symbol of symbols) {
    const ticker = TRACKED_STOCKS[symbol];
    if (!ticker) continue;
    const stockRows = await pricesFor(env, ticker, range);
    const sectorTicker = SECTOR_INDEX_TICKERS[symbol] || null;
    const sectorRows = sectorTicker ? await pricesFor(env, sectorTicker, range) : [];
    const stockReturn = periodReturn(stockRows, range);
    const sectorReturn = sectorTicker ? periodReturn(sectorRows, range) : null;
    const monthRows = stockRows.filter((row) => row.price_date >= range.start && row.price_date < range.next);
    const endRows = stockRows.filter((row) => row.price_date < range.next);
    const firstPrice = monthRows[0]?.close ?? null;
    const lastPrice = monthRows.at(-1)?.close ?? null;
    const initialQty = startQty.get(symbol) || 0;
    const startValue = initialQty > 0 && firstPrice != null ? initialQty * firstPrice : 0;
    const technical = technicalSnapshot(endRows, monthRows, lastPrice);
    const fundamentals = await fundamentalChange(env, symbol, range);
    const [events, aiReview] = await Promise.all([evidenceFor(env, symbol, range), filingAiFor(env, symbol, range)]);
    const governance = governanceSummary(events, aiReview);

    holdings.push({
      symbol,
      period: { firstTradingDate: monthRows[0]?.price_date || null, lastTradingDate: monthRows.at(-1)?.price_date || null },
      position: {
        heldAtStart: initialQty > 0, heldAtEnd: (endQty.get(symbol) || 0) > 0,
        startValueBasis: round2(startValue), endValue: lastPrice == null ? null : round2((endQty.get(symbol) || 0) * lastPrice),
        endWeightPct: null,
      },
      performance: {
        returnPct: stockReturn,
        nifty50ReturnPct: benchmarkReturns.nifty50,
        alphaVsNifty50Pct: subtract(stockReturn, benchmarkReturns.nifty50),
        niftyMidcapReturnPct: benchmarkReturns.niftyMidcap,
        alphaVsNiftyMidcapPct: subtract(stockReturn, benchmarkReturns.niftyMidcap),
        niftySmallcapReturnPct: benchmarkReturns.niftySmallcap,
        alphaVsNiftySmallcapPct: subtract(stockReturn, benchmarkReturns.niftySmallcap),
        sectorReturnPct: sectorReturn,
        alphaVsSectorPct: subtract(stockReturn, sectorReturn),
        sectorIndexName: sectorTicker ? SECTOR_INDEX_NAMES[symbol] || sectorTicker : null,
      },
      technical,
      fundamentals,
      developments: events.filter((event) => event.category !== 'governance' && event.category !== 'routine-compliance').slice(0, 12),
      governance,
    });
  }

  const endPortfolioValue = holdings.reduce((sum, holding) => sum + Number(holding.position.endValue || 0), 0);
  for (const holding of holdings) holding.position.endWeightPct = endPortfolioValue > 0 ? round2((holding.position.endValue / endPortfolioValue) * 100) : null;

  const weighted = holdings.filter((holding) => holding.position.startValueBasis > 0 && holding.performance.returnPct != null);
  const coveredValue = weighted.reduce((sum, holding) => sum + holding.position.startValueBasis, 0);
  const portfolioReturn = coveredValue > 0
    ? weighted.reduce((sum, holding) => sum + holding.position.startValueBasis * holding.performance.returnPct, 0) / coveredValue
    : null;
  const observations = buildObservations(holdings);
  const reviewPoints = observations.filter((point) => point.severity === 'medium' || point.severity === 'high');
  const missing = [];
  if (!holdings.length) missing.push('No holdings were found at month end.');
  for (const [name, value] of Object.entries(benchmarkReturns)) {
    if (value == null) missing.push(`${benchmarkLabel(name)} price coverage is incomplete.`);
  }
  if (holdings.some((holding) => !holding.position.heldAtStart)) missing.push('New positions are excluded from weighted return until their first full calendar month.');
  if (holdings.some((holding) => holding.fundamentals.coverage === 'missing')) missing.push('Some holdings have no fundamental data.');
  if (holdings.some((holding) => holding.fundamentals.outsidePeriod)) missing.push('Some fundamental figures are latest-known values published after this report month and are not historical comparisons.');
  if (holdings.some((holding) => holding.governance.status === 'insufficient-evidence')) missing.push('Some governance checks had no stored news or announcement evidence; this is not a clean result.');
  if (holdings.some((holding) => holding.governance.aiCoverage.unreviewed > 0)) missing.push('Some material filings were not available for AI content review in this report generation.');
  if (holdings.some((holding) => holding.governance.aiCoverage.needsOcr > 0)) missing.push('Some filing PDFs need OCR and were excluded from AI content review.');
  if (holdings.some((holding) => holding.governance.aiCoverage.failed > 0)) missing.push('Some AI filing reviews failed and require a retry or manual review.');
  const portfolioSnapshot = {
    returnPct: round2(portfolioReturn),
    alphaVsNifty50Pct: subtract(portfolioReturn, benchmarkReturns.nifty50),
    alphaVsNiftyMidcapPct: subtract(portfolioReturn, benchmarkReturns.niftyMidcap),
    alphaVsNiftySmallcapPct: subtract(portfolioReturn, benchmarkReturns.niftySmallcap),
  };
  const portfolioAnalysis = await analyzePortfolioForReport(env, { month, portfolio: portfolioSnapshot, holdings, warnings: missing });

  return {
    schemaVersion: 1,
    generatorVersion: REPORT_GENERATOR_VERSION,
    reportMonth: month,
    period: range,
    generatedAt,
    aiReview: {
      model: FILING_REVIEW_MODEL,
      promptVersion: FILING_REVIEW_PROMPT_VERSION,
      storage: 'Only this final report is persisted; specialist responses are processed in memory and discarded.',
    },
    methodology: 'Calendar-month close-to-close returns. Portfolio return uses month-start market-value weights and excludes positions not held at month start.',
    portfolioAnalysis,
    portfolio: {
      returnPct: portfolioSnapshot.returnPct,
      nifty50ReturnPct: benchmarkReturns.nifty50,
      alphaVsNifty50Pct: portfolioSnapshot.alphaVsNifty50Pct,
      niftyMidcapReturnPct: benchmarkReturns.niftyMidcap,
      alphaVsNiftyMidcapPct: portfolioSnapshot.alphaVsNiftyMidcapPct,
      niftySmallcapReturnPct: benchmarkReturns.niftySmallcap,
      alphaVsNiftySmallcapPct: portfolioSnapshot.alphaVsNiftySmallcapPct,
      holdingsAtEnd: holdings.length,
      reviewPointCount: reviewPoints.length,
    },
    reviewPoints,
    observations,
    holdings,
    dataQuality: { warnings: missing },
    disclaimer: 'Automated research aid, not investment advice. Governance matches are prompts for review, not findings of wrongdoing.',
  };
}

function quantitiesAt(trades, cutoff) {
  const quantities = new Map();
  for (const trade of trades) {
    if (trade.trade_date >= cutoff) continue;
    const signed = String(trade.trade_type).toLowerCase() === 'sell' ? -Number(trade.quantity) : Number(trade.quantity);
    quantities.set(trade.symbol, (quantities.get(trade.symbol) || 0) + signed);
  }
  return quantities;
}

async function pricesFor(env, ticker, range) {
  const lookback = new Date(`${range.start}T00:00:00Z`);
  lookback.setUTCDate(lookback.getUTCDate() - 320);
  const { results } = await env.DB.prepare(
    'SELECT price_date, open, high, low, close, volume FROM price_history WHERE symbol = ? AND price_date >= ? AND price_date < ? ORDER BY price_date'
  ).bind(ticker, lookback.toISOString().slice(0, 10), range.next).all();
  return results || [];
}

function periodReturn(rows, range) {
  const monthRows = rows.filter((row) => row.price_date >= range.start && row.price_date < range.next);
  if (monthRows.length < 2 || !monthRows[0].close) return null;
  return round2(((monthRows.at(-1).close - monthRows[0].close) / monthRows[0].close) * 100);
}

function technicalSnapshot(history, monthRows, currentPrice) {
  const levels = computeLevels(history, currentPrice);
  const avgVolume = history.slice(-60).filter((row) => row.volume != null).reduce((sum, row, _, arr) => sum + row.volume / arr.length, 0) || null;
  const monthVolume = monthRows.filter((row) => row.volume != null);
  const latestVolume = monthVolume.at(-1)?.volume ?? null;
  const rsi14 = computeRsi(history, 14);
  const macd = computeMacd(history);
  const atr14 = computeAtr(history, 14);
  const volatility60 = annualizedVolatility(history.slice(-61));
  return {
    monthEndPrice: currentPrice,
    dma50: levels.dma50,
    dma200: levels.dma200,
    aboveDma50: currentPrice != null && levels.dma50 != null ? currentPrice >= levels.dma50 : null,
    aboveDma200: currentPrice != null && levels.dma200 != null ? currentPrice >= levels.dma200 : null,
    pctOff52WeekHigh: currentPrice && levels.week52High ? round2(((currentPrice - levels.week52High) / levels.week52High) * 100) : null,
    recentBreak: levels.recentBreak,
    latestVolumeVs60DayAvgPct: latestVolume != null && avgVolume ? round2(((latestVolume - avgVolume) / avgVolume) * 100) : null,
    rsi14,
    macd,
    atr14,
    atrPct: atr14 != null && currentPrice ? round2((atr14 / currentPrice) * 100) : null,
    annualizedVolatility60Pct: volatility60,
    monthlyMaxDrawdownPct: maxDrawdown(monthRows),
  };
}

function computeRsi(rows, period) {
  if (rows.length <= period) return null;
  const closes = rows.slice(-(period + 1)).map((row) => row.close);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return round2(100 - 100 / (1 + avgGain / avgLoss));
}

function computeMacd(rows) {
  const closes = rows.map((row) => row.close);
  if (closes.length < 35) return { value: null, signal: null, histogram: null, state: null };
  const macdSeries = [];
  let ema12 = closes[0];
  let ema26 = closes[0];
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  for (let i = 1; i < closes.length; i++) {
    ema12 = closes[i] * k12 + ema12 * (1 - k12);
    ema26 = closes[i] * k26 + ema26 * (1 - k26);
    macdSeries.push(ema12 - ema26);
  }
  let signal = macdSeries[0];
  const k9 = 2 / 10;
  for (let i = 1; i < macdSeries.length; i++) signal = macdSeries[i] * k9 + signal * (1 - k9);
  const value = macdSeries.at(-1);
  const histogram = value - signal;
  return { value: round2(value), signal: round2(signal), histogram: round2(histogram), state: histogram >= 0 ? 'bullish' : 'bearish' };
}

function computeAtr(rows, period) {
  const valid = rows.filter((row) => row.high != null && row.low != null);
  if (valid.length <= period) return null;
  const sample = valid.slice(-(period + 1));
  const ranges = [];
  for (let i = 1; i < sample.length; i++) {
    ranges.push(Math.max(sample[i].high - sample[i].low, Math.abs(sample[i].high - sample[i - 1].close), Math.abs(sample[i].low - sample[i - 1].close)));
  }
  return round2(ranges.reduce((sum, value) => sum + value, 0) / ranges.length);
}

function annualizedVolatility(rows) {
  if (rows.length < 10) return null;
  const returns = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].close > 0) returns.push(Math.log(rows[i].close / rows[i - 1].close));
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  return round2(Math.sqrt(variance) * Math.sqrt(252) * 100);
}

function maxDrawdown(rows) {
  if (!rows.length) return null;
  let peak = rows[0].close;
  let worst = 0;
  for (const row of rows) {
    peak = Math.max(peak, row.close);
    if (peak > 0) worst = Math.min(worst, ((row.close - peak) / peak) * 100);
  }
  return round2(worst);
}

async function fundamentalChange(env, symbol, range) {
  const { results } = await env.DB.prepare(
    'SELECT snapshot_date, data_json FROM fundamental_snapshots WHERE symbol = ? AND snapshot_date < ? ORDER BY snapshot_date DESC'
  ).bind(symbol, range.next).all();
  const rows = results || [];
  let currentRow = rows[0] || null;
  const priorRow = rows.find((row) => row.snapshot_date < range.start) || null;
  let current = currentRow ? safeJson(currentRow.data_json) : null;
  let outsidePeriod = false;
  if (!current) {
    const latest = await env.DB.prepare('SELECT * FROM fundamentals WHERE symbol = ?').bind(symbol).first();
    if (latest) {
      currentRow = { snapshot_date: latest.fetched_at?.slice(0, 10) || null };
      outsidePeriod = true;
      current = {
        sector: latest.sector,
        industry: latest.industry,
        peRatio: latest.pe_ratio,
        forwardPe: latest.forward_pe,
        targetMeanPrice: latest.target_mean_price,
        targetHighPrice: latest.target_high_price,
        targetLowPrice: latest.target_low_price,
        recommendation: latest.recommendation,
        debtToEquity: latest.debt_to_equity,
        revenueGrowth: latest.revenue_growth,
        earningsGrowth: latest.earnings_growth,
        revenueGrowthQoq: latest.revenue_growth_qoq,
        profitGrowthQoq: latest.profit_growth_qoq,
        profitAtRecentHigh: latest.profit_at_recent_high == null ? null : Boolean(latest.profit_at_recent_high),
        latestQuarterProfitCr: latest.latest_quarter_profit_cr,
      };
    }
  }
  const prior = priorRow ? safeJson(priorRow.data_json) : null;
  const structured = await exchangeFundamentals(env, symbol);
  return {
    preferredSource: structured.available ? 'Yahoo metrics + NSE/BSE filing evidence' : 'Yahoo metrics',
    currentAsOf: currentRow?.snapshot_date || null,
    previousAsOf: priorRow?.snapshot_date || null,
    outsidePeriod,
    coverage: current ? (prior ? 'comparable' : outsidePeriod ? 'latest-only-outside-period' : 'current-only') : 'missing',
    current,
    changes: current && prior ? {
      peRatio: difference(current.peRatio, prior.peRatio),
      debtToEquity: difference(current.debtToEquity, prior.debtToEquity),
      revenueGrowth: difference(current.revenueGrowth, prior.revenueGrowth),
      earningsGrowth: difference(current.earningsGrowth, prior.earningsGrowth),
    } : null,
    quarterlyHistory: structured.income,
    shareholding: structured.shareholding,
    ratios: structured.ratios,
  };
}

async function exchangeFundamentals(env, symbol) {
  const [holdingRows, filingCount] = await Promise.all([
    env.DB.prepare("SELECT * FROM shareholding_history WHERE symbol = ? AND source IN ('nse', 'bse')").bind(symbol).all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM exchange_filings WHERE symbol = ? AND filing_type IN ('financial-results', 'shareholding')").bind(symbol).first(),
  ]);
  const periodTime = (label) => {
    const parsed = new Date(`01 ${label}`);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  };
  const holdings = holdingRows.results || [];
  const categories = {};
  for (const row of holdings) {
    if (!categories[row.category]) categories[row.category] = [];
    categories[row.category].push({ period: row.period_label, value: row.holding_pct });
  }
  for (const history of Object.values(categories)) history.sort((a, b) => periodTime(b.period) - periodTime(a.period));
  const promoterHistory = categories.promoters || [];
  const promoterChangePct = promoterHistory.length >= 2 ? round2(promoterHistory[0].value - promoterHistory[1].value) : null;
  return {
    available: Number(filingCount?.count || 0) > 0 || holdings.length > 0,
    income: [],
    shareholding: { categories, promoterChangePct, source: holdings[0]?.source || null },
    ratios: null,
  };
}

async function evidenceFor(env, symbol, range) {
  const [news, filings] = await Promise.all([
    env.DB.prepare(
      `SELECT 'news' AS kind, title, source, url, published_at AS occurred_at, category, governance_severity
       FROM news_items WHERE symbol = ? AND published_at >= ? AND published_at < ? ORDER BY published_at DESC`
    ).bind(symbol, range.start, range.next).all(),
    env.DB.prepare(
      `SELECT 'filing' AS kind, subject AS title, exchange || ' filing' AS source, document_url AS url,
              filed_at AS occurred_at,
              CASE WHEN filing_type IN ('promoter-pledge', 'shareholding', 'related-party', 'auditor',
                   'insider-trading', 'regulatory-legal', 'board-management', 'credit-rating', 'capital-raise')
                   THEN 'governance' ELSE 'business' END AS category,
              governance_severity
       FROM exchange_filings WHERE symbol = ? AND filed_at >= ? AND filed_at < ? ORDER BY filed_at DESC`
    ).bind(symbol, range.start, range.next).all(),
  ]);
  const seen = new Set();
  return [...(filings.results || []), ...(news.results || [])].filter((item) => {
    const key = `${String(item.title || '').toLowerCase()}:${item.occurred_at?.slice(0, 10) || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function filingAiFor(env, symbol, range) {
  return analyzeFilingsForReport(env, { symbol, from: range.start, to: range.next });
}

function governanceSummary(events, aiReview) {
  const governance = events.filter((event) => event.category === 'governance' || event.governance_severity);
  const aiGovernance = aiReview.reviews.filter((review) => review.categories.some((category) => ['promoter-shareholding', 'promoter-pledge', 'related-party', 'auditor', 'board-management', 'insider-trading', 'regulatory-legal'].includes(category)));
  const high = governance.filter((event) => event.governance_severity === 'high').length + aiGovernance.filter((review) => review.severity === 'high').length;
  const medium = governance.filter((event) => event.governance_severity === 'medium').length + aiGovernance.filter((review) => review.severity === 'medium').length;
  const incomplete = aiReview.coverage.unreviewed || aiReview.coverage.needsOcr || aiReview.coverage.failed;
  return {
    status: events.length === 0 && !aiReview.reviews.length ? 'insufficient-evidence' : high ? 'review-high' : medium ? 'review' : aiGovernance.length || governance.length ? 'development' : incomplete ? 'incomplete-review' : 'no-flags-in-reviewed-evidence',
    evidenceReviewed: events.length + aiReview.reviews.length,
    highCount: high,
    mediumCount: medium,
    items: governance.slice(0, 20),
    aiReviews: aiReview.reviews,
    aiCoverage: aiReview.coverage,
    coverageNote: incomplete
      ? `AI filing coverage is incomplete: ${aiReview.coverage.reviewed}/${aiReview.coverage.total} reviewed, ${aiReview.coverage.needsOcr} need OCR and ${aiReview.coverage.failed} failed.`
      : `AI reviewed ${aiReview.coverage.reviewed}/${aiReview.coverage.total} filing(s), alongside stored news and typed NSE/BSE checks.`,
  };
}

function buildObservations(holdings) {
  const points = [];
  for (const holding of holdings) {
    if (holding.governance.highCount) points.push({ symbol: holding.symbol, severity: 'high', reason: `${holding.governance.highCount} high-priority governance keyword match(es); verify the linked filing.` });
    else if (holding.governance.mediumCount) points.push({ symbol: holding.symbol, severity: 'medium', reason: `${holding.governance.mediumCount} governance development(s) to review.` });
    if (holding.governance.status === 'insufficient-evidence') points.push({ symbol: holding.symbol, severity: 'coverage', reason: 'No stored news or announcement evidence was available for governance review.' });
    if (holding.technical.aboveDma200 === false) points.push({ symbol: holding.symbol, severity: 'medium', reason: 'Month-end price was below its 200-day moving average.' });
    else if (holding.technical.aboveDma50 === false) points.push({ symbol: holding.symbol, severity: 'monitor', reason: 'Month-end price was below its 50-day moving average but remained above its 200-day average.' });
    if (holding.technical.pctOff52WeekHigh != null && holding.technical.pctOff52WeekHigh <= -10) points.push({ symbol: holding.symbol, severity: 'monitor', reason: `Month-end price was ${Math.abs(holding.technical.pctOff52WeekHigh).toFixed(2)}% below its 52-week high.` });
    if (holding.technical.recentBreak?.broke === 'support' && holding.technical.recentBreak.stillBroken) points.push({ symbol: holding.symbol, severity: 'high', reason: `Price broke support near ₹${holding.technical.recentBreak.level} and remained below it.` });
    if (holding.technical.recentBreak?.broke === 'resistance' && holding.technical.recentBreak.stillBroken) points.push({ symbol: holding.symbol, severity: 'positive', reason: `Price broke resistance near ₹${holding.technical.recentBreak.level} and remained above it.` });
    if (holding.technical.latestVolumeVs60DayAvgPct != null && Math.abs(holding.technical.latestVolumeVs60DayAvgPct) >= 50) points.push({ symbol: holding.symbol, severity: 'monitor', reason: `Latest volume was ${Math.abs(holding.technical.latestVolumeVs60DayAvgPct).toFixed(2)}% ${holding.technical.latestVolumeVs60DayAvgPct >= 0 ? 'above' : 'below'} its 60-day average.` });
    if (holding.technical.rsi14 != null && holding.technical.rsi14 >= 70) points.push({ symbol: holding.symbol, severity: 'monitor', reason: `RSI(14) was ${holding.technical.rsi14.toFixed(2)}, indicating stretched upward momentum.` });
    if (holding.technical.rsi14 != null && holding.technical.rsi14 <= 30) points.push({ symbol: holding.symbol, severity: 'monitor', reason: `RSI(14) was ${holding.technical.rsi14.toFixed(2)}, indicating stretched downward momentum.` });
    if (holding.technical.macd?.state === 'bearish') points.push({ symbol: holding.symbol, severity: 'monitor', reason: 'MACD was below its signal line at month end.' });
    if (holding.technical.monthlyMaxDrawdownPct != null && holding.technical.monthlyMaxDrawdownPct <= -10) points.push({ symbol: holding.symbol, severity: 'medium', reason: `Maximum drawdown during the month was ${holding.technical.monthlyMaxDrawdownPct.toFixed(2)}%.` });
    if (holding.performance.alphaVsNifty50Pct != null && holding.performance.alphaVsNifty50Pct < -5) points.push({ symbol: holding.symbol, severity: 'medium', reason: `Underperformed Nifty 50 by ${Math.abs(holding.performance.alphaVsNifty50Pct).toFixed(2)} percentage points.` });
    else if (holding.performance.alphaVsNifty50Pct != null && holding.performance.alphaVsNifty50Pct >= 5) points.push({ symbol: holding.symbol, severity: 'positive', reason: `Outperformed Nifty 50 by ${holding.performance.alphaVsNifty50Pct.toFixed(2)} percentage points.` });
    const current = holding.fundamentals.current;
    if (current?.revenueGrowth != null && current.revenueGrowth < 0) points.push({ symbol: holding.symbol, severity: 'medium', reason: `Latest available revenue growth was ${(current.revenueGrowth * 100).toFixed(1)}%.` });
    if (current?.earningsGrowth != null && current.earningsGrowth < 0) points.push({ symbol: holding.symbol, severity: 'medium', reason: `Latest available earnings growth was ${(current.earningsGrowth * 100).toFixed(1)}%.` });
    const promoterChange = holding.fundamentals.shareholding?.promoterChangePct;
    if (promoterChange != null && promoterChange <= -1) points.push({ symbol: holding.symbol, severity: 'medium', reason: `Promoter holding declined by ${Math.abs(promoterChange).toFixed(2)} percentage points in the latest reported quarter.` });
    else if (promoterChange != null && promoterChange >= 1) points.push({ symbol: holding.symbol, severity: 'positive', reason: `Promoter holding increased by ${promoterChange.toFixed(2)} percentage points in the latest reported quarter.` });
  }
  return points;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function difference(current, previous) {
  return current == null || previous == null ? null : round2(current - previous);
}

function subtract(a, b) {
  return a == null || b == null ? null : round2(a - b);
}

function round2(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

function benchmarkLabel(key) {
  const labelKeyByReportKey = {
    nifty50: 'NIFTY50',
    niftyMidcap: 'NIFTY_MIDCAP',
    niftySmallcap: 'NIFTY_SMALLCAP',
  };
  return BENCHMARK_LABELS[labelKeyByReportKey[key]] || key;
}
