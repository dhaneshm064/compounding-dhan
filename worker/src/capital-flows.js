const NSE_DEAL_SOURCES = {
  bulk: 'https://nsearchives.nseindia.com/content/equities/bulk.csv',
  block: 'https://nsearchives.nseindia.com/content/equities/block.csv',
};

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseDate(value) {
  const match = String(value || '').match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i);
  if (!match || MONTHS[match[2].toUpperCase()] == null) return null;
  return `${match[3]}-${String(MONTHS[match[2].toUpperCase()] + 1).padStart(2, '0')}-${match[1]}`;
}

function parseNumber(value) {
  const number = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function parseReport(text, dealType, sourceUrl, exchange) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2 || /NO RECORDS/i.test(lines[1])) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const index = (name) => {
    const target = name.replace(/[^a-z0-9]/g, '');
    return headers.findIndex((header) => header.replace(/[^a-z0-9]/g, '').includes(target));
  };
  const dateIndex = index('date');
  const symbolIndex = index('symbol');
  const securityIndex = index('security name');
  const clientIndex = index('client name');
  const sideIndex = index('buy/sell');
  const quantityIndex = index('quantity traded');
  const priceIndex = index('trade price');
  return lines.slice(1).map((line) => {
    const row = parseCsvLine(line);
    const quantity = parseNumber(row[quantityIndex]);
    const price = parseNumber(row[priceIndex]);
    return {
      dealType,
      exchange,
      dealDate: parseDate(row[dateIndex]),
      symbol: row[symbolIndex] || null,
      securityName: row[securityIndex] || null,
      clientName: row[clientIndex] || null,
      side: (row[sideIndex] || '').toUpperCase(),
      quantity,
      price,
      value: quantity != null && price != null ? Math.round(quantity * price * 100) / 100 : null,
      sourceUrl,
    };
  }).filter((deal) => deal.dealDate && deal.symbol && deal.clientName && deal.quantity != null && deal.price != null);
}

async function insertDeals(env, deals, fetchedAt) {
  const statements = deals.map((deal) => env.DB.prepare(
    `INSERT OR IGNORE INTO capital_flow_deals
      (deal_type, exchange, deal_date, symbol, security_name, client_name, side, quantity, price, value, source_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(deal.dealType, deal.exchange, deal.dealDate, deal.symbol, deal.securityName, deal.clientName, deal.side, deal.quantity, deal.price, deal.value, deal.sourceUrl, fetchedAt));
  let inserted = 0;
  for (let i = 0; i < statements.length; i += 100) {
    const result = await env.DB.batch(statements.slice(i, i + 100));
    inserted += result.filter((item) => item.meta?.changes > 0).length;
  }
  return inserted;
}

async function onlyRecentDeals(env, deals) {
  const latestBySource = new Map();
  const kept = [];
  for (const deal of deals) {
    const key = `${deal.exchange}:${deal.dealType}`;
    if (!latestBySource.has(key)) {
      const row = await env.DB.prepare(
        'SELECT MAX(deal_date) AS latest FROM capital_flow_deals WHERE exchange = ? AND deal_type = ?'
      ).bind(deal.exchange, deal.dealType).first();
      latestBySource.set(key, row?.latest || null);
    }
    const latest = latestBySource.get(key);
    if (!latest || deal.dealDate >= latest) kept.push(deal);
  }
  return kept;
}

export async function importCapitalFlowsCsv(env, text, { dealType = 'bulk', sourceUrl = 'repository import', exchange } = {}) {
  if (exchange !== 'NSE' && exchange !== 'BSE') throw new Error("importCapitalFlowsCsv requires exchange to be 'NSE' or 'BSE'");
  const deals = parseReport(text, dealType, sourceUrl, exchange);
  if (!deals.length) return { fetched: 0, inserted: 0 };
  const fetchedAt = new Date().toISOString();
  const inserted = await insertDeals(env, deals, fetchedAt);
  return { fetched: deals.length, inserted };
}

function parseHistoricalJson(payload, dealType, sourceUrl) {
  const rows = Array.isArray(payload) ? payload : (payload?.data || payload?.records || payload?.results || []);
  return rows.map((row) => {
    const get = (...keys) => keys.map((key) => row?.[key]).find((value) => value != null && value !== '');
    const quantity = parseNumber(get('BD_QTY_TRD', 'quantityTraded', 'quantity', 'qty'));
    const price = parseNumber(get('BD_TP_WATP', 'tradePrice', 'price', 'watp'));
    const rawDate = get('BD_DT_DATE', 'date', 'dealDate', 'tradeDate');
    const dealDate = parseDate(String(rawDate || '').toUpperCase()) || (/^\d{4}-\d{2}-\d{2}$/.test(String(rawDate)) ? rawDate : null);
    return {
      dealType,
      exchange: 'NSE',
      dealDate,
      symbol: get('BD_SYMBOL', 'symbol'),
      securityName: get('BD_SCRIP_NAME', 'securityName', 'companyName', 'name'),
      clientName: get('BD_CLIENT_NAME', 'clientName', 'client'),
      side: String(get('BD_BUY_SELL', 'buySell', 'side') || '').toUpperCase(),
      quantity,
      price,
      value: quantity != null && price != null ? Math.round(quantity * price * 100) / 100 : null,
      sourceUrl,
    };
  }).filter((deal) => deal.dealDate && deal.symbol && deal.clientName && deal.quantity != null && deal.price != null);
}

function nseDate(value) {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${day}-${month}-${year}` : null;
}

export async function fetchHistoricalCapitalFlows(env, { from, to }) {
  const fromDate = nseDate(from);
  const toDate = nseDate(to);
  if (!fromDate || !toDate) return { fetched: 0, inserted: 0, error: 'Dates must use YYYY-MM-DD format' };
  const fetchedAt = new Date().toISOString();
  const allDeals = [];
  for (const [dealType, endpoint] of [['bulk', 'https://www.nseindia.com/api/historical/bulk-deals'], ['block', 'https://www.nseindia.com/api/historical/block-deals']]) {
    try {
      const sourceUrl = `${endpoint}?from=${fromDate}&to=${toDate}`;
      const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompoundingDhanResearch/1.0)', Accept: 'application/json', Referer: 'https://www.nseindia.com/' } });
      if (response.ok) allDeals.push(...parseHistoricalJson(await response.json(), dealType, sourceUrl));
    } catch { /* best effort; preserve already stored deals */ }
  }
  if (!allDeals.length) return { fetched: 0, inserted: 0 };
  const inserted = await insertDeals(env, allDeals, fetchedAt);
  return { fetched: allDeals.length, inserted };
}

export async function fetchAndStoreCapitalFlows(env) {
  const fetchedAt = new Date().toISOString();
  const allDeals = [];
  for (const [dealType, sourceUrl] of Object.entries(NSE_DEAL_SOURCES)) {
    try {
      const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompoundingDhanResearch/1.0)', Accept: 'text/csv,*/*' } });
      if (!response.ok) continue;
      allDeals.push(...parseReport(await response.text(), dealType, sourceUrl, 'NSE'));
    } catch { /* best effort; keep the previous feed if NSE is unavailable */ }
  }
  if (!allDeals.length) return { fetched: 0, considered: 0, inserted: 0 };
  const recentDeals = await onlyRecentDeals(env, allDeals);
  const inserted = await insertDeals(env, recentDeals, fetchedAt);
  return { fetched: allDeals.length, considered: recentDeals.length, inserted };
}
