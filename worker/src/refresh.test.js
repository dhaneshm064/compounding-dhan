import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { guardedPortfolioRefresh } from './refresh.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
        async first() { return sqlite.prepare(sql).get(...values); },
      };
    },
  };
  let clock = Date.parse('2026-10-10T12:00:00Z');
  let token = 0;
  return {
    db,
    options: { now: () => clock, newToken: () => String(++token) },
    advance(ms) { clock += ms; },
    close() { sqlite.close(); },
  };
}
const good = () => ({ prices: { rowsWritten: 1, failed: [] } });

test('recent successful refresh is shared across callers and expires after 15 minutes', async () => {
  const f = fixture();
  let calls = 0;
  const refresh = async () => { calls++; return { ...good(), internalPayload: 'private' }; };
  try {
    const first = await guardedPortfolioRefresh(f.db, refresh, f.options);
    assert.equal(first.status, 200);
    assert.equal(first.body.cached, false);
    assert.equal(first.body.internalPayload, undefined);
    const cached = await guardedPortfolioRefresh(f.db, refresh, f.options);
    assert.equal(cached.body.cached, true);
    assert.equal(calls, 1);
    f.advance(15 * 60 * 1000);
    await guardedPortfolioRefresh(f.db, refresh, f.options);
    assert.equal(calls, 2);
  } finally { f.close(); }
});

test('simultaneous callers cannot both start upstream work', async () => {
  const f = fixture();
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  try {
    const running = guardedPortfolioRefresh(f.db, () => {
      started();
      return new Promise((resolve) => { release = resolve; });
    }, f.options);
    await ready;
    const other = await guardedPortfolioRefresh(f.db, () => { throw new Error('must not start'); }, f.options);
    assert.equal(other.status, 202);
    assert.equal(other.body.inProgress, true);
    release(good());
    assert.equal((await running).status, 200);
  } finally { f.close(); }
});

test('partial price failures permit a retry after two minutes', async () => {
  const f = fixture();
  try {
    await guardedPortfolioRefresh(f.db, async () => ({ prices: { rowsWritten: 0, failed: ['^NSEI'] } }), f.options);
    assert.equal((await guardedPortfolioRefresh(f.db, good, f.options)).body.cached, true);
    f.advance(2 * 60 * 1000);
    assert.equal((await guardedPortfolioRefresh(f.db, good, f.options)).body.cached, false);
  } finally { f.close(); }
});

test('a failed refresh releases its lease and retains a two-minute retry cooldown', async () => {
  const f = fixture();
  try {
    const failed = await guardedPortfolioRefresh(f.db, () => { throw new Error('expected upstream failure'); }, f.options);
    assert.equal(failed.status, 503);
    const cooldown = await guardedPortfolioRefresh(f.db, good, f.options);
    assert.equal(cooldown.status, 503);
    f.advance(2 * 60 * 1000);
    assert.equal((await guardedPortfolioRefresh(f.db, good, f.options)).status, 200);
  } finally { f.close(); }
});

test('expired leases recover and old owners cannot overwrite the new result', async () => {
  const f = fixture();
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  try {
    const abandoned = guardedPortfolioRefresh(f.db, () => {
      started();
      return new Promise((resolve) => { release = resolve; });
    }, f.options);
    await ready;
    f.advance(10 * 60 * 1000);
    const recovered = await guardedPortfolioRefresh(f.db, async () => ({ prices: { rowsWritten: 9, failed: [] } }), f.options);
    assert.equal(recovered.status, 200);
    release(good());
    assert.equal((await abandoned).status, 202);
    const cached = await guardedPortfolioRefresh(f.db, good, f.options);
    assert.equal(cached.body.prices.rowsWritten, 9);
  } finally { f.close(); }
});
