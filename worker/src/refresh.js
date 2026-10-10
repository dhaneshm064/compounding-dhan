// Shared across Worker isolates, regions and browser tabs via D1.
export const REFRESH_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS portfolio_refresh_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    next_allowed_at INTEGER NOT NULL DEFAULT 0,
    refreshed_at TEXT,
    prices_json TEXT
  )
`;
const initialized = new WeakSet();
const COOLDOWN_MS = 15 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;

export async function guardedPortfolioRefresh(db, refresh, {
  now = Date.now,
  newToken = () => crypto.randomUUID(),
} = {}) {
  if (!initialized.has(db)) {
    await db.prepare(REFRESH_STATE_SCHEMA).run();
    initialized.add(db);
  }
  const started = now();
  const token = newToken();
  // One atomic statement claims an expired lease only outside the cooldown.
  const claim = await db.prepare(`
    INSERT INTO portfolio_refresh_state (id, lease_token, lease_until)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET lease_token = excluded.lease_token,
      lease_until = excluded.lease_until
    WHERE portfolio_refresh_state.lease_until <= ?
      AND portfolio_refresh_state.next_allowed_at <= ?
  `).bind(token, started + LEASE_MS, started, started).run();

  if (!claim.meta?.changes) {
    const state = await db.prepare('SELECT * FROM portfolio_refresh_state WHERE id = 1').first();
    const inProgress = state.lease_until > started;
    return {
      status: inProgress ? 202 : state.prices_json ? 200 : 503,
      body: {
        ok: !inProgress && !!state.prices_json,
        cached: !inProgress,
        inProgress,
        refreshedAt: state.refreshed_at,
        retryAfterSeconds: Math.max(1, Math.ceil(((inProgress ? state.lease_until : state.next_allowed_at) - started) / 1000)),
        ...(state.prices_json ? { prices: JSON.parse(state.prices_json) } : {}),
        ...(!inProgress && !state.prices_json ? { error: 'The previous refresh failed. Please retry after the cooldown.' } : {}),
      },
    };
  }

  try {
    const result = await refresh();
    const prices = result?.prices;
    if (!prices || !Number.isFinite(prices.rowsWritten) || !Array.isArray(prices.failed)) {
      throw new Error('Price refresh result is missing');
    }
    // Store only public refresh counters, not internal upstream payloads.
    const publicPrices = { rowsWritten: prices.rowsWritten, failed: prices.failed };
    const completed = now();
    const refreshedAt = new Date(completed).toISOString();
    const updated = await db.prepare(`
      UPDATE portfolio_refresh_state SET lease_token = NULL, lease_until = 0,
        next_allowed_at = ?, refreshed_at = ?, prices_json = ?
      WHERE id = 1 AND lease_token = ?
    `).bind(completed + (prices.failed.length ? FAILURE_COOLDOWN_MS : COOLDOWN_MS), refreshedAt, JSON.stringify(publicPrices), token).run();
    if (!updated.meta?.changes) {
      return { status: 202, body: { ok: false, inProgress: true, cached: false, retryAfterSeconds: 30 } };
    }
    return { status: 200, body: { ok: true, cached: false, inProgress: false, refreshedAt, prices: publicPrices } };
  } catch (error) {
    await db.prepare(`
      UPDATE portfolio_refresh_state SET lease_token = NULL, lease_until = 0,
        next_allowed_at = ?, prices_json = NULL
      WHERE id = 1 AND lease_token = ?
    `).bind(now() + FAILURE_COOLDOWN_MS, token).run();
    // Detailed failures belong in Worker logs, not the public response.
    console.error('Portfolio refresh failed', error);
    return { status: 503, body: { ok: false, cached: false, inProgress: false, error: 'Refresh failed. Please retry in two minutes.', retryAfterSeconds: 120 } };
  }
}
