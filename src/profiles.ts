/**
 * Profiles.
 *
 * A profile is two things at once, and keeping them distinct is what makes the
 * model work:
 *
 *  - a **credential tenancy**: its own Plaid and SnapTrade keys. This is the
 *    point of the feature — Plaid's 10-Item cap is per team, so a second set of
 *    keys is a second allowance.
 *  - an **attribution bucket**: whose money this is, which is what `owner`
 *    used to mean.
 *
 * A connection belongs permanently to the profile whose credentials created it
 * — an account cannot be re-homed to another Plaid team without re-linking it.
 * An account's *attribution* is separate and movable, so a card linked under
 * one profile's Plaid team can still count towards another profile's net worth.
 */
import type { DB } from './db.ts';
import { nowISO } from './lib/money.ts';

/** Kept low deliberately: this is one household, not a SaaS tenant list. */
export const MAX_PROFILES = 5;

/** The profile every pre-existing row is migrated onto. */
export const DEFAULT_PROFILE_ID = 'me';

export type Profile = {
  id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
};

/** Slugify a display name into a stable id. */
export function toProfileId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    // NFKD splits an accented letter into base + combining mark; drop the marks
    // or "Ünïcodé" slugs to "u-ni-code" instead of "unicode".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'profile';
}

export function listProfiles(db: DB): Profile[] {
  return db.prepare('SELECT * FROM profiles ORDER BY position, created_at').all() as Profile[];
}

export function getProfile(db: DB, id: string): Profile | null {
  return (db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined) ?? null;
}

export function profileExists(db: DB, id: string): boolean {
  return getProfile(db, id) !== null;
}

export function createProfile(db: DB, name: string, id?: string): Profile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('profile name must not be empty');
  if (listProfiles(db).length >= MAX_PROFILES) {
    throw new Error(`at most ${MAX_PROFILES} profiles are supported`);
  }
  let profileId = id ?? toProfileId(trimmed);
  if (profileExists(db, profileId)) {
    // Disambiguate rather than clobbering an existing profile's credentials.
    let n = 2;
    while (profileExists(db, `${profileId}-${n}`)) n += 1;
    profileId = `${profileId}-${n}`;
  }
  const ts = nowISO();
  const position =
    ((db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM profiles').get() as { m: number }).m ??
      -1) + 1;
  db.prepare(
    'INSERT INTO profiles (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(profileId, trimmed, position, ts, ts);
  return getProfile(db, profileId)!;
}

export function renameProfile(db: DB, id: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('profile name must not be empty');
  return (
    db.prepare('UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, nowISO(), id)
      .changes > 0
  );
}

export type ProfileUsage = {
  accounts: number;
  plaid_items: number;
  settings: number;
};

export function profileUsage(db: DB, id: string): ProfileUsage {
  const one = (sql: string): number =>
    (db.prepare(sql).get(id) as { n: number }).n;
  return {
    accounts: one('SELECT COUNT(*) AS n FROM accounts WHERE profile_id = ?'),
    plaid_items: one('SELECT COUNT(*) AS n FROM plaid_items WHERE profile_id = ?'),
    settings: one('SELECT COUNT(*) AS n FROM settings WHERE profile_id = ?'),
  };
}

/**
 * Deleting a profile is refused while anything still points at it. Cascading
 * would silently drop credentials and re-home accounts, and there is no undo
 * for a deleted Plaid access token — it means re-linking the bank.
 */
export function deleteProfile(db: DB, id: string): { deleted: boolean; reason?: string } {
  if (id === DEFAULT_PROFILE_ID) {
    return { deleted: false, reason: 'the default profile cannot be deleted' };
  }
  if (!profileExists(db, id)) return { deleted: false, reason: 'no such profile' };
  const usage = profileUsage(db, id);
  if (usage.accounts > 0 || usage.plaid_items > 0) {
    return {
      deleted: false,
      reason:
        `still in use: ${usage.accounts} account(s) and ${usage.plaid_items} linked bank(s). ` +
        'Move the accounts to another profile and remove the connections first.',
    };
  }
  db.prepare('DELETE FROM settings WHERE profile_id = ?').run(id);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  return { deleted: true };
}

/** Move an account's attribution. Its connection stays where it was linked. */
export function moveAccount(db: DB, accountId: string, profileId: string): boolean {
  if (!profileExists(db, profileId)) throw new Error(`no such profile ${profileId}`);
  return (
    db
      .prepare('UPDATE accounts SET profile_id = ?, updated_at = ? WHERE id = ?')
      .run(profileId, nowISO(), accountId).changes > 0
  );
}
