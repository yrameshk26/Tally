/**
 * SQLite storage. One file, one household, no migrations framework — the
 * schema is created with CREATE TABLE IF NOT EXISTS and evolved through the
 * idempotent steps in `migrate()`.
 *
 * Sign convention (CLAUDE.md): assets are positive and liabilities negative in
 * `accounts.balance`. Transactions are stored Plaid-style (positive = money
 * leaving the account) and negated when read out.
 */
import Database from 'better-sqlite3';
import { pruneEmptySnapshots } from './snapshots.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { encryptToken, isEncrypted } from './lib/crypto.ts';
import { log } from './lib/logger.ts';

export type DB = Database.Database;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  institution       TEXT,
  name              TEXT,
  mask              TEXT,
  account_category  TEXT,
  account_subtype   TEXT,
  registered_type   TEXT NOT NULL DEFAULT 'NA',
  currency          TEXT NOT NULL DEFAULT 'CAD',
  balance           REAL NOT NULL DEFAULT 0,
  balance_cad       REAL NOT NULL DEFAULT 0,
  available         REAL,
  credit_limit      REAL,
  currency_override TEXT,
  owner             TEXT NOT NULL DEFAULT 'me',
  active            INTEGER NOT NULL DEFAULT 1,
  status            TEXT,
  item_id           TEXT,
  first_seen        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_source ON accounts(source);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner);

CREATE TABLE IF NOT EXISTS holdings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       TEXT NOT NULL,
  symbol           TEXT,
  description      TEXT,
  asset_type       TEXT,
  quantity         REAL NOT NULL DEFAULT 0,
  price            REAL,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  market_value     REAL NOT NULL DEFAULT 0,
  market_value_cad REAL NOT NULL DEFAULT 0,
  cost_basis       REAL,
  cost_basis_cad   REAL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings(account_id);
CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings(symbol);

CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  date              TEXT NOT NULL,
  name              TEXT,
  merchant          TEXT,
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'CAD',
  amount_cad        REAL NOT NULL DEFAULT 0,
  category          TEXT,
  category_detailed TEXT,
  pending           INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

CREATE TABLE IF NOT EXISTS activities (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  date         TEXT NOT NULL,
  type         TEXT,
  description  TEXT,
  symbol       TEXT,
  amount       REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'CAD',
  amount_cad   REAL NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_account_date ON activities(account_id, date);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);

CREATE TABLE IF NOT EXISTS fx_rates (
  pair       TEXT PRIMARY KEY,
  rate       REAL NOT NULL,
  as_of      TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                     TEXT NOT NULL,
  total_assets_cad       REAL NOT NULL,
  total_liabilities_cad  REAL NOT NULL,
  net_worth_cad          REAL NOT NULL,
  by_owner               TEXT,
  by_registered_type     TEXT,
  origin                 TEXT NOT NULL DEFAULT 'sync'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_day ON snapshots(substr(ts,1,10), origin);

CREATE TABLE IF NOT EXISTS plaid_items (
  item_id             TEXT PRIMARY KEY,
  institution_id      TEXT,
  institution_name    TEXT,
  access_token        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ok',
  error_code          TEXT,
  error_message       TEXT,
  cursor              TEXT,
  consent_expiration  TEXT,
  last_synced_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_details (
  account_id         TEXT PRIMARY KEY,
  statement_balance  REAL,
  minimum_payment    REAL,
  due_date           TEXT,
  last_payment_amount REAL,
  last_payment_date  TEXT,
  apr_percentage     REAL,
  is_overdue         INTEGER,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room (
  person             TEXT NOT NULL,
  account_type       TEXT NOT NULL,
  year               INTEGER NOT NULL,
  limit_amount       REAL NOT NULL,
  contributed_manual REAL NOT NULL DEFAULT 0,
  note               TEXT,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (person, account_type, year)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER NOT NULL DEFAULT 0,
  report      TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  profile_id  TEXT NOT NULL DEFAULT 'me',
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  is_secret   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
);

CREATE TABLE IF NOT EXISTS auth (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  csrf         TEXT NOT NULL,
  pending      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT,
  redirect_uris  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code            TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope           TEXT,
  resource        TEXT,
  username        TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  access_hash         TEXT NOT NULL UNIQUE,
  refresh_hash        TEXT UNIQUE,
  client_id           TEXT NOT NULL,
  username            TEXT NOT NULL,
  scope               TEXT,
  expires_at          TEXT NOT NULL,
  refresh_expires_at  TEXT,
  created_at          TEXT NOT NULL,
  last_used_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);

-- Hand corrections to what an institution reported.
--
-- Kept separate from the synced rows on purpose: a sync overwrites everything it
-- fetches, so a correction written into the transactions table would survive
-- exactly one night. They are applied on read instead, which also makes a rule
-- retroactive
-- over history the moment it is created.
CREATE TABLE IF NOT EXISTS tx_overrides (
  transaction_id TEXT PRIMARY KEY,
  merchant       TEXT,
  category       TEXT,
  note           TEXT,
  updated_at     TEXT NOT NULL
);

-- "Everything matching this pattern is really <merchant>, category <category>."
-- Ordered by position; the first match wins.
CREATE TABLE IF NOT EXISTS merchant_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type TEXT NOT NULL DEFAULT 'contains',   -- contains | prefix | exact
  pattern    TEXT NOT NULL,
  merchant   TEXT,
  category   TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_rules_pos ON merchant_rules(position, id);

-- Categories the user invented, on top of whatever taxonomy the institution
-- sends. Kept as a table rather than derived from usage, because a category has
-- to exist before anything is filed under it.
CREATE TABLE IF NOT EXISTS categories (
  name       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Assistant conversations. Stored in full (including tool calls) so a thread
-- can be reopened, and so it is always possible to see exactly what was sent to
-- the provider on the user's behalf.
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  profile_id  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL,
  role        TEXT NOT NULL,          -- user | assistant | tool
  content     TEXT NOT NULL DEFAULT '',
  -- JSON: assistant tool calls, or a tool result's name/id.
  meta        TEXT,
  model       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id, id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let handle: DB | null = null;

export function openDb(path = config.dbPath): DB {
  mkdirSync(dirname(path) || '.', { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function initDb(db: DB): DB {
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getDb(): DB {
  if (!handle) handle = initDb(openDb());
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** Idempotent schema/data migrations. Safe to run on every boot. */
export function migrate(db: DB): void {
  // Columns added after the first release. ALTER TABLE ADD COLUMN throws if the
  // column is already there, which is the cheapest "if not exists" sqlite gives.
  const addColumn = (table: string, column: string, decl: string): void => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  };
  addColumn('accounts', 'available', 'REAL');
  addColumn('accounts', 'credit_limit', 'REAL');
  // "The institution says USD, but this account is really CAD." Null means
  // trust the institution.
  addColumn('accounts', 'currency_override', 'TEXT');
  addColumn('plaid_items', 'consent_expiration', 'TEXT');
  // JSON array of the products the institution itself offers. Null = not yet
  // looked up; an empty array is a real answer (the bank offers none of them).
  addColumn('plaid_items', 'institution_products', 'TEXT');
  addColumn('room', 'note', 'TEXT');
  addColumn('sessions', 'pending', "INTEGER NOT NULL DEFAULT 0");

  migrateProfiles(db);
  encryptExistingTokens(db);
  pruneEmptySnapshots(db);
}

/**
 * Introduce profiles without losing anything.
 *
 * Runs against databases that already hold real accounts, encrypted
 * credentials and Plaid access tokens, so every step is idempotent and
 * additive: columns are added with a default, existing owner tags become
 * profiles, and nothing is deleted. A lost Plaid access token means re-linking
 * a bank by hand, so this errs heavily towards keeping data.
 */
export function migrateProfiles(db: DB): void {
  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (c) => c.name === column,
    );

  const ts = new Date().toISOString();
  const ensureProfile = (id: string, name: string, position: number): void => {
    db.prepare(
      `INSERT INTO profiles (id, name, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    ).run(id, name, position, ts, ts);
  };

  // The default profile always exists; everything pre-profiles belongs to it.
  ensureProfile('me', 'Me', 0);

  // Accounts: carry the old owner tag across as a profile so a household that
  // already tagged a spouse's accounts keeps that split.
  if (!hasColumn('accounts', 'profile_id')) {
    db.exec("ALTER TABLE accounts ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'me'");
  }
  // Which profile's credentials fetched this account. Immutable: an account
  // cannot be re-homed to a different Plaid team without re-linking it. Kept
  // separate from profile_id (attribution) so that a sync only ever deactivates
  // accounts belonging to the credentials it just used.
  if (!hasColumn('accounts', 'source_profile_id')) {
    db.exec("ALTER TABLE accounts ADD COLUMN source_profile_id TEXT NOT NULL DEFAULT 'me'");
  }
  if (hasColumn('accounts', 'owner')) {
    const owners = db
      .prepare("SELECT DISTINCT owner FROM accounts WHERE owner IS NOT NULL AND owner != ''")
      .all() as Array<{ owner: string }>;
    let position = 1;
    for (const { owner } of owners) {
      if (owner === 'me') continue;
      const name = owner.charAt(0).toUpperCase() + owner.slice(1);
      ensureProfile(owner, name, position);
      position += 1;
    }
    // Only backfill rows still sitting on the default — never overwrite a
    // profile someone has since set by hand.
    db.prepare(
      "UPDATE accounts SET profile_id = owner WHERE profile_id = 'me' AND owner IS NOT NULL AND owner != ''",
    ).run();
  }

  if (!hasColumn('plaid_items', 'profile_id')) {
    db.exec("ALTER TABLE plaid_items ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'me'");
  }

  // settings predates profiles and was keyed on `key` alone. SQLite cannot
  // change a primary key in place, so rebuild the table and copy every row
  // onto the default profile.
  if (!hasColumn('settings', 'profile_id')) {
    db.exec(`
      CREATE TABLE settings_with_profile (
        profile_id  TEXT NOT NULL DEFAULT 'me',
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        is_secret   INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (profile_id, key)
      );
      INSERT INTO settings_with_profile (profile_id, key, value, is_secret, updated_at)
        SELECT 'me', key, value, is_secret, updated_at FROM settings;
      ALTER TABLE settings RENAME TO settings_pre_profiles;
      ALTER TABLE settings_with_profile RENAME TO settings;
    `);
    // The old table is kept, not dropped. This is the only step of the whole
    // migration that is not purely additive, and the rows it holds are
    // encrypted provider credentials. Renaming makes recovery an INSERT..SELECT
    // instead of re-entering every key by hand.
    log.info('settings migrated onto the default profile (old table kept as settings_pre_profiles)');
  }
}

/**
 * Phase 7 hardening: once TOKEN_ENC_KEY is set, rewrite any plaintext access
 * token in place. Running this twice does nothing because encryptToken() is a
 * no-op on an already-encrypted value.
 */
export function encryptExistingTokens(db: DB, key = config.tokenEncKey): number {
  if (!key) return 0;
  const rows = db.prepare('SELECT item_id, access_token FROM plaid_items').all() as Array<{
    item_id: string;
    access_token: string;
  }>;
  const upd = db.prepare('UPDATE plaid_items SET access_token = ? WHERE item_id = ?');
  let changed = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (isEncrypted(row.access_token)) continue;
      upd.run(encryptToken(row.access_token, key), row.item_id);
      changed += 1;
    }
  });
  tx();
  if (changed > 0) log.info(`encrypted ${changed} plaid access token(s) at rest`);
  return changed;
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
