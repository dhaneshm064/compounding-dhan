/**
 * Comments + Likes + Portfolio/Watchlist API — a Cloudflare Worker backed by
 * a D1 (SQLite) database.
 *
 * Routes:
 *   GET    /api/comments?post=ID            -> { comments: [...] }
 *   POST   /api/comments  {post,name,body}  -> { ok: true, comment: {...} }
 *   GET    /api/likes?post=ID&visitor=VID   -> { count, liked }
 *   POST   /api/likes     {post,visitor}    -> { count, liked: true }
 *   DELETE /api/likes     {post,visitor}    -> { count, liked: false }
 *
 *   GET    /api/portfolio                                    -> public, percentages only
 *   GET    /api/watchlist                                    -> public, percentages only
 *   POST   /api/admin/holdings  {symbol,exchange,quantity,buyPrice} -> admin, adds/updates a holding
 *   DELETE /api/admin/holdings  {symbol}                      -> admin, removes it
 *   POST   /api/admin/watchlist {symbol,exchange}             -> admin, adds a symbol
 *   DELETE /api/admin/watchlist {symbol}                      -> admin, removes it
 *
 * A Cron Trigger (see wrangler.toml) refreshes price_snapshots from Yahoo
 * Finance once a day — no credentials involved, since that part has to run
 * unattended.
 *
 * The D1 database is bound as `env.DB` (see wrangler.toml).
 */

const MAX_NAME = 60;
const MAX_BODY = 2000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/comments') {
        if (request.method === 'GET') return getComments(url, env, cors);
        if (request.method === 'POST') return postComment(request, env, cors);
      }
      if (url.pathname === '/api/likes') {
        if (request.method === 'GET') return getLikes(url, env, cors);
        if (request.method === 'POST') return addLike(request, env, cors);
        if (request.method === 'DELETE') return removeLike(request, env, cors);
      }
      if (url.pathname === '/api/portfolio' && request.method === 'GET') {
        return getPortfolio(env, cors);
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        return getWatchlist(env, cors);
      }
      if (url.pathname === '/api/admin/holdings') {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
        if (request.method === 'POST') return addHolding(request, env, cors);
        if (request.method === 'DELETE') return removeHolding(request, env, cors);
      }
      if (url.pathname === '/api/admin/watchlist') {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
        if (request.method === 'POST') return addWatchlistSymbol(request, env, cors);
        if (request.method === 'DELETE') return removeWatchlistSymbol(request, env, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error', detail: String(err) }, 500, cors);
    }
  },

  // Cron Trigger — refreshes today's prices for every symbol we track.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAllPrices(env));
  },
};

// ---------- Comments ----------

async function getComments(url, env, cors) {
  const post = url.searchParams.get('post');
  if (!post) return json({ error: 'Missing post' }, 400, cors);

  const { results } = await env.DB
    .prepare('SELECT id, name, body, created_at FROM comments WHERE post_slug = ? ORDER BY created_at DESC LIMIT 500')
    .bind(post)
    .all();

  return json({ comments: results || [] }, 200, cors);
}

async function postComment(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const post = String(data.post || '').trim();
  let name = String(data.name || '').trim().slice(0, MAX_NAME);
  const body = String(data.body || '').trim().slice(0, MAX_BODY);

  if (!post) return json({ error: 'Missing post' }, 400, cors);
  if (!body) return json({ error: 'Comment body is required' }, 400, cors);
  if (!name) name = 'Anonymous';

  const created_at = new Date().toISOString();
  const result = await env.DB
    .prepare('INSERT INTO comments (post_slug, name, body, created_at) VALUES (?, ?, ?, ?)')
    .bind(post, name, body, created_at)
    .run();

  return json(
    { ok: true, comment: { id: result.meta.last_row_id, name, body, created_at } },
    201,
    cors
  );
}

// ---------- Likes ----------

async function likeCount(env, post) {
  const row = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM likes WHERE post_slug = ?')
    .bind(post)
    .first();
  return row ? row.n : 0;
}

async function hasLiked(env, post, visitor) {
  const row = await env.DB
    .prepare('SELECT 1 FROM likes WHERE post_slug = ? AND visitor_id = ? LIMIT 1')
    .bind(post, visitor)
    .first();
  return !!row;
}

async function getLikes(url, env, cors) {
  const post = url.searchParams.get('post');
  const visitor = url.searchParams.get('visitor') || '';
  if (!post) return json({ error: 'Missing post' }, 400, cors);

  const [count, liked] = await Promise.all([
    likeCount(env, post),
    visitor ? hasLiked(env, post, visitor) : Promise.resolve(false),
  ]);
  return json({ count, liked }, 200, cors);
}

async function addLike(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const post = String(data.post || '').trim();
  const visitor = String(data.visitor || '').trim();
  if (!post || !visitor) return json({ error: 'Missing post or visitor' }, 400, cors);

  // INSERT OR IGNORE makes a repeated like a no-op (the table has a UNIQUE constraint).
  await env.DB
    .prepare('INSERT OR IGNORE INTO likes (post_slug, visitor_id, created_at) VALUES (?, ?, ?)')
    .bind(post, visitor, new Date().toISOString())
    .run();

  return json({ count: await likeCount(env, post), liked: true }, 200, cors);
}

async function removeLike(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const post = String(data.post || '').trim();
  const visitor = String(data.visitor || '').trim();
  if (!post || !visitor) return json({ error: 'Missing post or visitor' }, 400, cors);

  await env.DB
    .prepare('DELETE FROM likes WHERE post_slug = ? AND visitor_id = ?')
    .bind(post, visitor)
    .run();

  return json({ count: await likeCount(env, post), liked: false }, 200, cors);
}

// ---------- Portfolio ----------
//
// Holdings' quantity and avg_buy_price, and every fetched price, are used
// only to derive percentages here. They are never put into a JSON response.

async function getPortfolio(env, cors) {
  const { results: holdings } = await env.DB
    .prepare('SELECT symbol, exchange, quantity, avg_buy_price FROM holdings')
    .all();

  if (!holdings || holdings.length === 0) {
    return json({ holdings: [], totalGainPct: null, updatedAt: null }, 200, cors);
  }

  const { results: snapshots } = await env.DB
    .prepare('SELECT symbol, price, prev_close, fetched_at FROM price_snapshots')
    .all();
  const bySymbol = Object.fromEntries((snapshots || []).map((s) => [s.symbol, s]));

  let totalCost = 0;
  let totalValue = 0;
  let updatedAt = null;
  const priced = holdings.map((h) => {
    const snap = bySymbol[h.symbol];
    const price = snap ? snap.price : h.avg_buy_price;
    const cost = h.quantity * h.avg_buy_price;
    const value = h.quantity * price;
    totalCost += cost;
    totalValue += value;
    if (snap && (!updatedAt || snap.fetched_at > updatedAt)) updatedAt = snap.fetched_at;
    return { ...h, price, prevClose: snap ? snap.prev_close : null, value };
  });

  const out = priced.map((h) => ({
    symbol: h.symbol,
    exchange: h.exchange,
    gainPct: pct(h.price - h.avg_buy_price, h.avg_buy_price),
    dayChangePct: h.prevClose ? pct(h.price - h.prevClose, h.prevClose) : null,
    weightPct: totalValue ? round2((h.value / totalValue) * 100) : null,
  }));

  return json(
    { holdings: out, totalGainPct: totalCost ? pct(totalValue - totalCost, totalCost) : null, updatedAt },
    200,
    cors
  );
}

async function addHolding(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const symbol = String(data.symbol || '').trim().toUpperCase();
  const exchange = String(data.exchange || 'NSE').trim().toUpperCase();
  const quantity = Number(data.quantity);
  const buyPrice = Number(data.buyPrice);
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  if (!quantity || quantity <= 0) return json({ error: 'Missing or invalid quantity' }, 400, cors);
  if (!buyPrice || buyPrice <= 0) return json({ error: 'Missing or invalid buyPrice' }, 400, cors);

  const now = new Date().toISOString();
  await env.DB
    .prepare(
      'INSERT INTO holdings (symbol, exchange, quantity, avg_buy_price, added_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(symbol) DO UPDATE SET exchange = excluded.exchange, quantity = excluded.quantity, avg_buy_price = excluded.avg_buy_price, added_at = excluded.added_at'
    )
    .bind(symbol, exchange, quantity, buyPrice, now)
    .run();

  // Best-effort: seed today's price immediately so the page isn't stale until the next cron run.
  const quote = await fetchYahooQuote(symbol, exchange);
  if (quote) {
    await env.DB
      .prepare(
        'INSERT INTO price_snapshots (symbol, price, prev_close, fetched_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, fetched_at = excluded.fetched_at'
      )
      .bind(symbol, quote.price, quote.prevClose, now)
      .run();
  }

  return json({ ok: true }, 201, cors);
}

async function removeHolding(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const symbol = String(data.symbol || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  await env.DB.prepare('DELETE FROM holdings WHERE symbol = ?').bind(symbol).run();
  return json({ ok: true }, 200, cors);
}

// ---------- Watchlist ----------

async function getWatchlist(env, cors) {
  const { results: items } = await env.DB
    .prepare('SELECT symbol, exchange, added_price, added_at FROM watchlist')
    .all();
  if (!items || items.length === 0) return json({ items: [] }, 200, cors);

  const { results: snapshots } = await env.DB
    .prepare('SELECT symbol, price, prev_close FROM price_snapshots')
    .all();
  const bySymbol = Object.fromEntries((snapshots || []).map((s) => [s.symbol, s]));

  const out = items.map((w) => {
    const snap = bySymbol[w.symbol];
    const price = snap ? snap.price : w.added_price;
    return {
      symbol: w.symbol,
      exchange: w.exchange,
      changeSinceAddedPct: pct(price - w.added_price, w.added_price),
      dayChangePct: snap && snap.prev_close ? pct(price - snap.prev_close, snap.prev_close) : null,
      addedAt: w.added_at,
    };
  });

  return json({ items: out }, 200, cors);
}

async function addWatchlistSymbol(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const symbol = String(data.symbol || '').trim().toUpperCase();
  const exchange = String(data.exchange || 'NSE').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);

  const quote = await fetchYahooQuote(symbol, exchange);
  if (!quote) return json({ error: 'Could not fetch a price for that symbol' }, 502, cors);

  const now = new Date().toISOString();
  await env.DB
    .prepare(
      'INSERT INTO watchlist (symbol, exchange, added_price, added_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(symbol) DO UPDATE SET exchange = excluded.exchange, added_price = excluded.added_price, added_at = excluded.added_at'
    )
    .bind(symbol, exchange, quote.price, now)
    .run();
  await env.DB
    .prepare(
      'INSERT INTO price_snapshots (symbol, price, prev_close, fetched_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, fetched_at = excluded.fetched_at'
    )
    .bind(symbol, quote.price, quote.prevClose, now)
    .run();

  return json({ ok: true }, 201, cors);
}

async function removeWatchlistSymbol(request, env, cors) {
  const data = await request.json().catch(() => ({}));
  const symbol = String(data.symbol || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol' }, 400, cors);
  await env.DB.prepare('DELETE FROM watchlist WHERE symbol = ?').bind(symbol).run();
  return json({ ok: true }, 200, cors);
}

// ---------- Price feed (Yahoo Finance, no auth — safe to run on a cron) ----------

const YAHOO_SUFFIX = { NSE: '.NS', BSE: '.BO' };

async function fetchYahooQuote(symbol, exchange) {
  const suffix = YAHOO_SUFFIX[exchange] || '.NS';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${suffix}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
    return {
      price: meta.regularMarketPrice,
      prevClose: meta.previousClose ?? meta.chartPreviousClose ?? null,
    };
  } catch {
    return null;
  }
}

async function refreshAllPrices(env) {
  const { results: holdingSymbols } = await env.DB.prepare('SELECT symbol, exchange FROM holdings').all();
  const { results: watchSymbols } = await env.DB.prepare('SELECT symbol, exchange FROM watchlist').all();

  const bySymbol = new Map();
  for (const row of [...(holdingSymbols || []), ...(watchSymbols || [])]) bySymbol.set(row.symbol, row.exchange);
  if (bySymbol.size === 0) return;

  const now = new Date().toISOString();
  const statements = [];
  for (const [symbol, exchange] of bySymbol) {
    const quote = await fetchYahooQuote(symbol, exchange);
    if (!quote) continue;
    statements.push(
      env.DB
        .prepare(
          'INSERT INTO price_snapshots (symbol, price, prev_close, fetched_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, prev_close = excluded.prev_close, fetched_at = excluded.fetched_at'
        )
        .bind(symbol, quote.price, quote.prevClose, now)
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

// ---------- Helpers ----------

function isAdmin(request, env) {
  const token = request.headers.get('x-admin-token') || '';
  return !!env.ADMIN_TOKEN && token === env.ADMIN_TOKEN;
}

function pct(delta, base) {
  if (!base) return null;
  return round2((delta / base) * 100);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
