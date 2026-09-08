import { INVESTMENT_PHILOSOPHY, thesisFor } from './investment-theses.js';

export const COMMITTEE_PROMPT_VERSION = 'investment-committee-v2-valuation-evidence';
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
  if (!env.AI || !debated.length) return unavailableResult(prepared, !env.AI ? 'AI binding unavailable' : 'No holdings have an active thesis');

  try {
    const firstRounds = await Promise.all(debated.map(async (item) => {
      const input = JSON.stringify({ philosophy: INVESTMENT_PHILOSOPHY, thesis: item.thesis, evidence: item.evidence });
      const [bull, bear, valuation] = await Promise.all([
        run(env, `${item.symbol} bull advocate`, advocatePrompt('BULL'), input, ARGUMENT_SCHEMA, 1700),
        run(env, `${item.symbol} bear advocate`, advocatePrompt('BEAR'), input, ARGUMENT_SCHEMA, 1700),
        run(env, `${item.symbol} valuation specialist`, valuationPrompt(), input, VALUATION_SCHEMA, 1300),
      ]);
      const checkedBull = validateRefs(bull, item.evidence);
      const checkedBear = validateRefs(bear, item.evidence);
      const checkedValuation = validateValuationRefs(valuation, item.evidence);
      const [bullRebuttal, bearRebuttal] = await Promise.all([
        run(env, `${item.symbol} bull rebuttal`, rebuttalPrompt('BULL'), JSON.stringify({ evidence: item.evidence, valuation: checkedValuation, own: checkedBull, opponent: checkedBear }), REBUTTAL_SCHEMA, 1200),
        run(env, `${item.symbol} bear rebuttal`, rebuttalPrompt('BEAR'), JSON.stringify({ evidence: item.evidence, valuation: checkedValuation, own: checkedBear, opponent: checkedBull }), REBUTTAL_SCHEMA, 1200),
      ]);
      return { symbol: item.symbol, thesis: item.thesis, valuation: checkedValuation, bull: checkedBull, bear: checkedBear, bullRebuttal: validateRefs(bullRebuttal, item.evidence), bearRebuttal: validateRefs(bearRebuttal, item.evidence) };
    }));

    const committeeInput = JSON.stringify({ month, philosophy: INVESTMENT_PHILOSOPHY, portfolio, holdings: prepared.map(({ thesis, ...item }) => item), debates: firstRounds, warnings, missingTheses: missing });
    const [philosophyReview, riskReview] = await Promise.all([
      run(env, 'philosophy steward', philosophyPrompt(), committeeInput, REVIEW_SCHEMA, 1200),
      run(env, 'portfolio risk officer', riskPrompt(), committeeInput, REVIEW_SCHEMA, 1200),
    ]);
    const judgeInput = JSON.stringify({ month, philosophy: INVESTMENT_PHILOSOPHY, portfolio, evidenceBundles: prepared, debates: firstRounds, philosophyReview, riskReview, missingTheses: missing, warnings });
    const judged = await run(env, 'investment committee chair', judgePrompt(), judgeInput, VERDICT_SCHEMA, 2600);
    const verdictMap = new Map((judged.verdicts || []).map((item) => {
      const verdict = cleanVerdict(item);
      return [verdict.symbol, verdict];
    }));
    for (const symbol of missing) verdictMap.set(symbol, missingVerdict(symbol));
    return {
      status: 'complete', summary: clean(judged.summary, 1200), riskLevel: judged.riskLevel,
      philosophy: INVESTMENT_PHILOSOPHY, promptVersion: COMMITTEE_PROMPT_VERSION, model: MODEL,
      debates: firstRounds, philosophyReview, riskReview,
      verdicts: prepared.map((item) => verdictMap.get(item.symbol) || fallbackVerdict(item.symbol)),
      missingTheses: missing,
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
  for (const review of holding.governance.aiReviews || []) add('filing', { occurredAt: review.occurred_at, severity: review.severity, summary: review.summary, takeaways: review.keyTakeaways, evidence: review.evidence });
  for (const development of holding.developments || []) add('development', { occurredAt: development.occurred_at, title: development.title, source: development.source, url: development.url });
  return { symbol: holding.symbol, thesis: thesisFor(holding.symbol, `${month}-28`), evidence };
}

function advocatePrompt(side) { return `ROLE: ${side} THESIS ADVOCATE\nUse only the supplied thesis and evidence. ${side === 'BULL' ? 'Build the strongest supported case that the thesis strengthened or remains intact.' : 'Stress-test the thesis and build the strongest supported case that it weakened or broke.'} Do not manufacture disagreement. Price and technical evidence cannot alone change a business thesis. Every factual claim must cite one or more supplied evidence IDs. State unknowns plainly. The human investor makes all trades. Keep the summary under 120 words, each claim under 60 words and each uncertainty under 35 words. Return compact, schema-valid JSON only.`; }
function rebuttalPrompt(side) { return `ROLE: ${side} REBUTTAL\nRead the opposing memo. Accept its supported points and rebut only claims contradicted or materially qualified by the supplied evidence. Cite supplied evidence IDs for factual rebuttals. Do not introduce facts, amplify weak evidence or issue a personalised trade command. Keep the summary under 100 words and every list item under 50 words. Return compact, schema-valid JSON only.`; }
function valuationPrompt() { return `ROLE: VALUATION SPECIALIST\nIndependently assess whether the supplied valuation evidence is undemanding, reasonable, demanding or extreme relative to the growth, cash-flow and execution expectations contained in the approved thesis and monthly evidence. Use only supplied evidence. Treat metrics marked outsideReportPeriod as current context, not facts from the report month. Analyst targets are external sentiment, not intrinsic value. Never invent peers, discount rates, forecasts or fair value. If the bundle lacks enough valuation and earnings evidence, return insufficient-evidence. Valuation may affect sizing or an add candidate, but it cannot by itself strengthen or break the operating thesis. Cite evidence IDs supporting the assessment. Keep the summary under 120 words and every list item under 40 words. Return compact, schema-valid JSON only.`; }
function philosophyPrompt() { return `ROLE: INVESTMENT PHILOSOPHY STEWARD\nAudit the debates against the supplied philosophy. Flag thesis drift, action bias, price-led reasoning, hidden assumptions and conclusions presented despite missing evidence. Veto an add/reduce/exit candidate when it conflicts with those principles. A veto is a process safeguard, not a trade instruction. Keep the summary under 120 words and each concern under 40 words. Return compact, schema-valid JSON only.`; }
function riskPrompt() { return `ROLE: PORTFOLIO RISK OFFICER\nReview concentration, correlated exposures, governance, volatility, downside and evidence gaps across the whole supplied portfolio. A position of 25% or more may warrant a sizing review, but never invent an ideal allocation. Technical weakness alone is not a sell case. Veto only when evidence or portfolio risk makes an action unsafe to present without further review. Keep the summary under 120 words and each concern under 40 words. Return compact, schema-valid JSON only.`; }
function judgePrompt() { return `ROLE: INVESTMENT COMMITTEE CHAIR\nResolve the bounded Bull/Bear debates by checking their claims against the original evidenceBundles, not by trusting agent summaries. Consider the independent Valuation Specialist, Philosophy Steward and Risk Officer reviews. Ignore any factual assertion that lacks a surviving evidence reference. Produce one verdict per debated symbol and thesis-missing verdicts for every missingTheses symbol. Distinguish business-thesis change from monthly share-price performance; valuation can affect sizing or an add candidate but cannot alone strengthen or break an operating thesis. A thesis is an evolving hypothesis, not a permanent constraint: when new evidence makes its wording incomplete, propose refine; when its causal mechanism has fundamentally changed, propose replace; when it is no longer investable or relevant, propose retire. Never silently rewrite it, and use none when the existing thesis remains adequate. All evolution proposals require explicit human approval and a new version. Prefer no-action or research-required when evidence is inconclusive. An add/reduce/exit candidate is only a research conclusion and requires human approval. Triggers must be observable and specific. Preserve the strongest dissent even when one side wins. Return only schema-valid JSON.`; }

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
function cleanVerdict(item) { return { symbol: clean(item.symbol, 20).toUpperCase(), thesisStatus: item.thesisStatus, confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)), winningArgument: clean(item.winningArgument, 650), strongestDissent: clean(item.strongestDissent, 500), action: item.action, trigger: clean(item.trigger, 350), thesisEvolution: item.thesisEvolution, evolutionProposal: clean(item.evolutionProposal, 650), evolutionRationale: clean(item.evolutionRationale, 500) }; }
function missingVerdict(symbol) { return { symbol, thesisStatus: 'thesis-missing', confidence: 1, winningArgument: 'No investor-authored thesis is available, so the committee did not infer a reason for owning this holding.', strongestDissent: '', action: 'research-required', trigger: 'Add and approve a structured thesis card before requesting an AI thesis verdict.', thesisEvolution: 'none', evolutionProposal: '', evolutionRationale: '' }; }
function fallbackVerdict(symbol) { return { symbol, thesisStatus: 'insufficient-evidence', confidence: 0, winningArgument: 'The chair did not return a valid verdict for this holding.', strongestDissent: '', action: 'research-required', trigger: 'Regenerate after checking the agent output and evidence coverage.', thesisEvolution: 'none', evolutionProposal: '', evolutionRationale: '' }; }
function unavailableResult(prepared, reason) { return { status: 'unavailable', summary: 'The investment committee was unavailable; no AI thesis conclusion was inferred.', riskLevel: 'moderate', philosophy: INVESTMENT_PHILOSOPHY, promptVersion: COMMITTEE_PROMPT_VERSION, model: MODEL, debates: [], verdicts: prepared.map((item) => item.thesis ? fallbackVerdict(item.symbol) : missingVerdict(item.symbol)), missingTheses: prepared.filter((item) => !item.thesis).map((item) => item.symbol), error: reason } }
function clean(value, max) { return String(value || '').replace(/\u0000/g, '').trim().slice(0, max); }
