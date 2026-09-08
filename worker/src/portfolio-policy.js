import policy from './portfolio-policy.json' with { type: 'json' };

export const PORTFOLIO_POLICY = policy;

export function tierForCapitalWeight(capitalWeightPct) {
  if (capitalWeightPct == null) return null;
  if (capitalWeightPct >= policy.positionTiers['High-conviction'].minCapitalPct) return 'High-conviction';
  if (capitalWeightPct >= policy.positionTiers.Standard.minCapitalPct) return 'Standard';
  return 'Starter';
}

export function evaluatePositionPolicy({ holding, thesis, verdict, valuation, evidenceKinds = [] }) {
  const currentTier = holding.position.deliberateCapitalWeightPct == null ? null : tierForCapitalWeight(holding.position.deliberateCapitalWeightPct);
  const reasons = [];
  const reviewFlags = [];
  if (!thesis) return { currentTier, eligibleTier: 'Starter', status: 'not-eligible', reasons: ['An approved thesis is required before promotion.'], reviewFlags: ['thesis-missing'], humanApprovalRequired: true };

  if (holding.position.endWeightPct >= policy.portfolioLimits.marketWeightReviewPct) reviewFlags.push('market-weight-concentration');
  if (holding.performance.alphaVsNifty50Pct <= policy.reviewTriggers.monthlyAlphaBelowPct) reviewFlags.push('monthly-underperformance-review');
  if (holding.technical.monthlyMaxDrawdownPct <= policy.reviewTriggers.monthlyDrawdownBelowPct) reviewFlags.push('drawdown-review');
  if (holding.governance.highCount > 0) reviewFlags.push('high-governance-review');

  let eligibleTier = currentTier || 'Starter';
  let status = 'hold-tier';
  if (verdict.thesisStatus === 'broken') {
    eligibleTier = 'Starter'; status = 'exit-review'; reasons.push('The committee classified the approved thesis as broken.');
  } else if (verdict.thesisStatus === 'weakened') {
    eligibleTier = 'Starter'; status = 'demotion-review'; reasons.push('The thesis weakened; price underperformance alone was not used.');
  } else if (verdict.thesisStatus === 'strengthened') {
    const hasBusinessEvidence = evidenceKinds.some((kind) => ['filing', 'fundamentals', 'development'].includes(kind));
    const valuationAllowsPromotion = !['extreme', 'insufficient-evidence'].includes(valuation?.assessment);
    const governanceAllowsPromotion = holding.governance.highCount === 0;
    if (hasBusinessEvidence && valuationAllowsPromotion && governanceAllowsPromotion && verdict.confidence >= 0.65) {
      if (currentTier === 'Starter') eligibleTier = 'Standard';
      else if (currentTier === 'Standard' && verdict.confidence >= 0.75 && ['undemanding', 'reasonable'].includes(valuation?.assessment)) eligibleTier = 'High-conviction';
      status = eligibleTier !== currentTier ? 'promotion-candidate' : 'hold-tier';
      reasons.push('Thesis strengthening is supported by business evidence and passed valuation and governance gates.');
    } else {
      reasons.push('Thesis strengthened, but promotion gates are not all satisfied.');
      if (!hasBusinessEvidence) reasons.push('No qualifying business evidence was available.');
      if (!valuationAllowsPromotion) reasons.push('Valuation does not support promotion.');
      if (!governanceAllowsPromotion) reasons.push('A high-priority governance review blocks promotion.');
    }
  } else {
    reasons.push('The thesis has not weakened, but there is insufficient new confirmation for promotion.');
  }
  if (reviewFlags.includes('monthly-underperformance-review')) reasons.push('Monthly underperformance triggers investigation only; it does not automatically reduce the position.');
  return { currentTier, eligibleTier, status, reasons, reviewFlags, humanApprovalRequired: true };
}

export function approvedPeersFor(symbol) {
  return structuredClone(policy.approvedPeers[symbol] || []);
}

export function evaluatePortfolioPolicy(holdings, thesisBySymbol) {
  const sectorWeights = new Map();
  for (const holding of holdings) {
    const sector = holding.fundamentals.current?.sector || 'Unknown';
    sectorWeights.set(sector, (sectorWeights.get(sector) || 0) + Number(holding.position.endWeightPct || 0));
  }
  const flags = [];
  for (const holding of holdings) {
    if (holding.position.endWeightPct >= policy.portfolioLimits.marketWeightReviewPct) flags.push({ type: 'position-concentration', symbol: holding.symbol, valuePct: holding.position.endWeightPct, thresholdPct: policy.portfolioLimits.marketWeightReviewPct });
  }
  for (const [sector, valuePct] of sectorWeights) {
    if (sector !== 'Unknown' && valuePct >= policy.portfolioLimits.sectorWeightReviewPct) flags.push({ type: 'sector-concentration', sector, valuePct: Math.round(valuePct * 100) / 100, thresholdPct: policy.portfolioLimits.sectorWeightReviewPct });
  }
  const thesisCovered = holdings.filter((holding) => thesisBySymbol.get(holding.symbol)).length;
  return {
    targetHoldingCount: policy.experiment.targetHoldingCount,
    currentHoldingCount: holdings.length,
    thesisCoveredCount: thesisCovered,
    thesisCoveragePct: holdings.length ? Math.round((thesisCovered / holdings.length) * 10000) / 100 : null,
    sectorWeights: [...sectorWeights].map(([sector, weightPct]) => ({ sector, weightPct: Math.round(weightPct * 100) / 100 })),
    flags,
    note: 'Limits are review triggers for the learning experiment, not automatic trade instructions.',
  };
}
