import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './index.js';
import { fetchAndStoreCapitalFlows, parseBseDeals } from './capital-flows.js';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const capitalFlowSchema = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS capital_flow_deals'), SCHEMA.indexOf('-- One-time cleanup'));

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(capitalFlowSchema);
  sqlite.exec(`CREATE TABLE shareholding_history (symbol TEXT, period_label TEXT, category TEXT, holding_pct REAL, source TEXT, available_from TEXT);
    CREATE TABLE exchange_filings (symbol TEXT, exchange TEXT, filing_type TEXT, subject TEXT, details TEXT, document_url TEXT, filed_at TEXT, governance_severity TEXT);`);
  const statement = (sql) => {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values); },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    };
  };
  const env = { DB: { prepare: statement, async batch(statements) { return Promise.all(statements.map((s) => s.run())); } } };
  return { sqlite, env };
}

const insertDeal = (sqlite, [type, exchange, date, symbol, client, side, quantity, price]) => sqlite.prepare(
  `INSERT INTO capital_flow_deals (deal_type, exchange, deal_date, symbol, client_name, side, quantity, price, value, source_url, fetched_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'test')`
).run(type, exchange, date, symbol, client, side, quantity, price, quantity * price);

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  return { calls, restore() { globalThis.fetch = original; } };
}

const bsePayload = (rows) => new Response(JSON.stringify({ Table: rows }), { headers: { 'content-type': 'application/json; charset=utf-8' } });

test('parses BSE archive rows into deals, mapping P/S to BUY/SELL', () => {
  const deals = parseBseDeals({ Table: [
    { DEAL_DATE: '2026-09-09T00:00:00', SCRIP_CODE: 539091, scripname: 'ccdl', CLIENT_NAME: ' METROCITY LLP ', TRANSACTION_TYPE: 'S', QUANTITY: 100.0, PRICE: 1.32 },
    { DEAL_DATE: '2026-09-09T00:00:00', SCRIP_CODE: 532523, scripname: 'BIOCON', CLIENT_NAME: 'ACTIV PINE LLP', TRANSACTION_TYPE: 'P', QUANTITY: 10.0, PRICE: 385 },
    { DEAL_DATE: '2026-09-09T00:00:00', scripname: 'BAD', CLIENT_NAME: 'X', TRANSACTION_TYPE: 'Z', QUANTITY: 1, PRICE: 1 },
  ] }, 'bulk', 'src');
  assert.deepEqual(deals.map(({ exchange, dealDate, symbol, clientName, side, value }) => ({ exchange, dealDate, symbol, clientName, side, value })), [
    { exchange: 'BSE', dealDate: '2026-09-09', symbol: 'CCDL', clientName: 'METROCITY LLP', side: 'SELL', value: 132 },
    { exchange: 'BSE', dealDate: '2026-09-09', symbol: 'BIOCON', clientName: 'ACTIV PINE LLP', side: 'BUY', value: 3850 },
  ]);
});

test('daily fetch stores NSE deals and catches BSE up from its last stored date', async () => {
  const { sqlite, env } = fixture();
  insertDeal(sqlite, ['bulk', 'BSE', '2026-10-10', 'OLD', 'OLD CLIENT', 'BUY', 1, 1]);
  const net = mockFetch((url) => {
    if (url.includes('nsearchives') && url.includes('bulk.csv')) {
      return new Response('Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks\n16-OCT-2026,ABC,Abc Ltd,NSE CLIENT,BUY,"1,000",10.5,-\n');
    }
    if (url.includes('nsearchives')) return new Response('Date,Symbol\nNO RECORDS\n');
    if (url.includes('DealType=1')) return bsePayload([{ DEAL_DATE: '2026-10-15T00:00:00', scripname: 'XYZ', CLIENT_NAME: 'BSE CLIENT', TRANSACTION_TYPE: 'P', QUANTITY: 5, PRICE: 20 }]);
    return bsePayload([]);
  });
  try {
    const result = await fetchAndStoreCapitalFlows(env, { today: '2026-10-16' });
    assert.equal(result.inserted, 2);
    assert.equal(result.bse.from, '2026-10-10');
    assert.ok(net.calls.some((u) => u.includes('FDate=10/10/2026&TDate=16/10/2026')));
    const stored = sqlite.prepare("SELECT exchange, deal_date, symbol, side, quantity FROM capital_flow_deals WHERE symbol != 'OLD' ORDER BY exchange").all();
    assert.deepEqual(stored.map((r) => ({ ...r })), [
      { exchange: 'BSE', deal_date: '2026-10-15', symbol: 'XYZ', side: 'BUY', quantity: 5 },
      { exchange: 'NSE', deal_date: '2026-10-16', symbol: 'ABC', side: 'BUY', quantity: 1000 },
    ]);
    // A second run is idempotent.
    assert.equal((await fetchAndStoreCapitalFlows(env, { today: '2026-10-16' })).inserted, 0);
  } finally { net.restore(); sqlite.close(); }
});

test('BSE catch-up is capped and an Akamai HTML block is reported, not stored', async () => {
  const { sqlite, env } = fixture();
  const net = mockFetch((url) => url.includes('bseindia')
    ? new Response('<HTML>Access Denied</HTML>', { status: 403, headers: { 'content-type': 'text/html' } })
    : new Response('Date,Symbol\nNO RECORDS\n'));
  try {
    const result = await fetchAndStoreCapitalFlows(env, { today: '2026-10-16' });
    assert.equal(result.bse.from, '2026-10-02');
    assert.deepEqual(result.bse.failed, ['bulk:403', 'block:403']);
    assert.equal(result.inserted, 0);
  } finally { net.restore(); sqlite.close(); }
});

test('export, client history and coverage endpoints page through stored deals', async () => {
  const { sqlite, env } = fixture();
  for (let i = 0; i < 150; i++) insertDeal(sqlite, ['bulk', i % 2 ? 'BSE' : 'NSE', `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, `S${i}`, i < 120 ? 'BIG FUND' : 'OTHER', 'BUY', 10, 2]);
  insertDeal(sqlite, ['block', 'NSE', '2026-10-15', 'BLK', 'OTHER', 'SELL', 1, 1]);
  const get = async (path) => (await worker.fetch(new Request(`https://example.test${path}`), env)).json();
  try {
    const first = await get('/api/portfolio/capital-flows/export?limit=100');
    assert.equal(first.rows.length, 100);
    assert.deepEqual(first.columns, ['id', 'type', 'exchange', 'date', 'symbol', 'clientName', 'side', 'quantity', 'price', 'securityName']);
    const second = await get(`/api/portfolio/capital-flows/export?limit=100&after=${first.next}`);
    assert.equal(second.rows.length, 51);
    assert.equal(second.next, null);

    const client = await get('/api/portfolio/capital-flows/client?name=BIG%20FUND');
    assert.equal(client.trades.length, 120);
    assert.deepEqual(Object.keys(client.trades[0]).sort(), ['clientName', 'date', 'exchange', 'price', 'quantity', 'side', 'symbol', 'type', 'value']);

    const flows = await get('/api/portfolio/capital-flows?pageSize=10');
    assert.deepEqual(flows.coverage, { NSE: { bulk: '2026-09-27', block: '2026-10-15' }, BSE: { bulk: '2026-09-28', block: null } });
  } finally { sqlite.close(); }
});

test('NSE archive CSV rows (the backfill source) parse into deals', async () => {
  const { sqlite, env } = fixture();
  const net = mockFetch((url) => url.includes('optionType=bulk_deals')
    ? new Response('﻿"Date ","Symbol ","Security Name ","Client Name ","Buy / Sell ","Quantity Traded ","Trade Price / Wght. Avg. Price ","Remarks "\n"10-SEP-2026","ABH","ABH Healthcare Limited","ANAND MOHAN","BUY","76,800","65.87","-"\n', { headers: { 'content-type': 'text/csv' } })
    : url.includes('historicalOR') ? new Response('Date,Symbol\n', { headers: { 'content-type': 'text/csv' } }) : bsePayload([]));
  try {
    const { fetchHistoricalCapitalFlows } = await import('./capital-flows.js');
    const result = await fetchHistoricalCapitalFlows(env, { from: '2026-09-10', to: '2026-09-10' });
    assert.equal(result.inserted, 1);
    const row = sqlite.prepare("SELECT exchange, deal_type, deal_date, symbol, security_name, side, quantity FROM capital_flow_deals").get();
    assert.deepEqual({ ...row }, { exchange: 'NSE', deal_type: 'bulk', deal_date: '2026-09-10', symbol: 'ABH', security_name: 'ABH Healthcare Limited', side: 'BUY', quantity: 76800 });
  } finally { net.restore(); sqlite.close(); }
});

test('latest=1 opens on the most recent disclosure day; client accepts spelling variants; stock endpoint pages one symbol', async () => {
  const { sqlite, env } = fixture();
  insertDeal(sqlite, ['bulk', 'NSE', '2026-10-15', 'ABC', 'SETU SECURITIES PVT LTD', 'BUY', 10, 5]);
  insertDeal(sqlite, ['bulk', 'BSE', '2026-10-16', 'ABC', 'SETU SECURITIES PRIVATE LIMITED', 'SELL', 10, 6]);
  insertDeal(sqlite, ['block', 'NSE', '2026-10-16', 'XYZ', 'OTHER FUND', 'BUY', 3, 100]);
  const get = async (path) => (await worker.fetch(new Request(`https://example.test${path}`), env)).json();
  try {
    const latest = await get('/api/portfolio/capital-flows?latest=1&pageSize=10');
    assert.equal(latest.pagination.from, '2026-10-16');
    assert.equal(latest.pagination.to, '2026-10-16');
    assert.deepEqual(latest.deals.map((d) => d.symbol).sort(), ['ABC', 'XYZ']);

    const client = await get('/api/portfolio/capital-flows/client?name=SETU%20SECURITIES%20PVT%20LTD&name=SETU%20SECURITIES%20PRIVATE%20LIMITED');
    assert.deepEqual(client.trades.map((t) => [t.date, t.clientName, t.side]), [
      ['2026-10-15', 'SETU SECURITIES PVT LTD', 'BUY'], ['2026-10-16', 'SETU SECURITIES PRIVATE LIMITED', 'SELL'],
    ]);

    const stock = await get('/api/portfolio/capital-flows/stock?symbol=abc');
    assert.equal(stock.symbol, 'ABC');
    assert.deepEqual(stock.trades.map((t) => [t.exchange, t.clientName]), [['NSE', 'SETU SECURITIES PVT LTD'], ['BSE', 'SETU SECURITIES PRIVATE LIMITED']]);
    assert.equal((await worker.fetch(new Request('https://example.test/api/portfolio/capital-flows/stock'), env)).status, 400);
  } finally { sqlite.close(); }
});

test('intraday and prop filters run before paging so pages stay full', async () => {
  const { sqlite, env } = fixture();
  env.SITE_ORIGIN = 'https://site.test';
  for (let i = 0; i < 30; i++) insertDeal(sqlite, ['bulk', 'NSE', '2026-10-16', `S${i}`, 'PROP DESK LLP', 'BUY', 1, 1]);
  for (let i = 0; i < 30; i++) insertDeal(sqlite, ['bulk', 'NSE', '2026-10-16', `S${i}`, 'PROP DESK LLP', 'SELL', 1, 1]);
  for (let i = 0; i < 15; i++) insertDeal(sqlite, ['bulk', 'NSE', '2026-10-16', `F${i}`, 'LONG FUND', 'BUY', 1, 1]);
  insertDeal(sqlite, ['bulk', 'NSE', '2026-10-16', 'Q', 'QUICK TRADER', 'BUY', 1, 1]);
  insertDeal(sqlite, ['bulk', 'NSE', '2026-10-16', 'Q', 'QUICK TRADER', 'SELL', 1, 1]);
  const net = mockFetch((url) => url === 'https://site.test/data/prop-clients.json'
    ? new Response(JSON.stringify(['PROP DESK LLP'])) : new Response('', { status: 404 }));
  const get = async (q) => (await worker.fetch(new Request(`https://example.test/api/portfolio/capital-flows?latest=1&pageSize=10&${q}`), env)).json();
  try {
    const all = await get('');
    assert.equal(all.pagination.total, 77);
    const noIntraday = await get('excludeIntraday=1');
    assert.equal(noIntraday.pagination.total, 15);
    assert.equal(noIntraday.deals.length, 10);
    const noProp = await get('hideProp=1');
    assert.equal(noProp.propFilter, 'on');
    assert.equal(noProp.pagination.total, 17);
    assert.equal(noProp.deals.length, 10);
    assert.ok(noProp.deals.every((d) => d.clientName !== 'PROP DESK LLP'));
  } finally { net.restore(); sqlite.close(); }
});
