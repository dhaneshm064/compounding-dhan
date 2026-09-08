import test from 'node:test';
import assert from 'node:assert/strict';

import { INVESTMENT_PHILOSOPHY, thesisCoverage, thesisFor } from './investment-theses.js';
import { runInvestmentCommittee } from './investment-committee.js';

test('provides versioned thesis cards only for approved holdings', () => {
  assert.equal(thesisFor('SKYGOLD', '2026-09-01').title, 'Cash-flow inflection');
  assert.equal(thesisFor('ANTHEM', '2026-09-01').version, 1);
  assert.equal(thesisFor('KMEW', '2026-09-01'), null);
  assert.equal(thesisFor('SKYGOLD', '2026-05-31'), null);
  assert.ok(INVESTMENT_PHILOSOPHY.principles.some((principle) => principle.includes('Doing nothing')));
});

test('marks unapproved holdings as missing rather than inventing a thesis', () => {
  assert.deepEqual(thesisCoverage(['SKYGOLD', 'KMEW'], '2026-09-01').map((item) => item.status), ['ready', 'missing']);
});

test('returns safe deterministic verdicts when AI is unavailable', async () => {
  const holding = (symbol) => ({
    symbol,
    position: { endWeightPct: 20 },
    performance: { returnPct: 2, alphaVsNifty50Pct: 1, alphaVsSectorPct: null },
    technical: { aboveDma50: true, aboveDma200: true, monthlyMaxDrawdownPct: -3, annualizedVolatility60Pct: 20 },
    fundamentals: { current: null }, governance: { aiReviews: [] }, developments: [],
  });
  const result = await runInvestmentCommittee({}, { month: '2026-09', portfolio: {}, holdings: [holding('SKYGOLD'), holding('KMEW')], warnings: [] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.verdicts[0].thesisStatus, 'insufficient-evidence');
  assert.equal(result.verdicts[1].thesisStatus, 'thesis-missing');
  assert.equal(result.verdicts[1].action, 'research-required');
});

