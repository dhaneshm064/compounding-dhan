import { xirr } from './xirr.js';

/**
 * Groups raw trade rows by symbol into net quantity + a signed cashflow list.
 * Convention: buys are negative (money out), sells are positive (money in).
 * Pure function — no D1 access, no amounts ever leave this module unless the
 * caller explicitly extracts a percentage from the result.
 */
export function deriveHoldingsFromTrades(trades) {
  const bySymbol = new Map();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, { netQty: 0, exchange: t.exchange, cashflows: [], buyCost: 0, buyQty: 0 });
    const h = bySymbol.get(t.symbol);
    const signedQty = t.trade_type === 'buy' ? t.quantity : -t.quantity;
    const amount = t.trade_type === 'buy' ? -t.price * t.quantity : t.price * t.quantity;
    h.netQty += signedQty;
    // Some stocks trade on both exchanges — prefer NSE (more liquid, the canonical
    // ticker for price lookups) once seen, rather than whichever row came last.
    if (h.exchange !== 'NSE') h.exchange = t.exchange;
    h.cashflows.push({ date: t.trade_date, amount });

    // Average-cost method: a sell doesn't change the average cost of the shares
    // still held, it only reduces quantity, so avg buy price is buyCost / buyQty
    // across all buys regardless of any later sells.
    if (t.trade_type === 'buy') {
      h.buyCost += t.price * t.quantity;
      h.buyQty += t.quantity;
    }
  }
  return bySymbol;
}

/** Average price paid per share (average-cost method) — a price, not an amount, safe to expose. */
export function avgBuyPrice(h) {
  return h.buyQty > 0 ? round2(h.buyCost / h.buyQty) : null;
}

/** Maps a bare NSE/BSE symbol to the yfinance ticker used in price_history. */
export function toTicker(symbol, exchange) {
  return exchange === 'BSE' ? `${symbol}.BO` : `${symbol}.NS`;
}

/** Builds a "nearest close on/before this date" lookup from an ascending-or-unsorted list of {price_date, close}. */
export function buildPriceLookup(rows) {
  const sorted = [...rows].sort((a, b) => a.price_date.localeCompare(b.price_date));
  return (date) => {
    let result = null;
    for (const r of sorted) {
      if (r.price_date > date) break;
      result = r.close;
    }
    return result;
  };
}

/** Net rupees currently deployed (buys minus sells) — used only to compute a ratio, never returned as-is. */
function netInvested(cashflows) {
  return -cashflows.reduce((sum, cf) => sum + cf.amount, 0);
}

/** Per-symbol XIRR + simple return. Adds a synthetic final flow of netQty * latestPrice if the position is still open. */
export function computeSymbolReturns(cashflows, netQty, latestPrice, asOfDate) {
  const flows = [...cashflows];
  if (netQty > 0 && latestPrice != null) {
    flows.push({ date: asOfDate, amount: netQty * latestPrice });
  }
  const invested = netInvested(cashflows);
  const finalValue = netQty > 0 && latestPrice != null ? netQty * latestPrice : null;
  return {
    xirrPct: flows.length >= 2 ? toPct(xirr(flows)) : null,
    simpleReturnPct: invested > 0 && finalValue != null ? toPct((finalValue - invested) / invested) : null,
  };
}

/** Portfolio-level XIRR + simple return across every symbol's cashflows plus total current market value. */
export function computePortfolioReturns(allCashflows, totalMarketValue, asOfDate) {
  const flows = [...allCashflows, { date: asOfDate, amount: totalMarketValue }];
  const invested = netInvested(allCashflows);
  return {
    xirrPct: toPct(xirr(flows)),
    simpleReturnPct: invested > 0 ? toPct((totalMarketValue - invested) / invested) : null,
  };
}

/**
 * "What if every rupee had bought the benchmark index instead" — same cashflow
 * dates/amounts as the real portfolio, but the final value is computed from
 * benchmark units bought/sold on those same dates at the benchmark's price.
 * priceLookup(date) must return the nearest known benchmark close on/before that date.
 */
export function computeBenchmarkReturns(allCashflows, priceLookup, asOfDate) {
  let units = 0;
  for (const cf of allCashflows) {
    const price = priceLookup(cf.date);
    if (!price) continue;
    units += -cf.amount / price;
  }
  const finalPrice = priceLookup(asOfDate);
  if (!finalPrice) return { xirrPct: null, simpleReturnPct: null };

  const finalValue = units * finalPrice;
  const flows = [...allCashflows, { date: asOfDate, amount: finalValue }];
  const invested = netInvested(allCashflows);
  return {
    xirrPct: toPct(xirr(flows)),
    simpleReturnPct: invested > 0 ? toPct((finalValue - invested) / invested) : null,
  };
}

function toPct(rate) {
  return rate == null ? null : round2(rate * 100);
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
