/**
 * The settings store is where provider credentials live once onboarding moves
 * into the UI, so these tests are mostly about what must NOT happen: secrets
 * leaking in the clear, unmanaged keys being writable, or a bad key looking
 * like "not configured".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.ts';

// config.ts snapshots process.env at module load, and static imports are
// hoisted above assignments — so the key must be set before the dynamic import.
process.env['TOKEN_ENC_KEY'] = 'c'.repeat(64);
const { initDb, openDb } = await import('../src/db.ts');
const { describeSettings, deleteSetting, getSetting, setSetting, sourceReady } = await import(
  '../src/settings.ts'
);

let db: DB;
const ENV_KEYS = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'SNAPTRADE_CLIENT_ID', 'WISE_API_TOKEN'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolution order', () => {
  it('returns the empty string when neither store has the key', () => {
    expect(getSetting(db, 'PLAID_CLIENT_ID')).toBe('');
    expect(sourceReady(db, 'plaid')).toBe(false);
  });

  it('falls back to the environment', () => {
    process.env['PLAID_CLIENT_ID'] = 'env-client';
    expect(getSetting(db, 'PLAID_CLIENT_ID')).toBe('env-client');
  });

  it('lets the database override the environment, so the UI wins without a redeploy', () => {
    process.env['PLAID_CLIENT_ID'] = 'env-client';
    setSetting(db, 'PLAID_CLIENT_ID', 'db-client');
    expect(getSetting(db, 'PLAID_CLIENT_ID')).toBe('db-client');
  });

  it('falls back to the environment again once the row is deleted', () => {
    process.env['PLAID_CLIENT_ID'] = 'env-client';
    setSetting(db, 'PLAID_CLIENT_ID', 'db-client');
    expect(deleteSetting(db, 'PLAID_CLIENT_ID')).toBe(true);
    expect(getSetting(db, 'PLAID_CLIENT_ID')).toBe('env-client');
  });
});

describe('secrets', () => {
  it('encrypts a secret at rest — the plaintext is not in the table', () => {
    setSetting(db, 'PLAID_SECRET', 'super-secret-value');
    const raw = db.prepare('SELECT value, is_secret FROM settings WHERE key = ?').get('PLAID_SECRET') as {
      value: string;
      is_secret: number;
    };
    expect(raw.is_secret).toBe(1);
    expect(raw.value).not.toContain('super-secret-value');
    expect(raw.value.startsWith('enc:v1:')).toBe(true);
    expect(getSetting(db, 'PLAID_SECRET')).toBe('super-secret-value');
  });

  it('stores non-secrets in the clear so they stay readable without the key', () => {
    setSetting(db, 'PLAID_ENV', 'production');
    const raw = db.prepare('SELECT value, is_secret FROM settings WHERE key = ?').get('PLAID_ENV') as {
      value: string;
      is_secret: number;
    };
    expect(raw.is_secret).toBe(0);
    expect(raw.value).toBe('production');
  });

  it('never exposes a secret value to the UI, only its presence', () => {
    setSetting(db, 'PLAID_SECRET', 'super-secret-value');
    setSetting(db, 'PLAID_CLIENT_ID', 'visible-client');
    const shown = describeSettings(db);

    const secret = shown.find((s) => s.key === 'PLAID_SECRET')!;
    expect(secret.configured).toBe(true);
    expect(secret.source).toBe('database');
    expect(secret.value).toBeNull();

    const plain = shown.find((s) => s.key === 'PLAID_CLIENT_ID')!;
    expect(plain.value).toBe('visible-client');

    expect(JSON.stringify(shown)).not.toContain('super-secret-value');
  });

  it('reports where each setting came from', () => {
    process.env['SNAPTRADE_CLIENT_ID'] = 'from-env';
    setSetting(db, 'PLAID_CLIENT_ID', 'from-db');
    const shown = describeSettings(db);
    expect(shown.find((s) => s.key === 'SNAPTRADE_CLIENT_ID')!.source).toBe('environment');
    expect(shown.find((s) => s.key === 'PLAID_CLIENT_ID')!.source).toBe('database');
    expect(shown.find((s) => s.key === 'WISE_API_TOKEN')!.source).toBe('unset');
  });

  it('surfaces a decryption failure instead of pretending the key is unset', () => {
    setSetting(db, 'PLAID_SECRET', 'super-secret-value');
    // Simulate the operator restoring a database without its TOKEN_ENC_KEY.
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA',
      'PLAID_SECRET',
    );
    expect(() => getSetting(db, 'PLAID_SECRET')).toThrow(/could not be decrypted/);
    // and it must not be silently reported as "ready"
    expect(sourceReady(db, 'plaid')).toBe(false);
  });
});

describe('write guard', () => {
  it('refuses keys outside the managed allowlist', () => {
    expect(() => setSetting(db, 'MCP_SECRET', 'nope')).toThrow(/unmanaged/);
    expect(() => setSetting(db, 'TOKEN_ENC_KEY', 'nope')).toThrow(/unmanaged/);
    expect(() => setSetting(db, 'DB_PATH', '/etc/passwd')).toThrow(/unmanaged/);
  });
});

describe('readiness', () => {
  it('needs every required key before a source counts as configured', () => {
    setSetting(db, 'PLAID_CLIENT_ID', 'id');
    expect(sourceReady(db, 'plaid')).toBe(false);
    setSetting(db, 'PLAID_SECRET', 'secret');
    expect(sourceReady(db, 'plaid')).toBe(true);
  });

  it('accepts a mix of database and environment', () => {
    process.env['SNAPTRADE_CLIENT_ID'] = 'env-id';
    setSetting(db, 'SNAPTRADE_CONSUMER_KEY', 'db-key');
    expect(sourceReady(db, 'snaptrade')).toBe(true);
  });
});

describe('effective defaults', () => {
  it('reports the default the code will actually use, not a blank', () => {
    // A blank "Plaid environment" field that silently means production is how a
    // Sandbox secret ends up being sent to the production API.
    const env = describeSettings(db).find((s) => s.key === 'PLAID_ENV')!;
    expect(env.source).toBe('default');
    expect(env.effective).toBe('production');
    expect(env.configured).toBe(false);
  });

  it('marks a genuinely unset key with no default as unset', () => {
    const wise = describeSettings(db).find((s) => s.key === 'WISE_API_TOKEN')!;
    expect(wise.source).toBe('unset');
    expect(wise.effective).toBeNull();
  });

  it('a saved value overrides the default and is reported as such', () => {
    setSetting(db, 'PLAID_ENV', 'sandbox');
    const env = describeSettings(db).find((s) => s.key === 'PLAID_ENV')!;
    expect(env.source).toBe('database');
    expect(env.effective).toBe('sandbox');
    expect(getSetting(db, 'PLAID_ENV')).toBe('sandbox');
  });

  it('never exposes a secret through the effective field', () => {
    setSetting(db, 'PLAID_SECRET', 'super-secret-value');
    const sec = describeSettings(db).find((s) => s.key === 'PLAID_SECRET')!;
    expect(sec.effective).toBeNull();
    expect(sec.value).toBeNull();
    expect(sec.configured).toBe(true);
    expect(JSON.stringify(describeSettings(db))).not.toContain('super-secret-value');
  });
});
