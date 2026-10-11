import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOfficialIndexHistory, parseIndexHistory } from './index-history.js';

const candle = (date, close = '17,574.85', name = 'Nifty Smallcap 250') => ({
  INDEX_NAME: name, HistoricalDate: date, OPEN: '17519.5', HIGH: '17647.85', LOW: '17346.8', CLOSE: close,
});

test('normalizes official dates and numeric closes while rejecting unrelated or invalid rows', () => {
  const rows = parseIndexHistory([
    candle('09 Oct 2026'), candle('08 Oct 2026', '17488.30'),
    candle('09 Oct 2026', '22520.45', 'Nifty 50'),
    candle('31 Feb 2026'), candle('10 Oct 2026', ''), candle('11 Oct 2026', 'NaN'),
  ], 'NIFTY SMALLCAP 250');
  assert.deepEqual(rows.map(({ date, close }) => ({ date, close })), [
    { date: '2026-10-08', close: 17488.3 }, { date: '2026-10-09', close: 17574.85 },
  ]);
  assert.equal(rows[1].volume, null);
  assert.deepEqual(parseIndexHistory({ d: JSON.stringify([candle('09-Oct-2026')]) }, 'NIFTY SMALLCAP 250'), [rows[1]]);
});

test('requests bounded consecutive history windows and preserves index identity', async () => {
  const requests = [];
  const rows = await fetchOfficialIndexHistory('NIFTY 50', '2025-01-01', '2026-01-02', async (url, options) => {
    const info = JSON.parse(JSON.parse(options.body).cinfo);
    requests.push({ url, info });
    return { ok: true, json: async () => [candle(requests.length === 1 ? '01 Jan 2025' : '02 Jan 2026', '20000', 'Nifty 50')] };
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://www.niftyindices.com/BackPage/getHistoricaldatatabletoString');
  assert.deepEqual(requests.map(({ info }) => info), [
    { name: 'NIFTY 50', indexName: 'NIFTY 50', startDate: '01-Jan-2025', endDate: '31-Dec-2025' },
    { name: 'NIFTY 50', indexName: 'NIFTY 50', startDate: '01-Jan-2026', endDate: '02-Jan-2026' },
  ]);
  assert.deepEqual(rows.map((row) => row.date), ['2025-01-01', '2026-01-02']);
});

test('failed history chunks cannot be accepted as a complete backfill', async () => {
  let calls = 0;
  const rows = await fetchOfficialIndexHistory('NIFTY 50', '2025-01-01', '2026-01-02', async () => {
    calls++;
    return calls === 1
      ? { ok: true, json: async () => [candle('01 Jan 2025', '20000', 'Nifty 50')] }
      : { ok: false, status: 503 };
  });
  assert.deepEqual(rows, []);
});
