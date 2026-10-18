#!/usr/bin/env node
// Builds public/data/whales-summary.json, the "Top disclosed whales" leaderboard
// on /capital-flows. Runs nightly in GitHub Actions (.github/workflows/whales.yml)
// because the FIFO matching over every disclosure is too CPU-heavy for the
// Worker's Free plan. Client histories are served live by the Worker API.
//
//   node scripts/build-whale-summary.mjs                     # read every deal from the API
//   node scripts/build-whale-summary.mjs --csv tradebook     # or from local exchange CSVs
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { clientKey, nameType } from '../src/lib/capital-flows.js';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const csvRoot = option('--csv');
const apiUrl = option('--api') || process.env.PUBLIC_API_URL || 'https://blog-api.compounding-dhan.workers.dev';
const output = option('--out') || 'public/data/whales-summary.json';
const metaOutput = join(dirname(output), 'client-meta.json');
const propOutput = join(dirname(output), 'prop-clients.json');

function parseCsvLine(line) {
  const fields = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(value.trim()); value = ''; }
    else value += char;
  }
  fields.push(value.trim());
  return fields;
}

function dateValue(value) {
  const match = String(value).trim().toUpperCase().match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (!match) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const month = months[match[2]];
  if (month == null) return null;
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return Number((values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2).toFixed(2));
}

const clientTrades = new Map();
const variants = new Map();
const seen = new Set();
let rows = 0;
let source;

function addTrade({ exchange, type, date, symbol, clientName, side, quantity, price }) {
  const name = clientName?.trim();
  if (!date || !symbol || !name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) return;
  const key = `${exchange}|${String(type).toLowerCase()}|${date}|${symbol}|${name}|${side}|${quantity}|${price}`;
  if (seen.has(key)) return;
  seen.add(key);
  rows++;
  // Group spelling variants of one client ("PVT. LTD." vs "PRIVATE LIMITED").
  const ck = clientKey(name);
  const spellings = variants.get(ck) || new Map();
  spellings.set(name, (spellings.get(name) || 0) + 1);
  variants.set(ck, spellings);
  const trades = clientTrades.get(ck) || [];
  trades.push({ date, symbol, clientName: ck, side, quantity, price, value: quantity * price, exchange, type });
  clientTrades.set(ck, trades);
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else if (entry.name.toLowerCase().endsWith('.csv')) files.push(path);
  }
  return files;
}

if (csvRoot) {
  const files = (await walk(csvRoot, [])).sort();
  for (const file of files) {
    const pathParts = file.split('/');
    const fileName = pathParts.at(-1) || '';
    const exchange = /^(NSE|BSE)-/i.exec(fileName)?.[1]?.toUpperCase() || pathParts.at(-3) || 'UNKNOWN';
    const type = /-(Bulk|Block)-Deals-/i.exec(fileName)?.[1] || pathParts.at(-2) || 'UNKNOWN';
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const [date, symbol, , clientName, side, quantityText, priceText] = parseCsvLine(line);
      addTrade({ exchange, type, date: dateValue(date), symbol, clientName, side,
        quantity: Number(String(quantityText).replaceAll(',', '')), price: Number(String(priceText).replaceAll(',', '')) });
    }
  }
  source = { csv: csvRoot, files: files.length };
} else {
  let after = 0;
  let requests = 0;
  for (;;) {
    const response = await fetch(`${apiUrl}/api/portfolio/capital-flows/export?after=${after}&limit=5000`);
    if (!response.ok) throw new Error(`Export request failed: HTTP ${response.status} after id ${after}`);
    const page = await response.json();
    requests++;
    const at = Object.fromEntries(page.columns.map((name, i) => [name, i]));
    for (const row of page.rows) {
      addTrade({ exchange: row[at.exchange], type: row[at.type], date: row[at.date], symbol: row[at.symbol],
        clientName: row[at.clientName], side: row[at.side], quantity: Number(row[at.quantity]), price: Number(row[at.price]) });
    }
    if (page.next == null) break;
    after = page.next;
  }
  source = { api: apiUrl, requests };
}

const dataThrough = {};
for (const trades of clientTrades.values()) for (const trade of trades) {
  if (!dataThrough[trade.exchange] || trade.date > dataThrough[trade.exchange]) dataThrough[trade.exchange] = trade.date;
}

// A block trade may also be published as a derived bulk deal. Collapse exact
// cross-type duplicates before calculating rankings and FIFO outcomes, while
// keeping every exchange-disclosed row available through the client API.
const economicDeals = new Map();
for (const trades of clientTrades.values()) for (const trade of trades) {
  const key = `${trade.exchange}|${trade.date}|${trade.symbol}|${trade.clientName}|${trade.side}|${trade.quantity}|${trade.price}`;
  if (!economicDeals.has(key)) economicDeals.set(key, trade);
}
const eligibleTrades = [...economicDeals.values()].sort((a, b) =>
  a.date.localeCompare(b.date)
  || a.symbol.localeCompare(b.symbol)
  || (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1)
);

const eligibleTradesByClient = new Map();
const clients = new Map();
const lots = new Map();
const outcomes = new Map();
const matchedEvents = new Map();
const activeDays = new Map();
for (const trade of eligibleTrades) {
  const trades = eligibleTradesByClient.get(trade.clientName) || [];
  trades.push(trade);
  eligibleTradesByClient.set(trade.clientName, trades);
  const summary = clients.get(trade.clientName) || { clientName: trade.clientName, deals: 0, stocks: new Set(), buyValue: 0, sellValue: 0, lastActivity: trade.date };
  summary.deals++;
  summary.stocks.add(trade.symbol);
  summary.lastActivity = summary.lastActivity > trade.date ? summary.lastActivity : trade.date;
  if (trade.side === 'BUY') summary.buyValue += trade.value;
  else summary.sellValue += trade.value;
  clients.set(trade.clientName, summary);
  const daySides = activeDays.get(trade.clientName) || new Map();
  daySides.set(`${trade.date}|${trade.symbol}`, (daySides.get(`${trade.date}|${trade.symbol}`) || 0) | (trade.side === 'BUY' ? 1 : 2));
  activeDays.set(trade.clientName, daySides);

  const lotKey = `${trade.clientName}\u0000${trade.symbol}`;
  const queue = lots.get(lotKey) || [];
  if (trade.side === 'BUY') queue.push({ qty: trade.quantity, price: trade.price, date: trade.date });
  else {
    let remaining = trade.quantity;
    while (remaining > 0 && queue.length) {
      const lot = queue[0];
      const matched = Math.min(remaining, lot.qty);
      const eventSet = matchedEvents.get(trade.clientName) || new Set();
      eventSet.add(`${trade.date}|${trade.symbol}`);
      matchedEvents.set(trade.clientName, eventSet);
      const result = outcomes.get(trade.clientName) || [];
      result.push({ returnPct: (trade.price / lot.price - 1) * 100, holdingDays: Math.max(0, Math.round((Date.parse(trade.date) - Date.parse(lot.date)) / 86400000)) });
      outcomes.set(trade.clientName, result);
      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 0) queue.shift();
    }
  }
  lots.set(lotKey, queue);
}

const whales = [...clients.values()].map((summary) => {
  const results = outcomes.get(summary.clientName) || [];
  const positionalResults = results.filter((item) => item.holdingDays > 0);
  const positive = results.filter((item) => item.returnPct > 0).length;
  const positionalPositive = positionalResults.filter((item) => item.returnPct > 0).length;
  const spellings = [...(variants.get(summary.clientName) || new Map()).entries()].sort((a, b) => b[1] - a[1]);
  const days = [...(activeDays.get(summary.clientName)?.values() || [])];
  const twoSidedDays = days.filter((sides) => sides === 3).length;
  // Prop/HFT desks buy and sell the same stock on the same day most of the time.
  // Funds and insurers also run same-day arbitrage, so only companies and
  // individuals are labelled prop.
  const byName = nameType(summary.clientName);
  const prop = ['corporate', 'individual'].includes(byName) && ((twoSidedDays >= 10 && twoSidedDays / days.length >= 0.5)
    || (results.length >= 20 && (results.length - positionalResults.length) / results.length >= 0.6));
  return {
    clientName: spellings[0]?.[0] || summary.clientName,
    clientKey: summary.clientName,
    type: prop ? 'prop' : byName,
    ...(spellings.length > 1 ? { aliases: spellings.map(([spelling]) => spelling) } : {}),
    deals: summary.deals,
    stocks: summary.stocks.size,
    buyValue: Math.round(summary.buyValue * 100) / 100,
    sellValue: Math.round(summary.sellValue * 100) / 100,
    lastActivity: summary.lastActivity,
    matchedTrades: results.length,
    matchedLots: results.length,
    sameDayMatchedLots: results.length - positionalResults.length,
    positionalMatchedLots: positionalResults.length,
    sameDayMatchedTrades: results.length - positionalResults.length,
    positionalMatchedTrades: positionalResults.length,
    hitRatePct: results.length ? Number((positive / results.length * 100).toFixed(1)) : null,
    medianReturnPct: median(results.map((item) => item.returnPct)),
    positionalHitRatePct: positionalResults.length ? Number((positionalPositive / positionalResults.length * 100).toFixed(1)) : null,
    positionalMedianReturnPct: median(positionalResults.map((item) => item.returnPct)),
    medianHoldingDays: median(positionalResults.map((item) => item.holdingDays)),
  };
}).sort((a, b) => b.buyValue - a.buyValue);

await mkdir(dirname(output), { recursive: true });
// Prop/HFT desks dominate buy value but are mostly same-day churn. Publish the
// top investors by buy value, plus the largest prop desks so the page can still
// show them when someone opts in.
const publishedWhales = [
  ...whales.filter((w) => w.type !== 'prop').slice(0, 500),
  ...whales.filter((w) => w.type === 'prop').slice(0, 50),
].sort((a, b) => b.buyValue - a.buyValue);
// Lets every page resolve any spelling to one client and mark prop desks,
// including clients outside the published leaderboard.
const clientMeta = {
  aliases: Object.fromEntries([...variants.entries()]
    .filter(([, spellings]) => spellings.size > 1)
    .map(([ck, spellings]) => [ck, [...spellings.entries()].sort((a, b) => b[1] - a[1]).map(([spelling]) => spelling)])
    .sort(([a], [b]) => a.localeCompare(b))),
  prop: whales.filter((w) => w.type === 'prop').map((w) => w.clientKey).sort(),
};
// Exact exchange spellings of prop desks, so the Worker can exclude them in SQL
// before paging (filtering a page in the browser leaves near-empty pages).
const propNames = whales.filter((w) => w.type === 'prop')
  .flatMap((w) => [...(variants.get(w.clientKey)?.keys() || [])]).sort();
// Leave the files untouched when nothing but the timestamp would change, so the
// nightly job only commits when there is new data.
const previous = await readFile(output, 'utf8').then(JSON.parse).catch(() => null);
const previousMeta = await readFile(metaOutput, 'utf8').then(JSON.parse).catch(() => null);
const unchanged = previous && previous.rows === rows
  && JSON.stringify(previous.dataThrough) === JSON.stringify(dataThrough)
  && JSON.stringify(previous.whales) === JSON.stringify(publishedWhales)
  && JSON.stringify(previousMeta?.aliases) === JSON.stringify(clientMeta.aliases)
  && JSON.stringify(previousMeta?.prop) === JSON.stringify(clientMeta.prop)
  && await readFile(propOutput, 'utf8').then((text) => text === JSON.stringify(propNames) + '\n').catch(() => false);
if (unchanged) {
  console.log(`No change since ${previous.generatedAt}; left ${output} as is.`);
  process.exit(0);
}
const generatedAt = new Date().toISOString();
await writeFile(output, JSON.stringify({ generatedAt, dataThrough, source, rows, whales: publishedWhales }, null, 2) + '\n');
await writeFile(metaOutput, JSON.stringify({ generatedAt, ...clientMeta }) + '\n');
await writeFile(propOutput, JSON.stringify(propNames) + '\n');
console.log(`Processed ${rows.toLocaleString()} unique disclosures (${JSON.stringify(dataThrough)}); ${whales.length.toLocaleString()} clients after merging ${Object.keys(clientMeta.aliases).length} spelling groups; ${clientMeta.prop.length} prop desks; wrote ${publishedWhales.length} to ${output}`);
