/**
 * Live, best-effort fetches from two unofficial upstream sources — both can break
 * or rate-limit without notice, so every function here returns [] on failure
 * rather than throwing (a missing news list shouldn't break the insights endpoint).
 */

export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export async function fetchNews(companyName) {
  try {
    const query = encodeURIComponent(`${companyName} NSE stock`);
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    // Google's search RSS is relevance-ranked, not date-ranked, so results arrive
    // out of chronological order — sort newest-first before truncating to 10.
    const items = parseRssItems(xml);
    items.sort((a, b) => new Date(b.pubDate || 0).getTime() - new Date(a.pubDate || 0).getTime());
    return items.slice(0, 10);
  } catch {
    return [];
  }
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
    return sorted.slice(0, 10).map((a) => ({
      date: a.an_dt || null,
      subject: a.desc || a.sm_name || null,
      text: a.attchmntText || null,
      url: a.attchmntFile || null,
    }));
  } catch {
    return [];
  }
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
