import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndStorePrices } from './prices.js';

test('backfills incomplete benchmark history and stores official closes under existing symbols', async (t) => {
  const requests = [];
  const writes = [];
  const db = {
    prepare(sql) {
      let values;
      return {
        bind(...args) { values = args; return this; },
        async first() { return { date: '2026-01-01' }; },
        async all() { return { results: [
          { symbol: '^NSEI', earliest: '2026-10-01', latest: '2026-10-09' },
          { symbol: 'NIFTYSMLCAP250.NS', earliest: '2023-01-01', latest: '2026-10-09' },
        ] }; },
        get values() { return values; },
      };
    },
    async batch(statements) {
      writes.push(...statements.map((statement) => statement.values));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!options?.body) return { ok: true, json: async () => ({ chart: { result: [] } }) };
    const info = JSON.parse(JSON.parse(options.body).cinfo);
    requests.push(info);
    const date = new Date(info.endDate).toISOString().slice(0, 10);
    const formatted = `${date.slice(8)} ${info.endDate.slice(3, 6)} ${date.slice(0, 4)}`;
    return { ok: true, json: async () => [{
      INDEX_NAME: info.indexName, HistoricalDate: formatted,
      CLOSE: info.name === 'NIFTY 50' ? '22520.45' : '17574.85',
    }] };
  });
  await fetchAndStorePrices({ DB: db });
  const nifty = requests.filter((info) => info.name === 'NIFTY 50');
  assert.ok(nifty.length >= 3, 'missing older history triggers full backfill');
  assert.ok(Date.parse(nifty[0].startDate) < Date.parse('2026-01-01'));
  const smallcap = requests.filter((info) => info.name === 'NIFTY SMALLCAP 250');
  assert.equal(smallcap.length, 1);
  assert.equal(smallcap[0].startDate, '29-Sep-2026', 'complete history keeps the ten-day overlap');
  assert.ok(writes.some((values) => values[0] === '^NSEI' && values[1] === 'benchmark' && values[6] === 22520.45));
  assert.ok(writes.some((values) => values[0] === 'NIFTYSMLCAP250.NS' && values[1] === 'benchmark' && values[6] === 17574.85));
});

test('refreshes the full cached price range once the feed confirms a split', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T11:00:00Z') });
  let feedHasSplit = false;
  let oldestFetch = '2026-10-24T10:30:00.000Z';
  const requests = [];
  const writes = [];
  const db = {
    prepare(sql) {
      let values;
      return {
        bind(...args) { values = args; return this; },
        async first() { return { date: '2026-10-23' }; },
        async all() {
          if (sql.includes('GROUP BY symbol')) return { results: [
            { symbol: 'KMEW.NS', earliest: '2026-10-23', latest: '2026-11-06', oldestFetch },
          ] };
          assert.deepEqual(values, ['KMEW.NS', '2026-11-06', '2026-11-06']);
          return { results: [{
            date: '2026-10-23', open: 2900, high: 3150, low: 2850,
            close: 3000, volume: 100, fetched_at: oldestFetch,
          }] };
        },
        get values() { return values; },
      };
    },
    async batch(statements) {
      writes.push(...statements.map((statement) => statement.values));
      oldestFetch = statements[0].values[8];
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (!url.pathname.endsWith('/KMEW.NS')) {
      return { ok: true, json: async () => options?.body ? [] : { chart: { result: [] } } };
    }
    requests.push(url.searchParams);
    const timestamps = ['2026-11-05', '2026-11-06'].map((date) => Date.parse(date) / 1000);
    const splits = feedHasSplit ? { [timestamps[1]]: { date: timestamps[1], numerator: 5, denominator: 1 } } : {};
    return { ok: true, json: async () => ({ chart: { result: [{
      timestamp: timestamps,
      events: { splits },
      indicators: { quote: [{ close: [620, 650] }] },
    }] } }) };
  });

  const before = await fetchAndStorePrices({ DB: db }, { years: 0.02 });
  assert.ok(before.failed.includes('KMEW.NS'));
  assert.equal(writes.length, 0);

  feedHasSplit = true;
  const after = await fetchAndStorePrices({ DB: db }, { years: 0.02 });
  assert.ok(!after.failed.includes('KMEW.NS'));
  assert.equal(requests[1].get('events'), 'splits');
  assert.equal(Number(requests[1].get('period1')) * 1000, Date.parse('2026-10-23'));
  const fallback = writes.find((values) => values[2] === '2026-10-23');
  assert.deepEqual(fallback.slice(3, 8), [580, 630, 570, 600, 500]);
  assert.equal(fallback[9], '2026-11-06');

  await fetchAndStorePrices({ DB: db }, { years: 0.02 });
  assert.equal(requests[2].get('events'), null);
  assert.equal(Number(requests[2].get('period1')) * 1000, Date.parse('2026-10-27'));
});
