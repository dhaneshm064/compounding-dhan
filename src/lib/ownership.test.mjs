import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShareholding } from './ownership.js';

const fact = (element, context, value) => `<in-bse-shp:${element} contextRef="${context}" decimals="INF">${value}</in-bse-shp:${element}>`;
const totals = (context, holders, shares, pct) =>
  fact('NumberOfShareholders', context, holders) + fact('NumberOfShares', context, shares) + fact('ShareholdingAsAPercentageOfTotalNumberOfShares', context, pct);

test('parses the 2025 layout (fractions, _ContextI totals, D_ named holders)', () => {
  const xml = [
    fact('Symbol', 'MainD', 'ANTHEM'), fact('DateOfReport', 'MainI', '2026-09-30'),
    totals('ShareholdingPattern_ContextI', 176209, 563528045, 1),
    totals('MutualFundsOrUTI_ContextI', 31, 52138271, 0.0925),
    totals('InstitutionsForeignPortfolioInvestorCategoryOne_ContextI', 100, 20000000, 0.0355),
    totals('InstitutionsForeignPortfolioInvestorCategoryTwo_ContextI', 17, 1373877, 0.0024),
    totals('ShareholdingOfPromoterAndPromoterGroup_ContextI', 7, 402349775, 0.714),
    fact('NameOfTheShareholder', 'D_MutualFundsOrUTI_Context15', 'HDFC MUTUAL FUND - HDFC BUSINESS CYCLE FUND'),
    totals('MutualFundsOrUTI_Context15', 1, 10702406, 0.019),
  ].join('\n');
  const r = parseShareholding(xml);
  assert.equal(r.symbol, 'ANTHEM');
  assert.equal(r.period, '2026-09-30');
  assert.equal(r.shares, 563528045);
  assert.deepEqual(r.groups.mf, [31, 52138271, 9.25]);
  assert.deepEqual(r.groups.promoter, [7, 402349775, 71.4]);
  assert.deepEqual(r.groups.fpi, [117, 21373877, 3.79]);
  assert.equal(r.groups.fpi1, undefined);
  assert.deepEqual(r.schemes, [['HDFC MUTUAL FUND - HDFC BUSINESS CYCLE FUND', 10702406, 1.9]]);
});

test('parses the 2022 layout (percent, ...I totals, DetailsOfSharesHeldBy named holders)', () => {
  const xml = [
    fact('Symbol', 'OneD', 'CREDITACC'), fact('DateOfReport', 'OneI', '2024-12-31'),
    totals('ShareholdingPatternI', 125004, 159571735, 100),
    totals('MutualFundsOrUtiI', 23, 19065808, 11.95),
    totals('InstitutionsForeignPortfolioInvestorCatergoryOneI', 134, 15567329, 9.76),
    fact('NameOfTheShareholder', 'DetailsOfSharesHeldByMutualFundsOrUti002D', 'NIPPON INDIA SMALL CAP FUND'),
    totals('DetailsOfSharesHeldByMutualFundsOrUti002I', 1, 4409585, 2.76),
    fact('NameOfTheShareholder', 'DetailsOfSharesHeldByMutualFundsOrUti001D', 'CANARA ROBECO EMERGING EQUITIES'),
    totals('DetailsOfSharesHeldByMutualFundsOrUti001I', 1, 5545937, 3.48),
    fact('NameOfTheShareholder', 'DetailsOfSharesHeldByInsuranceCompanies001D', 'LIC'),
  ].join('\n');
  const r = parseShareholding(xml);
  assert.equal(r.symbol, 'CREDITACC');
  assert.equal(r.period, '2024-12-31');
  assert.deepEqual(r.groups.mf, [23, 19065808, 11.95]);
  assert.deepEqual(r.groups.fpi, [134, 15567329, 9.76]);
  // Largest holding first; insurance holders are not mutual-fund schemes.
  assert.deepEqual(r.schemes.map((s) => s[0]), ['CANARA ROBECO EMERGING EQUITIES', 'NIPPON INDIA SMALL CAP FUND']);
});

test('a category with no holders is left out', () => {
  const r = parseShareholding(totals('ShareholdingPattern_ContextI', 10, 100, 1) + totals('AlternativeInvestmentFunds_ContextI', 0, 0, 0));
  assert.equal(r.groups.aif, undefined);
});
