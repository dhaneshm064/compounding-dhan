/**
 * Live, best-effort fetches from two unofficial upstream sources — both can break
 * or rate-limit without notice, so every function here returns [] on failure
 * rather than throwing (a missing news list shouldn't break the insights endpoint).
 */

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const COMPANY_SEARCH_NAMES = {
  SKYGOLD: 'Sky Gold and Diamonds',
  ANTHEM: 'Anthem Biosciences',
  KMEW: 'Knowledge Marine & Engineering Works',
  KRISHNADEF: 'Krishna Defence and Allied Industries',
  CREDITACC: 'CreditAccess Grameen',
};

export async function fetchNews(companyName, { googleEnabled = true } = {}) {
  const query = encodeURIComponent(`${companyName} NSE stock`);
  // Google News frequently returns 503 from Cloudflare's shared egress IPs.
  // Bing's RSS endpoint is a fallback, not a second fetch on every successful run.
  const feeds = [
    { provider: 'google', url: `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en` },
    { provider: 'bing', url: `https://www.bing.com/news/search?q=${query}&format=rss&mkt=en-IN` },
  ].filter((feed) => googleEnabled || feed.provider !== 'google');
  const primaryProvider = feeds[0]?.provider || null;
  const attempts = [];
  for (const feed of feeds) {
    const attemptedAt = new Date().toISOString();
    try {
      const res = await fetch(feed.url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        attempts.push({ provider: feed.provider, status: res.status, itemCount: 0, attemptedAt });
        continue;
      }
      const items = parseRssItems(await res.text());
      attempts.push({ provider: feed.provider, status: res.status, itemCount: items.length, attemptedAt });
      if (!items.length) continue;
      items.sort((a, b) => new Date(b.pubDate || 0).getTime() - new Date(a.pubDate || 0).getTime());
      return { items: items.slice(0, 25), provider: feed.provider, primaryProvider, attempts };
    } catch (error) {
      attempts.push({ provider: feed.provider, status: null, itemCount: 0, attemptedAt, error: String(error).slice(0, 240) });
      // Try the next provider.
    }
  }
  return { items: [], provider: null, primaryProvider, attempts };
}

// Fetches + upserts a news_cache row per symbol. Best-effort per stock — a
// symbol whose live fetch comes back empty (e.g. Google's bot-block page)
// keeps its previous cached headlines rather than overwriting them with [].
export async function fetchAndStoreNews(env, symbols) {
  const fetchedAt = new Date().toISOString();
  let updated = 0;
  const failed = [];
  const runs = [];

  for (const symbol of symbols) {
    const startedAt = new Date().toISOString();
    const fetched = await fetchNews(COMPANY_SEARCH_NAMES[symbol] || symbol, {
      googleEnabled: !['false', '0', 'off'].includes(String(env.NEWS_GOOGLE_ENABLED ?? 'true').toLowerCase()),
    });
    const items = fetched.items.filter((item) => isRelevantNews(symbol, item.title));
    const googleStatus = fetched.attempts.find((attempt) => attempt.provider === 'google')?.status ?? null;
    const bingStatus = fetched.attempts.find((attempt) => attempt.provider === 'bing')?.status ?? null;
    const outcome = !fetched.provider ? 'failed' : fetched.provider === fetched.primaryProvider ? 'primary-success' : 'fallback-success';
    const completedAt = new Date().toISOString();
    const error = fetched.provider && !items.length ? 'provider-returned-no-relevant-items' : !fetched.provider ? 'all-providers-failed-or-empty' : null;
    await env.DB.prepare(
      `INSERT INTO news_fetch_runs
         (symbol, started_at, completed_at, outcome, selected_provider, received_count,
          accepted_count, google_status, bing_status, attempts_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(symbol, startedAt, completedAt, outcome, fetched.provider, fetched.items.length, items.length,
      googleStatus, bingStatus, JSON.stringify(fetched.attempts), error).run();
    runs.push({ symbol, outcome, provider: fetched.provider, received: fetched.items.length, accepted: items.length, googleStatus, bingStatus, error });
    if (!items.length) {
      failed.push(symbol);
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO news_cache (symbol, items, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET items = excluded.items, fetched_at = excluded.fetched_at`
    )
      .bind(symbol, JSON.stringify(items), fetchedAt)
      .run();

    const evidence = items
      .filter((item) => item.title && item.link)
      .map((item) => {
        const governance = classifyGovernanceText(item.title);
        return env.DB.prepare(
          `INSERT OR IGNORE INTO news_items
             (symbol, title, source, url, published_at, fetched_at, category, governance_severity)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(symbol, item.title, item.source, item.link, normalizeDate(item.pubDate), fetchedAt, governance.category, governance.severity);
      });
    if (evidence.length) await env.DB.batch(evidence);
    updated++;
  }

  return { updated, failed, runs };
}

/** Seeds append-only evidence from the legacy latest-only cache. */
export async function backfillCachedNews(env) {
  const { results } = await env.DB.prepare('SELECT symbol, items, fetched_at FROM news_cache').all();
  let inserted = 0;
  let rejected = 0;
  for (const row of results || []) {
    let items = [];
    try { items = JSON.parse(row.items); } catch { continue; }
    const statements = [];
    for (const item of items) {
      if (!item.title || !item.link || !isRelevantNews(row.symbol, item.title)) {
        rejected++;
        continue;
      }
      const governance = classifyGovernanceText(item.title);
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO news_items
           (symbol, title, source, url, published_at, fetched_at, category, governance_severity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(row.symbol, item.title, item.source, item.link, normalizeDate(item.pubDate), row.fetched_at, governance.category, governance.severity));
    }
    if (statements.length) {
      const writes = await env.DB.batch(statements);
      inserted += writes.filter((result) => result.meta.changes === 1).length;
    }
  }
  return { inserted, rejected };
}

function isRelevantNews(symbol, title) {
  const value = String(title || '').toLowerCase();
  const aliases = {
    SKYGOLD: ['skygold', 'sky gold'],
    ANTHEM: ['anthem biosciences', 'anthem bio'],
    KMEW: ['kmew', 'knowledge marine'],
    KRISHNADEF: ['krishnadef', 'krishna defence'],
    CREDITACC: ['creditacc', 'creditaccess grameen'],
  }[symbol] || [String(symbol).toLowerCase()];
  return aliases.some((alias) => value.includes(alias));
}

/** Fetches and persists NSE announcements so old governance evidence is retained. */
export async function fetchAndStoreAnnouncements(env, symbols) {
  const fetchedAt = new Date().toISOString();
  let updated = 0;
  let filingsStored = 0;
  const failed = [];
  for (const symbol of symbols) {
    const company = await env.DB.prepare(
      `SELECT symbol, isin FROM trades WHERE symbol = ? ORDER BY (exchange = 'NSE') DESC LIMIT 1`
    ).bind(symbol).first();
    const nseItems = await fetchAnnouncements(symbol);
    const bseItems = await fetchBseAnnouncements(symbol, company?.isin);
    const items = [...nseItems, ...bseItems];
    if (!items.length) {
      failed.push(symbol);
      continue;
    }
    const statements = items.map((item) => {
      const governance = classifyGovernanceText(`${item.subject || ''} ${item.text || ''}`);
      const key = `${symbol}:${item.date || ''}:${item.url || item.subject || ''}`;
      return env.DB.prepare(
        `INSERT OR IGNORE INTO announcement_items
           (symbol, announcement_key, subject, body, attachment_url, announced_at, fetched_at, category, governance_severity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(symbol, key, item.subject, item.text, item.url, normalizeDate(item.date), fetchedAt, governance.category, governance.severity);
    });
    const filingStatements = items.map((item) => {
      const classification = classifyGovernanceText(`${item.subject || ''} ${item.text || ''}`);
      const exchange = item.exchange || 'NSE';
      const key = item.key || `${symbol}:${item.date || ''}:${item.url || item.subject || ''}`;
      return env.DB.prepare(
        `INSERT OR IGNORE INTO exchange_filings
           (symbol, isin, exchange, filing_key, filing_type, subject, details, document_url,
            filed_at, period_end, fetched_at, governance_severity, source_payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(symbol, company?.isin || null, exchange, key, classifyFilingType(item.subject, item.text),
        item.subject, item.text, item.url, normalizeDate(item.date), item.periodEnd || null,
        fetchedAt, classification.severity, JSON.stringify(item.raw || {}));
    });
    const results = await env.DB.batch([...statements, ...filingStatements]);
    filingsStored += results.slice(statements.length).filter((result) => result.meta.changes === 1).length;
    updated += statements.length;
  }
  return { updated, filingsStored, failed };
}

export function classifyFilingType(subject, details = '') {
  const value = `${subject || ''} ${details || ''}`.toLowerCase();
  const rules = [
    ['routine-compliance', ['trading window closure', 'closure of trading window', 'newspaper publication', 'investor grievance', 'regulation 74(5)']],
    ['promoter-pledge', ['promoter pledge', 'encumbrance of shares', 'release of encumbrance', 'invocation of pledge']],
    ['shareholding', ['shareholding pattern', 'regulation 31', 'share holding pattern']],
    ['financial-results', ['financial results', 'quarterly results', 'annual results', 'audited results', 'unaudited results']],
    ['related-party', ['related party transaction', 'related party transactions', 'regulation 23(9)']],
    ['auditor', ['auditor resignation', 'resignation of auditor', 'statutory auditor', 'qualified opinion', 'adverse opinion']],
    ['insider-trading', ['insider trading', 'regulation 7(2)', 'prohibition of insider trading', 'trading plan']],
    ['regulatory-legal', ['sebi order', 'show cause', 'penalty', 'litigation', 'tax demand', 'forensic audit', 'fraud', 'default']],
    ['credit-rating', ['credit rating', 'rating downgrade', 'rating upgrade']],
    ['capital-raise', ['preferential allotment', 'qualified institutions placement', 'fund raising', 'fundraising', 'warrant allotment', 'rights issue']],
    ['board-management', ['appointment of director', 'resignation of director', 'key managerial personnel', 'change in management']],
    ['corporate-action', ['dividend', 'bonus', 'stock split', 'buyback', 'merger', 'demerger']],
    ['business-update', ['order received', 'contract', 'capacity', 'acquisition', 'business update']],
  ];
  return rules.find(([, terms]) => terms.some((term) => value.includes(term)))?.[0] || 'other';
}

// This is intentionally conservative: it identifies items for human review; it
// does not assert misconduct. A future AI pass can summarize the linked evidence.
export function classifyGovernanceText(text) {
  const value = String(text || '').toLowerCase();
  const routine = [
    'certificate under sebi (depositories and participants)', 'regulation 74(5)',
    'closure of trading window', 'trading window closure', 'copy of newspaper publication', 'investor grievance',
  ];
  const high = [
    'fraud', 'forensic audit', 'search and seizure', 'insider trading', 'show cause notice',
    'default', 'wilful defaulter', 'promoter pledge', 'qualified opinion', 'adverse opinion',
    'resignation of auditor', 'auditor resignation', 'sebi order', 'penalty imposed',
  ];
  const medium = [
    'related party', 'promoter selling', 'promoter sold', 'share pledge', 'warrant allotment',
    'preferential allotment', 'fund raising', 'fundraising', 'board resignation',
    'independent director resignation', 'credit rating downgrade', 'litigation', 'tax demand',
  ];
  const governance = [
    'promoter', 'shareholding pattern', 'pledge', 'auditor', 'director', 'related party',
    'investigation', 'credit rating', 'default', 'warrant', 'insider trading', 'forensic audit',
  ];
  const operational = ['order received', 'contract', 'capacity', 'acquisition', 'merger', 'results', 'dividend'];
  const isRoutine = routine.some((term) => value.includes(term));
  const severity = isRoutine ? null : high.some((term) => value.includes(term)) ? 'high' : medium.some((term) => value.includes(term)) ? 'medium' : null;
  const category = isRoutine ? 'routine-compliance' : governance.some((term) => value.includes(term)) ? 'governance' : operational.some((term) => value.includes(term)) ? 'business' : 'general';
  return { category, severity };
}

export async function reclassifyStoredEvidence(env) {
  let updated = 0;
  for (const table of ['news_items', 'announcement_items']) {
    const textColumns = table === 'news_items' ? 'title' : "COALESCE(subject, '') || ' ' || COALESCE(body, '')";
    const { results } = await env.DB.prepare(`SELECT id, ${textColumns} AS text FROM ${table}`).all();
    for (const row of results || []) {
      const classification = classifyGovernanceText(row.text);
      await env.DB.prepare(`UPDATE ${table} SET category = ?, governance_severity = ? WHERE id = ?`)
        .bind(classification.category, classification.severity, row.id).run();
      updated++;
    }
  }
  const { results: filings } = await env.DB.prepare(
    "SELECT id, COALESCE(subject, '') || ' ' || COALESCE(details, '') AS text, subject, details FROM exchange_filings"
  ).all();
  for (const row of filings || []) {
    const classification = classifyGovernanceText(row.text);
    await env.DB.prepare('UPDATE exchange_filings SET filing_type = ?, governance_severity = ? WHERE id = ?')
      .bind(classifyFilingType(row.subject, row.details), classification.severity, row.id).run();
    updated++;
  }
  return { updated };
}

export async function fetchAnnouncements(symbol) {
  try {
    const res = await fetch(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        Referer: 'https://www.nseindia.com/companies-listing/corporate-filings-announcements',
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    // NSE's API is usually already newest-first, but sort explicitly rather than
    // trust that — their an_dt is "DD-Mon-YYYY HH:MM:SS", which Date() can't
    // parse directly, so parseNseDate() converts it to a sortable timestamp.
    const sorted = [...data].sort((a, b) => parseNseDate(b.an_dt) - parseNseDate(a.an_dt));
    return sorted.slice(0, 100).map((a) => ({
      exchange: 'NSE',
      key: String(a.seq_id || a.sort_date || `${symbol}:${a.an_dt}:${a.attchmntFile || a.desc}`),
      date: a.an_dt || null,
      subject: a.desc || a.sm_name || null,
      text: a.attchmntText || null,
      url: a.attchmntFile || null,
      raw: a,
    }));
  } catch {
    return [];
  }
}

async function fetchBseAnnouncements(symbol, isin) {
  try {
    const scripCode = await resolveBseScripCode(symbol, isin);
    if (!scripCode) return [];
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
    const params = new URLSearchParams({
      pageno: '1', strCat: '-1', strPrevDate: compactDate(from), strScrip: scripCode,
      strSearch: 'P', strToDate: compactDate(now), strType: 'C',
    });
    const res = await fetch(`https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?${params}`, { headers: bseHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    const rows = data?.Table || data?.table || [];
    return rows.slice(0, 100).map((a) => ({
      exchange: 'BSE',
      key: String(a.NEWSID || a.Newsid || `${scripCode}:${a.DT_TM || a.NEWS_DT}:${a.ATTACHMENTNAME || a.NEWSSUB}`),
      date: a.DT_TM || a.NEWS_DT || null,
      subject: a.NEWSSUB || a.HEADLINE || null,
      text: a.MORE || a.ANNOUNCEMENT_TYPE || null,
      url: bseAttachmentUrl(a.ATTACHMENTNAME),
      raw: a,
    }));
  } catch {
    return [];
  }
}

async function resolveBseScripCode(symbol, isin) {
  const res = await fetch(`https://api.bseindia.com/BseIndiaAPI/api/PeerSmartSearch/w?Type=SS&text=${encodeURIComponent(symbol)}`, { headers: bseHeaders() });
  if (!res.ok) return null;
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data?.Table || [];
  const exact = rows.find((row) => String(row.ISIN_NUMBER || row.ISIN || '').toUpperCase() === String(isin || '').toUpperCase())
    || rows.find((row) => String(row.LONG_NAME || row.SCRIP_NAME || row.scripname || '').toUpperCase().includes(symbol.toUpperCase()));
  return String(exact?.SCRIP_CD || exact?.scrip_cd || exact?.scripcode || '').trim() || null;
}

function bseHeaders() {
  return { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://www.bseindia.com', Referer: 'https://www.bseindia.com/' };
}

function compactDate(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function bseAttachmentUrl(name) {
  if (!name) return null;
  if (/^https?:\/\//i.test(name)) return name;
  return `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${String(name).replace(/^\/+/, '')}`;
}

function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: tag(block, 'title'),
      link: tag(block, 'link'),
      pubDate: tag(block, 'pubDate'),
      source: tag(block, 'source'),
    });
  }
  return items;
}

function normalizeDate(value) {
  if (!value) return null;
  const nse = parseNseDate(value);
  if (nse) return new Date(nse).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const NSE_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "14-Aug-2026 20:05:33" -> a sortable timestamp. Returns 0 (oldest) for anything
// that doesn't match, so unparseable rows sort last rather than break the sort.
function parseNseDate(str) {
  const m = str && str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const [, day, mon, year, h, min, s] = m;
  const month = NSE_MONTHS[mon];
  if (month == null) return 0;
  return new Date(Number(year), month, Number(day), Number(h), Number(min), Number(s)).getTime();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  if (!m) return null;
  return m[1]
    .replace('<![CDATA[', '')
    .replace(']]>', '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}
