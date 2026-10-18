#!/usr/bin/env node
// Builds the static Capital Flows dataset in public/data/flows/ so public pages
// never query D1 (the Free plan allows 5M rows read per day for the account).
// Runs nightly in GitHub Actions (.github/workflows/whales.yml), incrementally:
// it loads the committed day files, asks the export API only for deals newer
// than the highest id it has, and rewrites only the files those deals touch.
//
//   node scripts/build-capital-flows.mjs                    # incremental, from the API
//   node scripts/build-capital-flows.mjs --sqlite deals.db  # bootstrap from a SQLite copy
//
// Layout (all compact JSON):
//   index.json                 coverage, max id, list of days with deal counts
//   days/YYYY-MM-DD.json       every deal that day
//   stocks/<SYMBOL>.json       every deal in one stock (both exchanges)
//   clients/<bucket>.json      every deal of the clients hashed into that bucket
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { clientKey, clientBucket, stockFile } from '../src/lib/capital-flows.js';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const root = option('--out') || 'public/data/flows';
const apiUrl = option('--api') || process.env.PUBLIC_API_URL || 'https://blog-api.compounding-dhan.workers.dev';
const sqlitePath = option('--sqlite');

// id -> { id, type, exchange, date, symbol, client, side, qty, price }
const deals = new Map();
const securityNames = new Map();

async function readJson(path) {
  return readFile(path, 'utf8').then(JSON.parse).catch(() => null);
}

// 1. What we already have: the committed day files are the full history.
for (const file of (await readdir(join(root, 'days')).catch(() => [])).filter((f) => f.endsWith('.json'))) {
  const day = await readJson(join(root, 'days', file));
  for (const [id, type, exchange, symbol, client, side, qty, price] of day?.rows || []) {
    deals.set(id, { id, type, exchange, date: day.date, symbol, client, side, qty, price });
  }
}
for (const file of (await readdir(join(root, 'stocks')).catch(() => [])).filter((f) => f.endsWith('.json'))) {
  const stock = await readJson(join(root, 'stocks', file));
  if (stock?.name) securityNames.set(stock.symbol, stock.name);
}
const previousMax = Math.max(0, ...deals.keys());

// 2. New deals.
const fresh = [];
if (sqlitePath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const hasName = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('capital_flow_deals') WHERE name = 'security_name'").get().n > 0;
  for (const r of db.prepare(`SELECT id, deal_type, exchange, deal_date, symbol, client_name, side, quantity, price${hasName ? ', security_name' : ''} FROM capital_flow_deals WHERE id > ? ORDER BY id`).all(previousMax)) {
    fresh.push({ id: r.id, type: r.deal_type, exchange: r.exchange, date: r.deal_date, symbol: r.symbol, client: r.client_name, side: r.side, qty: r.quantity, price: r.price, name: r.security_name || null });
  }
} else {
  let after = previousMax;
  for (;;) {
    const response = await fetch(`${apiUrl}/api/portfolio/capital-flows/export?after=${after}&limit=5000`, { headers: { 'User-Agent': 'compounding-dhan-build' } });
    if (!response.ok) throw new Error(`Export failed: HTTP ${response.status} after id ${after}`);
    const page = await response.json();
    const at = Object.fromEntries(page.columns.map((name, i) => [name, i]));
    for (const row of page.rows) {
      fresh.push({ id: row[at.id], type: row[at.type], exchange: row[at.exchange], date: row[at.date], symbol: row[at.symbol], client: row[at.clientName], side: row[at.side], qty: Number(row[at.quantity]), price: Number(row[at.price]), name: at.securityName == null ? null : row[at.securityName] });
    }
    if (page.next == null) break;
    after = page.next;
  }
}
const newDeals = fresh.filter((d) => !deals.has(d.id));
for (const d of newDeals) {
  deals.set(d.id, d);
  if (d.name && !securityNames.has(d.symbol)) securityNames.set(d.symbol, d.name);
}
const bootstrap = previousMax === 0;
console.log(`${deals.size.toLocaleString()} deals (${newDeals.length.toLocaleString()} new since id ${previousMax})`);

// 3. Which files change.
const touchedDays = new Set(newDeals.map((d) => d.date));
const touchedStocks = new Set(newDeals.map((d) => d.symbol));
const touchedBuckets = new Set(newDeals.map((d) => clientBucket(d.client)));
const all = [...deals.values()].sort((a, b) => a.id - b.id);

let written = 0;
async function write(path, value) {
  const text = JSON.stringify(value) + '\n';
  if ((await readFile(path, 'utf8').catch(() => null)) === text) return;
  await writeFile(path, text);
  written++;
}
for (const dir of ['days', 'stocks', 'clients']) await mkdir(join(root, dir), { recursive: true });

const group = (keyOf) => {
  const map = new Map();
  for (const d of all) { const k = keyOf(d); const list = map.get(k) || []; list.push(d); map.set(k, list); }
  return map;
};

const byDay = group((d) => d.date);
for (const [date, list] of byDay) {
  if (!bootstrap && !touchedDays.has(date)) continue;
  await write(join(root, 'days', `${date}.json`), { date, rows: list.map((d) => [d.id, d.type, d.exchange, d.symbol, d.client, d.side, d.qty, d.price]) });
}

const byStock = group((d) => d.symbol);
for (const [symbol, list] of byStock) {
  if (!bootstrap && !touchedStocks.has(symbol)) continue;
  await write(join(root, 'stocks', `${stockFile(symbol)}.json`), {
    symbol, name: securityNames.get(symbol) || null,
    rows: list.map((d) => [d.id, d.type, d.exchange, d.date, d.client, d.side, d.qty, d.price]),
  });
}

const byBucket = group((d) => clientBucket(d.client));
for (const [bucket, list] of byBucket) {
  if (!bootstrap && !touchedBuckets.has(bucket)) continue;
  const clients = {};
  for (const d of list) {
    const key = clientKey(d.client);
    const entry = clients[key] ||= { names: [], rows: [] };
    let nameIndex = entry.names.indexOf(d.client);
    if (nameIndex === -1) nameIndex = entry.names.push(d.client) - 1;
    entry.rows.push([d.id, d.type, d.exchange, d.date, d.symbol, nameIndex, d.side, d.qty, d.price]);
  }
  await write(join(root, 'clients', `${bucket}.json`), clients);
}

const coverage = {};
for (const d of all) {
  const ex = coverage[d.exchange] ||= {};
  if (!ex[d.type] || d.date > ex[d.type]) ex[d.type] = d.date;
}
const maxId = all.at(-1)?.id || 0;
await write(join(root, 'index.json'), {
  maxId,
  deals: all.length,
  coverage,
  days: [...byDay].map(([date, list]) => [date, list.length]).sort((a, b) => b[0].localeCompare(a[0])),
});
console.log(`Wrote ${written} changed files to ${root}`);

// 4. Leaderboard, client spellings and prop list, from the same dataset.
const rowsPath = join(tmpdir(), `capital-flows-rows-${process.pid}.json`);
await writeFile(rowsPath, JSON.stringify(all.map((d) => [d.id, d.type, d.exchange, d.date, d.symbol, d.client, d.side, d.qty, d.price])));
execFileSync(process.execPath, [new URL('./build-whale-summary.mjs', import.meta.url).pathname, '--rows', rowsPath], { stdio: 'inherit' });
