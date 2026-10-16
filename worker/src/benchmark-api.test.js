import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE trades (symbol TEXT, exchange TEXT, trade_type TEXT, quantity REAL, price REAL, trade_date TEXT, order_exec_time TEXT);
    CREATE TABLE price_history (symbol TEXT, kind TEXT, price_date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL);
    INSERT INTO trades VALUES ('ABC', 'NSE', 'buy', 10, 100, '2026-10-01', '09:15:00');
  `);
  for (const [symbol, kind, start, end] of [
    ['ABC.NS', 'stock', 100, 110], ['^CRSLDX', 'benchmark', 1000, 1050],
    ['^NSEI', 'benchmark', 20000, 22000], ['^NSEMDCP50', 'benchmark', 16000, 20000], ['NIFTYSMLCAP250.NS', 'benchmark', 15000, 18000],
  ]) {
    for (const [date, close] of [['2026-10-01', start], ['2026-10-09', end]]) {
      sqlite.prepare('INSERT INTO price_history VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(symbol, kind, date, close, close, close, close);
    }
  }
  const env = { DB: { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values); },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    };
  } } };
  return {
    sqlite,
    async get(path) {
      const response = await worker.fetch(new Request(`https://example.test${path}`), env);
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

test('existing history API returns benchmark dates and values, and still resolves stocks', async () => {
  const f = fixture();
  try {
    for (const [symbol, close] of [['NIFTY50', 22000], ['NIFTY_SMALLCAP', 18000], ['ABC', 110]]) {
      const data = await f.get(`/api/portfolio/price-history?symbol=${symbol}&days=1825`);
      assert.equal(data.priceAsOf, '2026-10-09');
      assert.deepEqual(data.prices.map((row) => row.date), ['2026-10-01', '2026-10-09']);
      assert.equal(data.prices[1].close, close);
    }
  } finally { f.sqlite.close(); }
});

test('performance API compares every period index using their stored exact-date closes', async () => {
  const f = fixture();
  try {
    const data = await f.get('/api/portfolio/performance?from=2026-10-01&to=2026-10-09');
    assert.equal(data.portfolioReturnPct, 10);
    assert.deepEqual(data.benchmarks.map(({ symbol, returnPct }) => ({ symbol, returnPct })), [
      { symbol: 'NIFTY50', returnPct: 10 }, { symbol: 'NIFTY_MIDCAP', returnPct: 25 }, { symbol: 'NIFTY_SMALLCAP', returnPct: 20 },
    ]);
    assert.deepEqual(data.warnings, []);
  } finally { f.sqlite.close(); }
});

test('performance API does not substitute a stale index close for a missing date', async () => {
  const f = fixture();
  try {
    f.sqlite.exec("DELETE FROM price_history WHERE symbol = '^NSEI' AND price_date = '2026-10-09'");
    const data = await f.get('/api/portfolio/performance?from=2026-10-01&to=2026-10-09');
    assert.equal(data.benchmarks[0].returnPct, null);
    assert.ok(data.warnings.some((warning) => warning.includes('Missing Nifty 50')));
  } finally { f.sqlite.close(); }
});
