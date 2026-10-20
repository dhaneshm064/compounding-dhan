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
