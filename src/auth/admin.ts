/**
 * The single household account.
 *
 * Identity comes from the environment (username + an Argon2id hash) because it
 * has to exist before anyone can log in — there is no sign-up, and a
 * first-request-claims-the-account flow would be a race anyone on the internet
 * could win. The TOTP secret lives in the database, encrypted, because it is
 * enrolled after the fact.
 */
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { decryptToken, encryptToken } from '../lib/crypto.ts';
import { nowISO } from '../lib/money.ts';
import { isHash } from './password.ts';

const TOTP_KEY = 'totp_secret';

export function adminUsername(): string {
  return config.adminUsername;
}

export function adminPasswordHash(): string {
  return config.adminPasswordHash;
}

/** Why the UI cannot be enabled, or null when it is properly configured. */
export function adminConfigError(): string | null {
  if (!config.adminUsername) return 'ADMIN_USERNAME is not set';
  if (!config.adminPasswordHash) return 'ADMIN_PASSWORD_HASH is not set';
  if (!isHash(config.adminPasswordHash)) {
    return 'ADMIN_PASSWORD_HASH is not an Argon2 hash — generate one with `npm run hash-password`';
  }
  if (!config.tokenEncKey) return 'TOKEN_ENC_KEY is not set, so the TOTP secret cannot be stored';
  return null;
}

function getAuth(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM auth WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setAuth(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO auth (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowISO());
}

export function totpEnabled(db: DB): boolean {
  return getAuth(db, TOTP_KEY) !== null;
}

export function getTotpSecret(db: DB): string | null {
  const stored = getAuth(db, TOTP_KEY);
  if (stored === null) return null;
  return decryptToken(stored, config.tokenEncKey);
}

export function setTotpSecret(db: DB, secretBase32: string): void {
  if (!config.tokenEncKey) {
    throw new Error('TOKEN_ENC_KEY must be set before enrolling a second factor');
  }
  setAuth(db, TOTP_KEY, encryptToken(secretBase32, config.tokenEncKey));
}

export function clearTotpSecret(db: DB): boolean {
  return db.prepare('DELETE FROM auth WHERE key = ?').run(TOTP_KEY).changes > 0;
}
