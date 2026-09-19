/**
 * Sessions carry every balance in the database, so the interesting cases are
 * the ones where a session should stop working: abandoned, too old, or signed
 * out elsewhere. Two clocks run independently — the absolute lifetime from
 * sign-in, and inactivity since the last request — and neither may quietly
 * extend the other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.ts';
import { initDb, openDb, type DB } from '../src/db.ts';
import {
  SESSION_TTL_MS,
  createSession,
  destroyAllSessions,
  getSession,
  idleMs,
  listSessions,
  purgeExpiredSessions,
  touchSession,
} from '../src/auth/session.ts';

/**
 * config.ts snapshots process.env at import, and these tests need several
 * different windows, so they set the value directly. idleMs() reads it on
 * every call, which is what makes that work.
 */
const setIdleMinutes = (minutes: number): void => {
  (config as { sessionIdleMinutes: number }).sessionIdleMinutes = minutes;
};
const original = config.sessionIdleMinutes;

let db: DB;
const MINUTE = 60_000;

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  setIdleMinutes(30);
});

afterEach(() => setIdleMinutes(original));

describe('the idle timeout', () => {
  it('defaults to 30 minutes, because this is financial data on a browser tab', () => {
    setIdleMinutes(original);
    expect(original).toBe(30);
    expect(idleMs()).toBe(30 * MINUTE);
  });

  it('keeps a session that is being used', () => {
    const s = createSession(db, 'me');
    const now = Date.now() + 29 * MINUTE;
    expect(getSession(db, s.id, now)?.id).toBe(s.id);
  });

  it('ends one that has been idle past the window', () => {
    const s = createSession(db, 'me');
    expect(getSession(db, s.id, Date.now() + 31 * MINUTE)).toBeNull();
  });

  it('deletes the row rather than leaving it to be found later', () => {
    const s = createSession(db, 'me');
    getSession(db, s.id, Date.now() + 31 * MINUTE);
    expect(listSessions(db)).toHaveLength(0);
  });

  it('measures from the last request, not from sign-in', () => {
    const s = createSession(db, 'me');
    // Used every 20 minutes for two hours: each call moves last_seen_at, so
    // the window never runs out.
    let now = Date.now();
    for (let i = 0; i < 6; i += 1) {
      now += 20 * MINUTE;
      expect(getSession(db, s.id, now)?.id, `after ${String(i)} gaps`).toBe(s.id);
    }
    // Then abandoned.
    expect(getSession(db, s.id, now + 31 * MINUTE)).toBeNull();
  });

  it('is off when the window is zero, leaving only the absolute lifetime', () => {
    setIdleMinutes(0);
    const s = createSession(db, 'me');
    expect(idleMs()).toBe(0);
    expect(getSession(db, s.id, Date.now() + 3 * 24 * 60 * MINUTE)?.id).toBe(s.id);
  });
});

describe('the absolute lifetime', () => {
  it('ends a session a week after sign-in however much it is used', () => {
    const s = createSession(db, 'me');
    const start = Date.now();
    // Kept warm for the whole week: a request every twenty minutes, which is
    // inside the idle window, so only the absolute clock can end this.
    for (let t = 20 * MINUTE; t < SESSION_TTL_MS; t += 20 * MINUTE) {
      expect(getSession(db, s.id, start + t)?.id).toBe(s.id);
    }
    expect(getSession(db, s.id, start + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('is not pushed out by activity', () => {
    const s = createSession(db, 'me');
    const before = s.expires_at;
    const seen = getSession(db, s.id, Date.now() + 20 * MINUTE);
    expect(seen?.expires_at).toBe(before);
    expect(seen?.last_seen_at).not.toBe(s.last_seen_at);
  });
});

describe('recording activity', () => {
  it('throttles the write, but never past the point where it would expire early', () => {
    const s = createSession(db, 'me');
    const start = Date.parse(s.last_seen_at);
    // A request one minute in must not cost a write.
    const quiet = getSession(db, s.id, start + MINUTE);
    expect(quiet?.last_seen_at).toBe(s.last_seen_at);
    // One six minutes in must, or last_seen_at would drift far enough behind
    // that a session in continuous use could be treated as idle.
    const written = getSession(db, s.id, start + 6 * MINUTE);
    expect(written?.last_seen_at).not.toBe(s.last_seen_at);
  });

  it('the heartbeat writes immediately, since that is its only job', () => {
    const s = createSession(db, 'me');
    const now = Date.parse(s.last_seen_at) + 1_000;
    expect(touchSession(db, s, now).last_seen_at).not.toBe(s.last_seen_at);
  });
});

describe('purging', () => {
  it('sweeps idle sessions as well as expired ones', () => {
    createSession(db, 'me');
    expect(purgeExpiredSessions(db, Date.now() + 31 * MINUTE)).toBe(1);
    expect(listSessions(db)).toHaveLength(0);
  });

  it('leaves a live session alone', () => {
    createSession(db, 'me');
    expect(purgeExpiredSessions(db, Date.now() + 5 * MINUTE)).toBe(0);
    expect(listSessions(db)).toHaveLength(1);
  });

  it('signing out everywhere still takes them all', () => {
    createSession(db, 'me');
    createSession(db, 'me');
    expect(destroyAllSessions(db)).toBe(2);
  });
});
