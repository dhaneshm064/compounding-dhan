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
