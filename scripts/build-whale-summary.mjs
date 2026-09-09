#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.argv[2] || 'tradebook';
const output = process.argv[3] || 'public/data/whales-summary.json';
const summaryOnly = process.argv.includes('--summary-only');
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.toLowerCase().endsWith('.csv')) files.push(path);
  }
}

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

await walk(root);
files.sort();
const clientTrades = new Map();
const seen = new Set();
let rows = 0;

for (const file of files) {
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  const pathParts = file.split('/');
  const exchange = pathParts.at(-3) || 'UNKNOWN';
  const dealType = pathParts.at(-2) || 'UNKNOWN';
  for (const [lineNumber, line] of lines.slice(1).entries()) {
    if (!line.trim()) continue;
    const [date, symbol, , client, side, quantityText, priceText] = parseCsvLine(line);
    const dealDate = dateValue(date);
    const name = client?.trim();
    const qty = Number(String(quantityText).replaceAll(',', ''));
    const price = Number(String(priceText).replaceAll(',', ''));
    if (!dealDate || !symbol || !name || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) continue;
    const key = `${exchange}|${dealType}|${dealDate}|${symbol}|${name}|${side}|${qty}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows++;
    const trades = clientTrades.get(name) || [];
    trades.push({ date: dealDate, symbol, clientName: name, side, quantity: qty, price, value: qty * price, exchange, type: dealType });
    clientTrades.set(name, trades);
  }
}

// A block trade may also be published as a derived bulk deal. Collapse exact
// cross-type duplicates before calculating rankings and FIFO outcomes, while
// preserving every exchange-disclosed row in the client-history files.
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
  const positive = results.filter((item) => item.returnPct > 0).length;
  return {
    clientName: summary.clientName,
    deals: summary.deals,
    stocks: summary.stocks.size,
    buyValue: Math.round(summary.buyValue * 100) / 100,
    sellValue: Math.round(summary.sellValue * 100) / 100,
    lastActivity: summary.lastActivity,
    matchedTrades: (matchedEvents.get(summary.clientName) || new Set()).size,
    matchedLots: results.length,
    hitRatePct: results.length ? Number((positive / results.length * 100).toFixed(1)) : null,
    medianReturnPct: median(results.map((item) => item.returnPct)),
    medianHoldingDays: median(results.map((item) => item.holdingDays)),
  };
}).sort((a, b) => b.buyValue - a.buyValue);

await mkdir(join(output, '..'), { recursive: true });
const publishedWhales = whales.slice(0, 500);
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), sourceRoot: root, files: files.map((file) => relative(root, file)), rows, whales: publishedWhales }, null, 2) + '\n');
const partitionRoot = join(output, '..', 'whales');
let partitionCount = 0;
if (!summaryOnly) {
  await mkdir(partitionRoot, { recursive: true });
  const generatedAt = new Date().toISOString();
  const partitions = new Map();
  for (const whale of whales) {
    const first = whale.clientName.trim().charAt(0).toUpperCase();
    const key = /^[A-Z]$/.test(first) ? first : 'other';
    const entries = partitions.get(key) || [];
    // Preserve the complete exchange-disclosed history for inspection. The UI
    // checkbox controls whether likely intraday pairs are shown.
    entries.push({ ...whale, trades: clientTrades.get(whale.clientName) || [] });
    partitions.set(key, entries);
  }
  for (const [key, entries] of partitions) {
    await writeFile(join(partitionRoot, `${key}.json`), JSON.stringify({ generatedAt, letter: key, clients: entries }, null, 2) + '\n');
  }
  partitionCount = partitions.size;
}
console.log(`Processed ${rows.toLocaleString()} unique disclosures from ${files.length} files; wrote ${publishedWhales.length.toLocaleString()} top clients${summaryOnly ? ' (summary only)' : ` and ${whales.length.toLocaleString()} clients across ${partitionCount} letter partitions`}`);
