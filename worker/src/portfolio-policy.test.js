import test from 'node:test';
import assert from 'node:assert/strict';

import { approvedPeersFor, evaluatePortfolioPolicy, evaluatePositionPolicy, tierForCapitalWeight } from './portfolio-policy.js';

function holding(overrides = {}) {
  return {
    symbol: 'TEST', position: { deliberateCapitalWeightPct: 3, endWeightPct: 10 },
    performance: { alphaVsNifty50Pct: -6 }, technical: { monthlyMaxDrawdownPct: -4 },
    fundamentals: { current: { sector: 'Example' } }, governance: { highCount: 0 }, ...overrides,
  };
}

test('maps deliberate capital allocation to position tiers', () => {
  assert.equal(tierForCapitalWeight(2), 'Starter');
  assert.equal(tierForCapitalWeight(4), 'Standard');
  assert.equal(tierForCapitalWeight(7), 'High-conviction');
});

test('underperformance triggers review but does not automatically demote', () => {
  const result = evaluatePositionPolicy({
    holding: holding(), thesis: { version: 1 },
    verdict: { thesisStatus: 'unchanged', confidence: 0.8 },
    valuation: { assessment: 'reasonable' }, evidenceKinds: ['fundamentals'],
  });
  assert.equal(result.status, 'hold-tier');
  assert.equal(result.eligibleTier, 'Starter');
  assert.ok(result.reviewFlags.includes('monthly-underperformance-review'));
});

test('promotes a starter only after thesis, business, valuation and governance gates pass', () => {
  const result = evaluatePositionPolicy({
    holding: holding({ performance: { alphaVsNifty50Pct: 1 } }), thesis: { version: 1 },
    verdict: { thesisStatus: 'strengthened', confidence: 0.7 },
    valuation: { assessment: 'reasonable' }, evidenceKinds: ['filing'],
  });
  assert.equal(result.status, 'promotion-candidate');
  assert.equal(result.eligibleTier, 'Standard');
  assert.equal(result.humanApprovalRequired, true);
});

test('uses approved peer sets and flags holistic concentration', () => {
  assert.deepEqual(approvedPeersFor('ANTHEM').map((peer) => peer.symbol), ['SYNGENE', 'SAILIFE', 'COHANCE', 'DIVISLAB']);
  const portfolio = evaluatePortfolioPolicy([
    holding({ symbol: 'A', position: { endWeightPct: 30 }, fundamentals: { current: { sector: 'CDMO' } } }),
    holding({ symbol: 'B', position: { endWeightPct: 10 }, fundamentals: { current: { sector: 'CDMO' } } }),
  ], new Map([['A', {}]]));
  assert.equal(portfolio.thesisCoveragePct, 50);
  assert.ok(portfolio.flags.some((flag) => flag.type === 'position-concentration'));
  assert.ok(portfolio.flags.some((flag) => flag.type === 'sector-concentration'));
});

