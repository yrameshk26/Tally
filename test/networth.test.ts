/**
 * Fixture-based aggregation tests. The numbers mirror the real household in the
 * build plan (~$184k CAD) so a sign or double-count regression shows up as a
 * number that is obviously wrong rather than subtly off.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { computeTotals, writeSnapshot } from '../src/snapshots.ts';
import {
  getCashflow,
  getContributionRoom,
  getHoldings,
  getNetWorthHistory,
  getTransactions,
  listAccounts,
  setAccountOwner,
  setContributed,
  setRoomLimit,
} from '../src/queries.ts';
import { replaceHoldings, upsertAccount, upsertActivities, upsertTransactions } from '../src/store.ts';
import type { AccountRow } from '../src/store.ts';
import type { RegisteredType } from '../src/lib/registered.ts';

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

function add(db: DB, id: string, registered: RegisteredType, cad: number, over: Partial<AccountRow> = {}): void {
  upsertAccount(db, acct({ id, registered_type: registered, balance: cad, balance_cad: cad, ...over }));
}

let db: DB;

beforeEach(() => {
  db = initDb(openDb(':memory:'));

  // Owner's Wealthsimple
  add(db, 'snaptrade:ws-rrsp', 'RRSP', 128600);
  add(db, 'snaptrade:ws-lira', 'LIRA', 31300);
  add(db, 'snaptrade:ws-tfsa', 'TFSA', 8000);
  add(db, 'snaptrade:ws-dpsp', 'DPSP', 3000);
  add(db, 'snaptrade:ws-gtfsa', 'TFSA', 3000);
  add(db, 'snaptrade:ws-grrsp', 'RRSP', 2900);
  // Spouse's Wealthsimple
  add(db, 'snaptrade:sp-tfsa', 'TFSA', 4700);
  add(db, 'snaptrade:sp-rrsp', 'RRSP', 2800);
  setAccountOwner(db, 'snaptrade:sp-tfsa', 'spouse');
  setAccountOwner(db, 'snaptrade:sp-rrsp', 'spouse');
});

describe('net worth aggregation', () => {
  it('matches the household total', () => {
    expect(computeTotals(db).net_worth_cad).toBe(184300);
  });

  it('splits by registered type without double counting', () => {
    const t = computeTotals(db);
    expect(t.by_registered_type).toEqual({
      RRSP: 134300,
      LIRA: 31300,
      TFSA: 15700,
      DPSP: 3000,
    });
    const sum = Object.values(t.by_registered_type).reduce((a, b) => a + b, 0);
    expect(sum).toBe(t.net_worth_cad);
  });

  it('splits by owner', () => {
    const t = computeTotals(db);
    expect(t.by_owner).toEqual({ me: 176800, spouse: 7500 });
  });

  it('filters to one person', () => {
    expect(computeTotals(db, 'spouse').net_worth_cad).toBe(7500);
  });

  it('subtracts liabilities and reports them separately', () => {
    add(db, 'plaid:amex', 'NA', -1820.4, {
      source: 'plaid',
      institution: 'American Express',
      account_category: 'LOC',
    });
    add(db, 'plaid:chq', 'NON_REG', 2500, {
      source: 'plaid',
      institution: 'RBC',
      account_category: 'DEPOSITORY',
    });
    const t = computeTotals(db);
    expect(t.total_liabilities_cad).toBe(-1820.4);
    expect(t.total_assets_cad).toBe(186800);
    expect(t.net_worth_cad).toBe(184979.6);
  });

  it('excludes closed and suppressed accounts', () => {
    add(db, 'snaptrade:closed-card', 'NA', 0, { active: false, status: 'closed' });
    add(db, 'snaptrade:ws-old', 'TFSA', 99999, { active: false, status: 'archived' });
    expect(computeTotals(db).net_worth_cad).toBe(184300);
    expect(listAccounts(db)).toHaveLength(8);
    expect(listAccounts(db, { include_inactive: true })).toHaveLength(10);
  });

  it('counts a USD account at its converted CAD value, not its face value', () => {
    add(db, 'wise:1:usd', 'NON_REG', 0, {
      source: 'wise',
      institution: 'Wise',
      currency: 'USD',
      balance: 1000,
      balance_cad: 1354.2,
    });
    expect(computeTotals(db).net_worth_cad).toBe(185654.2);
    expect(computeTotals(db).by_source['wise']).toBe(1354.2);
  });
});

describe('snapshots', () => {
  it('writes one row per day and updates it on a re-sync', () => {
    writeSnapshot(db);
    writeSnapshot(db);
    const history = getNetWorthHistory(db);
    expect(history).toHaveLength(1);
    expect(history[0]!['net_worth_cad']).toBe(184300);
  });

  it('keeps a backfilled origin separate from the daily sync row', () => {
    writeSnapshot(db, 'sync');
    writeSnapshot(db, 'snaptrade');
    expect(getNetWorthHistory(db)).toHaveLength(2);
  });
});

describe('holdings concentration', () => {
  beforeEach(() => {
    replaceHoldings(db, 'snaptrade:ws-rrsp', [
      {
        account_id: 'snaptrade:ws-rrsp',
        symbol: 'XEQT',
        description: 'iShares Core Equity ETF',
        asset_type: 'security',
        quantity: 3500,
        price: 36.74,
        currency: 'CAD',
        market_value: 128590,
        market_value_cad: 128590,
        cost_basis: 100000,
        cost_basis_cad: 100000,
      },
      {
        account_id: 'snaptrade:ws-rrsp',
        symbol: 'CASH.CAD',
        description: 'Cash (CAD)',
        asset_type: 'cash',
        quantity: 10,
        price: 1,
        currency: 'CAD',
        market_value: 10,
        market_value_cad: 10,
        cost_basis: 10,
        cost_basis_cad: 10,
      },
    ]);
    replaceHoldings(db, 'snaptrade:ws-tfsa', [
      {
        account_id: 'snaptrade:ws-tfsa',
        symbol: 'XEQT',
        description: 'iShares Core Equity ETF',
        asset_type: 'security',
        quantity: 200,
        price: 36.74,
        currency: 'CAD',
        market_value: 7348,
        market_value_cad: 7348,
        cost_basis: 7000,
        cost_basis_cad: 7000,
      },
      {
        account_id: 'snaptrade:ws-tfsa',
        symbol: 'TSLA',
        description: 'Tesla Inc',
        asset_type: 'security',
        quantity: 2,
        price: 240,
        currency: 'USD',
        market_value: 480,
        market_value_cad: 650.02,
        cost_basis: 400,
        cost_basis_cad: 541.68,
      },
    ]);
  });

  it('rolls a symbol up across accounts and ranks by value', () => {
    const h = getHoldings(db);
    expect(h.positions[0]!.symbol).toBe('XEQT');
    expect(h.positions[0]!.quantity).toBe(3700);
    expect(h.positions[0]!.market_value_cad).toBe(135938);
    expect(h.positions[0]!.accounts).toHaveLength(2);
  });

  it('reports concentration as a percentage of invested value', () => {
    const h = getHoldings(db);
    expect(h.total_invested_cad).toBe(136588.02);
    expect(h.positions[0]!.weight_pct).toBeCloseTo(99.52, 1);
    const sum = h.positions.reduce((a, p) => a + p.weight_pct, 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  it('excludes cash unless asked for it', () => {
    expect(getHoldings(db).positions.some((p) => p.symbol === 'CASH.CAD')).toBe(false);
    expect(getHoldings(db, { include_cash: true }).positions.some((p) => p.symbol === 'CASH.CAD')).toBe(
      true,
    );
  });

  it('computes unrealized P&L from cost basis', () => {
    const xeqt = getHoldings(db).positions.find((p) => p.symbol === 'XEQT')!;
    expect(xeqt.unrealized_pnl_cad).toBe(28938);
  });

  it('holds a USD position at its CAD value', () => {
    const tsla = getHoldings(db).positions.find((p) => p.symbol === 'TSLA')!;
    expect(tsla.market_value_cad).toBe(650.02);
    expect(tsla.currencies).toEqual(['USD']);
  });
});

describe('transactions and cashflow', () => {
  beforeEach(() => {
    add(db, 'plaid:chq', 'NON_REG', 5000, {
      source: 'plaid',
      institution: 'RBC',
      account_category: 'DEPOSITORY',
    });
    add(db, 'plaid:amex', 'NA', -800, {
      source: 'plaid',
      institution: 'Amex',
      account_category: 'LOC',
    });
    // Stored Plaid-style: positive = money out of the account.
    upsertTransactions(db, [
      mkTx('t1', 'plaid:chq', '2026-08-03', 'PAYROLL', -4200, 'INCOME'),
      mkTx('t2', 'plaid:amex', '2026-08-05', 'Loblaws', 180.25, 'FOOD_AND_DRINK'),
      mkTx('t3', 'plaid:amex', '2026-08-12', 'Loblaws', 95.75, 'FOOD_AND_DRINK'),
      mkTx('t4', 'plaid:amex', '2026-08-20', 'Air Canada', 640, 'TRAVEL'),
      mkTx('t5', 'plaid:chq', '2026-08-25', 'TRANSFER TO WEALTHSIMPLE', 1000, 'TRANSFER_OUT'),
      mkTx('t6', 'plaid:chq', '2026-09-02', 'PAYROLL', -4200, 'INCOME'),
      mkTx('t7', 'plaid:chq', '2026-09-04', 'AMEX PAYMENT', 916, 'LOAN_PAYMENTS'),
    ]);
  });

  function mkTx(
    id: string,
    account: string,
    date: string,
    name: string,
    amount: number,
    category: string,
  ) {
    return {
      id: `plaid:${id}`,
      account_id: account,
      date,
      name,
      merchant: name,
      amount,
      currency: 'CAD',
      amount_cad: amount,
      category,
      category_detailed: category,
      pending: false,
    };
  }

  it('flips the sign on read so money out is negative', () => {
    const rows = getTransactions(db, { start: '2026-08-01', end: '2026-08-31' });
    const groceries = rows.find((r) => r.id === 'plaid:t2')!;
    expect(groceries.amount_cad).toBe(-180.25);
    const payroll = rows.find((r) => r.id === 'plaid:t1')!;
    expect(payroll.amount_cad).toBe(4200);
  });

  it('filters by date, account and search text', () => {
    expect(getTransactions(db, { start: '2026-09-01', end: '2026-09-30' })).toHaveLength(2);
    expect(getTransactions(db, { account_id: 'plaid:amex' })).toHaveLength(3);
    expect(getTransactions(db, { search: 'Loblaws' })).toHaveLength(2);
  });

  it('excludes transfers and card payments from cashflow by default', () => {
    const cf = getCashflow(db, { start: '2026-08-01', end: '2026-09-30' });
    expect(cf.income_cad).toBe(8400);
    expect(cf.spend_cad).toBe(916);
    expect(cf.net_cad).toBe(7484);
    expect(cf.excluded_categories).toContain('TRANSFER_OUT');
    expect(cf.excluded_categories).toContain('LOAN_PAYMENTS');
  });

  it('can include transfers when explicitly asked', () => {
    const cf = getCashflow(db, {
      start: '2026-08-01',
      end: '2026-09-30',
      include_transfers: true,
      include_loan_payments: true,
    });
    expect(cf.spend_cad).toBe(2832);
  });

  it('breaks spend down by month and merchant', () => {
    const cf = getCashflow(db, { start: '2026-08-01', end: '2026-09-30' });
    expect(cf.by_month.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(cf.top_merchants[0]).toEqual({ merchant: 'Air Canada', spend_cad: 640, count: 1 });
    expect(cf.top_merchants.find((m) => m.merchant === 'Loblaws')!.spend_cad).toBe(276);
  });
});

describe('contribution room', () => {
  beforeEach(() => {
    setRoomLimit(db, 'me', 'RRSP', 2026, 115568, 'CRA NOA 2025');
    setRoomLimit(db, 'me', 'TFSA', 2026, 80676.52);
    upsertActivities(db, [
      {
        id: 'snaptrade:act:1',
        account_id: 'snaptrade:ws-rrsp',
        date: '2026-03-01',
        type: 'CONTRIBUTION',
        description: 'RRSP contribution',
        symbol: null,
        amount: 12000,
        currency: 'CAD',
        amount_cad: 12000,
      },
      {
        id: 'snaptrade:act:2',
        account_id: 'snaptrade:ws-rrsp',
        date: '2025-03-01',
        type: 'CONTRIBUTION',
        description: 'prior year',
        symbol: null,
        amount: 9000,
        currency: 'CAD',
        amount_cad: 9000,
      },
      {
        id: 'snaptrade:act:3',
        account_id: 'snaptrade:ws-rrsp',
        date: '2026-04-01',
        type: 'DIVIDEND',
        description: 'not a contribution',
        symbol: 'XEQT',
        amount: 400,
        currency: 'CAD',
        amount_cad: 400,
      },
    ]);
  });

  it('subtracts detected contributions for the requested year only', () => {
    const rrsp = getContributionRoom(db, { year: 2026 }).find((r) => r.account_type === 'RRSP')!;
    expect(rrsp.contributed_detected_cad).toBe(12000);
    expect(rrsp.remaining_cad).toBe(103568);
    expect(rrsp.basis).toBe('detected');
    expect(rrsp.confidence).toBe('high');
  });

  it('ignores activity that is not a contribution', () => {
    const rrsp = getContributionRoom(db, { year: 2026 }).find((r) => r.account_type === 'RRSP')!;
    expect(rrsp.contributed_detected_cad).not.toBe(12400);
  });

  it('flags low confidence when nothing was detected', () => {
    const tfsa = getContributionRoom(db, { year: 2026 }).find((r) => r.account_type === 'TFSA')!;
    expect(tfsa.contributed_detected_cad).toBe(0);
    expect(tfsa.remaining_cad).toBe(80676.52);
    expect(tfsa.confidence).toBe('low');
  });

  it('lets a manual figure override detection', () => {
    setContributed(db, 'me', 'RRSP', 2026, 20000, 'includes the March lump sum');
    const rrsp = getContributionRoom(db, { year: 2026 }).find((r) => r.account_type === 'RRSP')!;
    expect(rrsp.basis).toBe('manual');
    expect(rrsp.contributed_used_cad).toBe(20000);
    expect(rrsp.remaining_cad).toBe(95568);
    expect(rrsp.contributed_detected_cad).toBe(12000);
  });

  it('reports bank transfers into a brokerage separately, never subtracted', () => {
    add(db, 'plaid:chq', 'NON_REG', 5000, { source: 'plaid', account_category: 'DEPOSITORY' });
    upsertTransactions(db, [
      {
        id: 'plaid:x1',
        account_id: 'plaid:chq',
        date: '2026-02-01',
        name: 'TRANSFER WEALTHSIMPLE',
        merchant: 'Wealthsimple',
        amount: 5000,
        currency: 'CAD',
        amount_cad: 5000,
        category: 'TRANSFER_OUT',
        category_detailed: 'TRANSFER_OUT_INVESTMENT',
        pending: false,
      },
    ]);
    const rrsp = getContributionRoom(db, { year: 2026 }).find((r) => r.account_type === 'RRSP')!;
    expect(rrsp.unattributed_brokerage_transfers_cad).toBe(5000);
    expect(rrsp.remaining_cad).toBe(103568);
  });

  it('keeps the person filter honest', () => {
    setRoomLimit(db, 'spouse', 'TFSA', 2026, 7000);
    expect(getContributionRoom(db, { year: 2026, person: 'spouse' })).toHaveLength(1);
    expect(getContributionRoom(db, { year: 2026 })).toHaveLength(3);
  });
});

describe('owner tagging', () => {
  it('survives a re-sync of the same account', () => {
    setAccountOwner(db, 'snaptrade:ws-tfsa', 'spouse');
    add(db, 'snaptrade:ws-tfsa', 'TFSA', 8500);
    const a = listAccounts(db).find((x) => x.id === 'snaptrade:ws-tfsa')!;
    expect(a.owner).toBe('spouse');
    expect(a.balance_cad).toBe(8500);
  });

  it('reports failure for an unknown account id', () => {
    expect(setAccountOwner(db, 'snaptrade:nope', 'spouse')).toBe(false);
  });
});
