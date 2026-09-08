import thesisData from './investment-theses.json' with { type: 'json' };

export const INVESTMENT_PHILOSOPHY = thesisData.philosophy;
const THESES = thesisData.theses;

export function thesisFor(symbol, asOf) {
  const versions = THESES[String(symbol || '').toUpperCase()] || [];
  const thesis = versions
    .filter((candidate) => !asOf || (candidate.effectiveFrom <= asOf && (!candidate.effectiveTo || candidate.effectiveTo >= asOf)))
    .sort((a, b) => b.version - a.version)[0];
  if (!thesis) return null;
  return structuredClone(thesis);
}

export function thesisCoverage(symbols, asOf) {
  return symbols.map((symbol) => ({ symbol, thesis: thesisFor(symbol, asOf), status: thesisFor(symbol, asOf) ? 'ready' : 'missing' }));
}
