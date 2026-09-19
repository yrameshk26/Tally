/**
 * Server-side sessions.
 *
 * The cookie carries only an opaque random id; everything else lives in the
 * database. That makes logout and "revoke all sessions" real rather than
 * advisory, which a signed stateless cookie cannot offer.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import type { DB } from '../db.ts';
import { nowISO } from '../lib/money.ts';

export const COOKIE_NAME = 'tally_sid';
/**
 * Absolute lifetime, fixed at sign-in and never extended. It used to slide on
 * every request, which meant a session in daily use never expired at all.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A half-authenticated session, holding only the fact that a password was
 * accepted. Deliberately short: it is a window in which someone who has the
 * password but not the second factor is holding a cookie.
 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** Inactivity that ends a session, or 0 when the timeout is turned off. */
export function idleMs(): number {
  return Math.max(0, config.sessionIdleMinutes) * 60_000;
}

/**
 * How stale `last_seen_at` may get before a request writes it back. A write on
 * every request would be wasteful, but the throttle is also the error bar on
 * the idle timeout: a session can survive up to this long past it. A sixth of
 * the window keeps that under 17% and the writes to one per five minutes at
 * the default.
 */
function refreshAfterMs(idle: number): number {
  if (idle <= 0) return 60 * 60 * 1000;
  return Math.min(60 * 60 * 1000, Math.max(30_000, Math.round(idle / 6)));
}

export type Session = {
  id: string;
  username: string;
  csrf: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  /** 1 while the second factor is still outstanding. Grants nothing. */
  pending: number;
};

function token(): string {
  return randomBytes(32).toString('base64url');
}

export function createSession(
  db: DB,
  username: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
  opts: { pending?: boolean } = {},
): Session {
  const now = Date.now();
  const pending = opts.pending === true;
  const session: Session = {
    id: token(),
    username,
    csrf: token(),
    created_at: nowISO(new Date(now)),
    last_seen_at: nowISO(new Date(now)),
    expires_at: nowISO(new Date(now + (pending ? PENDING_TTL_MS : SESSION_TTL_MS))),
    ip: meta.ip ?? null,
    user_agent: (meta.userAgent ?? null)?.slice(0, 300) ?? null,
    pending: pending ? 1 : 0,
  };
  db.prepare(
    `INSERT INTO sessions (id, username, csrf, created_at, last_seen_at, expires_at, user_agent, ip, pending)
     VALUES (@id, @username, @csrf, @created_at, @last_seen_at, @expires_at, @user_agent, @ip, @pending)`,
  ).run(session);
  return session;
}

/**
 * Second factor accepted: clear the pending flag and issue a NEW session id.
 *
 * Rotating the id is what stops session fixation — an attacker who planted a
 * cookie before sign-in holds a value that is now dead.
 */
export function promoteSession(db: DB, id: string): Session | null {
  const current = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  if (!current) return null;
  const now = Date.now();
  const next: Session = {
    ...current,
    id: token(),
    csrf: token(),
    last_seen_at: nowISO(new Date(now)),
    expires_at: nowISO(new Date(now + SESSION_TTL_MS)),
    pending: 0,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, username, csrf, created_at, last_seen_at, expires_at, user_agent, ip, pending)
       VALUES (@id, @username, @csrf, @created_at, @last_seen_at, @expires_at, @user_agent, @ip, @pending)`,
    ).run(next);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  })();
  return next;
}

/**
 * Look up a session, treating a dead one as absent and deleting it. Returns
 * null for anything unusable so callers never have to check expiry themselves.
 *
 * Two clocks end a session: the absolute lifetime from sign-in, and the idle
 * timeout since the last request. Neither extends the other.
 */
export function getSession(db: DB, id: string | undefined, now = Date.now()): Session | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now) {
    destroySession(db, id);
    return null;
  }
  const idle = idleMs();
  if (idle > 0 && now - Date.parse(row.last_seen_at) >= idle) {
    destroySession(db, id);
    return null;
  }
  return touchSession(db, row, now, refreshAfterMs(idle));
}

/**
 * Record that a session is still in use. `after` throttles the write; pass 0
 * from the heartbeat, which exists precisely to move this timestamp.
 */
export function touchSession(db: DB, row: Session, now = Date.now(), after = 0): Session {
  if (now - Date.parse(row.last_seen_at) < after) return row;
  const lastSeen = nowISO(new Date(now));
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(lastSeen, row.id);
  return { ...row, last_seen_at: lastSeen };
}

export function destroySession(db: DB, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Used after a password change, and by the "sign out everywhere" action. */
export function destroyAllSessions(db: DB): number {
  return db.prepare('DELETE FROM sessions').run().changes;
}

/** Both clocks, so the nightly sweep clears idle sessions too. */
export function purgeExpiredSessions(db: DB, now = Date.now()): number {
  const idle = idleMs();
  const dead = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowISO(new Date(now)))
    .changes;
  if (idle <= 0) return dead;
  return (
    dead +
    db.prepare('DELETE FROM sessions WHERE last_seen_at <= ?').run(nowISO(new Date(now - idle)))
      .changes
  );
}

/** Only fully-authenticated sessions; a half-finished sign-in is not a device. */
export function listSessions(db: DB): Session[] {
  return db
    .prepare('SELECT * FROM sessions WHERE pending = 0 ORDER BY last_seen_at DESC')
    .all() as Session[];
}

/**
 * Parse a Cookie header. Written out rather than adding cookie-parser: it is
 * six lines and this repository is published.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure: boolean; expires?: Date },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  else if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  return parts.join('; ');
}
