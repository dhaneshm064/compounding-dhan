import test from 'node:test';
import assert from 'node:assert/strict';

import { computeTimeWeightedPerformance } from './portfolio.js';

const benchmarkPrices = [
  { price_date: '2026-01-01', close: 200 },
  { price_date: '2026-01-02', close: 210 },
  { price_date: '2026-01-05', close: 220 },
];

test('calculates a close-to-close portfolio return and benchmark alpha', () => {
  const result = computeTimeWeightedPerformance({
    trades: [{ symbol: 'ABC', trade_type: 'buy', quantity: 10, price: 100, trade_date: '2026-01-01' }],
    pricesBySymbol: { ABC: [
      { price_date: '2026-01-01', close: 100 },
      { price_date: '2026-01-02', close: 110 },
    ] },
    benchmarkPrices: benchmarkPrices.slice(0, 2),
    from: '2026-01-01',
    to: '2026-01-02',
  });

  assert.equal(result.portfolioReturnPct, 10);
  assert.equal(result.benchmarkReturnPct, 5);
  assert.equal(result.alphaPct, 5);
});

test('does not count a new purchase as portfolio or benchmark performance', () => {
  const result = computeTimeWeightedPerformance({
    trades: [
      { symbol: 'ABC', trade_type: 'buy', quantity: 10, price: 100, trade_date: '2026-01-01' },
      { symbol: 'ABC', trade_type: 'buy', quantity: 10, price: 110, trade_date: '2026-01-02' },
    ],
    pricesBySymbol: { ABC: [
      { price_date: '2026-01-01', close: 100 },
      { price_date: '2026-01-02', close: 110 },
      { price_date: '2026-01-05', close: 110 },
    ] },
    benchmarkPrices,
    from: '2026-01-02',
    to: '2026-01-05',
  });

  assert.equal(result.portfolioReturnPct, 0);
  assert.equal(result.series[0].portfolioIndex, 100);
  assert.equal(result.series.at(-1).portfolioIndex, 100);
});

test('reports a held symbol when no price history is available', () => {
  const result = computeTimeWeightedPerformance({
    trades: [{ symbol: 'MISSING', trade_type: 'buy', quantity: 1, price: 100, trade_date: '2026-01-01' }],
    pricesBySymbol: { MISSING: [] },
    benchmarkPrices: benchmarkPrices.slice(0, 2),
    from: '2026-01-01',
    to: '2026-01-02',
  });

  assert.deepEqual(result.missingSymbols, ['MISSING']);
});
