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

function parseReport(text, dealType, sourceUrl) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2 || /NO RECORDS/i.test(lines[1])) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const index = (name) => headers.findIndex((header) => header.includes(name));
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

export async function fetchAndStoreCapitalFlows(env) {
  const fetchedAt = new Date().toISOString();
  const allDeals = [];
  for (const [dealType, sourceUrl] of Object.entries(NSE_DEAL_SOURCES)) {
    try {
      const response = await fetch(sourceUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompoundingDhanResearch/1.0)', Accept: 'text/csv,*/*' } });
      if (!response.ok) continue;
      allDeals.push(...parseReport(await response.text(), dealType, sourceUrl));
    } catch { /* best effort; keep the previous feed if NSE is unavailable */ }
  }
  if (!allDeals.length) return { fetched: 0, inserted: 0 };
  const statements = allDeals.map((deal) => env.DB.prepare(
    `INSERT OR IGNORE INTO capital_flow_deals
      (deal_type, deal_date, symbol, security_name, client_name, side, quantity, price, value, source_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(deal.dealType, deal.dealDate, deal.symbol, deal.securityName, deal.clientName, deal.side, deal.quantity, deal.price, deal.value, deal.sourceUrl, fetchedAt));
  const result = await env.DB.batch(statements);
  return { fetched: allDeals.length, inserted: result.filter((item) => item.meta?.changes > 0).length };
}
