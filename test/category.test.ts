/**
 * Rent and utilities, split from Plaid's single combined category by its
 * detailed one. The split happens as rows are written and, once, for rows
 * already stored; a hand correction still has the last word.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { categoryLabel, effectiveCategory, familyLabel, familyOf, refineCategory } from '../src/lib/category.ts';
import { FROM_PLAID, GROUPED_CATEGORIES, GROUPED_PARENT_OF, toGrouped } from '../src/lib/taxonomy.ts';
import {
  categoryParents,
  getCashflow,
  getTransactions,
  isTransferLike,
  knownCategories,
  matchesCategory,
} from '../src/queries.ts';
import { categoryOptions, categoryPath } from '../src/web/pages.ts';
import { createProfile } from '../src/profiles.ts';
import { addCategory, addMerchantRule, setTransactionOverride } from '../src/overrides.ts';
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
  beforeEach(() => setSetting(db, 'CATEGORY_DETAIL', 'detailed'));
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

  it('reads the detailed category, and the primary in broad mode', () => {
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
    // A shorter family (the grouped FOOD) does not capture a longer one's codes.
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

  it('is an install-wide choice between three values, grouped by default', () => {
    db.prepare("DELETE FROM settings WHERE key = 'CATEGORY_DETAIL'").run();
    expect(categoryDetail(db)).toBe('grouped');
    setSetting(db, 'CATEGORY_DETAIL', ' Broad ');
    expect(categoryDetail(db)).toBe('broad');
    expect(() => setSetting(db, 'CATEGORY_DETAIL', 'fine')).toThrow(/"grouped", "detailed" or "broad"/);
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

describe('grouped categories', () => {
  const month = { start: '2026-08-01', end: '2026-08-31' };
  const seed = (): number =>
    upsertTransactions(db, [
      row('g', 'FreshCo', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', 120),
      row('c', 'Cafe Uno', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 6),
      row('k', 'Little Steps Daycare', 'GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE', 800),
      row('t', 'Telus', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE', 74),
      row('r', 'Landlord', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT', 1_500),
      row('p', 'Card payment', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 500),
      row('m', 'Mortgage', 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT', 2_100),
      row('s', 'To savings', 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', 300),
      row('w', 'Payroll', 'INCOME', 'INCOME_SALARY', -4_000),
    ]);
  const cat = (id: string): string | null | undefined => getTransactions(db).find((t) => t.id === id)?.category;

  it('is the default, and files the bank rows into the list', () => {
    seed();
    expect(categoryDetail(db)).toBe('grouped');
    expect(cat('g')).toBe('FOOD_GROCERIES');
    expect(cat('c')).toBe('FOOD_DINING');
    expect(cat('k')).toBe('FAMILY_CARE_CHILDCARE');
    expect(cat('t')).toBe('BILLS_AND_UTILITIES_PHONE_INTERNET');
    expect(cat('r')).toBe('HOME_RENT');
    expect(categoryLabel('FAMILY_CARE_CHILDCARE')).toBe('Childcare & daycare');
    expect(familyLabel('BILLS_AND_UTILITIES')).toBe('Bills & utilities');
  });

  it('leaves income, transfers and payments in Plaid’s terms', () => {
    seed();
    expect(cat('w')).toBe('INCOME_SALARY');
    expect(cat('p')).toBe('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT');
    // A mortgage payment stays out of spending, as it is in the other modes.
    expect(cat('m')).toBe('LOAN_PAYMENTS_MORTGAGE_PAYMENT');
    expect(cat('s')).toBe('TRANSFER_OUT_ACCOUNT_TRANSFER');
  });

  it('gives the same totals as Plaid’s categories, in every mode', () => {
    seed();
    const totals = (): number[] => {
      const c = getCashflow(db, month);
      return [c.spend_cad, c.income_cad, c.net_cad];
    };
    const grouped = totals();
    expect(grouped).toEqual([2_500, 4_000, 1_500]);
    setSetting(db, 'CATEGORY_DETAIL', 'detailed');
    expect(totals()).toEqual(grouped);
    setSetting(db, 'CATEGORY_DETAIL', 'broad');
    expect(totals()).toEqual(grouped);
  });

  it('totals by group and filters by group', () => {
    seed();
    expect(getCashflow(db, month).by_category_group).toEqual([
      { category: 'HOME', spend_cad: 1_500 },
      { category: 'FAMILY_CARE', spend_cad: 800 },
      { category: 'FOOD', spend_cad: 126 },
      { category: 'BILLS_AND_UTILITIES', spend_cad: 74 },
    ]);
    expect(getTransactions(db, { category: 'FOOD' }).map((t) => t.id).sort()).toEqual(['c', 'g']);
    // Asked in Plaid's terms, as a model used to them might.
    expect(getTransactions(db, { category: 'FOOD_AND_DRINK' }).map((t) => t.id).sort()).toEqual(['c', 'g']);
  });

  it('maps a correction made in Plaid’s terms, and leaves your own categories alone', () => {
    seed();
    addMerchantRule(db, { pattern: 'Telus', match_type: 'merchant', category: 'FOOD_AND_DRINK' });
    addMerchantRule(db, { pattern: 'FreshCo', match_type: 'merchant', category: 'HOUSEHOLD' });
    expect(cat('t')).toBe('FOOD');
    expect(cat('g')).toBe('HOUSEHOLD');
  });

  it('offers the whole list in the picker, including what nothing is filed under yet', () => {
    seed();
    const cats = knownCategories(db);
    expect(cats).toContain('PETS_GROOMING');
    expect(cats).toContain('FOOD_GROCERIES');
    expect(cats).toContain('INCOME_SALARY');
    expect(cats).not.toContain('FOOD_AND_DRINK_COFFEE');
    const picker = categoryOptions(cats, 'FOOD_GROCERIES').value;
    expect(picker).toContain('<optgroup label="Food">');
    expect(picker).toContain('<option value="FOOD_GROCERIES" selected>Groceries</option>');
  });
});

describe('the grouped list itself', () => {
  it('files every entry under the parent it is declared in', () => {
    // A child starting with a longer parent's code (HOME_IMPROVEMENT_...)
    // would be counted under that parent instead.
    for (const [code, parent] of GROUPED_PARENT_OF) expect(familyOf(code), code).toBe(parent);
  });

  it('never moves a row into or out of spending', () => {
    for (const [src, dst] of FROM_PLAID) {
      expect(isTransferLike(src), src).toBe(false);
      expect(isTransferLike(dst), dst).toBe(false);
    }
  });

  it('only maps Plaid codes, into its own list', () => {
    for (const [src, dst] of FROM_PLAID) {
      expect(familyOf(src) !== null || ['RENT', 'UTILITIES'].includes(src), src).toBe(true);
      expect(GROUPED_CATEGORIES, src).toContain(dst);
    }
  });

  it('covers every spending code seen on a live install', () => {
    const seen = [
      'BANK_FEES_CASH_ADVANCE', 'BANK_FEES_FOREIGN_TRANSACTION_FEES', 'BANK_FEES_INTEREST_CHARGE',
      'BANK_FEES_OTHER_BANK_FEES', 'ENTERTAINMENT_CASINOS_AND_GAMBLING', 'ENTERTAINMENT_OTHER_ENTERTAINMENT',
      'ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS', 'ENTERTAINMENT_TV_AND_MOVIES',
      'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR', 'FOOD_AND_DRINK_COFFEE', 'FOOD_AND_DRINK_FAST_FOOD',
      'FOOD_AND_DRINK_GROCERIES', 'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT',
      'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', 'GENERAL_MERCHANDISE_CONVENIENCE_STORES',
      'GENERAL_MERCHANDISE_DISCOUNT_STORES', 'GENERAL_MERCHANDISE_ELECTRONICS',
      'GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',
      'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SPORTING_GOODS',
      'GENERAL_MERCHANDISE_SUPERSTORES', 'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING',
      'GENERAL_SERVICES_AUTOMOTIVE', 'GENERAL_SERVICES_CHILDCARE', 'GENERAL_SERVICES_EDUCATION',
      'GENERAL_SERVICES_INSURANCE', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES',
      'GENERAL_SERVICES_POSTAGE_AND_SHIPPING', 'GOVERNMENT_AND_NON_PROFIT', 'HOME_IMPROVEMENT_HARDWARE',
      'HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE', 'KIDS_ENTERTAINMENT', 'MEDICAL_OTHER_MEDICAL',
      'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'PERSONAL_CARE_HAIR_AND_BEAUTY',
      'PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',
      'RENT_AND_UTILITIES_OTHER_UTILITIES', 'RENT_AND_UTILITIES_TELEPHONE', 'TRANSPORTATION',
      'TRANSPORTATION_GAS', 'TRANSPORTATION_OTHER_TRANSPORTATION', 'TRANSPORTATION_PARKING',
      'TRANSPORTATION_PUBLIC_TRANSIT', 'TRAVEL', 'TRAVEL_FLIGHTS', 'TRAVEL_LODGING', 'TRAVEL_OTHER_TRAVEL',
      'TRAVEL_RENTAL_CARS',
    ];
    for (const code of seen) expect(GROUPED_CATEGORIES, code).toContain(toGrouped(code));
  });
});

describe('a category of your own, under a parent', () => {
  it('is the parent code with the name on the end, filed under that parent', () => {
    expect(addCategory(db, 'Rent', 'INCOME')).toBe('INCOME_RENT');
    expect(familyOf('INCOME_RENT')).toBe('INCOME');
    expect(categoryPath('INCOME_RENT')).toBe('Income › Rent');
    // Under a grouped parent too, and without doubling a prefix already typed.
    expect(addCategory(db, 'Food tips', 'FOOD')).toBe('FOOD_TIPS');
    expect(addCategory(db, 'Household')).toBe('HOUSEHOLD');
    expect(categoryPath('HOUSEHOLD')).toBe('Household');
  });

  it('refuses a name that would land in another family, or a parent that cannot hold one', () => {
    // HOME + IMPROVEMENT spells Plaid's HOME_IMPROVEMENT, not Home.
    expect(() => addCategory(db, 'Improvement shed', 'HOME')).toThrow(/would file under Home improvement, not Home/);
    expect(() => addCategory(db, 'Rent', 'HOUSEHOLD')).toThrow(/is not a category that can hold subcategories/);
  });

  it('is offered under its parent in every picker, and counted as income when money comes in', () => {
    addCategory(db, 'Rent', 'INCOME');
    expect(categoryParents(db)).toContain('INCOME');
    const picker = categoryOptions(knownCategories(db), null).value;
    expect(picker).toMatch(/<optgroup label="Income">.*<option value="INCOME_RENT">Rent<\/option>/s);
    upsertTransactions(db, [row('t', 'Tenant', 'TRANSFER_IN', 'TRANSFER_IN_DEPOSIT', -1_500)]);
    setTransactionOverride(db, 't', { category: 'INCOME_RENT' });
    const c = getCashflow(db, { start: '2026-08-01', end: '2026-08-31' });
    // A deposit the bank called a transfer, filed as rent received, is income now.
    expect(c.income_cad).toBe(1_500);
    expect(getTransactions(db, { category: 'INCOME' }).map((t) => t.id)).toEqual(['t']);
  });
});
