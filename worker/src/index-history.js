import { BROWSER_UA } from './newsfeeds.js';

// Keep the canonical price_history symbols so all existing readers benefit.
export const OFFICIAL_INDEX_NAMES = {
  '^NSEI': 'NIFTY 50',
  'NIFTYSMLCAP250.NS': 'NIFTY SMALLCAP 250',
};
const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function requestDate(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

export function parseIndexHistory(payload, indexName) {
  let data = payload?.d ?? payload;
  if (typeof data === 'string') data = JSON.parse(data);
  if (!Array.isArray(data)) throw new Error('Invalid index history response');
  const rows = new Map();
  const number = (value) => {
    if (value == null || String(value).trim() === '') return null;
    const result = Number(String(value).replaceAll(',', ''));
    return Number.isFinite(result) ? result : null;
  };
  for (const row of data) {
    if (row.INDEX_NAME?.trim().toUpperCase() !== indexName.toUpperCase()) continue;
    const parts = /^(\d{2})[ -]([A-Za-z]{3})[ -](\d{4})$/.exec(row.HistoricalDate || '');
    if (!parts) continue;
    const month = MONTHS.findIndex((m) => m.toLowerCase() === parts[2].toLowerCase());
    if (month < 0) continue;
    const date = `${parts[3]}-${String(month + 1).padStart(2, '0')}-${parts[1]}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    const close = number(row.CLOSE);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || !(close > 0)) continue;
    rows.set(date, { date, open: number(row.OPEN), high: number(row.HIGH), low: number(row.LOW), close, volume: null });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchOfficialIndexHistory(indexName, from, to, fetcher = fetch) {
  try {
    const end = new Date(`${to}T00:00:00Z`);
    let start = new Date(`${from}T00:00:00Z`);
    const rows = new Map();
    // The official history form limits each request to one year.
    while (start <= end) {
      const chunkEnd = new Date(Math.min(end.getTime(), start.getTime() + 364 * DAY_MS));
      const response = await fetcher('https://www.niftyindices.com/BackPage/getHistoricaldatatabletoString', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'User-Agent': BROWSER_UA, Referer: 'https://www.niftyindices.com/reports/historical-data' },
        body: JSON.stringify({ cinfo: JSON.stringify({ name: indexName, indexName, startDate: requestDate(start), endDate: requestDate(chunkEnd) }) }),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`Index history HTTP ${response.status}`);
      for (const row of parseIndexHistory(await response.json(), indexName)) {
        if (row.date >= from && row.date <= to) rows.set(row.date, row);
      }
      start = new Date(chunkEnd.getTime() + DAY_MS);
    }
    return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  } catch (error) {
    console.error(`Official index history failed for ${indexName}`, error);
    return [];
  }
}
