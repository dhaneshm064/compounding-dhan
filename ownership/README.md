# Ownership data pipeline

Place exchange shareholding exports and AMFI scheme portfolio exports under `ownership/raw/`. CSV and TSV files are supported. The importer recognizes common column names such as stock/symbol, ISIN, investor/shareholder, period/quarter/month, shares, holding percentage, and value.

Run:

```sh
npm run ownership:build
```

Generated files are written to `public/data/ownership/`:

- `ownership-summary.json` contains normalized events.
- `stocks/A.json` through `Z.json` partition events by stock.
- `investors/A.json` through `Z.json` partition events by investor.

The source files are retained separately from bulk/block trade data because ownership snapshots are periodic holdings, not exact executions.
