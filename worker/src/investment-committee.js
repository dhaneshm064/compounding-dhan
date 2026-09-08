import { INVESTMENT_PHILOSOPHY, thesisFor } from './investment-theses.js';
import { evaluatePortfolioPolicy, evaluatePositionPolicy, PORTFOLIO_POLICY } from './portfolio-policy.js';

export const COMMITTEE_PROMPT_VERSION = 'investment-committee-v6.2-governance-content-required';
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

const ARGUMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    thesisStatus: { type: 'string', enum: ['strengthened', 'unchanged', 'weakened', 'broken', 'insufficient-evidence'] },
    summary: { type: 'string' },
    claims: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, properties: {
      claim: { type: 'string' }, evidenceRefs: { type: 'array', maxItems: 4, items: { type: 'string' } },
    }, required: ['claim', 'evidenceRefs'] } },
    uncertainties: { type: 'array', maxItems: 4, items: { type: 'string' } },
    proposedAction: { type: 'string', enum: ['no-action', 'continue-observing', 'research-required', 'review-position-size', 'add-candidate', 'reduce-or-exit-candidate'] },
  }, required: ['thesisStatus', 'summary', 'claims', 'uncertainties', 'proposedAction'],
};

const REBUTTAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    acceptedOpponentPoints: { type: 'array', maxItems: 3, items: { type: 'string' } },
    rebuttals: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, properties: {
      claim: { type: 'string' }, evidenceRefs: { type: 'array', maxItems: 4, items: { type: 'string' } },
    }, required: ['claim', 'evidenceRefs'] } },
    revisedThesisStatus: { type: 'string', enum: ['strengthened', 'unchanged', 'weakened', 'broken', 'insufficient-evidence'] },
  }, required: ['summary', 'acceptedOpponentPoints', 'rebuttals', 'revisedThesisStatus'],
};

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    concerns: { type: 'array', maxItems: 5, items: { type: 'string' } },
    veto: { type: 'boolean' }, vetoReason: { type: 'string' },
  }, required: ['summary', 'concerns', 'veto', 'vetoReason'],
};

const VALUATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    assessment: { type: 'string', enum: ['undemanding', 'reasonable', 'demanding', 'extreme', 'insufficient-evidence'] },
    summary: { type: 'string' },
    evidenceRefs: { type: 'array', maxItems: 5, items: { type: 'string' } },
    expectationsToJustifyValuation: { type: 'array', maxItems: 4, items: { type: 'string' } },
    uncertainties: { type: 'array', maxItems: 4, items: { type: 'string' } },
    sizingImplication: { type: 'string', enum: ['none', 'caution', 'requires-human-review'] },
  }, required: ['assessment', 'summary', 'evidenceRefs', 'expectationsToJustifyValuation', 'uncertainties', 'sizingImplication'],
};

const INDUSTRY_PEER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    industryTrend: { type: 'string', enum: ['supportive', 'mixed', 'adverse', 'insufficient-evidence'] },
    peerPosition: { type: 'string', enum: ['leading', 'in-line', 'lagging', 'not-comparable', 'insufficient-evidence'] },
    summary: { type: 'string' }, evidenceRefs: { type: 'array', maxItems: 6, items: { type: 'string' } },
    differentiators: { type: 'array', maxItems: 4, items: { type: 'string' } },
    industryRisks: { type: 'array', maxItems: 4, items: { type: 'string' } },
  }, required: ['industryTrend', 'peerPosition', 'summary', 'evidenceRefs', 'differentiators', 'industryRisks'],
};

const GOVERNANCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['no-material-change', 'confirmed-disclosure', 'review-required', 'unverified-allegation', 'insufficient-coverage'] },
    summary: { type: 'string' },
    evidenceRefs: { type: 'array', maxItems: 6, items: { type: 'string' } },
    findings: { type: 'array', maxItems: 4, items: { type: 'string' } },
    capitalAllocationConcerns: { type: 'array', maxItems: 4, items: { type: 'string' } },
    requiresHumanReview: { type: 'boolean' },
  }, required: ['status', 'summary', 'evidenceRefs', 'findings', 'capitalAllocationConcerns', 'requiresHumanReview'],
};

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' }, riskLevel: { type: 'string', enum: ['low', 'moderate', 'elevated', 'high'] },
    verdicts: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: {
      symbol: { type: 'string' }, thesisStatus: { type: 'string', enum: ['strengthened', 'unchanged', 'weakened', 'broken', 'insufficient-evidence', 'thesis-missing'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 }, winningArgument: { type: 'string' }, strongestDissent: { type: 'string' },
      action: { type: 'string', enum: ['no-action', 'continue-observing', 'research-required', 'review-position-size', 'add-candidate', 'reduce-or-exit-candidate'] },
      trigger: { type: 'string' }, thesisEvolution: { type: 'string', enum: ['none', 'refine', 'replace', 'retire'] },
      evolutionProposal: { type: 'string' }, evolutionRationale: { type: 'string' },
    }, required: ['symbol', 'thesisStatus', 'confidence', 'winningArgument', 'strongestDissent', 'action', 'trigger', 'thesisEvolution', 'evolutionProposal', 'evolutionRationale'] } },
  }, required: ['summary', 'riskLevel', 'verdicts'],
};

export async function runInvestmentCommittee(env, { month, portfolio, holdings, warnings }) {
  const prepared = holdings.map((holding) => prepareHolding(holding, month));
  const debated = prepared.filter((item) => item.thesis);
  const missing = prepared.filter((item) => !item.thesis).map((item) => item.symbol);
  const holisticPolicyReview = evaluatePortfolioPolicy(holdings, new Map(prepared.map((item) => [item.symbol, item.thesis])));
  if (!env.AI || !debated.length) return unavailableResult(prepared, !env.AI ? 'AI binding unavailable' : 'No holdings have an active thesis');

  try {
    const debateRuns = await Promise.all(debated.map(async (item) => {
      try {
        const input = JSON.stringify({ philosophy: INVESTMENT_PHILOSOPHY, thesis: item.thesis, evidence: item.evidence });
        const governanceEvidence = item.evidence.filter((entry) => entry.kind === 'filing' || (entry.kind === 'governance-event' && entry.fact?.classification === 'news-report'));
        const governanceInput = JSON.stringify({
          evidence: governanceEvidence,
          coverage: item.evidenceScout,
          instruction: 'Assess only the content present in these evidence objects. A title or URL does not establish the substance of a governance event.',
        });
        const [bull, bear, valuation, industryPeers, governance] = await Promise.all([
          run(env, `${item.symbol} bull advocate`, advocatePrompt('BULL'), input, ARGUMENT_SCHEMA, 1700),
          run(env, `${item.symbol} bear advocate`, advocatePrompt('BEAR'), input, ARGUMENT_SCHEMA, 1700),
          run(env, `${item.symbol} valuation specialist`, valuationPrompt(), input, VALUATION_SCHEMA, 1300),
          run(env, `${item.symbol} industry and peer analyst`, industryPeerPrompt(), input, INDUSTRY_PEER_SCHEMA, 1300),
          governanceEvidence.length
            ? run(env, `${item.symbol} governance and capital allocation analyst`, governancePrompt(), governanceInput, GOVERNANCE_SCHEMA, 1100)
            : Promise.resolve({ status: 'insufficient-coverage', summary: 'No substantive governance filing or reviewed filing evidence was available for this month; this is not a clean governance conclusion.', evidenceRefs: [], findings: [], capitalAllocationConcerns: [], requiresHumanReview: false }),
        ]);
        const checkedBull = validateRefs(bull, item.evidence);
        const checkedBear = validateRefs(bear, item.evidence);
        const checkedValuation = validateValuationRefs(valuation, item.evidence);
        const checkedIndustryPeers = validateIndustryPeerRefs(industryPeers, item.evidence);
        const checkedGovernance = validateGovernanceRefs(governance, item.evidence);
        const [bullRebuttal, bearRebuttal] = await Promise.all([
          run(env, `${item.symbol} bull rebuttal`, rebuttalPrompt('BULL'), JSON.stringify({ evidence: item.evidence, valuation: checkedValuation, industryPeers: checkedIndustryPeers, own: checkedBull, opponent: checkedBear }), REBUTTAL_SCHEMA, 1200),
          run(env, `${item.symbol} bear rebuttal`, rebuttalPrompt('BEAR'), JSON.stringify({ evidence: item.evidence, valuation: checkedValuation, industryPeers: checkedIndustryPeers, own: checkedBear, opponent: checkedBull }), REBUTTAL_SCHEMA, 1200),
        ]);
        return { symbol: item.symbol, thesis: item.thesis, evidenceScout: item.evidenceScout, valuation: checkedValuation, industryPeers: checkedIndustryPeers, governance: checkedGovernance, bull: checkedBull, bear: checkedBear, bullRebuttal: validateRefs(bullRebuttal, item.evidence), bearRebuttal: validateRefs(bearRebuttal, item.evidence) };
      } catch (error) {
        return { symbol: item.symbol, error: clean(error, 300) };
      }
    }));
    const firstRounds = debateRuns.filter((result) => !result.error);
    const debateErrors = debateRuns.filter((result) => result.error);

    const committeeInput = JSON.stringify(compactOversightInput({ month, holisticPolicyReview, prepared, debates: firstRounds, warnings, missing }));
    const [philosophyReview, riskReview] = await Promise.all([
      safeOversightRun(env, 'philosophy steward', philosophyPrompt(), committeeInput),
      safeOversightRun(env, 'portfolio risk officer', riskPrompt(), committeeInput),
    ]);
    const judgeInput = JSON.stringify({ month, philosophy: INVESTMENT_PHILOSOPHY, portfolio, portfolioPolicy: PORTFOLIO_POLICY, holisticPolicyReview, evidenceBundles: prepared, debates: firstRounds, philosophyReview, riskReview, missingTheses: missing, warnings });
    let judged;
    let chairError = null;
    try {
      judged = await run(env, 'investment committee chair', judgePrompt(), judgeInput, VERDICT_SCHEMA, 2600);
      const initialIssues = chairVerdictProblems(judged, debated.map((item) => item.symbol), missing);
      if (initialIssues.length) {
        judged = await run(
          env,
          'investment committee chair correction',
          `${judgePrompt()}\nCORRECTION REQUIRED: ${initialIssues.join('; ')}. Return exactly one verdict for each of these symbols, in this order: ${prepared.map((item) => item.symbol).join(', ')}. Do not add, omit or duplicate symbols.`,
          judgeInput,
          VERDICT_SCHEMA,
          2600,
        );
      }
    } catch (error) {
      chairError = clean(error, 300);
      judged = { summary: 'The specialist debates completed, but the committee chair output was unavailable. No final thesis conclusion was inferred.', riskLevel: 'elevated', verdicts: [] };
    }
    const verdictMap = new Map((judged.verdicts || []).map((item) => {
      const verdict = cleanVerdict(item);
      return [verdict.symbol, verdict];
    }));
    const expectedSymbols = new Set(debated.map((item) => item.symbol));
    const chairVerdictIssues = chairVerdictProblems(judged, [...expectedSymbols], missing);
    for (const symbol of missing) verdictMap.set(symbol, missingVerdict(symbol));
    for (const failure of debateErrors) verdictMap.set(failure.symbol, failedDebateVerdict(failure.symbol, failure.error));
    const debateMap = new Map(firstRounds.map((debate) => [debate.symbol, debate]));
    const holdingMap = new Map(holdings.map((holding) => [holding.symbol, holding]));
    const chairMissingSymbols = debated.map((item) => item.symbol).filter((symbol) => !verdictMap.has(symbol) && !debateErrors.some((failure) => failure.symbol === symbol));
    const verdicts = prepared.map((item) => {
      const verdict = enforceVerdictRules(verdictMap.get(item.symbol) || fallbackVerdict(item.symbol), item, debateMap.get(item.symbol));
      const debate = debateMap.get(item.symbol);
      return {
        ...verdict,
        thesis: item.thesis ? { title: item.thesis.title, tldr: item.thesis.tldr, version: item.thesis.version } : null,
        sizing: evaluatePositionPolicy({ holding: holdingMap.get(item.symbol), thesis: item.thesis, verdict, valuation: debate?.valuation, evidenceKinds: item.evidence.map((entry) => entry.kind) }),
      };
    });
    const errors = [...debateErrors.map((failure) => `${failure.symbol}: ${failure.error}`), philosophyReview.error, riskReview.error, chairError, ...chairMissingSymbols.map((symbol) => `${symbol}: chair omitted the required verdict`), ...chairVerdictIssues].filter(Boolean);
    return {
      status: errors.length ? 'partial' : 'complete', summary: clean(judged.summary, 520), riskLevel: portfolioRiskLevel(holisticPolicyReview),
      philosophy: INVESTMENT_PHILOSOPHY, promptVersion: COMMITTEE_PROMPT_VERSION, model: MODEL,
      debates: firstRounds, philosophyReview, riskReview,
      verdicts, portfolioPolicy: PORTFOLIO_POLICY, holisticPolicyReview,
      missingTheses: missing,
      researchQuality: researchQuality({ prepared, missing, firstRounds, errors, warnings }),
      errors,
      storage: 'The structured debate, reviews and final verdict are persisted inside the versioned monthly report.',
    };
  } catch (error) {
    return { ...unavailableResult(prepared, clean(error, 300)), status: 'failed' };
  }
}

function prepareHolding(holding, month) {
  const evidence = [];
  const add = (kind, fact) => { if (fact != null && fact !== '') evidence.push({ id: `${kind}-${evidence.length + 1}`, kind, fact }); };
  add('performance', { returnPct: holding.performance.returnPct, alphaVsNifty50Pct: holding.performance.alphaVsNifty50Pct, alphaVsSectorPct: holding.performance.alphaVsSectorPct });
  add('position', { weightPct: holding.position.endWeightPct });
  add('technical', { aboveDma50: holding.technical.aboveDma50, aboveDma200: holding.technical.aboveDma200, drawdownPct: holding.technical.monthlyMaxDrawdownPct, volatilityPct: holding.technical.annualizedVolatility60Pct });
  if (holding.fundamentals.current) add('fundamentals', { asOf: holding.fundamentals.currentAsOf, outsideReportPeriod: holding.fundamentals.outsidePeriod, metrics: holding.fundamentals.current, changes: holding.fundamentals.changes });
  if (holding.peerContext?.peers?.length) add('peer-context', holding.peerContext);
  for (const review of holding.governance.aiReviews || []) add('filing', { occurredAt: review.occurred_at, severity: review.severity, summary: review.summary, takeaways: review.keyTakeaways, evidence: review.evidence });
  for (const event of holding.governance.items || []) add('governance-event', { occurredAt: event.occurred_at, title: event.title, source: event.source, url: event.url, severity: event.governance_severity, classification: event.kind === 'filing' ? 'confirmed-disclosure' : 'news-report' });
  for (const development of holding.developments || []) add('development', { occurredAt: development.occurred_at, title: development.title, source: development.source, url: development.url });
  const thesis = thesisFor(holding.symbol, `${month}-28`);
  if (thesis?.valuationFrame) add('thesis-valuation', { referenceOnly: true, ...thesis.valuationFrame });
  for (const source of thesis?.evidenceSources || []) add('thesis-source', { referenceOnly: true, ...source });
  if (thesis) add('thesis-context', { referenceOnly: true, tldr: thesis.tldr, supportingFactors: thesis.supportingFactors, monitoringMetrics: thesis.monitoringMetrics });
  const filingCount = evidence.filter((entry) => entry.kind === 'filing').length;
  const governanceEventCount = evidence.filter((entry) => entry.kind === 'governance-event').length;
  return { symbol: holding.symbol, thesis, evidence, evidenceScout: {
    status: holding.governance.status,
    reviewedFilingCount: filingCount,
    governanceEventCount,
    coverageNote: holding.governance.coverageNote,
  } };
}

function advocatePrompt(side) { return `ROLE: ${side} THESIS ADVOCATE\nUse only the supplied thesis and evidence. ${side === 'BULL' ? 'Build the strongest supported case that the thesis strengthened or remains intact.' : 'Stress-test the thesis and build the strongest supported case that it weakened or broke.'} Do not manufacture disagreement. A known risk, business-model characteristic, current-only metric, price move, technical signal, valuation or position concentration is context—not evidence that the operating thesis changed. Strengthened, weakened or broken requires a new dated business delta that confirms a must-happen condition or crosses a falsifier. Judge debt relative to the company business model, cash generation, maturity, funding access and the thesis trajectory; debt is not inherently negative. Every factual claim must cite one or more supplied evidence IDs. State unknowns plainly. The human investor makes all trades. Keep the summary under 120 words, each claim under 60 words and each uncertainty under 35 words. Return compact, schema-valid JSON only.`; }
function rebuttalPrompt(side) { return `ROLE: ${side} REBUTTAL\nRead the opposing memo. Accept its supported points and rebut only claims contradicted or materially qualified by the supplied evidence. Cite supplied evidence IDs for factual rebuttals. Do not introduce facts, amplify weak evidence or issue a personalised trade command. Keep the summary under 100 words and every list item under 50 words. Return compact, schema-valid JSON only.`; }
function valuationPrompt() { return `ROLE: VALUATION SPECIALIST\nIndependently assess whether the supplied valuation evidence is undemanding, reasonable, demanding or extreme relative to the growth, cash-flow and execution expectations contained in the approved thesis and monthly evidence. Use only supplied evidence. Treat metrics marked outsideReportPeriod as current context, not facts from the report month. Analyst targets are external sentiment, not intrinsic value. Never invent peers, discount rates, forecasts or fair value. If the bundle lacks enough valuation and earnings evidence, return insufficient-evidence. Valuation may affect sizing or an add candidate, but it cannot by itself strengthen or break the operating thesis. Cite evidence IDs supporting the assessment. Keep the summary under 120 words and every list item under 40 words. Return compact, schema-valid JSON only.`; }
function industryPeerPrompt() { return `ROLE: INDUSTRY AND PEER ANALYST\nUse only the approved peer-context and other supplied evidence. Assess whether observable industry conditions support the thesis and how the holding compares with its pre-approved peers on growth, earnings, leverage, valuation and monthly market performance. Do not choose new peers, confuse a retailer with a manufacturer, or infer market share from price performance. Metrics marked outsideReportPeriod are context only. If peer or industry coverage is inadequate, say insufficient-evidence rather than guessing. Cite evidence IDs. Keep the summary under 120 words and list items under 40 words. Return compact, schema-valid JSON only.`; }
function governancePrompt() { return `ROLE: GOVERNANCE AND CAPITAL ALLOCATION ANALYST\nReview only the supplied dated filing and governance-event evidence for promoter transactions, pledging, dilution, related-party dealings, auditor changes, regulatory or legal action, contingent liabilities, guarantees, acquisitions and capital allocation. Primary exchange filings outrank news. A news item is not proof; label an allegation unverified unless a primary disclosure confirms it. Keyword matches are prompts, never findings of wrongdoing. Every finding must cite a supplied evidence ID. No evidence or incomplete coverage means insufficient-coverage, never a clean conclusion. Distinguish an ordinary business-model feature from deterioration and explain materiality to minority shareholders. Keep the summary under 120 words and list items under 40 words. Return compact, schema-valid JSON only.`; }
function philosophyPrompt() { return `ROLE: INVESTMENT PHILOSOPHY STEWARD\nAudit only the compact debate claims supplied. Flag thesis drift, action bias, price-led reasoning, hidden assumptions and conclusions despite missing evidence. Veto an add/reduce/exit candidate when it conflicts with those principles. Use no more than 3 concerns, a summary under 60 words and concern text under 25 words. A veto is a process safeguard, not a trade instruction. Return compact schema-valid JSON only.`; }
function riskPrompt() { return `ROLE: PORTFOLIO RISK OFFICER\nReview concentration, correlated exposures, governance, volatility, downside and evidence gaps across the whole supplied portfolio. A position of 25% or more may warrant a sizing review, but never invent an ideal allocation. Technical weakness alone is not a sell case. Veto only when evidence or portfolio risk makes an action unsafe to present without further review. Keep the summary under 120 words and each concern under 40 words. Return compact, schema-valid JSON only.`; }
function judgePrompt() { return `ROLE: INVESTMENT COMMITTEE CHAIR\nResolve the bounded Bull/Bear debates by checking their claims against the original evidenceBundles, not by trusting agent summaries. Consider the independent Valuation Specialist, Philosophy Steward and Risk Officer reviews. Ignore any factual assertion that lacks a surviving evidence reference. Produce one verdict per debated symbol and thesis-missing verdicts for every missingTheses symbol. Distinguish business-thesis change from monthly share-price performance. A known risk, business-model characteristic, current-only metric, valuation or concentration flag cannot establish thesis change without a new dated business delta. Debt must be assessed relative to the business model and its direction, not treated as automatically adverse. Strengthened, weakened or broken requires evidence that a must-happen condition progressed or a falsifier was approached/crossed; otherwise use unchanged or insufficient-evidence. Portfolio concentration may independently trigger a sizing review but must not alter thesis status. A thesis is an evolving hypothesis, not a permanent constraint: when new evidence makes its wording incomplete, propose refine; when its causal mechanism has fundamentally changed, propose replace; when it is no longer investable or relevant, propose retire. Never silently rewrite it, and use none when the existing thesis remains adequate. All evolution proposals require explicit human approval and a new version. Prefer no-action or research-required when evidence is inconclusive. An add/reduce/exit candidate is only a research conclusion and requires human approval. Triggers must be observable and specific. Preserve a genuinely opposing strongest dissent; never repeat the winning argument as dissent. Return only schema-valid JSON.`; }

async function run(env, role, prompt, content, schema, maxTokens) {
  let firstError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const retryRule = attempt ? '\nRETRY: Your prior JSON was malformed or truncated. Be much more concise, close every string/array/object, and return JSON only.' : '';
      const result = await env.AI.run(MODEL, { messages: [{ role: 'system', content: `${prompt}${retryRule}` }, { role: 'user', content }], response_format: { type: 'json_schema', json_schema: schema }, temperature: 0, max_tokens: attempt ? Math.ceil(maxTokens * 1.35) : maxTokens });
      let value = result?.response ?? result;
      if (typeof value === 'string') value = JSON.parse(value.replace(/^```json\s*|\s*```$/g, ''));
      if (!value || typeof value !== 'object') throw new Error('invalid JSON object');
      return value;
    } catch (error) {
      firstError ||= error;
    }
  }
  throw new Error(`${role} failed after compact retry: ${clean(firstError, 220)}`);
}

async function safeOversightRun(env, role, prompt, content) {
  try {
    return await run(env, role, prompt, content, REVIEW_SCHEMA, 650);
  } catch (error) {
    const detail = clean(error, 260);
    return {
      summary: `${role} was unavailable; the chair must treat this control as incomplete.`,
      concerns: ['Oversight coverage is incomplete because the agent did not return valid structured output.'],
      veto: true, vetoReason: 'Do not present an add, promotion, reduce or exit candidate without human review of this missing control.',
      error: detail,
    };
  }
}

function validateRefs(result, evidence) {
  const allowed = new Set(evidence.map((item) => item.id));
  for (const key of ['claims', 'rebuttals']) result[key] = (result[key] || []).flatMap((claim) => {
    const evidenceRefs = (claim.evidenceRefs || []).filter((ref) => allowed.has(ref));
    return evidenceRefs.length ? [{ ...claim, evidenceRefs }] : [];
  });
  return result;
}
function validateValuationRefs(result, evidence) {
  const allowed = new Set(evidence.map((item) => item.id));
  result.evidenceRefs = (result.evidenceRefs || []).filter((ref) => allowed.has(ref));
  if (!result.evidenceRefs.length) {
    result.assessment = 'insufficient-evidence';
    result.sizingImplication = 'none';
    result.summary = 'The valuation assessment had no valid supporting evidence references.';
  }
  return result;
}
function validateIndustryPeerRefs(result, evidence) {
  const allowed = new Set(evidence.map((item) => item.id));
  result.evidenceRefs = (result.evidenceRefs || []).filter((ref) => allowed.has(ref));
  if (!result.evidenceRefs.length) {
    result.industryTrend = 'insufficient-evidence'; result.peerPosition = 'insufficient-evidence';
    result.summary = 'The industry and peer assessment had no valid supporting evidence references.';
  }
  return result;
}
function validateGovernanceRefs(result, evidence) {
  const allowed = new Set(evidence.filter((entry) => ['filing', 'governance-event'].includes(entry.kind)).map((entry) => entry.id));
  result.evidenceRefs = (result.evidenceRefs || []).filter((ref) => allowed.has(ref));
  if (!result.evidenceRefs.length && result.status !== 'insufficient-coverage') {
    result.status = 'insufficient-coverage';
    result.summary = 'The governance assessment had no valid supporting filing or governance-event references; this is not a clean conclusion.';
    result.findings = [];
    result.capitalAllocationConcerns = [];
    result.requiresHumanReview = false;
  }
  return result;
}
function cleanVerdict(item) { return { symbol: clean(item.symbol, 20).toUpperCase(), thesisStatus: item.thesisStatus, confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)), winningArgument: clean(item.winningArgument, 650), strongestDissent: clean(item.strongestDissent, 500), action: item.action, trigger: clean(item.trigger, 350), thesisEvolution: item.thesisEvolution, evolutionProposal: clean(item.evolutionProposal, 650), evolutionRationale: clean(item.evolutionRationale, 500) }; }
function chairVerdictProblems(judged, debatedSymbols, missingSymbols) {
  const expected = new Set([...debatedSymbols, ...missingSymbols]);
  const symbols = (judged.verdicts || []).map((item) => clean(item.symbol, 20).toUpperCase());
  const issues = [];
  if (new Set(symbols).size !== symbols.length) issues.push('chair returned duplicate holding verdicts');
  for (const symbol of symbols) if (!expected.has(symbol)) issues.push(`chair returned unexpected symbol ${symbol}`);
  for (const symbol of expected) if (!symbols.includes(symbol)) issues.push(`chair omitted the required verdict for ${symbol}`);
  return issues;
}
function missingVerdict(symbol) { return { symbol, thesisStatus: 'thesis-missing', confidence: 1, winningArgument: 'No investor-authored thesis is available, so the committee did not infer a reason for owning this holding.', strongestDissent: '', action: 'research-required', trigger: 'Add and approve a structured thesis card before requesting an AI thesis verdict.', thesisEvolution: 'none', evolutionProposal: '', evolutionRationale: '' }; }
function fallbackVerdict(symbol) { return { symbol, thesisStatus: 'insufficient-evidence', confidence: 0, winningArgument: 'The chair did not return a valid verdict for this holding.', strongestDissent: '', action: 'research-required', trigger: 'Regenerate after checking the agent output and evidence coverage.', thesisEvolution: 'none', evolutionProposal: '', evolutionRationale: '' }; }
function failedDebateVerdict(symbol, error) { return { ...fallbackVerdict(symbol), winningArgument: 'This holding’s specialist debate was incomplete, so no thesis conclusion was inferred.', trigger: `Retry after checking the recorded specialist error: ${clean(error, 180)}` }; }
function unavailableResult(prepared, reason) { return { status: 'unavailable', summary: 'The investment committee was unavailable; no AI thesis conclusion was inferred.', riskLevel: 'moderate', philosophy: INVESTMENT_PHILOSOPHY, promptVersion: COMMITTEE_PROMPT_VERSION, model: MODEL, debates: [], verdicts: prepared.map((item) => item.thesis ? fallbackVerdict(item.symbol) : missingVerdict(item.symbol)), missingTheses: prepared.filter((item) => !item.thesis).map((item) => item.symbol), error: reason } }
function clean(value, max) { return String(value || '').replace(/\u0000/g, '').trim().slice(0, max); }

function compactOversightInput({ month, holisticPolicyReview, prepared, debates, warnings, missing }) {
  return {
    month,
    principles: INVESTMENT_PHILOSOPHY.principles,
    portfolioFlags: holisticPolicyReview.flags,
    evidenceKinds: prepared.map((item) => ({ symbol: item.symbol, kinds: item.evidence.map((entry) => entry.kind) })),
    debates: debates.map((debate) => ({
      symbol: debate.symbol,
      bull: { status: debate.bull.thesisStatus, claims: debate.bull.claims },
      bear: { status: debate.bear.thesisStatus, claims: debate.bear.claims },
      valuation: { assessment: debate.valuation.assessment, evidenceRefs: debate.valuation.evidenceRefs },
      industryPeers: { industryTrend: debate.industryPeers.industryTrend, peerPosition: debate.industryPeers.peerPosition, evidenceRefs: debate.industryPeers.evidenceRefs },
      governance: { status: debate.governance.status, evidenceRefs: debate.governance.evidenceRefs, requiresHumanReview: debate.governance.requiresHumanReview },
    })),
    warnings: (warnings || []).slice(0, 8),
    missingTheses: missing,
  };
}

function enforceVerdictRules(verdict, item, debate) {
  if (!item.thesis || verdict.thesisStatus === 'thesis-missing') return verdict;
  let thesisStatus = verdict.thesisStatus;
  const unsupportedChange = ['strengthened', 'weakened', 'broken'].includes(thesisStatus) && !hasThesisChangeEvidence(thesisStatus, debate, item.evidence);
  if (unsupportedChange) thesisStatus = 'unchanged';
  const meaninglessEvolution = unsupportedChange || (verdict.thesisEvolution === 'refine' && (!verdict.evolutionProposal || /^refine$/i.test(verdict.evolutionProposal)));
  return {
    ...verdict,
    thesisStatus,
    confidence: unsupportedChange ? Math.min(verdict.confidence, 0.5) : verdict.confidence,
    winningArgument: unsupportedChange ? 'No new dated business evidence established a change to the investment thesis this month.' : verdict.winningArgument,
    action: unsupportedChange && ['add-candidate', 'review-position-size', 'reduce-or-exit-candidate'].includes(verdict.action) ? 'continue-observing' : verdict.action,
    trigger: observableTrigger(item.thesis),
    thesisEvolution: meaninglessEvolution ? 'none' : verdict.thesisEvolution,
    evolutionProposal: meaninglessEvolution ? '' : verdict.evolutionProposal,
    evolutionRationale: meaninglessEvolution ? '' : verdict.evolutionRationale,
  };
}

function hasThesisChangeEvidence(status, debate, evidence) {
  if (!debate) return false;
  const source = status === 'strengthened' ? debate.bull : debate.bear;
  const cited = new Set((source?.claims || []).flatMap((claim) => claim.evidenceRefs || []));
  return evidence.some((entry) => cited.has(entry.id) && qualifiesAsBusinessDelta(entry));
}

function qualifiesAsBusinessDelta(entry) {
  if (entry.kind === 'filing') {
    const fact = entry.fact || {};
    return Boolean(fact.summary || fact.takeaways?.length || fact.evidence?.length);
  }
  if (entry.kind === 'fundamentals' && !entry.fact?.outsideReportPeriod) {
    const changes = entry.fact?.changes;
    return Boolean(changes && typeof changes === 'object' && Object.values(changes).some((value) => value != null));
  }
  return false;
}

function observableTrigger(thesis) {
  return thesis.monitoringMetrics?.[0] || thesis.mustHappen?.[0] || 'Review the next company filing against the thesis conditions.';
}

function portfolioRiskLevel(review) {
  const flags = review.flags || [];
  const positions = flags.filter((flag) => flag.type === 'position-concentration').length;
  const sectors = flags.filter((flag) => flag.type === 'sector-concentration').length;
  if ((positions >= 2 || (positions && sectors)) && Number(review.deployedCapitalPct || 0) >= 25) return 'high';
  if (positions || sectors) return 'elevated';
  return 'moderate';
}

function researchQuality({ prepared, missing, firstRounds, errors, warnings }) {
  const evidenceCovered = prepared.filter((item) => item.evidence.some((entry) => ['filing', 'development', 'fundamentals'].includes(entry.kind))).length;
  const coverageIssues = (warnings || []).filter((warning) => /coverage|no stored|not available|excluded|failed/i.test(warning));
  const status = errors.length ? 'incomplete' : missing.length || evidenceCovered < prepared.length || coverageIssues.length ? 'limited' : 'complete';
  return { status, evidenceCovered, holdingCount: prepared.length, missingTheses: missing, issues: [...errors, ...coverageIssues] };
}
