// Completed splits. Yahoo's daily prices use the latest share units.
// NSE circulars CML71692 and CML77126.
const SPLITS_BY_SYMBOL = new Map([
  ['KMEW', [
    { exDate: '2025-12-22', multiplier: 2 },
    { exDate: '2026-11-06', multiplier: 5 },
  ]],
]);

export function shareSplitsFor(symbol) {
  return SPLITS_BY_SYMBOL.get(symbol) || [];
}

export function splitMultiplierSince(symbol, date) {
  return shareSplitsFor(symbol).reduce(
    (factor, split) => date < split.exDate ? factor * split.multiplier : factor,
    1
  );
}

export function splitAdjustedQuantity(trade) {
  return Number(trade.quantity) * splitMultiplierSince(trade.symbol, trade.trade_date);
}
