/**
 * Comments + Likes API — a Cloudflare Worker backed by a D1 (SQLite) database.
 *
 * Routes:
 *   GET    /api/comments?post=ID            -> { comments: [...] }
 *   POST   /api/comments  {post,name,body}  -> { ok: true, comment: {...} }
 *   GET    /api/likes?post=ID&visitor=VID   -> { count, liked }
 *   POST   /api/likes     {post,visitor}    -> { count, liked: true }
 *   DELETE /api/likes     {post,visitor}    -> { count, liked: false }
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
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error', detail: String(err) }, 500, cors);
    }
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

// ---------- Helpers ----------

function corsHeaders(env) {
  const origin = (env && env.ALLOWED_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
