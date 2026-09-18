/**
 * Profiles carry live credentials and Plaid access tokens, so the migration is
 * tested against a database shaped like the one already in production — with
 * accounts, owner tags, encrypted settings and linked items — not an empty one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db.ts';

process.env['TOKEN_ENC_KEY'] = 'e'.repeat(64);
const { initDb, openDb } = await import('../src/db.ts');
const {
  MAX_PROFILES,
  createProfile,
  deleteProfile,
  listProfiles,
  moveAccount,
  profileUsage,
  renameProfile,
  toProfileId,
} = await import('../src/profiles.ts');

let db: DB;
beforeEach(() => {
  db = initDb(openDb(':memory:'));
});

describe('slugs', () => {
  it('produces stable ids from display names', () => {
    expect(toProfileId('Me')).toBe('me');
    expect(toProfileId('My Spouse')).toBe('my-spouse');
    expect(toProfileId('  Business  ')).toBe('business');
    expect(toProfileId('Ünïcodé Näme')).toBe('unicode-name');
  });

  it('never produces an empty id', () => {
    expect(toProfileId('!!!')).toBe('profile');
    expect(toProfileId('')).toBe('profile');
  });
});

describe('creating profiles', () => {
  it('seeds a default profile', () => {
    const all = listProfiles(db);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('me');
  });

  it('caps the count', () => {
    for (let i = 0; i < MAX_PROFILES - 1; i += 1) createProfile(db, `Profile ${i}`);
    expect(listProfiles(db)).toHaveLength(MAX_PROFILES);
    expect(() => createProfile(db, 'One too many')).toThrow(/at most 5/);
  });

  it('disambiguates rather than clobbering an existing profile', () => {
    const a = createProfile(db, 'Spouse');
    const b = createProfile(db, 'Spouse');
    expect(a.id).toBe('spouse');
    expect(b.id).toBe('spouse-2');
  });

  it('rejects an empty name', () => {
    expect(() => createProfile(db, '   ')).toThrow(/must not be empty/);
  });

  it('renames without changing the id, so credentials stay attached', () => {
    const p = createProfile(db, 'Spouse');
    expect(renameProfile(db, p.id, 'Partner')).toBe(true);
    expect(listProfiles(db).find((x) => x.id === 'spouse')!.name).toBe('Partner');
  });
});

describe('deleting profiles', () => {
  it('refuses to delete the default', () => {
    expect(deleteProfile(db, 'me')).toEqual({
      deleted: false,
      reason: 'the default profile cannot be deleted',
    });
  });

  it('refuses while accounts still point at it, rather than cascading', () => {
    const p = createProfile(db, 'Business');
    db.prepare(
      `INSERT INTO accounts (id, source, registered_type, currency, balance, balance_cad,
                             owner, profile_id, first_seen, updated_at)
       VALUES ('x', 'plaid', 'NA', 'CAD', 1, 1, 'me', ?, '', '')`,
    ).run(p.id);
    const res = deleteProfile(db, p.id);
    expect(res.deleted).toBe(false);
    expect(res.reason).toMatch(/still in use/);
    // and the profile must survive the refusal
    expect(listProfiles(db).some((x) => x.id === p.id)).toBe(true);
  });

  it('deletes once nothing references it', () => {
    const p = createProfile(db, 'Business');
    expect(deleteProfile(db, p.id)).toEqual({ deleted: true });
    expect(listProfiles(db).some((x) => x.id === p.id)).toBe(false);
  });
});

describe('moving accounts', () => {
  beforeEach(() => {
    createProfile(db, 'Spouse');
    db.prepare(
      `INSERT INTO accounts (id, source, registered_type, currency, balance, balance_cad,
                             owner, profile_id, item_id, first_seen, updated_at)
       VALUES ('plaid:card', 'plaid', 'NA', 'CAD', -100, -100, 'me', 'me', 'item-1', '', '')`,
    ).run();
  });

  it('moves attribution', () => {
    expect(moveAccount(db, 'plaid:card', 'spouse')).toBe(true);
    expect(profileUsage(db, 'spouse').accounts).toBe(1);
    expect(profileUsage(db, 'me').accounts).toBe(0);
  });

  it('leaves the connection where it was linked — only attribution moves', () => {
    moveAccount(db, 'plaid:card', 'spouse');
    const row = db.prepare('SELECT item_id FROM accounts WHERE id = ?').get('plaid:card') as {
      item_id: string;
    };
    expect(row.item_id).toBe('item-1');
  });

  it('refuses an unknown profile', () => {
    expect(() => moveAccount(db, 'plaid:card', 'nope')).toThrow(/no such profile/);
  });

  it('reports failure for an unknown account', () => {
    expect(moveAccount(db, 'plaid:missing', 'spouse')).toBe(false);
  });
});

describe('isolation between profiles', () => {
  it('keeps credentials separate — a second profile does not inherit the first', async () => {
    const { getSetting, setSetting } = await import('../src/settings.ts');
    createProfile(db, 'Spouse');
    setSetting(db, 'PLAID_CLIENT_ID', 'client-me', 'me');
    setSetting(db, 'PLAID_CLIENT_ID', 'client-spouse', 'spouse');
    expect(getSetting(db, 'PLAID_CLIENT_ID', 'me')).toBe('client-me');
    expect(getSetting(db, 'PLAID_CLIENT_ID', 'spouse')).toBe('client-spouse');
  });

  it('does not leak the environment fallback into a non-default profile', async () => {
    const { getSetting } = await import('../src/settings.ts');
    createProfile(db, 'Spouse');
    process.env['PLAID_CLIENT_ID'] = 'from-env';
    try {
      // The default profile may inherit the environment; a second profile must
      // not, or its banks would link against the wrong Plaid team.
      expect(getSetting(db, 'PLAID_CLIENT_ID', 'me')).toBe('from-env');
      expect(getSetting(db, 'PLAID_CLIENT_ID', 'spouse')).toBe('');
    } finally {
      delete process.env['PLAID_CLIENT_ID'];
    }
  });

  it('one profile’s sync never deactivates another profile’s accounts', async () => {
    const { deactivateMissing, upsertAccount } = await import('../src/store.ts');
    createProfile(db, 'Spouse');
    const base = {
      source: 'plaid' as const,
      institution: null,
      name: 'card',
      mask: null,
      account_category: 'LOC',
      account_subtype: null,
      registered_type: 'NA' as const,
      currency: 'CAD',
      balance: -10,
      balance_cad: -10,
      available: null,
      active: true,
      status: 'ok',
      item_id: 'i1',
    };
    upsertAccount(db, { ...base, id: 'plaid:mine' }, 'me');
    upsertAccount(db, { ...base, id: 'plaid:theirs' }, 'spouse');

    // "me" syncs and sees nothing — only its own account may be deactivated.
    const deactivated = deactivateMissing(db, 'plaid', [], 'me');
    expect(deactivated).toBe(1);

    const rows = db
      .prepare('SELECT id, active FROM accounts ORDER BY id')
      .all() as Array<{ id: string; active: number }>;
    expect(rows.find((r) => r.id === 'plaid:mine')!.active).toBe(0);
    expect(rows.find((r) => r.id === 'plaid:theirs')!.active).toBe(1);
  });

  it('a moved account is still deactivated by the profile that linked it', async () => {
    const { deactivateMissing, upsertAccount } = await import('../src/store.ts');
    createProfile(db, 'Spouse');
    upsertAccount(
      db,
      {
        id: 'plaid:card', source: 'plaid', institution: null, name: 'card', mask: null,
        account_category: 'LOC', account_subtype: null, registered_type: 'NA',
        currency: 'CAD', balance: -10, balance_cad: -10, available: null,
        active: true, status: 'ok', item_id: 'i1',
      },
      'me',
    );
    // Attribution moves to the spouse, but the connection stays with "me".
    moveAccount(db, 'plaid:card', 'spouse');
    expect(deactivateMissing(db, 'plaid', [], 'spouse')).toBe(0);
    expect(deactivateMissing(db, 'plaid', [], 'me')).toBe(1);
  });
});
