#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2] || 'ownership/raw/mutual-funds';
const indexUrl = 'https://www.amfiindia.com/online-center/portfolio-disclosure';
const headers = { 'user-agent': 'Compounding-Dhan-Ownership/1.0', accept: 'text/html,application/xhtml+xml' };
const absolute = (value, base) => { try { return new URL(value, base).href; } catch { return null; } };
const clean = (value) => value.replaceAll('\\/', '/').replaceAll('&amp;', '&').replaceAll('\\u0026', '&');
const isPortfolioFile = (url) => /\.(xlsx?|csv|tsv)(?:\?|$)/i.test(url) && /(portfolio|holding|scheme|equity|monthly|half.?year|qtr|quarter)/i.test(url);
const get = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });

let response;
for (const candidate of [indexUrl, 'https://amfi-dev.webileapps.io/online-center/portfolio-disclosure']) {
  try { response = await fetch(candidate, { headers }); if (response.ok) break; } catch {}
}
if (!response?.ok) throw new Error('AMFI directory could not be reached');
const html = await response.text();
const amcLinks = [...new Set([...html.matchAll(/amc_monthly_portfolio_disclosure\\?"?\s*:\s*\\?"([^"\\]+)|amc_halfYearly_portfolio_disclosure\\?"?\s*:\s*\\?"([^"\\]+)/gi)].flatMap((match) => match.slice(1).filter(Boolean).map(clean).map((url) => absolute(url, indexUrl)).filter(Boolean)))];
if (!amcLinks.length) throw new Error('No AMC disclosure links found in AMFI directory');

const discovered = [];
for (const url of amcLinks) {
  try {
    const page = await get(url, { headers, redirect: 'follow' });
    if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) continue;
    const body = await page.text();
    for (const match of body.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const file = absolute(match[1], page.url || url);
      if (file && isPortfolioFile(file)) discovered.push({ amcPage: url, file });
    }
  } catch {}
}
const unique = [...new Map(discovered.map((item) => [item.file, item])).values()];
await mkdir(out, { recursive: true });
const downloaded = [];
for (let offset = 0; offset < unique.length; offset += 8) {
  const batch = unique.slice(offset, offset + 8);
  await Promise.all(batch.map(async (item) => {
   try {
    const fileResponse = await get(item.file, { headers, redirect: 'follow' });
    if (!fileResponse.ok) return;
    const bytes = Buffer.from(await fileResponse.arrayBuffer());
    if (bytes.length < 5000) return;
    const name = `${String(downloaded.length + 1).padStart(4, '0')}-${new URL(item.file).pathname.split('/').pop() || 'portfolio.xlsx'}`.replace(/[^\w.()-]+/g, '_');
    await writeFile(join(out, name), bytes);
    downloaded.push({ ...item, path: join(out, name), bytes: bytes.length });
   } catch {}
  }));
}
await writeFile(join(out, 'manifest.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), source: indexUrl, amcPages: amcLinks.length, discoveredFiles: unique.length, downloaded }, null, 2) + '\n');
console.log(`Found ${amcLinks.length} AMC disclosure pages, discovered ${unique.length} candidate files, downloaded ${downloaded.length}`);
