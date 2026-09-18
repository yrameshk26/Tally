/**
 * Runtime settings and provider secrets, stored in the database instead of the
 * environment.
 *
 * Why: environment variables leak broadly — they are visible in the host's
 * control panel, in `docker inspect`, in /proc/<pid>/environ, and they are
 * inherited by every child process. Moving provider credentials into the
 * database lets them be encrypted at rest and rotated through the UI without a
 * redeploy.
 *
 * What this does NOT achieve: zero secrets in the environment. The key that
 * decrypts these rows has to come from somewhere the app can read unattended,
 * or the nightly sync cannot run after a restart until a human logs in. So
 * TOKEN_ENC_KEY stays in env and acts as the key-encryption key. This reduces
 * N secrets to 1; it does not remove them. See SECURITY.md.
 *
 * Resolution order is DB first, env second, so an operator can start from a
 * pure-env deployment and migrate one key at a time without downtime.
 */
import type { DB } from './db.ts';
import { config } from './config.ts';
import { decryptToken, encryptToken } from './lib/crypto.ts';
import { nowISO } from './lib/money.ts';
import { errMessage, log } from './lib/logger.ts';

/** Keys that must never be stored or returned in the clear. */
export const SECRET_KEYS = new Set([
  'SNAPTRADE_CONSUMER_KEY',
  'PLAID_SECRET',
  'WISE_API_TOKEN',
]);

/** Provider settings the onboarding UI is allowed to write. */
export const MANAGED_KEYS = [
  'SNAPTRADE_CLIENT_ID',
  'SNAPTRADE_CONSUMER_KEY',
  'SNAPTRADE_TRANSPORT',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'WISE_API_TOKEN',
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

/**
 * Values the code falls back to when neither the database nor the environment
 * has one. These must be surfaced in the UI: a blank "Plaid environment" field
 * that silently means "production" is how a Sandbox secret ends up being sent
 * to the production API.
 */
export const DEFAULTS: Partial<Record<ManagedKey, string>> = {
  SNAPTRADE_TRANSPORT: 'rest',
  PLAID_ENV: 'production',
};

function isManaged(key: string): key is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(key);
}

/**
 * Read a setting. Database wins over environment so a value set in the UI
 * takes effect without a redeploy. Returns '' when neither has it, matching
 * how config.ts treats an unset variable.
 */
export function getSetting(db: DB, key: string): string {
  const row = db.prepare('SELECT value, is_secret FROM settings WHERE key = ?').get(key) as
    | { value: string; is_secret: number }
    | undefined;
  if (row) {
    if (!row.is_secret) return row.value;
    try {
      return decryptToken(row.value, config.tokenEncKey);
    } catch (e) {
      // A wrong or missing TOKEN_ENC_KEY must not look like "not configured",
      // or the sync would silently report {skipped} forever.
      log.error(`settings: cannot decrypt ${key} — is TOKEN_ENC_KEY correct?`, {
        error: errMessage(e),
      });
      throw new Error(`stored setting ${key} could not be decrypted`);
    }
  }
  return process.env[key] ?? '';
}

export function setSetting(db: DB, key: string, value: string): void {
  if (!isManaged(key)) throw new Error(`refusing to store unmanaged setting ${key}`);
  const secret = SECRET_KEYS.has(key);
  if (secret && !config.tokenEncKey) {
    throw new Error('TOKEN_ENC_KEY must be set before storing a secret in the database');
  }
  db.prepare(
    `INSERT INTO settings (key, value, is_secret, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret,
                                    updated_at = excluded.updated_at`,
  ).run(key, secret ? encryptToken(value, config.tokenEncKey) : value, secret ? 1 : 0, nowISO());
}

export function deleteSetting(db: DB, key: string): boolean {
  return db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
}

/**
 * What the UI may display: values for non-secrets, presence only for secrets.
 * A secret is never returned in the clear — not to a template, not to an API
 * response, not to a log line.
 */
export function describeSettings(db: DB): Array<{
  key: ManagedKey;
  source: 'database' | 'environment' | 'default' | 'unset';
  secret: boolean;
  value: string | null;
  effective: string | null;
  configured: boolean;
}> {
  const rows = db.prepare('SELECT key, is_secret FROM settings').all() as Array<{
    key: string;
    is_secret: number;
  }>;
  const inDb = new Set(rows.map((r) => r.key));

  return MANAGED_KEYS.map((key) => {
    const secret = SECRET_KEYS.has(key);
    const fromDb = inDb.has(key);
    const fromEnv = Boolean(process.env[key]);
    const fallback = DEFAULTS[key] ?? null;
    const source = fromDb
      ? 'database'
      : fromEnv
        ? 'environment'
        : fallback !== null
          ? 'default'
          : 'unset';
    let value: string | null = null;
    if (!secret && (fromDb || fromEnv)) {
      try {
        value = getSetting(db, key);
      } catch {
        value = null;
      }
    }
    return {
      key,
      source,
      secret,
      value,
      // What the code will actually use. Secrets report null, never the value.
      effective: secret ? null : (value ?? fallback),
      configured: fromDb || fromEnv,
    };
  });
}

/** True once a source has everything it needs, from either store. */
export function sourceReady(db: DB, source: 'snaptrade' | 'plaid' | 'wise'): boolean {
  const need: Record<string, string[]> = {
    snaptrade: ['SNAPTRADE_CLIENT_ID', 'SNAPTRADE_CONSUMER_KEY'],
    plaid: ['PLAID_CLIENT_ID', 'PLAID_SECRET'],
    wise: ['WISE_API_TOKEN'],
  };
  return (need[source] ?? []).every((k) => {
    try {
      return getSetting(db, k) !== '';
    } catch {
      return false;
    }
  });
}
