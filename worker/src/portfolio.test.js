import test from 'node:test';
import assert from 'node:assert/strict';

import { avgBuyPrice, computeTimeWeightedPerformance, deriveHoldingsFromTrades } from './portfolio.js';

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

test('rebases holdings across KMEW splits while preserving the original cashflows', () => {
  const fills = [
    { symbol: 'KMEW', exchange: 'BSE', trade_type: 'buy', quantity: 2, price: 5000, trade_date: '2025-12-19' },
    { symbol: 'KMEW', exchange: 'NSE', trade_type: 'buy', quantity: 10, price: 2500, trade_date: '2026-11-05' },
    { symbol: 'KMEW', exchange: 'NSE', trade_type: 'sell', quantity: 10, price: 500, trade_date: '2026-11-06' },
  ];
  const holding = deriveHoldingsFromTrades(fills).get('KMEW');
  assert.equal(holding.netQty, 60);
  assert.equal(avgBuyPrice(holding), 500);
  assert.deepEqual(holding.cashflows.map((flow) => flow.amount), [-10000, -25000, 5000]);
});

test('uses consistent share units for a performance range across a split', () => {
  const dates = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
  const result = computeTimeWeightedPerformance({
    trades: [
      { symbol: 'KMEW', trade_type: 'buy', quantity: 2, price: 2500, trade_date: dates[0] },
      { symbol: 'KMEW', trade_type: 'buy', quantity: 1, price: 2500, trade_date: dates[1] },
      { symbol: 'KMEW', trade_type: 'sell', quantity: 5, price: 500, trade_date: dates[2] },
    ],
    pricesBySymbol: { KMEW: dates.map((date, i) => ({ price_date: date, close: i === 3 ? 550 : 500 })) },
    benchmarkPrices: dates.map((date) => ({ price_date: date, close: 200 })),
    from: dates[0],
    to: dates[3],
  });
  assert.deepEqual(result.series.map((row) => row.portfolioIndex), [100, 100, 100, 110]);
});
