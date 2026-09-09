#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import XLSX from 'xlsx';

const inputRoot = process.argv[2] || 'ownership/raw';
const outputRoot = process.argv[3] || 'public/data/ownership';
const files = [];

async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(csv|tsv)$/i.test(entry.name)) files.push(path);
  }
}
function parseLine(line, delimiter = ',') {
  const out = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === delimiter && !quoted) { out.push(value.trim()); value = ''; }
    else value += c;
  }
  out.push(value.trim()); return out;
}
const clean = (v) => String(v ?? '').replace(/[,%₹]/g, '').trim();
const key = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const find = (headers, names) => { const wanted = names.map(key); return headers.findIndex((h) => wanted.includes(key(h))); };
const number = (v) => { const n = Number(clean(v)); return Number.isFinite(n) ? n : null; };
const isoPeriod = (v) => { const s = String(v ?? '').trim(); const q = s.match(/(20\d{2})[- _]?Q([1-4])/i); if (q) return `${q[1]}-Q${q[2]}`; const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 7); };

await walk(inputRoot); files.sort();
const events = [];
for (const file of files) {
  const isExcel = /\.xlsx?$/i.test(file);
  let rows;
  if (isExcel) {
    const workbook = XLSX.read(await readFile(file), { type: 'buffer' });
    rows = workbook.SheetNames.flatMap((sheetName) => XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }));
  } else {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
    rows = lines.map((line) => parseLine(line, delimiter));
  }
  if (rows.length < 2) continue;
  const headers = rows[0].map(String);
  const symbolIdx = find(headers, ['symbol', 'scrip code', 'stock', 'company']);
  const isinIdx = find(headers, ['isin']);
  const investorIdx = find(headers, ['investor', 'investor name', 'shareholder', 'client name', 'scheme name', 'fund name']);
  const typeIdx = find(headers, ['investor type', 'category', 'shareholder category', 'type']);
  const periodIdx = find(headers, ['period', 'quarter', 'quarter ended', 'month', 'as on']);
  const sharesIdx = find(headers, ['shares', 'shares held', 'no of shares', 'quantity']);
  const pctIdx = find(headers, ['holding %', 'holding percentage', 'percentage', '% holding', 'shareholding']);
  const valueIdx = find(headers, ['value', 'market value', 'value rs']);
  if (symbolIdx < 0 || investorIdx < 0) continue;
  for (const row of rows.slice(1)) {
    const stock = row[symbolIdx]?.trim(); const investor = row[investorIdx]?.trim();
    if (!stock || !investor) continue;
    events.push({ stock, isin: isinIdx >= 0 ? row[isinIdx] || null : null, investorName: investor, investorType: typeIdx >= 0 ? row[typeIdx] || 'Institutional' : 'Institutional', period: isoPeriod(periodIdx >= 0 ? row[periodIdx] : ''), shares: sharesIdx >= 0 ? number(row[sharesIdx]) : null, holdingPct: pctIdx >= 0 ? number(row[pctIdx]) : null, value: valueIdx >= 0 ? number(row[valueIdx]) : null, sourceFile: file });
  }
}
const deduped = [...new Map(events.map((event) => [`${event.stock}|${event.investorName}|${event.period}|${event.investorType}`, event])).values()];
const byStock = new Map(); const byInvestor = new Map();
for (const event of deduped) {
  const stock = byStock.get(event.stock) || []; stock.push(event); byStock.set(event.stock, stock);
  const investor = byInvestor.get(event.investorName) || []; investor.push(event); byInvestor.set(event.investorName, investor);
}
const generatedAt = new Date().toISOString();
await mkdir(join(outputRoot, 'stocks'), { recursive: true }); await mkdir(join(outputRoot, 'investors'), { recursive: true });
const writePartitions = async (map, folder, field) => {
  const partitions = new Map();
  for (const [name, records] of map) { const first = name.trim().charAt(0).toUpperCase(); const letter = /^[A-Z]$/.test(first) ? first : 'other'; const list = partitions.get(letter) || []; list.push({ [field]: name, records: records.sort((a, b) => String(b.period).localeCompare(String(a.period))) }); partitions.set(letter, list); }
  for (const [letter, records] of partitions) await writeFile(join(outputRoot, folder, `${letter}.json`), JSON.stringify({ generatedAt, records }, null, 2) + '\n');
};
await writePartitions(byStock, 'stocks', 'stock'); await writePartitions(byInvestor, 'investors', 'investorName');
await writeFile(join(outputRoot, 'ownership-summary.json'), JSON.stringify({ generatedAt, sourceRoot: inputRoot, eventCount: deduped.length, stocks: byStock.size, investors: byInvestor.size, events: deduped }, null, 2) + '\n');
console.log(`Processed ${deduped.length.toLocaleString()} ownership events for ${byStock.size.toLocaleString()} stocks and ${byInvestor.size.toLocaleString()} investors`);
