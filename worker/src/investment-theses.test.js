import test from 'node:test';
import assert from 'node:assert/strict';

import { INVESTMENT_PHILOSOPHY, thesisCoverage, thesisFor } from './investment-theses.js';
import { runInvestmentCommittee } from './investment-committee.js';

test('provides versioned thesis cards only for investor-authored holdings', () => {
  assert.equal(thesisFor('SKYGOLD', '2026-09-01').title, 'Cash-flow inflection');
  assert.equal(thesisFor('ANTHEM', '2026-09-01').version, 1);
  assert.equal(thesisFor('KMEW', '2026-09-01').title, 'FY27 bridge to a contracted marine-infrastructure platform');
  assert.equal(thesisFor('CREDITACC', '2026-08-31').title, 'Credit-cost normalisation plus Project Shakti diversification');
  assert.equal(thesisFor('KRISHNADEF', '2026-09-01').title, 'Bulb-bar moat funding three defence optionalities');
  assert.equal(thesisFor('KRISHNADEF', '2026-08-11'), null);
  assert.equal(thesisFor('SKYGOLD', '2026-05-31'), null);
  assert.ok(INVESTMENT_PHILOSOPHY.principles.some((principle) => principle.includes('Doing nothing')));
});

test('marks holdings without an investor-authored thesis as missing rather than inventing one', () => {
  assert.deepEqual(thesisCoverage(['KMEW', 'UNAPPROVED'], '2026-09-01').map((item) => item.status), ['ready', 'missing']);
});

test('returns safe deterministic verdicts when AI is unavailable', async () => {
  const holding = (symbol) => ({
    symbol,
    position: { endWeightPct: 20 },
    performance: { returnPct: 2, alphaVsNifty50Pct: 1, alphaVsSectorPct: null },
    technical: { aboveDma50: true, aboveDma200: true, monthlyMaxDrawdownPct: -3, annualizedVolatility60Pct: 20 },
    fundamentals: { current: null }, governance: { aiReviews: [] }, developments: [],
  });
  const result = await runInvestmentCommittee({}, { month: '2026-09', portfolio: {}, holdings: [holding('KMEW'), holding('UNAPPROVED')], warnings: [] });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.verdicts[0].thesisStatus, 'insufficient-evidence');
  assert.equal(result.verdicts[1].thesisStatus, 'thesis-missing');
  assert.equal(result.verdicts[1].action, 'research-required');
});

test('keeps price-only thesis changes unchanged and replaces internal triggers', async () => {
  const holding = {
    symbol: 'SKYGOLD',
    position: { endWeightPct: 20, deliberateCapitalWeightPct: 5 },
    performance: { returnPct: -8, alphaVsNifty50Pct: -7, alphaVsSectorPct: null },
    technical: { aboveDma50: false, aboveDma200: true, monthlyMaxDrawdownPct: -11, annualizedVolatility60Pct: 35 },
    fundamentals: { current: { peRatio: 28, sector: 'Jewellery' }, currentAsOf: '2026-08-20', outsidePeriod: false, changes: {} },
    peerContext: { peers: [] }, governance: {
      aiReviews: [], highCount: 0, status: 'development', coverageNote: 'One exchange filing reviewed.',
      items: [{ kind: 'news', title: 'Reported governance development', source: 'Test news', url: 'https://example.test/news', occurred_at: '2026-08-18', governance_severity: null }],
    }, developments: [],
  };
  const env = { AI: { run: async (_model, request) => fakeCommitteeResponse(request) } };
  const result = await runInvestmentCommittee(env, { month: '2026-08', portfolio: {}, holdings: [holding], warnings: [] });
  assert.equal(result.status, 'complete');
  assert.equal(result.verdicts[0].thesisStatus, 'unchanged');
  assert.equal(result.verdicts[0].trigger, 'Operating cash flow and free cash flow');
  assert.notEqual(result.debates[0].valuation.assessment, 'insufficient-evidence');
  assert.equal(result.debates[0].governance.status, 'unverified-allegation');
});

function fakeCommitteeResponse(request) {
  const role = request.messages[0].content;
  const input = JSON.parse(request.messages[1].content);
  if (role.includes('REBUTTAL')) return { response: {
    summary: 'Price does not decide the thesis.', acceptedOpponentPoints: [], rebuttals: [{ claim: 'Price is context only.', evidenceRefs: ['performance-1'] }], revisedThesisStatus: 'unchanged',
  } };
  if (role.startsWith('ROLE: BULL') || role.startsWith('ROLE: BEAR')) return { response: {
    thesisStatus: role.startsWith('ROLE: BULL') ? 'strengthened' : 'weakened',
    summary: 'Current context is not evidence of a dated business change.',
    claims: [role.startsWith('ROLE: BULL')
      ? { claim: 'The share price changed.', evidenceRefs: ['performance-1'] }
      : { claim: 'The current snapshot includes debt.', evidenceRefs: ['fundamentals-4'] }],
    uncertainties: ['Business evidence is unchanged.'], proposedAction: 'continue-observing',
  } };
  if (role.startsWith('ROLE: VALUATION')) return { response: {
    assessment: 'reasonable', summary: 'The thesis valuation frame provides a dated reference.',
    evidenceRefs: [input.evidence.find((entry) => entry.kind === 'thesis-valuation').id],
    expectationsToJustifyValuation: ['Cash conversion'], uncertainties: ['Forward execution'], sizingImplication: 'caution',
  } };
  if (role.startsWith('ROLE: INDUSTRY')) return { response: {
    industryTrend: 'insufficient-evidence', peerPosition: 'insufficient-evidence', summary: 'No peer evidence.',
    evidenceRefs: ['fundamentals-4'], differentiators: [], industryRisks: [],
  } };
  if (role.startsWith('ROLE: GOVERNANCE')) return { response: {
    status: 'unverified-allegation', summary: 'The news report is not confirmed by a primary exchange disclosure.',
    evidenceRefs: [input.evidence.find((entry) => entry.kind === 'governance-event').id], findings: [], capitalAllocationConcerns: [], requiresHumanReview: false,
  } };
  if (role.startsWith('ROLE: INVESTMENT PHILOSOPHY') || role.startsWith('ROLE: PORTFOLIO RISK')) return { response: {
    summary: 'No process breach.', concerns: [], veto: false, vetoReason: '',
  } };
  if (role.startsWith('ROLE: INVESTMENT COMMITTEE CHAIR')) return { response: {
    summary: 'No business-thesis change was established.', riskLevel: 'moderate', verdicts: [{
      symbol: 'SKYGOLD', thesisStatus: 'strengthened', confidence: 0.7,
      winningArgument: 'The share price changed.', strongestDissent: 'No new business evidence.', action: 'continue-observing',
      trigger: 'monthlyAlphaBelowPct', thesisEvolution: 'refine', evolutionProposal: 'refine', evolutionRationale: 'Price moved.',
    }],
  } };
  throw new Error(`Unhandled role: ${role}`);
}
