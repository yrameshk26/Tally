/**
 * Server-side sessions.
 *
 * The cookie carries only an opaque random id; everything else lives in the
 * database. That makes logout and "revoke all sessions" real rather than
 * advisory, which a signed stateless cookie cannot offer.
 */
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.ts';
import { nowISO } from '../lib/money.ts';

export const COOKIE_NAME = 'tally_sid';
/** Absolute lifetime. Sliding refresh extends it while the session is in use. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A half-authenticated session, holding only the fact that a password was
 * accepted. Deliberately short: it is a window in which someone who has the
 * password but not the second factor is holding a cookie.
 */
export const PENDING_TTL_MS = 5 * 60 * 1000;
/** Refresh at most this often, to avoid a write on every request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

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
 * Look up a session, treating an expired row as absent and deleting it. Returns
 * null for anything unusable so callers never have to check expiry themselves.
 */
export function getSession(db: DB, id: string | undefined, now = Date.now()): Session | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now) {
    destroySession(db, id);
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > REFRESH_AFTER_MS) {
    const lastSeen = nowISO(new Date(now));
    const expires = nowISO(new Date(now + SESSION_TTL_MS));
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
      lastSeen,
      expires,
      id,
    );
    return { ...row, last_seen_at: lastSeen, expires_at: expires };
  }
  return row;
}

export function destroySession(db: DB, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Used after a password change, and by the "sign out everywhere" action. */
export function destroyAllSessions(db: DB): number {
  return db.prepare('DELETE FROM sessions').run().changes;
}

export function purgeExpiredSessions(db: DB, now = Date.now()): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowISO(new Date(now)))
    .changes;
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
