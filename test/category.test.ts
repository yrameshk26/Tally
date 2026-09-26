/**
 * Rent and utilities, split from Plaid's single combined category by its
 * detailed one. The split happens as rows are written and, once, for rows
 * already stored; a hand correction still has the last word.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { refineCategory } from '../src/lib/category.ts';
import { getCashflow, getTransactions } from '../src/queries.ts';
import { addMerchantRule } from '../src/overrides.ts';
import { upsertAccount, upsertTransactions } from '../src/store.ts';
import type { RegisteredType } from '../src/lib/registered.ts';

const row = (id: string, merchant: string, category: string, detailed: string | null, amount = 100) => ({
  id,
  account_id: 'chq',
  date: '2026-08-10',
  name: merchant.toUpperCase(),
  merchant,
  amount,
  currency: 'CAD',
  amount_cad: amount,
  category,
  category_detailed: detailed,
  pending: false,
});

let db: DB;
beforeEach(() => {
  db = initDb(openDb(':memory:'));
  upsertAccount(db, {
    id: 'chq', source: 'plaid', institution: 'Test Bank', name: 'chq', mask: null,
    account_category: 'DEPOSITORY', account_subtype: 'checking', registered_type: 'NON_REG' as RegisteredType,
    currency: 'CAD', balance: 0, balance_cad: 0, available: null, active: true, status: 'ok', item_id: null,
  });
});

describe('refining the combined category', () => {
  it('reads rent and the bills apart from the detailed category', () => {
    expect(refineCategory('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')).toBe('RENT');
    expect(refineCategory('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY')).toBe('UTILITIES');
    expect(refineCategory('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE')).toBe('UTILITIES');
  });

  it('leaves a row alone when there is nothing to go on, rather than guessing', () => {
    expect(refineCategory('RENT_AND_UTILITIES', null)).toBe('RENT_AND_UTILITIES');
    expect(refineCategory('RENT_AND_UTILITIES', 'Service > Utilities')).toBe('RENT_AND_UTILITIES');
  });

  it('touches no other category', () => {
    expect(refineCategory('FOOD_AND_DRINK', 'RENT_AND_UTILITIES_RENT')).toBe('FOOD_AND_DRINK');
    expect(refineCategory(null, null)).toBeNull();
  });
});

describe('as rows are written', () => {
  it('stores them split, so every total sees rent and utilities apart', () => {
    upsertTransactions(db, [
      row('r', 'Meridian Apartments', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT', 1_850),
      row('u', 'Lumen Electric', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 96),
    ]);
    const c = getCashflow(db, { start: '2026-08-01', end: '2026-08-31' });
    expect(c.by_category).toEqual([
      { category: 'RENT', spend_cad: 1_850 },
      { category: 'UTILITIES', spend_cad: 96 },
    ]);
  });

  it('still lets a merchant rule decide', () => {
    upsertTransactions(db, [row('u', 'Lumen Electric', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY')]);
    addMerchantRule(db, { pattern: 'Lumen Electric', match_type: 'merchant', category: 'HOUSING' });
    expect(getTransactions(db)[0]?.category).toBe('HOUSING');
  });
});

describe('rows stored before the split', () => {
  it('are split once on start, and nothing after', () => {
    // Written the old way, straight past the store.
    db.prepare(
      `INSERT INTO transactions (id, account_id, date, name, merchant, amount, currency, amount_cad, category, category_detailed, pending, updated_at)
       VALUES ('old-r','chq','2026-07-01','X','Landlord',1500,'CAD',1500,'RENT_AND_UTILITIES','RENT_AND_UTILITIES_RENT',0,''),
              ('old-w','chq','2026-07-02','X','City Water',40,'CAD',40,'RENT_AND_UTILITIES','RENT_AND_UTILITIES_WATER',0,''),
              ('old-n','chq','2026-07-03','X','Mystery',10,'CAD',10,'RENT_AND_UTILITIES',NULL,0,'')`,
    ).run();
    initDb(db);
    const cat = (id: string): string =>
      (db.prepare('SELECT category FROM transactions WHERE id = ?').get(id) as { category: string }).category;
    expect([cat('old-r'), cat('old-w'), cat('old-n')]).toEqual(['RENT', 'UTILITIES', 'RENT_AND_UTILITIES']);
    // Idempotent: a second start changes nothing.
    initDb(db);
    expect(cat('old-n')).toBe('RENT_AND_UTILITIES');
  });
});
