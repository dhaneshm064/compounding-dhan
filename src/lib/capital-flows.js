// Shared by the Capital Flows pages and scripts/build-whale-summary.mjs (plain
// JS so the Node build script can import it without a TypeScript step).

/**
 * Exchanges spell the same client several ways ("PVT. LTD." vs "PRIVATE
 * LIMITED", stray dots, double spaces). Deliberately conservative: only
 * punctuation, whitespace and the two common legal suffixes are folded, so
 * genuinely different names are never merged.
 */
export function clientKey(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bPVT\b/g, 'PRIVATE')
    .replace(/\bLTD\b/g, 'LIMITED');
}

export const CLIENT_TYPES = {
  prop: 'Prop / HFT',
  'mutual-fund': 'Mutual fund',
  insurance: 'Insurer',
  fund: 'Fund / FPI',
  corporate: 'Company',
  individual: 'Individual / HUF',
};

const MUTUAL_FUND = /\bM[AU]TUAL FUND\b|\bASSET MANAGEMENT\b/;
const INSURANCE = /\bINSURANCE\b|\bASSURANCE\b/;
const FUND = /\bFUNDS?\b|\bTRUST\b|\bPTE\b|\bLLC\b|\bL ?P\b|\bPLC\b|\bINC\b|\bSICAV\b|\bVCC\b|\bPCC\b|\bODI\b|\bGMBH\b|\bS ?A\b|\bS ?E\b|\bA ?G\b|\bN ?V\b|\bB ?V\b|MAURITIUS|SINGAPORE|CAYMAN|\bBANK\b|GOVERNMENT OF|MONETARY AUTHORITY|INVESTMENT AUTHORITY|\bNORGES\b/;
// Global banks and asset managers often file without a legal suffix.
const GLOBAL_INSTITUTION = /\bETF\b|\bISHARES\b|\bVANGUARD\b|\bBLACKROCK\b|\bFIDELITY\b|SOCIETE GENERALE|\bPARIBAS\b|MORGAN STANLEY|GOLDMAN SACHS|\bCITIGROUP\b|\bJ ?P ?MORGAN\b|\bMERRILL\b|\bUBS\b|\bBOFA\b|\bNOMURA\b|CREDIT SUISSE|\bBARCLAYS\b|\bHSBC\b|\bDEUTSCHE\b|\bMACQUARIE\b|\bABU DHABI\b|\bQATAR\b|\bKUWAIT\b|\bCIT\b|\bICAV\b|\bPARTNERS\b|\bUNIVERSITY\b|\bENDOWMENT\b|\bFOUNDATION\b|\bPENSION\b|\bSMALLCAP WORLD\b|\bNEW WORLD FUND\b/;
const CORPORATE = /\bLIMITED\b|\bLLP\b|\bPRIVATE\b|\bCORPORATION\b|\bCOMPANY\b|\bENTERPRISES?\b|\bINDUSTRIES\b|\bTRADERS?\b|\bTRADING\b|\bVENTURES\b|\bCAPITAL\b|\bSECURITIES\b|\bHOLDINGS?\b|\bINVESTMENTS?\b|\bCOMMODITIES\b|\bFINANCE\b|\bFINVEST\b|\bBROKING\b|\bBROKERS?\b|\bSTOCKS\b|\bSERVICES\b|\bADVISORS\b|\bADVISORY\b|\bCONSULTANCY\b|\bGLOBAL\b|\bRESEARCH\b/;

/** Type from the name alone. Prop/HFT is behavioural and comes from the nightly build. */
export function nameType(name) {
  const key = clientKey(name);
  if (MUTUAL_FUND.test(key)) return 'mutual-fund';
  if (INSURANCE.test(key)) return 'insurance';
  if (/\bHUF\b/.test(key)) return 'individual';
  if (FUND.test(key) || GLOBAL_INSTITUTION.test(key)) return 'fund';
  if (CORPORATE.test(key)) return 'corporate';
  return 'individual';
}

export function clientType(name, propKeys) {
  return propKeys?.has(clientKey(name)) ? 'prop' : nameType(name);
}

/**
 * FIFO-matches disclosed buys to later sells per stock. Exact duplicates across
 * bulk and block feeds (one execution reported twice) are collapsed first.
 */
export function matchTrades(trades) {
  const economic = new Map();
  for (const t of trades) {
    const key = `${t.exchange}|${t.date}|${t.symbol}|${clientKey(t.clientName)}|${t.side}|${t.quantity}|${t.price}`;
    if (!economic.has(key)) economic.set(key, t);
  }
  const ordered = [...economic.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
    || String(a.symbol).localeCompare(String(b.symbol))
    || (a.side === b.side ? 0 : a.side === 'BUY' ? -1 : 1));
  const queues = new Map();
  const outcomes = [];
  for (const t of ordered) {
    const queue = queues.get(t.symbol) || [];
    let quantity = Number(t.quantity) || 0;
    if (t.side === 'BUY') {
      if (quantity > 0) queue.push({ quantity, price: Number(t.price), date: t.date, exchange: t.exchange });
    } else if (t.side === 'SELL') {
      while (quantity > 0 && queue.length) {
        const lot = queue[0];
        const matched = Math.min(quantity, lot.quantity);
        const holdingDays = Math.max(0, Math.round((Date.parse(t.date) - Date.parse(lot.date)) / 86400000));
        outcomes.push({
          symbol: t.symbol, buyDate: lot.date, buyPrice: lot.price, buyExchange: lot.exchange,
          sellDate: t.date, sellPrice: Number(t.price), sellExchange: t.exchange,
          quantity: matched, holdingDays, returnPct: (Number(t.price) / lot.price - 1) * 100, intraday: holdingDays === 0,
        });
        lot.quantity -= matched;
        quantity -= matched;
        if (lot.quantity <= 0) queue.shift();
      }
    }
    queues.set(t.symbol, queue);
  }
  return outcomes;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
}

/** Hit rate, median return and median hold for a set of matched outcomes. */
export function outcomeStats(outcomes) {
  return {
    matched: outcomes.length,
    hitRatePct: outcomes.length ? Number((outcomes.filter((o) => o.returnPct > 0).length / outcomes.length * 100).toFixed(1)) : null,
    medianReturnPct: median(outcomes.map((o) => o.returnPct)),
    medianHoldingDays: median(outcomes.filter((o) => o.holdingDays > 0).map((o) => o.holdingDays)),
  };
}

// ---------- Static data layout (public/data/flows, built nightly) ----------

export const CLIENT_BUCKETS = 1024;

/** FNV-1a: stable across Node and browsers, spreads ~28k clients over 1,024 files. */
export function clientBucket(name) {
  const key = clientKey(name);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash % CLIENT_BUCKETS).padStart(4, '0');
}

/** File-safe symbol (symbols can contain &, spaces or dots). */
export function stockFile(symbol) {
  return String(symbol).toUpperCase().replace(/[^A-Z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
}

/** Packs deal type, exchange and side into three letters: "uNB" = bulk, NSE, BUY. */
export function dealCode(type, exchange, side) {
  return `${type === 'block' ? 'l' : 'u'}${exchange === 'BSE' ? 'B' : 'N'}${side === 'SELL' ? 'S' : 'B'}`;
}
export function decodeDeal(code) {
  return { type: code[0] === 'l' ? 'block' : 'bulk', exchange: code[1] === 'B' ? 'BSE' : 'NSE', side: code[2] === 'S' ? 'SELL' : 'BUY' };
}
