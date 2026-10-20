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

test('standardScheme: one identity per scheme across spellings', async () => {
  const { standardScheme } = await import('./ownership.js');
  const key = (name) => standardScheme(name).key;
  assert.equal(key('AXIS MUTUAL FUND TRUSTEE LIMITED A/C AXIS MUTUAL FUND A/C AXIS SMALL CAP FUND'), key('Axis Small Cap Fund'));
  assert.notEqual(key('Axis Small Cap Fund'), key('AXIS MULTICAP FUND'));
  assert.equal(key('Aditya Birla Sun Life Trustee Private Limited A/C - Aditya Birla Sun Life Elss Tax Saver Fund'),
    key('Aditya Birla Sun Life Mutual Fund - Aditya Birla Sun Life Elss Tax Saver Fund'));
  assert.equal(key('HDFC TRUSTEE COMPANY LIMITED-HDFC FLEXI CAP FUND'), key('HDFC Flexi Cap Fund'));
  assert.equal(key('NIPPON LIFE INDIA TRUSTEE LTD-A/C NIPPON INDIA SMALL CAP FUND'), key('Nippon India Small Cap Fund'));
  assert.equal(standardScheme('Aditya Birla Sun Life Mutual Fund - Aditya Birla Sun Life Elss Tax Saver Fund').label, 'Aditya Birla Sun Life ELSS Tax Saver Fund');
});

test('standardScheme: fund-house totals and cut-off names are not schemes', async () => {
  const { standardScheme } = await import('./ownership.js');
  for (const [name, key] of [
    ['SBI MUTUAL FUND (Under different sub accounts)', 'AMC:SBI'],
    ['NIPPON LIFE INDIA TRUSTEE LTD', 'AMC:NIPPON INDIA'],
    ['ICIC Prudential', 'AMC:ICICI PRUDENTIAL'],
    ['KOTAK MAHINDRA TRUSTEE CO LTD', 'AMC:KOTAK'],
    ['ADITYA BIRLA SUN LIFE MUTUAL FUND - ADITYA BIRLA S', 'CUT:ADITYA BIRLA SUN LIFE'],
  ]) {
    const s = standardScheme(name);
    assert.equal(s.key, key, name);
    assert.equal(s.combined, true, name);
  }
  // Sub accounts of one named scheme are still that scheme.
  assert.equal(standardScheme('ICICI PRUDENTIAL LARGE CAP FUND WITH SUB ACCOUNTS').key, 'ICICI PRUDENTIAL LARGE CAP');
});

test('sameScheme matches names cut off at ~50 characters', async () => {
  const { standardScheme, sameScheme } = await import('./ownership.js');
  const cut = standardScheme('NIPPON LIFE INDIA TRUSTEE LTD-A/C NIPPON INDIA SMA').key;
  assert.equal(sameScheme(cut, standardScheme('Nippon India Small Cap Fund').key), true);
  assert.equal(sameScheme(standardScheme('Axis Small Cap Fund').key, standardScheme('Axis Smallcap Index Fund').key), false);
});
