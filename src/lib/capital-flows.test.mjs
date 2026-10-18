import test from 'node:test';
import assert from 'node:assert/strict';
import { clientKey, nameType, clientType, matchTrades, outcomeStats } from './capital-flows.js';

test('clientKey folds punctuation, spacing and legal suffixes only', () => {
  assert.equal(clientKey('SETU SECURITIES PVT. LTD.'), 'SETU SECURITIES PRIVATE LIMITED');
  assert.equal(clientKey('YUGA STOCKS AND COMMODITIES PRIVATE LIMITED  .'), 'YUGA STOCKS AND COMMODITIES PRIVATE LIMITED');
  assert.equal(clientKey('VEENA  RAJESH  SHAH'), 'VEENA RAJESH SHAH');
  assert.notEqual(clientKey('ABC CAPITAL'), clientKey('ABC CAPITAL MARKETS'));
});

test('nameType recognises funds, insurers, companies and individuals', () => {
  assert.equal(nameType('KOTAK MAHINDRA MATUAL FUND'), 'mutual-fund');
  assert.equal(nameType('BAJAJ LIFE INSURANCE LIMITED'), 'insurance');
  assert.equal(nameType('ISHARES MSCI INDIA ETF'), 'fund');
  assert.equal(nameType('GOVERNMENT OF SINGAPORE'), 'fund');
  assert.equal(nameType('KAILASH DHANUKA HUF'), 'individual');
  assert.equal(nameType('MANSI SHARE AND STOCK BROKING PRIVATE LIMITED'), 'corporate');
  assert.equal(nameType('ARUN VENUGOPAL IYER'), 'individual');
  assert.equal(clientType('Graviton Research Capital LLP', new Set(['GRAVITON RESEARCH CAPITAL LLP'])), 'prop');
});

test('matchTrades pairs FIFO across spelling variants and collapses bulk/block duplicates', () => {
  const t = (date, side, quantity, price, clientName = 'A PVT LTD', type = 'bulk') => ({ date, symbol: 'X', clientName, side, quantity, price, exchange: 'NSE', type });
  const outcomes = matchTrades([
    t('2026-01-01', 'BUY', 100, 10), t('2026-01-01', 'BUY', 100, 10, 'A PVT LTD', 'block'),
    t('2026-02-01', 'SELL', 60, 15, 'A PRIVATE LIMITED'), t('2026-02-01', 'SELL', 60, 8),
  ]);
  assert.deepEqual(outcomes.map((o) => [o.quantity, Math.round(o.returnPct), o.holdingDays]), [[60, 50, 31], [40, -20, 31]]);
  assert.deepEqual(outcomeStats(outcomes), { matched: 2, hitRatePct: 50, medianReturnPct: 15, medianHoldingDays: 31 });
});
