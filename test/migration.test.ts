/**
 * The profiles migration runs against a database holding real encrypted
 * credentials and Plaid access tokens. Losing one means re-linking a bank by
 * hand, so this builds the pre-profiles schema explicitly, fills it the way the
 * live database is filled, and asserts nothing is lost or silently re-homed.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { DB } from '../src/db.ts';

process.env['TOKEN_ENC_KEY'] = 'f'.repeat(64);
const { initDb, migrateProfiles } = await import('../src/db.ts');

/** The schema as it existed before profiles, with the old single-key settings. */
function legacyDb(): DB {
  const db = new Database(':memory:') as DB;
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, institution TEXT, name TEXT, mask TEXT,
      account_category TEXT, account_subtype TEXT, registered_type TEXT NOT NULL DEFAULT 'NA',
      currency TEXT NOT NULL DEFAULT 'CAD', balance REAL NOT NULL DEFAULT 0,
      balance_cad REAL NOT NULL DEFAULT 0, available REAL,
      owner TEXT NOT NULL DEFAULT 'me', active INTEGER NOT NULL DEFAULT 1,
      status TEXT, item_id TEXT, first_seen TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE plaid_items (
      item_id TEXT PRIMARY KEY, institution_id TEXT, institution_name TEXT,
      access_token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', error_code TEXT,
      error_message TEXT, cursor TEXT, consent_expiration TEXT, last_synced_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  // Shaped like the live database: owner-tagged accounts, a linked bank with an
  // encrypted token, and saved provider credentials.
  db.prepare(
    `INSERT INTO accounts (id, source, name, registered_type, currency, balance, balance_cad,
                           owner, first_seen, updated_at)
     VALUES (?, ?, ?, ?, 'CAD', ?, ?, ?, '', '')`,
  ).run('snaptrade:rrsp', 'snaptrade', 'RRSP', 'RRSP', 128626.94, 128626.94, 'me');
  db.prepare(
    `INSERT INTO accounts (id, source, name, registered_type, currency, balance, balance_cad,
                           owner, first_seen, updated_at)
     VALUES (?, ?, ?, ?, 'CAD', ?, ?, ?, '', '')`,
  ).run('snaptrade:sp-tfsa', 'snaptrade', 'TFSA', 'TFSA', 4663.72, 4663.72, 'spouse');
  db.prepare(
    `INSERT INTO plaid_items (item_id, institution_name, access_token, created_at, updated_at)
     VALUES ('item-1', 'Chase', 'enc:v1:aaa:bbb:ccc', '', '')`,
  ).run();
  db.prepare(
    `INSERT INTO settings (key, value, is_secret, updated_at)
     VALUES ('PLAID_SECRET', 'enc:v1:xxx:yyy:zzz', 1, ''), ('PLAID_ENV', 'production', 0, '')`,
  ).run();
  return db;
}

describe('profiles migration', () => {
  it('creates the default profile and turns owner tags into profiles', () => {
    const db = legacyDb();
    migrateProfiles(db);
    const profiles = db.prepare('SELECT id, name FROM profiles ORDER BY position').all() as Array<{
      id: string;
      name: string;
    }>;
    expect(profiles.map((p) => p.id)).toEqual(['me', 'spouse']);
    expect(profiles.find((p) => p.id === 'spouse')!.name).toBe('Spouse');
  });

  it('carries an existing spouse tag across instead of flattening it', () => {
    const db = legacyDb();
    migrateProfiles(db);
    const rows = db.prepare('SELECT id, profile_id FROM accounts ORDER BY id').all() as Array<{
      id: string;
      profile_id: string;
    }>;
    expect(rows.find((r) => r.id === 'snaptrade:sp-tfsa')!.profile_id).toBe('spouse');
    expect(rows.find((r) => r.id === 'snaptrade:rrsp')!.profile_id).toBe('me');
  });

  it('preserves every encrypted Plaid access token', () => {
    const db = legacyDb();
    migrateProfiles(db);
    const item = db.prepare('SELECT access_token, profile_id FROM plaid_items').get() as {
      access_token: string;
      profile_id: string;
    };
    expect(item.access_token).toBe('enc:v1:aaa:bbb:ccc');
    expect(item.profile_id).toBe('me');
  });

  it('rebuilds settings onto the default profile without losing a row', () => {
    const db = legacyDb();
    migrateProfiles(db);
    const rows = db
      .prepare('SELECT profile_id, key, value, is_secret FROM settings ORDER BY key')
      .all() as Array<{ profile_id: string; key: string; value: string; is_secret: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.profile_id === 'me')).toBe(true);
    const secret = rows.find((r) => r.key === 'PLAID_SECRET')!;
    expect(secret.value).toBe('enc:v1:xxx:yyy:zzz');
    expect(secret.is_secret).toBe(1);
  });

  it('is idempotent — running it repeatedly changes nothing', () => {
    const db = legacyDb();
    migrateProfiles(db);
    const snapshot = () =>
      JSON.stringify({
        profiles: db.prepare('SELECT * FROM profiles ORDER BY id').all(),
        accounts: db.prepare('SELECT id, profile_id, source_profile_id FROM accounts ORDER BY id').all(),
        settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
        items: db.prepare('SELECT item_id, access_token, profile_id FROM plaid_items').all(),
      });
    const before = snapshot();
    migrateProfiles(db);
    migrateProfiles(db);
    expect(snapshot()).toBe(before);
  });

  it('never overwrites a profile set by hand on a later run', () => {
    const db = legacyDb();
    migrateProfiles(db);
    // Simulate the user moving an account after the first migration.
    db.prepare("UPDATE accounts SET profile_id = 'spouse' WHERE id = 'snaptrade:rrsp'").run();
    migrateProfiles(db);
    const row = db.prepare("SELECT profile_id FROM accounts WHERE id = 'snaptrade:rrsp'").get() as {
      profile_id: string;
    };
    expect(row.profile_id).toBe('spouse');
  });

  it('runs clean on a fresh database too', () => {
    const db = initDb(new Database(':memory:') as DB);
    const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: string }>;
    expect(profiles.map((p) => p.id)).toEqual(['me']);
  });
});
