/**
 * The one-call picture. These tests pin two things the tool surface depends on:
 * that every section is actually reachable, and that asking for a subset really
 * does omit the rest — a summary tool that quietly returns everything regardless
 * of `sections` would blow up a context window on every small question.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { DEFAULT_SECTIONS, SUMMARY_SECTIONS, buildSummary, monthsAgoISO } from '../src/summary.ts';
import {
  getActivities,
  getHoldingsByAccount,
  isLiabilityAccount,
  setAccountProfile,
} from '../src/queries.ts';
import {
  replaceHoldings,
  upsertAccount,
  upsertActivities,
  upsertTransactions,
  type AccountRow,
} from '../src/store.ts';
import type { RegisteredType } from '../src/lib/registered.ts';
import { createProfile } from '../src/profiles.ts';

function acct(over: Partial<AccountRow> & { id: string }): AccountRow {
  return {
    source: 'snaptrade',
    institution: 'Wealthsimple',
    name: over.id,
    mask: null,
    account_category: 'INVESTMENT',
    account_subtype: null,
    registered_type: 'NA' as RegisteredType,
    currency: 'CAD',
    balance: 0,
    balance_cad: 0,
    available: null,
    active: true,
    status: 'open',
    item_id: null,
    ...over,
  };
}

let db: DB;

beforeEach(() => {
  db = initDb(openDb(':memory:'));

  upsertAccount(db, acct({ id: 'st:rrsp', registered_type: 'RRSP' as RegisteredType, balance: 100000, balance_cad: 100000 }));
  upsertAccount(db, acct({ id: 'st:tfsa', registered_type: 'TFSA' as RegisteredType, balance: 20000, balance_cad: 20000 }));
  upsertAccount(
    db,
    acct({
      id: 'plaid:amex',
      source: 'plaid',
      institution: 'American Express',
      name: 'Cobalt',
      mask: '1004',
      account_category: 'LOC',
      balance: -1500,
      balance_cad: -1500,
      registered_type: 'NA' as RegisteredType,
    }),
  );
  createProfile(db, 'Spouse');
  setAccountProfile(db, 'st:tfsa', 'spouse');

  replaceHoldings(db, 'st:rrsp', [
    {
      account_id: 'st:rrsp',
      symbol: 'XEQT',
      description: 'iShares All-Equity ETF',
      asset_type: 'et',
      quantity: 2000,
      price: 40,
      currency: 'CAD',
      market_value: 80000,
      market_value_cad: 80000,
      cost_basis: 60000,
      cost_basis_cad: 60000,
    },
  ]);
  replaceHoldings(db, 'st:tfsa', [
    {
      account_id: 'st:tfsa',
      symbol: 'VFV',
      description: 'Vanguard S&P 500',
      asset_type: 'et',
      quantity: 100,
      price: 150,
      currency: 'CAD',
      market_value: 15000,
      market_value_cad: 15000,
      cost_basis: null,
      cost_basis_cad: null,
    },
  ]);

  upsertActivities(db, [
    {
      id: 'act:div1',
      account_id: 'st:rrsp',
      date: '2026-08-15',
      type: 'DIVIDEND',
      description: 'XEQT distribution',
      symbol: 'XEQT',
      amount: 220.5,
      currency: 'CAD',
      amount_cad: 220.5,
    },
    {
      id: 'act:buy1',
      account_id: 'st:rrsp',
      date: '2026-08-16',
      type: 'BUY',
      description: 'Bought XEQT',
      symbol: 'XEQT',
      amount: -500,
      currency: 'CAD',
      amount_cad: -500,
    },
    {
      id: 'act:div2',
      account_id: 'st:tfsa',
      date: '2026-09-02',
      type: 'dividend',
      description: 'VFV distribution',
      symbol: 'VFV',
      amount: 30,
      currency: 'CAD',
      amount_cad: 30,
    },
  ]);

  upsertTransactions(db, [
    {
      id: 'tx:1',
      account_id: 'plaid:amex',
      date: '2026-09-01',
      name: 'Loblaws',
      merchant: 'Loblaws',
      amount: 120,
      currency: 'CAD',
      amount_cad: 120,
      category: 'FOOD_AND_DRINK',
      category_detailed: 'FOOD_AND_DRINK_GROCERIES',
      pending: false,
    },
    {
      id: 'tx:2',
      account_id: 'plaid:amex',
      date: '2026-09-02',
      name: 'Payroll',
      merchant: null,
      amount: -3000,
      currency: 'CAD',
      amount_cad: -3000,
      category: 'INCOME',
      category_detailed: 'INCOME_WAGES',
      pending: false,
    },
  ]);
});

describe('buildSummary', () => {
  it('returns the default sections and names the ones it left out', () => {
    const s = buildSummary(db);
    expect(s.sections).toEqual(DEFAULT_SECTIONS.filter((x) => SUMMARY_SECTIONS.includes(x)));
    for (const section of DEFAULT_SECTIONS) expect(s[section]).toBeDefined();
    expect(s.omitted_sections).toContain('transactions');
    expect(s['transactions']).toBeUndefined();
    expect(s.hint).toMatch(/transactions/);
  });

  it('returns every section when asked for all of them', () => {
    const s = buildSummary(db, { sections: SUMMARY_SECTIONS });
    for (const section of SUMMARY_SECTIONS) expect(s[section], section).toBeDefined();
    expect(s.omitted_sections).toEqual([]);
    expect(s.hint).toBeUndefined();
  });

  it('returns only what was asked for', () => {
    const s = buildSummary(db, { sections: ['net_worth'] });
    expect(s['net_worth']).toBeDefined();
    for (const other of SUMMARY_SECTIONS.filter((x) => x !== 'net_worth')) {
      expect(s[other], other).toBeUndefined();
    }
  });

  it('ignores a section name it does not know rather than failing', () => {
    const s = buildSummary(db, { sections: ['net_worth', 'crypto_moon' as never] });
    expect(s['net_worth']).toBeDefined();
    expect(s.sections).toEqual(['net_worth']);
  });

  it('covers the whole household across sources', () => {
    const s = buildSummary(db, { sections: SUMMARY_SECTIONS });
    const nw = s['net_worth'] as { net_worth_cad: number; by_source: Record<string, number> };
    expect(nw.net_worth_cad).toBe(118500);
    expect(nw.by_source).toEqual({ snaptrade: 120000, plaid: -1500 });

    const accounts = s['accounts'] as { count: number; by_source: Record<string, number> };
    expect(accounts.count).toBe(3);
    expect(accounts.by_source).toEqual({ snaptrade: 2, plaid: 1 });

    const cards = s['cards'] as { count: number; total_owing_cad: number; cards: Array<Record<string, unknown>> };
    expect(cards.count).toBe(1);
    expect(cards.total_owing_cad).toBe(-1500);
    expect(cards.cards[0]?.['mask']).toBe('1004');
    // The UI's "Cards and loans" table filters on the same categories.
    expect(isLiabilityAccount({ category: 'LOC' })).toBe(true);
    expect(isLiabilityAccount({ category: 'loan' })).toBe(true);
    expect(isLiabilityAccount({ category: 'DEPOSITORY' })).toBe(false);
    expect(isLiabilityAccount({ category: null })).toBe(false);
  });

  it('scopes every section to one profile', () => {
    const s = buildSummary(db, { profile: 'spouse', sections: ['net_worth', 'accounts', 'holdings'] });
    expect((s['net_worth'] as { net_worth_cad: number }).net_worth_cad).toBe(20000);
    expect((s['accounts'] as { count: number }).count).toBe(1);
    expect((s['holdings'] as { total_invested_cad: number }).total_invested_cad).toBe(15000);
  });

  it('flags a truncated transaction list instead of silently dropping rows', () => {
    const s = buildSummary(db, { sections: ['transactions'], start: '2026-01-01', end: '2026-12-31', limit: 1 });
    const tx = s['transactions'] as { count: number; truncated: boolean; note?: string };
    expect(tx.count).toBe(1);
    expect(tx.truncated).toBe(true);
    expect(tx.note).toMatch(/get_transactions/);
  });

  it('defaults the period to whole months back from today', () => {
    const s = buildSummary(db, { months: 3, end: '2026-09-18' });
    expect(s.period).toEqual({ start: '2026-07-01', end: '2026-09-18' });
    expect(monthsAgoISO(1, new Date('2026-01-15T00:00:00Z'))).toBe('2026-01-01');
    expect(monthsAgoISO(2, new Date('2026-01-15T00:00:00Z'))).toBe('2025-12-01');
  });
});

describe('getActivities', () => {
  it('rolls brokerage movements up by type', () => {
    const r = getActivities(db, {});
    expect(r.count).toBe(3);
    expect(r.by_type).toEqual([
      { type: 'DIVIDEND', amount_cad: 250.5, count: 2 },
      { type: 'BUY', amount_cad: -500, count: 1 },
    ]);
  });

  it('keeps the brokerage sign: a dividend is money in', () => {
    const [latest] = getActivities(db, { type: 'DIVIDEND' }).activities;
    expect(latest?.amount_cad).toBeGreaterThan(0);
    expect(latest?.account).toBe('st:tfsa');
  });

  it('filters by profile, symbol and date', () => {
    expect(getActivities(db, { profile: 'spouse' }).count).toBe(1);
    expect(getActivities(db, { symbol: 'xeqt' }).count).toBe(2);
    expect(getActivities(db, { start: '2026-09-01' }).count).toBe(1);
  });
});

describe('getHoldingsByAccount', () => {
  it('groups positions under their account, largest account first', () => {
    const accounts = getHoldingsByAccount(db, {});
    expect(accounts.map((a) => a.account_id)).toEqual(['st:rrsp', 'st:tfsa']);
    expect(accounts[0]?.invested_cad).toBe(80000);
    expect(accounts[0]?.registered_type).toBe('RRSP');
    expect(accounts[0]?.positions[0]?.weight_pct).toBe(100);
    expect(accounts[0]?.positions[0]?.unrealized_pnl_cad).toBe(20000);
    expect(accounts[1]?.profile).toBe('spouse');
    expect(accounts[1]?.positions[0]?.unrealized_pnl_cad).toBeNull();
  });

  it('reports invested separately from the account balance', () => {
    const [rrsp] = getHoldingsByAccount(db, { account_id: 'st:rrsp' });
    expect(rrsp?.balance_cad).toBe(100000);
    expect(rrsp?.invested_cad).toBe(80000);
  });
});
