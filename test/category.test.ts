/**
 * Rent and utilities, split from Plaid's single combined category by its
 * detailed one. The split happens as rows are written and, once, for rows
 * already stored; a hand correction still has the last word.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { categoryLabel, effectiveCategory, familyOf, refineCategory } from '../src/lib/category.ts';
import { getCashflow, getTransactions, isTransferLike, knownCategories, matchesCategory } from '../src/queries.ts';
import { categoryOptions } from '../src/web/pages.ts';
import { createProfile } from '../src/profiles.ts';
import { addMerchantRule } from '../src/overrides.ts';
import { upsertAccount, upsertTransactions } from '../src/store.ts';
import { categoryDetail, setSetting } from '../src/settings.ts';
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
    setSetting(db, 'CATEGORY_DETAIL', 'broad');
    const c = getCashflow(db, { start: '2026-08-01', end: '2026-08-31' });
    expect(c.by_category).toEqual([
      { category: 'RENT', spend_cad: 1_850 },
      { category: 'UTILITIES', spend_cad: 96 },
    ]);
    // Detailed mode reads the detailed codes, which keep them apart as well.
    setSetting(db, 'CATEGORY_DETAIL', 'detailed');
    expect(getCashflow(db, { start: '2026-08-01', end: '2026-08-31' }).by_category).toEqual([
      { category: 'RENT_AND_UTILITIES_RENT', spend_cad: 1_850 },
      { category: 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', spend_cad: 96 },
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

describe('detailed categories', () => {
  const month = { start: '2026-08-01', end: '2026-08-31' };
  const seed = (): number =>
    upsertTransactions(db, [
      row('g', 'FreshCo', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', 120),
      row('c', 'Cafe Uno', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 6),
      row('f', 'Petro Pass', 'TRANSPORTATION', 'TRANSPORTATION_GAS', 70),
      row('p', 'Card payment', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 500),
      row('s', 'To savings', 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', 300),
      row('w', 'Payroll', 'INCOME', 'INCOME_WAGES', -2_000),
      // An older Item: the legacy path, not a code.
      row('l', 'Old Diner', 'FOOD_AND_DRINK', 'Food and Drink > Restaurants', 30),
    ]);

  it('reads the detailed category by default, and the primary in broad mode', () => {
    seed();
    const cat = (id: string): string | null | undefined => getTransactions(db).find((t) => t.id === id)?.category;
    expect(cat('g')).toBe('FOOD_AND_DRINK_GROCERIES');
    expect(cat('l')).toBe('FOOD_AND_DRINK');
    setSetting(db, 'CATEGORY_DETAIL', 'broad');
    expect(cat('g')).toBe('FOOD_AND_DRINK');
  });

  it('leaves a hand correction in charge in either mode', () => {
    seed();
    addMerchantRule(db, { pattern: 'FreshCo', match_type: 'merchant', category: 'HOUSEHOLD' });
    expect(getTransactions(db).find((t) => t.id === 'g')?.category).toBe('HOUSEHOLD');
    setSetting(db, 'CATEGORY_DETAIL', 'broad');
    expect(getTransactions(db).find((t) => t.id === 'g')?.category).toBe('HOUSEHOLD');
  });

  it('excludes the same transfers and card payments, so the totals do not move', () => {
    seed();
    const detailed = getCashflow(db, month);
    setSetting(db, 'CATEGORY_DETAIL', 'broad');
    const broad = getCashflow(db, month);
    expect(detailed.spend_cad).toBe(226);
    expect(detailed.income_cad).toBe(2_000);
    expect([broad.spend_cad, broad.income_cad, broad.net_cad]).toEqual([
      detailed.spend_cad,
      detailed.income_cad,
      detailed.net_cad,
    ]);
    expect(isTransferLike('TRANSFER_IN_DEPOSIT')).toBe(true);
    expect(isTransferLike('LOAN_PAYMENTS_MORTGAGE_PAYMENT')).toBe(true);
    expect(isTransferLike('LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT')).toBe(false);
  });

  it('still totals by primary, for "how much on food"', () => {
    seed();
    const c = getCashflow(db, month);
    expect(c.by_category).toContainEqual({ category: 'FOOD_AND_DRINK_GROCERIES', spend_cad: 120 });
    expect(c.by_category_group).toEqual([
      { category: 'FOOD_AND_DRINK', spend_cad: 156 },
      { category: 'TRANSPORTATION', spend_cad: 70 },
    ]);
  });

  it('filters by a primary to find everything under it, or by one detailed category', () => {
    seed();
    const ids = (category: string): string[] => getTransactions(db, { category }).map((t) => t.id).sort();
    expect(ids('FOOD_AND_DRINK')).toEqual(['c', 'g', 'l']);
    expect(ids('FOOD_AND_DRINK_COFFEE')).toEqual(['c']);
    // A hand-made category that happens to prefix a Plaid code is not a family.
    expect(ids('FOOD')).toEqual([]);
    expect(matchesCategory('FOOD_AND_DRINK_COFFEE', 'FOOD')).toBe(false);
  });

  it('filters after corrections, and still honours the limit', () => {
    seed();
    addMerchantRule(db, { pattern: 'Petro Pass', match_type: 'merchant', category: 'FOOD_AND_DRINK_GROCERIES' });
    expect(getTransactions(db, { category: 'FOOD_AND_DRINK_GROCERIES' }).map((t) => t.id).sort()).toEqual(['f', 'g']);
    expect(getTransactions(db, { category: 'FOOD_AND_DRINK', limit: 1 })).toHaveLength(1);
  });

  it('offers the detailed categories in the picker only in detailed mode', () => {
    seed();
    expect(knownCategories(db)).toContain('FOOD_AND_DRINK_COFFEE');
    setSetting(db, 'CATEGORY_DETAIL', 'broad');
    expect(knownCategories(db)).not.toContain('FOOD_AND_DRINK_COFFEE');
    expect(knownCategories(db)).toContain('FOOD_AND_DRINK');
  });

  it('is an install-wide choice between two values', () => {
    expect(categoryDetail(db)).toBe('detailed');
    setSetting(db, 'CATEGORY_DETAIL', ' Broad ');
    expect(categoryDetail(db)).toBe('broad');
    expect(() => setSetting(db, 'CATEGORY_DETAIL', 'fine')).toThrow(/detailed" or "broad/);
    createProfile(db, 'Partner');
    expect(() => setSetting(db, 'CATEGORY_DETAIL', 'broad', 'partner')).toThrow(/whole install/);
  });
});

describe('category labels', () => {
  it('drops the primary a detailed category repeats', () => {
    expect(categoryLabel('FOOD_AND_DRINK_GROCERIES')).toBe('Groceries');
    expect(categoryLabel('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe('Credit card payment');
    expect(categoryLabel('OTHER_OTHER')).toBe('Other');
    expect(categoryLabel('ENTERTAINMENT_TV_AND_MOVIES')).toBe('TV and movies');
    // Not "Gas", which beside "Gas and electricity" reads as the same bill.
    expect(categoryLabel('TRANSPORTATION_GAS')).toBe('Fuel');
  });

  it('keeps the direction of a transfer, and leaves primaries and your own alone', () => {
    expect(categoryLabel('TRANSFER_OUT_ACCOUNT_TRANSFER')).toBe('Transfer out: account transfer');
    expect(categoryLabel('FOOD_AND_DRINK')).toBe('Food and drink');
    expect(categoryLabel('HOUSEHOLD')).toBe('Household');
  });

  it('knows which primary a code belongs to', () => {
    expect(familyOf('KIDS_ENTERTAINMENT_TOYS')).toBe('KIDS_ENTERTAINMENT');
    expect(familyOf('ENTERTAINMENT_MUSIC')).toBe('ENTERTAINMENT');
    expect(familyOf('RENT')).toBeNull();
    expect(effectiveCategory('FOOD_AND_DRINK', 'Food and Drink > Coffee', 'detailed')).toBe('FOOD_AND_DRINK');
    expect(effectiveCategory('FOOD_AND_DRINK', 'FOOD_AND_DRINK', 'detailed')).toBe('FOOD_AND_DRINK');
    expect(effectiveCategory('NEW_THING', 'NEW_THING_DETAIL', 'detailed')).toBe('NEW_THING_DETAIL');
  });

  it('groups the picker under each primary, with an "All" entry for filtering', () => {
    const cats = ['FOOD_AND_DRINK_COFFEE', 'FOOD_AND_DRINK_GROCERIES', 'HOUSEHOLD', 'TRANSFER_OUT'];
    const filter = categoryOptions(cats, 'FOOD_AND_DRINK', 'filter').value;
    expect(filter).toContain('<optgroup label="Food and drink"><option value="FOOD_AND_DRINK" selected>All food and drink</option>');
    expect(filter.indexOf('Coffee')).toBeLessThan(filter.indexOf('Groceries'));
    const assign = categoryOptions(cats, 'FOOD_AND_DRINK_GROCERIES').value;
    expect(assign).not.toContain('All food and drink');
    expect(assign).toContain('<option value="FOOD_AND_DRINK_GROCERIES" selected>Groceries</option>');
    expect(assign).toContain('<option value="TRANSFER_OUT">Transfer out</option>');
  });
});
