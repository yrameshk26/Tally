/**
 * How long an MCP connector stays signed in. The window comes from
 * MCP_SESSION_DAYS (30 by default), slides forward on every authenticated
 * request and every refresh, survives an expired access token, and tolerates
 * concurrent or retried refreshes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MCP_SESSION_DAYS, sessionDays } from '../src/config.ts';
import { initDb, openDb, type DB } from '../src/db.ts';
import {
  ACCESS_TTL_MS,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TTL_MS,
  hashToken,
  issueTokens,
  refreshTokens,
  registerClient,
  verifyAccessToken,
} from '../src/oauth.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-05T12:00:00.000Z');

let db: DB;
let clientId: string;

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  clientId = registerClient(db, { client_name: 'Test', redirect_uris: ['https://example.test/cb'] }).client_id;
});

function refreshExpiry(refresh: string): number {
  const row = db.prepare('SELECT refresh_expires_at FROM oauth_tokens WHERE refresh_hash = ?').get(hashToken(refresh)) as
    | { refresh_expires_at: string }
    | undefined;
  return row ? Date.parse(row.refresh_expires_at) : NaN;
}

const issue = (ttl = REFRESH_TTL_MS, now = T0) =>
  issueTokens(db, { client_id: clientId, username: 'owner', scope: null }, ttl, now);

describe('MCP_SESSION_DAYS', () => {
  it('defaults to 30 days', () => {
    expect(DEFAULT_MCP_SESSION_DAYS).toBe(30);
    expect(sessionDays(undefined)).toBe(30);
    expect(sessionDays('')).toBe(30);
  });

  it('takes a whole number of days from 1 to 365, and falls back to 30 otherwise', () => {
    expect(sessionDays('90')).toBe(90);
    expect(sessionDays(' 7 ')).toBe(7);
    for (const bad of ['0', '-3', '1.5', 'abc', '366']) expect(sessionDays(bad)).toBe(30);
  });

  it('sets the refresh window the server uses', async () => {
    vi.resetModules();
    const before = process.env['MCP_SESSION_DAYS'];
    process.env['MCP_SESSION_DAYS'] = '45';
    try {
      const fresh = await import('../src/oauth.ts');
      expect(fresh.REFRESH_TTL_MS).toBe(45 * DAY);
    } finally {
      if (before === undefined) delete process.env['MCP_SESSION_DAYS'];
      else process.env['MCP_SESSION_DAYS'] = before;
      vi.resetModules();
    }
  });

  it('is 30 days when unset', () => {
    if (process.env['MCP_SESSION_DAYS'] === undefined) expect(REFRESH_TTL_MS).toBe(30 * DAY);
  });
});

describe('sliding session', () => {
  it('a new pair gets the full window', () => {
    const t = issue();
    expect(refreshExpiry(t.refresh_token)).toBe(T0 + REFRESH_TTL_MS);
  });

  it('every authenticated request resets the window to the full TTL', () => {
    const t = issue();
    const later = T0 + 20 * 60 * 1000;
    expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, later)).not.toBeNull();
    expect(refreshExpiry(t.refresh_token)).toBe(later + REFRESH_TTL_MS);
  });

  it('a connector used every few weeks never signs out', () => {
    let t = issue();
    let now = T0;
    for (let i = 0; i < 6; i++) {
      now += 25 * DAY; // under the 30-day window each time, 150 days in total
      // The stale access token is refused, the refresh still works.
      expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, now)).toBeNull();
      const next = refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now);
      expect(next).not.toBeNull();
      t = next!;
      expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, now + 1000)).not.toBeNull();
    }
  });

  it('an expired access token does not take its refresh token with it', () => {
    const t = issue();
    const now = T0 + ACCESS_TTL_MS + 1000;
    expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, now)).toBeNull();
    expect(refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now)).not.toBeNull();
  });

  it('a session left unused past the window is signed out', () => {
    const t = issue();
    const now = T0 + REFRESH_TTL_MS + 1000;
    expect(refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now)).toBeNull();
    // and the dead row is cleaned up when the access token is presented
    expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, now)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 0 });
  });

  it('honours a custom window', () => {
    const t = issue(7 * DAY);
    expect(refreshTokens(db, t.refresh_token, clientId, 7 * DAY, T0 + 8 * DAY)).toBeNull();
    const u = issue(7 * DAY);
    const r = refreshTokens(db, u.refresh_token, clientId, 7 * DAY, T0 + 6 * DAY)!;
    expect(refreshExpiry(r.refresh_token)).toBe(T0 + 13 * DAY);
  });
});

describe('rotation', () => {
  it('carries the full window to the new refresh token', () => {
    const t = issue();
    const now = T0 + 10 * DAY;
    const r = refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now)!;
    expect(refreshExpiry(r.refresh_token)).toBe(now + REFRESH_TTL_MS);
  });

  it('two refreshes with the same token at once both succeed', () => {
    const t = issue();
    const now = T0 + 2 * ACCESS_TTL_MS;
    const a = refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now);
    const b = refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now + 500);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(verifyAccessToken(db, a!.access_token, REFRESH_TTL_MS, now + 1000)).not.toBeNull();
    expect(verifyAccessToken(db, b!.access_token, REFRESH_TTL_MS, now + 1000)).not.toBeNull();
  });

  it('a rotated refresh token is refused once the grace window has passed', () => {
    const t = issue();
    const now = T0 + 2 * ACCESS_TTL_MS;
    expect(refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now)).not.toBeNull();
    expect(refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now + REFRESH_REUSE_GRACE_MS + 1)).toBeNull();
  });

  it('using a rotated pair does not extend it', () => {
    const t = issue();
    const now = T0 + 10 * 60 * 1000;
    refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now);
    expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, now + 1000)).not.toBeNull();
    expect(refreshExpiry(t.refresh_token)).toBe(now + REFRESH_REUSE_GRACE_MS);
    expect(verifyAccessToken(db, t.access_token, REFRESH_TTL_MS, now + REFRESH_REUSE_GRACE_MS + 1)).toBeNull();
  });

  it('refuses another client', () => {
    const t = issue();
    expect(refreshTokens(db, t.refresh_token, 'someone-else', REFRESH_TTL_MS, T0 + 1000)).toBeNull();
  });
});
