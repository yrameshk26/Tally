/**
 * How long an MCP connector stays signed in. The window comes from
 * MCP_SESSION_DAYS (30 by default), slides forward on every authenticated
 * request and every refresh, survives an expired access token, and tolerates
 * concurrent or retried refreshes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MCP_SESSION_DAYS, sessionDays, sessionMaxDays } from '../src/config.ts';
import { initDb, openDb, type DB } from '../src/db.ts';
import {
  ACCESS_TTL_MS,
  CODE_RETENTION_MS,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TTL_MS,
  consumeCode,
  hashToken,
  issueCode,
  issueTokens,
  purgeExpiredOauth,
  refreshTokens,
  registerClient,
  verifyAccessToken,
} from '../src/oauth.ts';
import { createHash, randomBytes } from 'node:crypto';

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
    // Digits only: Number() alone would accept exponent, hex and padded forms.
    for (const bad of ['0', '-3', '1.5', 'abc', '366', '1e2', '0x10', '+7', '7 days']) {
      expect(sessionDays(bad)).toBe(30);
    }
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

  it('is 30 days when the variable is not set', async () => {
    vi.resetModules();
    const before = process.env['MCP_SESSION_DAYS'];
    delete process.env['MCP_SESSION_DAYS'];
    try {
      const fresh = await import('../src/oauth.ts');
      expect(fresh.REFRESH_TTL_MS).toBe(30 * DAY);
      expect(fresh.SESSION_MAX_MS).toBe(0);
    } finally {
      if (before !== undefined) process.env['MCP_SESSION_DAYS'] = before;
      vi.resetModules();
    }
  });
});

describe('MCP_SESSION_MAX_DAYS', () => {
  it('is off unless set to a whole number of days from 1 to 3650', () => {
    expect(sessionMaxDays(undefined)).toBe(0);
    expect(sessionMaxDays('')).toBe(0);
    expect(sessionMaxDays('180')).toBe(180);
    expect(sessionMaxDays(' 365 ')).toBe(365);
    for (const bad of ['0', '-1', '1.5', 'abc', '3651', '1e2']) expect(sessionMaxDays(bad)).toBe(0);
  });

  it('sets the cap the server uses', async () => {
    vi.resetModules();
    const before = process.env['MCP_SESSION_MAX_DAYS'];
    process.env['MCP_SESSION_MAX_DAYS'] = '90';
    try {
      const fresh = await import('../src/oauth.ts');
      expect(fresh.SESSION_MAX_MS).toBe(90 * DAY);
    } finally {
      if (before === undefined) delete process.env['MCP_SESSION_MAX_DAYS'];
      else process.env['MCP_SESSION_MAX_DAYS'] = before;
      vi.resetModules();
    }
  });
});

describe('the optional absolute cap', () => {
  const CAP = 60 * DAY;
  const started = (refresh: string): number => {
    const row = db.prepare('SELECT session_started_at FROM oauth_tokens WHERE refresh_hash = ?').get(hashToken(refresh)) as {
      session_started_at: string;
    };
    return Date.parse(row.session_started_at);
  };

  it('with no cap a connector used often never signs out (the default)', () => {
    let t = issue();
    let now = T0;
    for (let i = 0; i < 20; i++) {
      now += 25 * DAY; // 500 days
      t = refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now, 0)!;
      expect(t).not.toBeNull();
    }
  });

  it('sliding never pushes the refresh token past the cap', () => {
    const WINDOW = 50 * DAY;
    const t = issueTokens(db, { client_id: clientId, username: 'owner', scope: null }, WINDOW, T0, T0, CAP);
    const later = T0 + 40 * DAY;
    // At day 40 a refresh would slide to day 90; the cap holds it at day 60.
    const r = refreshTokens(db, t.refresh_token, clientId, WINDOW, later, CAP)!;
    expect(refreshExpiry(r.refresh_token)).toBe(T0 + CAP);
    // So does an ordinary request with the new access token.
    expect(verifyAccessToken(db, r.access_token, WINDOW, later + 1000, CAP)).not.toBeNull();
    expect(refreshExpiry(r.refresh_token)).toBe(T0 + CAP);
  });

  it('rotation carries the original start, so refreshing cannot reset the cap', () => {
    let t = issueTokens(db, { client_id: clientId, username: 'owner', scope: null }, REFRESH_TTL_MS, T0, T0, CAP);
    let now = T0;
    for (let i = 0; i < 2; i++) {
      now += 25 * DAY;
      t = refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, now, CAP)!;
      expect(started(t.refresh_token)).toBe(T0);
    }
    // Day 75: past the cap, so the connector must sign in again however recently it was used.
    expect(refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, T0 + 75 * DAY, CAP)).toBeNull();
  });

  it('a refresh inside the grace window cannot reach past the cap either', () => {
    // A window as long as the cap, so the original token is still alive at the edge.
    const t = issueTokens(db, { client_id: clientId, username: 'owner', scope: null }, CAP, T0, T0, CAP);
    const edge = T0 + CAP - 1000;
    const a = refreshTokens(db, t.refresh_token, clientId, CAP, edge, CAP)!;
    expect(a).not.toBeNull();
    expect(refreshExpiry(a.refresh_token)).toBe(T0 + CAP);
    // Reusing the retired token within its grace window still cannot go past day 60.
    const b = refreshTokens(db, t.refresh_token, clientId, CAP, edge + 500, CAP)!;
    expect(refreshExpiry(b.refresh_token)).toBe(T0 + CAP);
    expect(refreshTokens(db, t.refresh_token, clientId, CAP, T0 + CAP + 1, CAP)).toBeNull();
  });

  it('rows from before the column count from their own issue time', () => {
    const t = issueTokens(db, { client_id: clientId, username: 'owner', scope: null }, REFRESH_TTL_MS, T0, T0, 0);
    db.prepare('UPDATE oauth_tokens SET session_started_at = NULL').run();
    expect(refreshTokens(db, t.refresh_token, clientId, REFRESH_TTL_MS, T0 + 61 * DAY, CAP)).toBeNull();
  });
});

describe('authorization codes and replay', () => {
  const REDIRECT = 'https://example.test/cb';
  function consumedCode(): { code: string; verifier: string } {
    const verifier = randomBytes(48).toString('base64url');
    const code = issueCode(db, {
      client_id: clientId, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      challenge_method: 'S256', scope: null, resource: null, username: 'owner',
    });
    expect(consumeCode(db, code, clientId, REDIRECT, verifier).ok).toBe(true);
    return { code, verifier };
  }

  it('a replayed code still revokes its tokens minutes after it expired and the table was purged', () => {
    const { code, verifier } = consumedCode();
    const t = issue(REFRESH_TTL_MS, Date.now());
    // A refresh runs the purge, long after the code's 60 seconds are up.
    purgeExpiredOauth(db, Date.now() + 5 * 60 * 1000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 1 });
    expect(consumeCode(db, code, clientId, REDIRECT, verifier).ok).toBe(false);
    expect(verifyAccessToken(db, t.access_token)).toBeNull();
  });

  it('used codes are purged once the retention period has passed, not before', () => {
    consumedCode();
    purgeExpiredOauth(db, Date.now() + CODE_RETENTION_MS - DAY);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 1 });
    purgeExpiredOauth(db, Date.now() + CODE_RETENTION_MS + 2 * 60 * 1000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 0 });
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
