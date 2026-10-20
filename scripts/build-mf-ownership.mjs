#!/usr/bin/env node
// Builds quarterly institutional ownership from NSE shareholding-pattern
// filings (XBRL), with mutual funds in focus, for the /ownership screen.
// Runs nightly in GitHub Actions (.github/workflows/whales.yml), incrementally:
// it lists filings broadcast in the last few weeks and downloads only those it
// hasn't parsed yet (each quarter file records the filing id per company).
//
//   node scripts/build-mf-ownership.mjs                 # incremental (last 30 days of filings)
//   node scripts/build-mf-ownership.mjs --since 2024-12-01 --quarters 8
//                                                       # backfill: list filings from a date
// Downloads are deliberately slow (2 at a time, with a pause) and capped per
// run (--limit); NSE blocks an address that pulls files too quickly. A
// backfill is resumable: rerun until "0 filings to download".
//
// Layout (public/data/ownership):
//   index.json                 quarters with company counts, newest first
//   quarters/YYYY-MM-DD.json   { period, companies: { SYMBOL: { name, isin, recordId, broadcast,
//                                holders, shares, groups: { mf: [holders, shares, pct], ... },
//                                schemes: [[name, shares, pct]] } } }   (schemes: named MF holders >1%)
//   screen/YYYY-MM-DD.json     one row per company comparing the quarter with the one before it
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nameType } from '../src/lib/capital-flows.js';
import { parseShareholding } from '../src/lib/ownership.js';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const root = option('--out') || 'public/data/ownership';
const flowsRoot = option('--flows') || 'public/data/flows';
const keepQuarters = Number(option('--quarters') || 8);
const since = option('--since') || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const concurrency = Number(option('--concurrency') || 2);
const delayMs = Number(option('--delay') || 500);
const limit = Number(option('--limit') || 4000);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const QUARTER_END = /-(03-31|06-30|09-30|12-31)$/;
const nseDate = (value) => { // 30-SEP-2026 -> 2026-09-30
  const m = String(value || '').match(/^(\d{2})-([A-Z]{3})-(\d{4})/i);
  return m ? `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1]}` : null;
};
const dmy = (iso) => iso.split('-').reverse().join('-');
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse).catch(() => null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, type = 'json') {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.nseindia.com/', Accept: '*/*' }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return type === 'json' ? await response.json() : await response.text();
    } catch (error) {
      // 403/404: a just-filed document NSE hasn't published yet; the next run retries it.
      if (attempt >= (error.status === 403 || error.status === 404 ? 2 : 4)) throw new Error(`${url}: ${error.message}`);
      await sleep(2000 * attempt);
    }
  }
}

// ---------- 1. Load what we have ----------
await mkdir(join(root, 'quarters'), { recursive: true });
await mkdir(join(root, 'screen'), { recursive: true });
const quarters = new Map(); // period -> { period, companies }
for (const file of (await readdir(join(root, 'quarters')).catch(() => [])).filter((f) => f.endsWith('.json'))) {
  const q = await readJson(join(root, 'quarters', file));
  if (q?.period) quarters.set(q.period, q);
}

// ---------- 2. List filings broadcast since `since`, in 30-day windows ----------
const filings = new Map(); // `${symbol}|${period}` -> newest filing
const today = new Date().toISOString().slice(0, 10);
for (let start = since; start <= today;) {
  const end = new Date(Math.min(Date.parse(start) + 29 * 86400000, Date.parse(today))).toISOString().slice(0, 10);
  const list = await get(`https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&from_date=${dmy(start)}&to_date=${dmy(end)}`);
  for (const f of Array.isArray(list) ? list : []) {
    const period = nseDate(f.date);
    if (!period || !QUARTER_END.test(period) || !f.xbrl || !f.symbol) continue;
    const key = `${f.symbol}|${period}`;
    const previous = filings.get(key);
    // Revisions are filed again later; keep the latest broadcast.
    if (!previous || Number(f.recordId) > Number(previous.recordId)) filings.set(key, { ...f, period });
  }
  console.log(`Listed ${start} → ${end}: ${filings.size.toLocaleString()} quarterly filings so far`);
  start = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10);
}

// Only the most recent `keepQuarters` quarters are kept.
const allPeriods = [...new Set([...quarters.keys(), ...[...filings.values()].map((f) => f.period)])].sort().reverse();
const wanted = new Set(allPeriods.slice(0, keepQuarters));
const pending = [...filings.values()]
  .filter((f) => wanted.has(f.period) && quarters.get(f.period)?.companies?.[f.symbol]?.recordId !== String(f.recordId))
  .sort((a, b) => b.period.localeCompare(a.period) || Number(a.recordId) - Number(b.recordId)); // newest quarter first
const todo = pending.slice(0, limit);
console.log(`${pending.length.toLocaleString()} filings to download${pending.length > limit ? `; this run takes ${limit.toLocaleString()}` : ''}`);

// ---------- 3. Download and parse new filings ----------
const touched = new Set();
let done = 0, failed = 0, blockedStreak = 0, blocked = false;
async function saveQuarter(period) {
  const q = quarters.get(period);
  const companies = Object.fromEntries(Object.entries(q.companies).sort(([a], [b]) => a.localeCompare(b)));
  await writeIfChanged(join(root, 'quarters', `${period}.json`), { period, companies });
}
let written = 0;
async function writeIfChanged(path, value) {
  const text = JSON.stringify(value) + '\n';
  if ((await readFile(path, 'utf8').catch(() => null)) === text) return;
  await writeFile(path, text);
  written++;
}
const queue = [...todo];
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let f = queue.shift(); f && !blocked; f = queue.shift()) {
    await sleep(delayMs);
    try {
      const parsed = parseShareholding(await get(f.xbrl, 'text'));
      if (!parsed.groups.public && !parsed.groups.promoter) throw new Error('no shareholding totals');
      const q = quarters.get(f.period) || { period: f.period, companies: {} };
      quarters.set(f.period, q);
      q.companies[f.symbol] = {
        name: f.name, isin: f.isin, recordId: String(f.recordId), broadcast: nseDate(f.broadcastDate),
        holders: parsed.holders, shares: parsed.shares, groups: parsed.groups, schemes: parsed.schemes,
      };
      touched.add(f.period);
      blockedStreak = 0;
    } catch (error) {
      failed++;
      // A run of 403s means NSE is refusing this address; stop and keep what we have.
      if (/HTTP 403/.test(error.message) && ++blockedStreak >= 25) {
        blocked = true;
        console.warn('NSE is refusing downloads (25 consecutive 403s); stopping early. Rerun later to continue.');
      }
      if (failed <= 20) console.warn(`Skipped ${f.symbol} ${f.period}: ${error.message}`);
    }
    if (++done % 250 === 0) {
      console.log(`${done.toLocaleString()} / ${todo.length.toLocaleString()} downloaded (${failed} failed)`);
      for (const period of touched) await saveQuarter(period); // resumable
    }
  }
}));
for (const period of touched) await saveQuarter(period);
console.log(`Parsed ${(done - failed).toLocaleString()} filings, ${failed} failed`);

// ---------- 4. Screen: each quarter against the one before it ----------
const periods = [...quarters.keys()].filter((p) => wanted.has(p)).sort().reverse();

// Mutual-fund bulk/block deal value per stock per quarter, from the static deal files.
const mfDeals = new Map(); // period -> symbol -> [buy, sell]
const quarterOf = (date) => { const [y, m] = date.split('-').map(Number); const qm = Math.ceil(m / 3) * 3; return `${y}-${String(qm).padStart(2, '0')}-${qm === 6 || qm === 9 ? '30' : '31'}`; };
for (const file of (await readdir(join(flowsRoot, 'days')).catch(() => [])).filter((f) => f.endsWith('.json'))) {
  const period = quarterOf(file.slice(0, 10));
  if (!wanted.has(period)) continue;
  const day = await readJson(join(flowsRoot, 'days', file));
  for (const [, code, symbol, n, qty, price] of day?.rows || []) {
    if (nameType(day.names[n]) !== 'mutual-fund') continue;
    const bySymbol = mfDeals.get(period) || new Map();
    mfDeals.set(period, bySymbol);
    const entry = bySymbol.get(symbol) || [0, 0];
    entry[code[2] === 'S' ? 1 : 0] += qty * price;
    bySymbol.set(symbol, entry);
  }
}

const delta = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 100) / 100);
const g = (c, key, i) => c?.groups?.[key]?.[i] ?? (c ? 0 : null); // a missing group in a filing means none held
const SCREEN_COLUMNS = ['symbol', 'name', 'mfPct', 'mfPctPrev', 'mfHolders', 'mfHoldersPrev', 'mfShares', 'mfSharesPrev',
  'insurancePctChange', 'fpiPctChange', 'aifPctChange', 'promoterPctChange', 'retailHoldersChangePct',
  'newSchemes', 'exitedSchemes', 'mfDealBuy', 'mfDealSell', 'history', 'shares', 'sharesPrev'];
for (let i = 0; i < periods.length - 1; i++) {
  const period = periods[i], prevPeriod = periods[i + 1];
  const now = quarters.get(period).companies, prev = quarters.get(prevPeriod).companies;
  const rows = [];
  for (const [symbol, c] of Object.entries(now)) {
    const p = prev[symbol] || null;
    const names = (x) => new Set((x?.schemes || []).map((s) => s[0]));
    const nowSchemes = names(c), prevSchemes = names(p);
    const retailNow = g(c, 'retail', 0), retailPrev = g(p, 'retail', 0);
    const deals = mfDeals.get(period)?.get(symbol) || [0, 0];
    rows.push([
      symbol, c.name, g(c, 'mf', 2), g(p, 'mf', 2), g(c, 'mf', 0), g(p, 'mf', 0), g(c, 'mf', 1), g(p, 'mf', 1),
      delta(g(c, 'insurance', 2), g(p, 'insurance', 2)), delta(g(c, 'fpi', 2), g(p, 'fpi', 2)),
      delta(g(c, 'aif', 2), g(p, 'aif', 2)), delta(g(c, 'promoter', 2), g(p, 'promoter', 2)),
      retailPrev ? Math.round(((retailNow - retailPrev) / retailPrev) * 1000) / 10 : null,
      p ? [...nowSchemes].filter((s) => !prevSchemes.has(s)) : [],
      p ? [...prevSchemes].filter((s) => !nowSchemes.has(s)) : [],
      Math.round(deals[0]), Math.round(deals[1]),
      periods.slice(i, i + 8).reverse().map((q) => quarters.get(q).companies[symbol]?.groups?.mf?.[2] ?? (quarters.get(q).companies[symbol] ? 0 : null)),
      c.shares, p?.shares ?? null,
    ]);
  }
  rows.sort((a, b) => (b[2] - (b[3] ?? b[2])) - (a[2] - (a[3] ?? a[2])));
  await writeIfChanged(join(root, 'screen', `${period}.json`), { period, previous: prevPeriod, columns: SCREEN_COLUMNS, history: periods.slice(i, i + 8).reverse(), rows });
}

await writeIfChanged(join(root, 'index.json'), {
  quarters: periods.map((p) => [p, Object.keys(quarters.get(p).companies).length]),
  screens: periods.slice(0, -1),
});
console.log(`Wrote ${written} changed files to ${root}`);
