/**
 * OAuth 2.1 authorization server, sized for one household.
 *
 * Why this exists: the MCP endpoint used to authenticate with a secret in the
 * URL path. That is a bearer token in the one place bearer tokens must never
 * go — it lands in browser history, screen shares, and reverse-proxy access
 * logs (Traefik writes every request path to disk by default, which is how the
 * original secret leaked on this very deployment).
 *
 * Design notes, all deliberate for a single-user server:
 *  - Clients are PUBLIC and register dynamically (RFC 7591). There is no client
 *    secret to leak; PKCE S256 is mandatory instead.
 *  - Tokens are opaque random strings, stored only as SHA-256 hashes. A stolen
 *    database yields no usable token, and revocation is a DELETE — which a JWT
 *    could not offer without a blocklist anyway.
 *  - The resource owner is the UI login, so consent already sits behind a
 *    password and a TOTP code.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { nowISO } from './lib/money.ts';

/** Short, because a code is exchanged immediately by a well-behaved client. */
export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SCOPE = 'tally:read';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are looked up by hash, so the plaintext exists only in transit. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type OAuthClient = {
  client_id: string;
  client_name: string | null;
  redirect_uris: string;
  created_at: string;
  last_used_at: string | null;
};

/**
 * A redirect URI must be an exact, pre-registered match. Loopback is allowed
 * for desktop clients; everything else must be HTTPS, or an attacker who can
 * register a client could have codes delivered to plaintext.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}

export function registerClient(
  db: DB,
  opts: { client_name?: string | null; redirect_uris: string[] },
): OAuthClient {
  const uris = opts.redirect_uris.filter(isAllowedRedirectUri);
  if (uris.length === 0) throw new Error('at least one https (or loopback) redirect_uri is required');
  const clientId = randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(clientId, opts.client_name ?? null, JSON.stringify(uris), nowISO());
  return getClient(db, clientId)!;
}

export function getClient(db: DB, clientId: string): OAuthClient | null {
  return (
    (db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as
      | OAuthClient
      | undefined) ?? null
  );
}

export function clientRedirectUris(client: OAuthClient): string[] {
  try {
    const parsed = JSON.parse(client.redirect_uris) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function listClients(db: DB): Array<OAuthClient & { tokens: number }> {
  return (db.prepare('SELECT * FROM oauth_clients ORDER BY created_at DESC').all() as OAuthClient[]).map(
    (c) => ({
      ...c,
      tokens: (
        db
          .prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE client_id = ?')
          .get(c.client_id) as { n: number }
      ).n,
    }),
  );
}

/** Revoking a client drops its tokens too — otherwise it keeps working. */
export function revokeClient(db: DB, clientId: string): boolean {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM oauth_tokens WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM oauth_codes WHERE client_id = ?').run(clientId);
    return db.prepare('DELETE FROM oauth_clients WHERE client_id = ?').run(clientId).changes > 0;
  });
  return tx();
}

export function issueCode(
  db: DB,
  opts: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    challenge_method: string;
    scope: string | null;
    resource: string | null;
    username: string;
  },
): string {
  const code = newToken();
  db.prepare(
    `INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, challenge_method,
                              scope, resource, username, expires_at)
     VALUES (@code, @client_id, @redirect_uri, @code_challenge, @challenge_method,
             @scope, @resource, @username, @expires_at)`,
  ).run({ ...opts, code, expires_at: nowISO(new Date(Date.now() + CODE_TTL_MS)) });
  return code;
}

export type CodeRow = {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  challenge_method: string;
  scope: string | null;
  resource: string | null;
  username: string;
  expires_at: string;
  used: number;
};

/** RFC 7636 S256. `plain` is refused — OAuth 2.1 removed it. */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Consume an authorization code. Single use: a replayed code is not merely
 * rejected, it revokes every token already issued from it, because a replay
 * means the code leaked.
 */
export function consumeCode(
  db: DB,
  code: string,
  clientId: string,
  redirectUri: string,
  verifier: string,
): { ok: true; row: CodeRow } | { ok: false; error: string } {
  const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code) as
    | CodeRow
    | undefined;
  if (!row) return { ok: false, error: 'invalid_grant' };

  if (row.used) {
    db.prepare('DELETE FROM oauth_tokens WHERE client_id = ? AND username = ?').run(
      row.client_id,
      row.username,
    );
    db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(code);
    return { ok: false, error: 'invalid_grant' };
  }
  db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);

  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, error: 'invalid_grant' };
  if (row.client_id !== clientId) return { ok: false, error: 'invalid_grant' };
  if (row.redirect_uri !== redirectUri) return { ok: false, error: 'invalid_grant' };
  if (!verifyPkce(verifier, row.code_challenge, row.challenge_method)) {
    return { ok: false, error: 'invalid_grant' };
  }
  return { ok: true, row };
}

export type IssuedTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: 'Bearer';
};

export function issueTokens(
  db: DB,
  opts: { client_id: string; username: string; scope: string | null },
): IssuedTokens {
  const access = newToken();
  const refresh = newToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO oauth_tokens (access_hash, refresh_hash, client_id, username, scope,
                               expires_at, refresh_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(access),
    hashToken(refresh),
    opts.client_id,
    opts.username,
    opts.scope ?? SCOPE,
    nowISO(new Date(now + ACCESS_TTL_MS)),
    nowISO(new Date(now + REFRESH_TTL_MS)),
    nowISO(new Date(now)),
  );
  db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(
    nowISO(new Date(now)),
    opts.client_id,
  );
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: opts.scope ?? SCOPE,
    token_type: 'Bearer',
  };
}

/** Refresh tokens rotate: using one invalidates it and issues a fresh pair. */
export function refreshTokens(
  db: DB,
  refreshToken: string,
  clientId: string,
): IssuedTokens | null {
  const row = db
    .prepare('SELECT * FROM oauth_tokens WHERE refresh_hash = ?')
    .get(hashToken(refreshToken)) as
    | { id: number; client_id: string; username: string; scope: string | null; refresh_expires_at: string }
    | undefined;
  if (!row) return null;
  if (row.client_id !== clientId) return null;
  if (Date.parse(row.refresh_expires_at) <= Date.now()) return null;

  db.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(row.id);
  return issueTokens(db, { client_id: row.client_id, username: row.username, scope: row.scope });
}

export type TokenIdentity = { username: string; client_id: string; scope: string | null };

/** Validate a bearer token. Expired rows are deleted rather than left to rot. */
export function verifyAccessToken(db: DB, token: string): TokenIdentity | null {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE access_hash = ?').get(hashToken(token)) as
    | { id: number; username: string; client_id: string; scope: string | null; expires_at: string }
    | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM oauth_tokens WHERE id = ?').run(row.id);
    return null;
  }
  db.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?').run(nowISO(), row.id);
  return { username: row.username, client_id: row.client_id, scope: row.scope };
}

export function purgeExpiredOauth(db: DB, now = Date.now()): number {
  const ts = nowISO(new Date(now));
  const codes = db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(ts).changes;
  const tokens = db
    .prepare('DELETE FROM oauth_tokens WHERE COALESCE(refresh_expires_at, expires_at) <= ?')
    .run(ts).changes;
  return codes + tokens;
}
