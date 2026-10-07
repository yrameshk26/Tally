/**
 * Cash spending entered by hand. What matters: it counts as spending like any
 * other row in every category mode, a transfer category is refused (it would
 * silently vanish), only the entries made here can be edited or deleted, a bank
 * sync never touches them, and the reconciliation compares cash taken out with
 * cash spending recorded without ever categorising the withdrawal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { deactivateMissing, upsertAccount, upsertTransactions } from '../src/store.ts';
import { getCashflow, getTransactions } from '../src/queries.ts';
import { setSetting } from '../src/settings.ts';
import { listTags } from '../src/tags.ts';
import { DEFAULT_PROFILE_ID, createProfile } from '../src/profiles.ts';
import { todayISO } from '../src/lib/money.ts';
import {
  addCashExpense,
  cashAccountId,
  cashReconciliation,
  deleteCashExpense,
  ensureCashAccount,
  isCashTransactionId,
  tagsFromField,
  updateCashExpense,
} from '../src/cash.ts';
import type { RegisteredType } from '../src/lib/registered.ts';

let db: DB;

const WINDOW = { start: '2026-06-01', end: '2026-06-30' };

const bank = (id: string, profile = DEFAULT_PROFILE_ID) =>
  upsertAccount(
    db,
    {
      id, source: 'plaid', institution: 'Test Bank', name: 'Chequing', mask: null,
      account_category: 'DEPOSITORY', account_subtype: 'checking', registered_type: 'NON_REG' as RegisteredType,
      currency: 'CAD', balance: 500, balance_cad: 500, available: null, active: true, status: 'ok', item_id: 'item-1',
    },
    profile,
  );

const bankRow = (id: string, account: string, date: string, amount: number, category: string, detailed: string | null) => ({
  id, account_id: account, date, name: id.toUpperCase(), merchant: id, amount, currency: 'CAD',
  amount_cad: amount, category, category_detailed: detailed, pending: false,
});

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  bank('chq');
});

describe('adding cash spending', () => {
  it('creates one Cash account per profile, with no balance, and counts the entry as spending', () => {
    const id = addCashExpense(db, { amount: 12.5, description: 'Market', date: '2026-06-10', category: 'FOOD_AND_DRINK' });
    expect(isCashTransactionId(id)).toBe(true);

    const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(cashAccountId(DEFAULT_PROFILE_ID)) as Record<string, unknown>;
    expect(acct).toMatchObject({ source: 'manual', name: 'Cash', balance: 0, balance_cad: 0, active: 1 });

    addCashExpense(db, { amount: 3, description: 'Bus', date: '2026-06-11' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE source = 'manual'").get()).toEqual({ n: 1 });

    const flow = getCashflow(db, WINDOW);
    expect(flow.spend_cad).toBe(15.5);
    expect(flow.top_merchants.map((m) => m.merchant)).toContain('Market');
  });

  it('reads as money out, like a card purchase', () => {
    addCashExpense(db, { amount: 12.5, description: 'Market', date: '2026-06-10', category: 'FOOD_AND_DRINK' });
    const [t] = getTransactions(db, { ...WINDOW });
    expect(t).toMatchObject({ amount: -12.5, amount_cad: -12.5, merchant: 'Market', pending: false });
  });

  it('gives the same total in every category mode', () => {
    addCashExpense(db, { amount: 20, description: 'Haircut', date: '2026-06-12', category: 'PERSONAL_CARE' });
    addCashExpense(db, { amount: 8, description: 'Lunch', date: '2026-06-12', category: 'FOOD_AND_DRINK' });
    const totals = (['grouped', 'detailed', 'broad'] as const).map((mode) => {
      setSetting(db, 'CATEGORY_DETAIL', mode);
      return getCashflow(db, WINDOW).spend_cad;
    });
    expect(totals).toEqual([28, 28, 28]);
  });

  it('refuses a transfer category, which would make the entry vanish from spending', () => {
    for (const c of ['TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL', 'LOAN_PAYMENTS']) {
      expect(() => addCashExpense(db, { amount: 5, description: 'x', category: c })).toThrow(/not spending/);
    }
    expect(getTransactions(db, {})).toHaveLength(0);
  });

  it('leaves the category blank when none is given', () => {
    addCashExpense(db, { amount: 4, description: 'Tip', date: '2026-06-12' });
    expect(getCashflow(db, WINDOW).spend_cad).toBe(4);
  });

  it('applies tags, and a tag narrows the view without changing a total', () => {
    addCashExpense(db, { amount: 40, description: 'Souvenirs', date: '2026-06-12', tags: ['Italy 2031'] });
    addCashExpense(db, { amount: 10, description: 'Coffee', date: '2026-06-13' });
    expect(listTags(db).map((t) => t.tag)).toEqual(['Italy 2031']);
    expect(getCashflow(db, { ...WINDOW, tag: 'Italy 2031' }).spend_cad).toBe(40);
    expect(getCashflow(db, WINDOW).spend_cad).toBe(50);
  });

  it('validates the amount, the description and the date', () => {
    const bad = (o: object) => () => addCashExpense(db, { amount: 5, description: 'ok', ...o });
    expect(bad({ amount: 0 })).toThrow(/more than zero/);
    expect(bad({ amount: -3 })).toThrow(/more than zero/);
    expect(bad({ amount: Number.NaN })).toThrow(/more than zero/);
    expect(bad({ amount: 2_000_000 })).toThrow(/too large/);
    expect(bad({ description: '   ' })).toThrow(/Say what it was/);
    expect(bad({ date: '10/06/2031' })).toThrow(/look like/);
    expect(bad({ date: '2026-02-31' })).toThrow(/look like/);
    expect(bad({ date: '2999-01-01' })).toThrow(/future/);
    expect(getTransactions(db, {})).toHaveLength(0);
  });

  it('defaults the date to today and tidies the description', () => {
    addCashExpense(db, { amount: 5, description: '  Fruit \n stand\t ' });
    const [t] = getTransactions(db, { start: todayISO(), end: todayISO() });
    expect(t?.merchant).toBe('Fruit stand');
  });

  it('converts another currency at the latest rate, and says so when there is none', () => {
    expect(() => addCashExpense(db, { amount: 10, description: 'Souk', currency: 'MAD', date: '2026-06-12' })).toThrow(/No exchange rate/);
    db.prepare("INSERT INTO fx_rates (pair, rate, as_of, fetched_at) VALUES ('EURCAD', 1.5, '2026-06-01', '2026-06-01T00:00:00Z')").run();
    addCashExpense(db, { amount: 10, description: 'Gelato', currency: 'EUR', date: '2026-06-12' });
    const [t] = getTransactions(db, { ...WINDOW });
    expect(t).toMatchObject({ amount: -10, currency: 'EUR', amount_cad: -15 });
    expect(getCashflow(db, WINDOW).spend_cad).toBe(15);
  });

  it('keeps each profile’s cash separate', () => {
    const p = createProfile(db, 'Partner');
    addCashExpense(db, { amount: 7, description: 'Mine', date: '2026-06-12' });
    addCashExpense(db, { amount: 9, description: 'Theirs', date: '2026-06-12', profile: p.id });
    expect(getCashflow(db, { ...WINDOW, profile: p.id }).spend_cad).toBe(9);
    expect(getCashflow(db, { ...WINDOW, profile: DEFAULT_PROFILE_ID }).spend_cad).toBe(7);
    expect(() => ensureCashAccount(db, 'nobody')).toThrow(/No such profile/);
  });
});

describe('changing and deleting cash entries', () => {
  it('edits amount, description and date, and recomputes the base amount', () => {
    const id = addCashExpense(db, { amount: 10, description: 'Market', date: '2026-06-10', category: 'FOOD_AND_DRINK' });
    updateCashExpense(db, id, { amount: 14.25, description: 'Farm market', date: '2026-06-09' });
    const [t] = getTransactions(db, { ...WINDOW });
    expect(t).toMatchObject({ amount: -14.25, amount_cad: -14.25, merchant: 'Farm market', date: '2026-06-09' });
    expect(getCashflow(db, WINDOW).spend_cad).toBe(14.25);
  });

  it('touches only the fields it is given, and validates them', () => {
    const id = addCashExpense(db, { amount: 10, description: 'Market', date: '2026-06-10', tags: ['Italy'] });
    updateCashExpense(db, id, { description: 'Bakery' });
    expect(getTransactions(db, { ...WINDOW })[0]).toMatchObject({ amount: -10, merchant: 'Bakery', tags: ['Italy'] });
    expect(() => updateCashExpense(db, id, { amount: 0 })).toThrow(/more than zero/);
    expect(() => updateCashExpense(db, id, { category: 'TRANSFER_OUT' })).toThrow(/not spending/);
    updateCashExpense(db, id, { tags: [] });
    expect(getTransactions(db, { ...WINDOW })[0]?.tags).toEqual([]);
  });

  it('deletes an entry with its tags', () => {
    const id = addCashExpense(db, { amount: 10, description: 'Market', date: '2026-06-10', tags: ['Italy'] });
    deleteCashExpense(db, id);
    expect(getTransactions(db, {})).toHaveLength(0);
    expect(listTags(db)).toEqual([]);
    expect(getCashflow(db, WINDOW).spend_cad).toBe(0);
  });

  it('refuses a bank’s transaction, a missing one, and a manual-looking id on a bank account', () => {
    upsertTransactions(db, [
      bankRow('buy', 'chq', '2026-06-10', 30, 'FOOD_AND_DRINK', null),
      bankRow('manual:sneaky', 'chq', '2026-06-10', 30, 'FOOD_AND_DRINK', null),
    ]);
    for (const id of ['buy', 'manual:sneaky']) {
      expect(() => deleteCashExpense(db, id)).toThrow(/Only cash entries/);
      expect(() => updateCashExpense(db, id, { amount: 1 })).toThrow(/Only cash entries/);
    }
    expect(() => deleteCashExpense(db, 'manual:nope')).toThrow(/No such transaction/);
    expect(getTransactions(db, {})).toHaveLength(2);
  });

  it('survives a bank sync, which only deactivates its own source', () => {
    addCashExpense(db, { amount: 10, description: 'Market', date: '2026-06-10' });
    deactivateMissing(db, 'plaid', [], DEFAULT_PROFILE_ID);
    expect(db.prepare('SELECT active FROM accounts WHERE id = ?').get(cashAccountId(DEFAULT_PROFILE_ID))).toEqual({ active: 1 });
    expect(db.prepare('SELECT active FROM accounts WHERE id = ?').get('chq')).toEqual({ active: 0 });
  });

  it('does not move net worth', () => {
    const before = db.prepare('SELECT COALESCE(SUM(balance_cad), 0) AS n FROM accounts').get();
    addCashExpense(db, { amount: 500, description: 'Furniture', date: '2026-06-10' });
    expect(db.prepare('SELECT COALESCE(SUM(balance_cad), 0) AS n FROM accounts').get()).toEqual(before);
  });
});

describe('cash reconciliation', () => {
  const withdrawal = (id: string, date: string, amount: number, account = 'chq') =>
    bankRow(id, account, date, amount, 'TRANSFER_OUT', 'TRANSFER_OUT_WITHDRAWAL');

  it('compares cash taken out with cash spending recorded, and the withdrawal stays hidden', () => {
    upsertTransactions(db, [
      withdrawal('atm1', '2026-06-05', 200),
      withdrawal('atm2', '2026-06-20', 100),
      bankRow('xfer', 'chq', '2026-06-06', 50, 'TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER'),
    ]);
    addCashExpense(db, { amount: 60, description: 'Market', date: '2026-06-07' });
    addCashExpense(db, { amount: 45, description: 'Haircut', date: '2026-06-08' });

    expect(cashReconciliation(db, WINDOW)).toEqual({
      ...WINDOW,
      withdrawn_cad: 300,
      withdrawals: 2,
      recorded_cad: 105,
      entries: 2,
      unaccounted_cad: 195,
    });
    // The withdrawal is a transfer: only the two entries are spending.
    expect(getCashflow(db, WINDOW).spend_cad).toBe(105);
  });

  it('goes negative when more is recorded than was withdrawn in the window', () => {
    upsertTransactions(db, [withdrawal('atm1', '2026-05-28', 100)]);
    addCashExpense(db, { amount: 30, description: 'Market', date: '2026-06-07' });
    expect(cashReconciliation(db, WINDOW)).toMatchObject({ withdrawn_cad: 0, recorded_cad: 30, unaccounted_cad: -30 });
  });

  it('respects the window and the profile, and leaves out pending rows and deposits', () => {
    const p = createProfile(db, 'Partner');
    bank('their-chq', p.id);
    upsertTransactions(db, [
      withdrawal('mine', '2026-06-05', 100),
      withdrawal('theirs', '2026-06-05', 70, 'their-chq'),
      withdrawal('outside', '2026-07-05', 500),
      { ...withdrawal('pend', '2026-06-09', 40), pending: true },
      bankRow('dep', 'chq', '2026-06-09', -80, 'TRANSFER_IN', 'TRANSFER_IN_DEPOSIT'),
    ]);
    addCashExpense(db, { amount: 25, description: 'Mine', date: '2026-06-07' });
    addCashExpense(db, { amount: 10, description: 'Theirs', date: '2026-06-07', profile: p.id });

    expect(cashReconciliation(db, WINDOW)).toMatchObject({ withdrawn_cad: 170, recorded_cad: 35 });
    expect(cashReconciliation(db, { ...WINDOW, profile: p.id })).toMatchObject({ withdrawn_cad: 70, recorded_cad: 10, unaccounted_cad: 60 });
    expect(cashReconciliation(db, { ...WINDOW, profile: DEFAULT_PROFILE_ID })).toMatchObject({ withdrawn_cad: 100, recorded_cad: 25 });
  });

  it('is all zeros when there is nothing', () => {
    expect(cashReconciliation(db, WINDOW)).toMatchObject({ withdrawn_cad: 0, withdrawals: 0, recorded_cad: 0, entries: 0, unaccounted_cad: 0 });
  });
});

describe('tagsFromField', () => {
  it('splits and cleans what a form sends', () => {
    expect(tagsFromField(' Italy 2031 ,  business ,, ')).toEqual(['Italy 2031', 'business']);
    expect(tagsFromField(undefined)).toEqual([]);
  });
});
