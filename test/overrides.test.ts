/**
 * Hand corrections. The thing worth pinning here is precedence and reach: a
 * correction has to survive a sync, apply to history, and reach the rollups —
 * a rule that fixed the transaction list but left cashflow showing the bank's
 * spelling would be worse than no rule at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import {
  addMerchantRule,
  deleteMerchantRule,
  listMerchantRules,
  ruleImpact,
  setAccountCurrency,
  setTransactionOverride,
} from '../src/overrides.ts';
import {
  getCashflow,
  getTransactions,
  groupByCategory,
  groupByMerchant,
  knownCategories,
  listAccounts,
} from '../src/queries.ts';
import { upsertAccount, upsertTransactions, type AccountRow } from '../src/store.ts';
import type { RegisteredType } from '../src/lib/registered.ts';
import { inlineHandlers } from './helpers.ts';

function acct(over: Partial<AccountRow> & { id: string }): AccountRow {
  return {
    source: 'plaid',
    institution: 'American Express',
    name: over.id,
    mask: null,
    account_category: 'LOC',
    account_subtype: 'credit card',
    registered_type: 'NA' as RegisteredType,
    currency: 'USD',
    balance: 0,
    balance_cad: 0,
    available: null,
    active: true,
    status: 'ok',
    item_id: null,
    ...over,
  };
}

let db: DB;

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  db.prepare("INSERT INTO fx_rates (pair, rate, as_of, fetched_at) VALUES ('USDCAD', 1.4, '2026-09-17', '2026-09-17')").run();

  upsertAccount(db, acct({ id: 'plaid:card', currency: 'USD', balance: -100, balance_cad: -140 }));
  upsertTransactions(db, [
    {
      id: 'tx:1',
      account_id: 'plaid:card',
      date: '2026-09-01',
      name: 'PRIMMUM INSURANCE CO',
      merchant: 'Primmum Insurance Co',
      amount: 60,
      currency: 'USD',
      amount_cad: 84,
      category: 'GENERAL_SERVICES',
      category_detailed: 'GENERAL_SERVICES_INSURANCE',
      pending: false,
    },
    {
      id: 'tx:2',
      account_id: 'plaid:card',
      date: '2026-09-02',
      name: 'PRIMMUM INSURANCE COMP',
      merchant: 'Primmum Insurance Comp',
      amount: 40,
      currency: 'USD',
      amount_cad: 56,
      category: 'GENERAL_SERVICES',
      category_detailed: 'GENERAL_SERVICES_INSURANCE',
      pending: false,
    },
    {
      id: 'tx:3',
      account_id: 'plaid:card',
      date: '2026-09-03',
      name: 'SDM 1235',
      merchant: 'Sdm',
      amount: 10,
      currency: 'USD',
      amount_cad: 14,
      category: 'GENERAL_MERCHANDISE',
      category_detailed: 'GENERAL_MERCHANDISE_OTHER',
      pending: false,
    },
  ]);
});

const byId = (id: string) => getTransactions(db, { limit: 50 }).find((t) => t.id === id);

describe('merchant rules', () => {
  it('merges two spellings of one merchant, retroactively', () => {
    expect(groupByMerchant(getTransactions(db, { limit: 50 }))).toHaveLength(3);

    addMerchantRule(db, { pattern: 'primmum', merchant: 'Primmum Insurance' });

    const groups = groupByMerchant(getTransactions(db, { limit: 50 }));
    const primmum = groups.find((g) => g.merchant === 'Primmum Insurance');
    expect(primmum?.count).toBe(2);
    expect(primmum?.spend_cad).toBe(140);
    expect(groups).toHaveLength(2);
  });

  it('reaches the cashflow rollup, not just the transaction list', () => {
    addMerchantRule(db, { pattern: 'primmum', merchant: 'Primmum Insurance' });
    const cf = getCashflow(db, { start: '2026-09-01', end: '2026-09-30' });
    const names = cf.top_merchants.map((m) => m.merchant);
    expect(names).toContain('Primmum Insurance');
    expect(names).not.toContain('Primmum Insurance Co');
    expect(cf.top_merchants.find((m) => m.merchant === 'Primmum Insurance')?.spend_cad).toBe(140);
  });

  it('matches the raw description when the merchant field is unhelpful', () => {
    addMerchantRule(db, { pattern: 'SDM', merchant: 'Shoppers Drug Mart', category: 'PERSONAL_CARE' });
    const tx = byId('tx:3');
    expect(tx?.merchant).toBe('Shoppers Drug Mart');
    expect(tx?.category).toBe('PERSONAL_CARE');
    expect(tx?.corrected_by).toBe('rule');
  });

  it('applies the first matching rule and stops', () => {
    addMerchantRule(db, { pattern: 'primmum', merchant: 'First' });
    addMerchantRule(db, { pattern: 'primmum', merchant: 'Second' });
    expect(byId('tx:1')?.merchant).toBe('First');
  });

  it('reports how many transactions a pattern touches, before and after', () => {
    expect(ruleImpact(db, { pattern: 'primmum' })).toBe(2);
    expect(ruleImpact(db, { pattern: 'primmum insurance comp', match_type: 'contains' })).toBe(1);
    expect(ruleImpact(db, { pattern: 'nothing-here' })).toBe(0);
  });

  it('refuses a rule that would change nothing', () => {
    expect(() => addMerchantRule(db, { pattern: 'x' })).toThrow(/merchant, a category, or both/);
    expect(() => addMerchantRule(db, { pattern: '  ', merchant: 'X' })).toThrow(/pattern/);
  });

  it('reverts to the bank’s data when the rule is deleted', () => {
    const rule = addMerchantRule(db, { pattern: 'primmum', merchant: 'Primmum Insurance' });
    expect(byId('tx:1')?.merchant).toBe('Primmum Insurance');
    expect(deleteMerchantRule(db, rule.id)).toBe(true);
    expect(byId('tx:1')?.merchant).toBe('Primmum Insurance Co');
    expect(byId('tx:1')?.corrected_by).toBeNull();
    expect(listMerchantRules(db)).toHaveLength(0);
  });

  it('recategorising into a transfer actually excludes it from spend', () => {
    const before = getCashflow(db, { start: '2026-09-01', end: '2026-09-30' });
    expect(before.spend_cad).toBe(154);
    addMerchantRule(db, { pattern: 'SDM', category: 'TRANSFER_OUT' });
    const after = getCashflow(db, { start: '2026-09-01', end: '2026-09-30' });
    expect(after.spend_cad).toBe(140);
  });
});

describe('per-transaction overrides', () => {
  it('beats any rule', () => {
    addMerchantRule(db, { pattern: 'primmum', merchant: 'Primmum Insurance' });
    setTransactionOverride(db, 'tx:1', { merchant: 'Car insurance' });
    expect(byId('tx:1')?.merchant).toBe('Car insurance');
    expect(byId('tx:1')?.corrected_by).toBe('override');
    expect(byId('tx:2')?.merchant).toBe('Primmum Insurance');
  });

  it('merges successive edits instead of dropping the other field', () => {
    setTransactionOverride(db, 'tx:3', { merchant: 'Shoppers' });
    setTransactionOverride(db, 'tx:3', { category: 'MEDICAL' });
    expect(byId('tx:3')?.merchant).toBe('Shoppers');
    expect(byId('tx:3')?.category).toBe('MEDICAL');
  });

  it('clearing every field removes the override entirely', () => {
    setTransactionOverride(db, 'tx:3', { merchant: 'Shoppers' });
    setTransactionOverride(db, 'tx:3', { merchant: null });
    expect(byId('tx:3')?.merchant).toBe('Sdm');
    expect(byId('tx:3')?.corrected_by).toBeNull();
  });

  it('offers the categories already in use for a picker', () => {
    setTransactionOverride(db, 'tx:3', { category: 'MEDICAL' });
    expect(knownCategories(db)).toContain('MEDICAL');
    expect(knownCategories(db)).toContain('GENERAL_SERVICES');
  });
});

describe('account currency override', () => {
  it('reinterprets the account and its history, not just new rows', () => {
    expect(listAccounts(db)[0]?.balance_cad).toBe(-140);
    expect(byId('tx:1')?.amount_cad).toBe(-84);

    setAccountCurrency(db, 'plaid:card', 'CAD');

    const account = listAccounts(db)[0];
    expect(account?.balance_cad).toBe(-100);
    expect(account?.currency).toBe('CAD');
    expect(account?.currency_override).toBe('CAD');
    expect(byId('tx:1')?.amount_cad).toBe(-60);
  });

  it('goes back to trusting the institution when cleared', () => {
    setAccountCurrency(db, 'plaid:card', 'CAD');
    setAccountCurrency(db, 'plaid:card', null);
    expect(listAccounts(db)[0]?.balance_cad).toBe(-140);
    expect(listAccounts(db)[0]?.currency_override).toBeNull();
  });

  it('refuses a currency that is not a 3-letter code, and an unknown account', () => {
    expect(() => setAccountCurrency(db, 'plaid:card', 'dollars')).toThrow(/3-letter/);
    expect(setAccountCurrency(db, 'plaid:nope', 'CAD')).toBe(false);
  });
});

describe('grouping', () => {
  it('separates money out from money in, and dates the group', () => {
    upsertTransactions(db, [
      {
        id: 'tx:4',
        account_id: 'plaid:card',
        date: '2026-08-15',
        name: 'REFUND',
        merchant: 'Sdm',
        amount: -20,
        currency: 'USD',
        amount_cad: -28,
        category: 'GENERAL_MERCHANDISE',
        category_detailed: null,
        pending: false,
      },
    ]);
    const sdm = groupByMerchant(getTransactions(db, { limit: 50 })).find((g) => g.merchant === 'Sdm');
    expect(sdm).toMatchObject({ spend_cad: 14, received_cad: 28, net_cad: 14, count: 2, first: '2026-08-15', last: '2026-09-03' });
  });

  it('counts distinct merchants per category', () => {
    const cats = groupByCategory(getTransactions(db, { limit: 50 }));
    expect(cats.find((c) => c.category === 'GENERAL_SERVICES')).toMatchObject({
      spend_cad: 140,
      count: 2,
      merchants: 2,
    });
  });
});

describe('the transactions page', () => {
  it('escapes an institution-supplied merchant name', async () => {
    const { transactionsPage } = await import('../src/web/pages.ts');
    upsertTransactions(db, [
      {
        id: 'tx:xss',
        account_id: 'plaid:card',
        date: '2026-09-04',
        name: '<script>alert(1)</script>',
        merchant: '<img src=x onerror=alert(1)>',
        amount: 1,
        currency: 'USD',
        amount_cad: 1.4,
        category: null,
        category_detailed: null,
        pending: false,
      },
    ]);
    const rows = getTransactions(db, { limit: 50 });
    const out = transactionsPage({
      nonce: 'n',
      csrf: 'c',
      filters: {
        start: '2026-01-01',
        end: '2026-12-31',
        profile: '',
        account_id: '',
        category: '',
        search: '',
        direction: 'all',
        min_amount: '',
        group: 'merchant',
      },
      rows,
      merchants: groupByMerchant(rows),
      categoryGroups: groupByCategory(rows),
      accounts: listAccounts(db, {}),
      categories: knownCategories(db),
      profiles: [],
      rules: [],
      truncated: false,
    }).value;

    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;script&gt;');
    // The same string reaches a value= attribute in the edit form.
    expect(out).not.toMatch(/value="[^"]*<img/);
    expect(inlineHandlers(out)).toEqual([]);
  });
});
