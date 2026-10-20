// Parses NSE shareholding-pattern filings (XBRL). Shared by
// scripts/build-mf-ownership.mjs and its tests.
//
// Two layouts are in use:
//   2025-10 taxonomy: totals in `MutualFundsOrUTI_ContextI`, named holders as
//     `D_MutualFundsOrUTI_Context15` (name) + `MutualFundsOrUTI_Context15` (numbers),
//     percentages as fractions (0.0925).
//   2022-09 taxonomy: totals in `MutualFundsOrUtiI`, named holders as
//     `DetailsOfSharesHeldByMutualFundsOrUti001D` (name) + `...001I` (numbers),
//     percentages as percent (9.25).
// Category names are compared lower-cased, so the two spellings meet.

// Short key -> normalised category name.
export const GROUPS = {
  mf: 'mutualfundsoruti',
  insurance: 'insurancecompanies',
  aif: 'alternativeinvestmentfunds',
  pension: 'providentfundsorpensionfunds',
  banks: 'banks',
  dii: 'institutionsdomestic',
  fpi1: 'institutionsforeignportfolioinvestorcategoryone',
  fpi2: 'institutionsforeignportfolioinvestorcategorytwo',
  fii: 'institutionsforeign',
  promoter: 'shareholdingofpromoterandpromotergroup',
  retail: 'residentindividualshareholdersholdingnominalsharecapitaluptorstwolakh',
  public: 'publicshareholding',
};

const norm = (value) => value.toLowerCase().replace(/catergory/g, 'category');

/** Pulls totals per investor group and the named mutual-fund holders out of one filing. */
export function parseShareholding(xml) {
  const facts = new Map(); // context -> { element: value }
  for (const m of xml.matchAll(/<in-bse-shp:(\w+) contextRef="([^"]+)"[^>]*>([^<]*)</g)) {
    const entry = facts.get(m[2]) || {};
    entry[m[1]] = m[3].trim();
    facts.set(m[2], entry);
  }
  const num = (v) => (v == null || v === '' ? null : Number(v));

  // Category totals, keyed by normalised category name.
  const totals = new Map();
  const named = new Map(); // holder id -> { name, numbers }
  let symbol = null, period = null;
  for (const [context, f] of facts) {
    if (f.Symbol) symbol ||= f.Symbol;
    if (f.DateOfReport) period ||= f.DateOfReport;
    let m;
    if ((m = context.match(/^D_MutualFundsOrUTI_(Context\w+)$/i)) || (m = context.match(/^DetailsOfSharesHeldByMutualFundsOrUti(\d+)D$/i))) {
      (named.get(m[1]) || named.set(m[1], {}).get(m[1])).name = f.NameOfTheShareholder;
    } else if ((m = context.match(/^MutualFundsOrUTI_(Context(?!I$)\w+)$/i)) || (m = context.match(/^DetailsOfSharesHeldByMutualFundsOrUti(\d+)I$/i))) {
      (named.get(m[1]) || named.set(m[1], {}).get(m[1])).numbers = f;
    } else if ((m = context.match(/^(\w+)_ContextI$/)) || (!context.startsWith('Details') && !context.startsWith('D_') && (m = context.match(/^(\w+)I$/)))) {
      totals.set(norm(m[1]), f);
    }
  }
  // Percentages: fractions in the newer layout (the whole company is 1), percent in the older (100).
  const scale = num(totals.get('shareholdingpattern')?.ShareholdingAsAPercentageOfTotalNumberOfShares) > 1.5 ? 1 : 100;
  const pct = (v) => (num(v) == null ? null : Math.round(num(v) * scale * 100) / 100);

  const groups = {};
  for (const [key, category] of Object.entries(GROUPS)) {
    const f = totals.get(category);
    if (!f) continue;
    const value = [num(f.NumberOfShareholders), num(f.NumberOfShares), pct(f.ShareholdingAsAPercentageOfTotalNumberOfShares)];
    if (value[0] || value[1]) groups[key] = value;
  }
  // FPI category I and II are reported separately; the screen wants one figure.
  if (groups.fpi1 || groups.fpi2) {
    const a = groups.fpi1 || [0, 0, 0], b = groups.fpi2 || [0, 0, 0];
    groups.fpi = [a[0] + b[0], a[1] + b[1], Math.round((a[2] + b[2]) * 100) / 100];
  }
  delete groups.fpi1; delete groups.fpi2;

  const schemes = [...named.values()]
    .filter((h) => h.name)
    .map((h) => [h.name.replace(/\s+/g, ' '), num(h.numbers?.NumberOfShares), pct(h.numbers?.ShareholdingAsAPercentageOfTotalNumberOfShares)])
    .sort((a, b) => (b[1] || 0) - (a[1] || 0));
  const total = totals.get('shareholdingpattern') || {};
  return { symbol, period, holders: num(total.NumberOfShareholders), shares: num(total.NumberOfShares), groups, schemes };
}

// ---------- Scheme names ----------
// Filings spell the same scheme many ways: case, trustee wrappers ("NIPPON LIFE
// INDIA TRUSTEE LTD-A/C ..."), fund-house aliases, and names cut off at ~50
// characters. Some lines are a fund house's combined holding rather than a
// scheme ("SBI MUTUAL FUND (Under different sub accounts)").

// Fund houses, longest first so "KOTAK MAHINDRA" wins over "KOTAK".
const AMCS = [
  'ADITYA BIRLA SUN LIFE', 'BARODA BNP PARIBAS', 'FRANKLIN TEMPLETON', 'MAHINDRA MANULIFE', 'ICICI PRUDENTIAL', 'WHITEOAK CAPITAL',
  'PARAG PARIKH', 'CANARA ROBECO', 'MOTILAL OSWAL', 'BAJAJ FINSERV', 'KOTAK MAHINDRA', 'NIPPON INDIA', 'INVESCO INDIA', 'FRANKLIN INDIA',
  'JM FINANCIAL', 'BANK OF INDIA', 'MIRAE ASSET', 'PGIM INDIA', 'OLD BRIDGE', 'EDELWEISS', 'SUNDARAM', 'BANDHAN', 'QUANTUM', '360 ONE',
  'SHRIRAM', 'HELIOS', 'ZERODHA', 'KOTAK', 'GROWW', 'UNION', 'QUANT', 'HSBC', 'HDFC', 'AXIS', 'TATA', 'SBI', 'UTI', 'DSP', 'LIC', 'ITI', 'NAVI', 'SAMCO', 'TRUST',
];
const ALIASES = [
  [/\bNIPPON LIFE INDIA\b/g, 'NIPPON INDIA'], [/\bNIPPON(?! INDIA)\b/g, 'NIPPON INDIA'], [/\bICIC\b/g, 'ICICI'], [/\bICICI PRU\b(?!DENTIAL)/g, 'ICICI PRUDENTIAL'],
  [/\bABSL\b/g, 'ADITYA BIRLA SUN LIFE'], [/\bPPFAS\b/g, 'PARAG PARIKH'], [/\bMF\b/g, 'MUTUAL FUND'],
];
// One name per fund house for its combined line.
const HOUSE_NAMES = { 'KOTAK MAHINDRA': 'KOTAK', 'FRANKLIN INDIA': 'FRANKLIN TEMPLETON' };
const ACRONYMS = new Set(['SBI', 'HDFC', 'ICICI', 'UTI', 'DSP', 'LIC', 'ITI', 'JM', 'BNP', 'HSBC', 'PGIM', 'ELSS', 'ETF', 'PSU', 'MNC', 'ESG', 'BSE', 'NSE', 'FOF', 'II', 'III', 'IV', 'BFSI', 'CPSE', 'G-SEC', 'MF']);

const clean = (name) => {
  let s = String(name).toUpperCase().replace(/&AMP;/g, '&').replace(/\s+/g, ' ').trim();
  for (const [pattern, replacement] of ALIASES) s = s.replace(pattern, replacement);
  return s;
};
/** Strips trustee and account wrappers, leaving the scheme part (may be empty). */
const schemePart = (upper) => upper
  .replace(/^.*\bA\s*\/?\s*C\b\.?\s*[-–:]?\s*/, '') // "... A/C", "... AC-"
  .replace(/^.*\bTRUSTEE(?:SHIP)?\s+(?:CO(?:MPANY)?\.?\s+)?(?:PVT\.?\s+|PRIVATE\s+)?(?:LTD|LIMITED)\.?\s*[-–:]?\s*/, '')
  .replace(/^.*?\bMUTUAL FUND\s*[-–:]\s*/, '')
  .replace(/\(?\s*(?:UNDER\s+)?(?:DIFFERENT|MULTIPLE|WITH)\s+(?:SUB\s+)?ACCOUNTS?\s*\)?/g, '')
  .replace(/^[-–:\s]+|[-–:\s]+$/g, '');
const amcOf = (upper) => AMCS.find((amc) => upper.startsWith(amc) || upper.includes(` ${amc} `) || upper.includes(`${amc} `)) || null;
const titleCase = (upper) => upper.split(' ').map((w) => (ACRONYMS.has(w) || /\d/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');

/**
 * Standard identity for a named mutual-fund holder.
 * key:   compare across filings (same scheme, any spelling)
 * label: display name ("Nippon India Small Cap Fund", "HDFC (combined)")
 * combined: true when the line is a fund house's total, or the scheme part was cut off
 * amc:   the fund house, when recognised
 */
export function standardScheme(name) {
  const upper = clean(name);
  const part = schemePart(upper);
  const amc = amcOf(upper);
  // Nothing beyond the fund house's own name left: a fund-house line.
  const core = part.replace(/\b(MUTUAL FUND|MUTUAL|FUND|TRUSTEE|LTD|LIMITED|CO|COMPANY|PRIVATE|PVT|ASSET MANAGEMENT|AMC)\b/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  // ("SBI MUTUAL FUND (under different sub accounts)" is a fund-house line;
  // "ICICI PRUDENTIAL LARGE CAP FUND WITH SUB ACCOUNTS" is still one scheme.)
  const house = amc ? HOUSE_NAMES[amc] || amc : null;
  if (!core || (amc && core === amc)) {
    const name = house || core || upper;
    return { key: `AMC:${name}`, label: `${titleCase(name)} (combined)`, combined: true, amc: house };
  }
  // "ADITYA BIRLA SUN LIFE MUTUAL FUND - ADITYA BIRLA S": cut off inside the fund house's name.
  if (amc && amc.startsWith(core)) {
    return { key: `CUT:${house}`, label: `${titleCase(house)} (name cut off)`, combined: true, amc: house };
  }
  const key = part.replace(/[^A-Z0-9 ]/g, ' ').replace(/\b(THE|FUND|SCHEME|MUTUAL)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return { key, label: titleCase(part), combined: false, amc: house };
}

/** Same scheme? Equal keys, or one is a cut-off prefix of the other ("NIPPON INDIA SMA"). */
export function sameScheme(a, b) {
  if (a === b) return true;
  if (a.includes(':') || b.includes(':')) return false; // fund-house lines only match exactly
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 12 && long.startsWith(short);
}
