# Ownership data pipeline

## Quarterly ownership (live): `/ownership`

`scripts/build-mf-ownership.mjs` (`npm run ownership:build`) reads every NSE
company's quarterly shareholding-pattern filing (XBRL, parsed by
`src/lib/ownership.js`) and writes `public/data/ownership/`:

- `index.json`: quarters with company counts, and quarters that have a screen.
- `quarters/YYYY-MM-DD.json`: per company, holder count, shares and % for mutual
  funds, insurance, AIFs, pension funds, banks, domestic and foreign institutions,
  FPIs, promoters, small retail and the public, plus every named mutual-fund
  scheme above 1%.
- `screen/YYYY-MM-DD.json`: each company compared with the previous quarter,
  plus the mutual funds' bulk/block deals in that quarter (from `public/data/flows`).

It runs nightly in `.github/workflows/whales.yml` and only downloads filings it
hasn't parsed yet. Downloads are throttled and capped per run because NSE blocks
addresses that fetch too quickly. To backfill, run the workflow manually with
`ownership_since` (e.g. `2024-12-01`) and repeat until the log says
`0 filings to download`.

## Monthly fund portfolios (planned)

`scripts/fetch-amfi-portfolios.mjs` discovers and downloads AMC monthly
portfolio workbooks from AMFI's directory. Each fund house uses its own layout,
so these still need a parser before they can feed the site.
