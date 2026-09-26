/**
 * The period report is the thing people print and keep, so the figures on it
 * have to be the same figures everywhere else. The cases worth pinning: a card
 * payment is not counted as spending on top of the purchases it paid for,
 * the report agrees with cashflow to the cent, and a month nobody measured
 * says so instead of reporting a change of zero.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { buildPeriodReport, parsePeriod, periodBounds } from '../src/report.ts';
import { getCashflow, isTransferLike } from '../src/queries.ts';
import { reportPage } from '../src/web/pages.ts';
import { toolDefs } from '../src/tools/registry.ts';
import { upsertAccount, upsertTransactions, type AccountRow } from '../src/store.ts';
import type { RegisteredType } from '../src/lib/registered.ts';
import { inlineHandlers } from './helpers.ts';

const TODAY = new Date('2026-09-23T12:00:00Z');

function acct(id: string, over: Partial<AccountRow> = {}): AccountRow {
  return {
    id,
    source: 'plaid',
    institution: 'Test Bank',
    name: id,
    mask: null,
    account_category: 'DEPOSITORY',
    account_subtype: 'checking',
    registered_type: 'NON_REG' as RegisteredType,
    currency: 'CAD',
    balance: 0,
    balance_cad: 0,
    available: null,
    active: true,
    status: 'ok',
    item_id: null,
    ...over,
  };
}

/** Plaid-style: positive is money out. */
function tx(
  id: string,
  account: string,
  date: string,
  amount: number,
  category: string,
  merchant: string | null = null,
  pending = false,
) {
  return {
    id,
    account_id: account,
    date,
    name: (merchant ?? id).toUpperCase(),
    merchant,
    amount,
    currency: 'CAD',
    amount_cad: amount,
    category,
    category_detailed: null,
    pending,
  };
}

function snapshot(db: DB, date: string, net: number, byProfile: Record<string, number> = {}): void {
  db.prepare(
    `INSERT INTO snapshots (ts, total_assets_cad, total_liabilities_cad, net_worth_cad, by_owner, by_registered_type, origin)
     VALUES (?, ?, ?, ?, ?, ?, 'test')`,
  ).run(`${date}T04:15:00.000Z`, net + 500, -500, net, JSON.stringify(byProfile), JSON.stringify({ TFSA: net }));
}

let db: DB;

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  upsertAccount(db, acct('chq'));
  upsertAccount(db, acct('card', { account_category: 'LOC', account_subtype: 'credit card' }));
  upsertTransactions(db, [
    // August: 300 of purchases on the card, then the card paid off from
    // chequing. Counting both would report 600 of spending.
    tx('g1', 'card', '2026-08-03', 120, 'FOOD_AND_DRINK', 'Northgate Grocery'),
    tx('g2', 'card', '2026-08-10', 80, 'FOOD_AND_DRINK', 'Northgate Grocery'),
    tx('f1', 'card', '2026-08-15', 100, 'TRANSPORTATION', 'Harbour Fuel'),
    tx('pay-chq', 'chq', '2026-08-20', 300, 'LOAN_PAYMENTS'),
    tx('pay-card', 'card', '2026-08-20', -300, 'LOAN_PAYMENTS'),
    // Money to savings: both sides, neither is spending or income.
    tx('xfer-out', 'chq', '2026-08-21', 1_000, 'TRANSFER_OUT'),
    tx('xfer-in', 'chq', '2026-08-21', -1_000, 'TRANSFER_IN'),
    tx('pay', 'chq', '2026-08-28', -2_000, 'INCOME', 'Acme Logistics'),
    // Still pending on the last day: not settled, not counted.
    tx('p1', 'card', '2026-08-31', 45, 'FOOD_AND_DRINK', 'Corner Coffee', true),
    // Outside the month, so it must not leak in.
    tx('sep', 'card', '2026-09-02', 999, 'TRAVEL', 'Skyline Air'),
  ]);
});

describe('reading a period', () => {
  it('defaults to the last complete month', () => {
    expect(parsePeriod({}, TODAY)).toEqual({ kind: 'month', month: '2026-08' });
    // January looks back into the previous year.
    expect(parsePeriod({}, new Date('2026-01-10T00:00:00Z'))).toEqual({ kind: 'month', month: '2025-12' });
  });

  it('reads a month or a year, and falls back rather than throwing on junk', () => {
    expect(parsePeriod({ month: '2026-03' }, TODAY)).toEqual({ kind: 'month', month: '2026-03' });
    expect(parsePeriod({ period: 'year', year: '2025' }, TODAY)).toEqual({ kind: 'year', year: 2025 });
    expect(parsePeriod({ month: '2026-13' }, TODAY)).toEqual({ kind: 'month', month: '2026-08' });
    expect(parsePeriod({ period: 'year', year: 'soon' }, TODAY)).toEqual({ kind: 'year', year: 2026 });
  });

  it('reads the month and the year as two fields, the way the page sends them', () => {
    expect(parsePeriod({ period: 'month', month: '03', year: '2025' }, TODAY)).toEqual({ kind: 'month', month: '2025-03' });
    // A month with no usable year is not guessed at.
    expect(parsePeriod({ period: 'month', month: '03', year: 'soon' }, TODAY)).toEqual({ kind: 'month', month: '2026-08' });
  });

  it('offers a month dropdown, not a browser month picker', () => {
    const out = reportPage({
      nonce: 'n',
      report: buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY),
      profiles: [],
    }).value;
    expect(out).not.toContain('type="month"');
    expect(out).toContain('<option value="08" selected>August</option>');
    expect(out).toContain('<option value="2026" selected>2026</option>');
  });

  it('knows how long February is', () => {
    expect(periodBounds({ kind: 'month', month: '2028-02' }, TODAY).end).toBe('2028-02-29');
    expect(periodBounds({ kind: 'month', month: '2026-02' }, TODAY).end).toBe('2026-02-28');
  });

  it('flags a period that has not finished', () => {
    expect(periodBounds({ kind: 'month', month: '2026-09' }, TODAY).to_date).toBe(true);
    expect(periodBounds({ kind: 'month', month: '2026-08' }, TODAY).to_date).toBe(false);
    expect(periodBounds({ kind: 'year', year: 2026 }, TODAY)).toMatchObject({ label: '2026', to_date: true });
  });
});

describe('income and spending', () => {
  it('does not count a card payment as spending on top of the purchases', () => {
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    expect(r.spend_cad).toBe(300);
    expect(r.income_cad).toBe(2_000);
    expect(r.net_cad).toBe(1_700);
    expect(r.savings_rate).toBe(0.85);
  });

  it('agrees with cashflow to the cent', () => {
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    const c = getCashflow(db, { start: '2026-08-01', end: '2026-08-31' });
    expect([r.income_cad, r.spend_cad, r.net_cad]).toEqual([c.income_cad, c.spend_cad, c.net_cad]);
  });

  it('says what it left out, and how much', () => {
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    expect(r.excluded.count).toBe(4);
    // Both sides of a transfer are the same money, so out and in are kept
    // apart rather than summed into a figure twice the size of what moved.
    expect(r.excluded.out_cad).toBe(1_300);
    expect(r.excluded.in_cad).toBe(1_300);
    expect(r.excluded.pending).toBe(1);
    expect(r.transactions_counted).toBe(4);
  });

  it('ranks categories with their share, and the largest expenses first', () => {
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    expect(r.by_category).toEqual([
      { category: 'FOOD_AND_DRINK', spend_cad: 200, share: 0.67 },
      { category: 'TRANSPORTATION', spend_cad: 100, share: 0.33 },
    ]);
    expect(r.largest_expenses.map((e) => e.amount_cad)).toEqual([-120, -100, -80]);
    // A transfer is never one of the largest expenses, however large.
    expect(r.largest_expenses.some((e) => isTransferLike(e.category))).toBe(false);
  });

  it('keeps a year to its own twelve months', () => {
    const r = buildPeriodReport(db, { period: { kind: 'year', year: 2026 } }, TODAY);
    expect(r.by_month.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(r.spend_cad).toBe(1_299);
  });
});

describe('net worth', () => {
  it('opens on the last snapshot before the period, and closes on the last inside it', () => {
    snapshot(db, '2026-07-31', 10_000);
    snapshot(db, '2026-08-15', 10_600);
    snapshot(db, '2026-08-31', 11_250);
    snapshot(db, '2026-09-10', 99_999);
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    expect(r.net_worth).toMatchObject({
      start_cad: 10_000,
      start_date: '2026-07-31',
      end_cad: 11_250,
      end_date: '2026-08-31',
      change_cad: 1_250,
      end_by_registered_type: { TFSA: 11_250 },
    });
    // The opening snapshot leads the chart, so its delta equals the change.
    expect(r.net_worth.history.map((h) => h.date)).toEqual(['2026-07-31', '2026-08-15', '2026-08-31']);
    const h = r.net_worth.history;
    expect(h[h.length - 1]!.net_worth_cad - h[0]!.net_worth_cad).toBe(r.net_worth.change_cad);
  });

  it('does not report a change of zero for a month nobody measured', () => {
    // History exists, but all of it is from before August.
    snapshot(db, '2026-07-01', 10_000);
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    expect(r.net_worth.end_cad).toBeNull();
    expect(r.net_worth.change_cad).toBeNull();
  });

  it('uses the first snapshot inside the period when there is none before it', () => {
    snapshot(db, '2026-08-12', 5_000);
    snapshot(db, '2026-08-30', 5_400);
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY);
    expect(r.net_worth).toMatchObject({ start_cad: 5_000, start_date: '2026-08-12', change_cad: 400 });
  });

  it("reads one profile's share, and leaves out what snapshots cannot split", () => {
    snapshot(db, '2026-07-31', 10_000, { me: 7_000, partner: 3_000 });
    snapshot(db, '2026-08-31', 11_000, { me: 7_400, partner: 3_600 });
    const r = buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' }, profile: 'partner' }, TODAY);
    expect(r.net_worth).toMatchObject({ start_cad: 3_000, end_cad: 3_600, change_cad: 600 });
    expect(r.net_worth.end_assets_cad).toBeNull();
    expect(r.net_worth.end_by_registered_type).toBeNull();
  });
});

describe('the printed page', () => {
  it('renders every section, and never an inline handler', () => {
    snapshot(db, '2026-07-31', 10_000);
    snapshot(db, '2026-08-31', 11_250);
    const out = reportPage({
      nonce: 'n',
      report: buildPeriodReport(db, { period: { kind: 'year', year: 2026 } }, TODAY),
      profiles: [],
    }).value;
    for (const heading of ['Net worth', 'Income and spending by month', 'Spending by category', 'Top merchants', 'Largest expenses']) {
      expect(out, heading).toContain(`<h2>${heading}</h2>`);
    }
    expect(out).toContain('id="save-pdf"');
    expect(out).toContain('window.print()');
    expect(inlineHandlers(out)).toEqual([]);
  });

  it('escapes a merchant name the bank sent', () => {
    upsertTransactions(db, [tx('x', 'card', '2026-08-05', 50, 'SHOPPING', '<img src=x onerror=alert(1)>')]);
    const out = reportPage({
      nonce: 'n',
      report: buildPeriodReport(db, { period: { kind: 'month', month: '2026-08' } }, TODAY),
      profiles: [],
    }).value;
    expect(out).not.toContain('<img src=x');
  });
});

describe('spend by merchant, over MCP', () => {
  type Rollup = {
    transactions: number;
    excluded_transfers: number;
    groups: Array<{ category?: string; merchant?: string; spend_cad: number }>;
  };
  const call = async (args: Record<string, unknown>): Promise<Rollup> => {
    const def = toolDefs(db).find((d) => d.name === 'get_spend_by_merchant')!;
    const res = await def.handler({ start: '2026-08-01', end: '2026-08-31', ...args });
    return JSON.parse((res.content[0] as { text: string }).text) as Rollup;
  };

  it('does not count a card payment on top of the purchases it paid for', async () => {
    const r = await call({ group_by: 'category' });
    const cats = r.groups.map((g) => g.category);
    expect(cats).not.toContain('LOAN_PAYMENTS');
    expect(cats).not.toContain('TRANSFER_OUT');
    // 300 of purchases, plus the pending coffee this rollup has always shown.
    expect(r.groups.reduce((s, g) => s + g.spend_cad, 0)).toBe(345);
    expect(r.excluded_transfers).toBe(4);
  });

  it('includes them when asked', async () => {
    const r = await call({ group_by: 'category', include_transfers: true });
    expect(r.groups.map((g) => g.category)).toContain('LOAN_PAYMENTS');
    expect(r.excluded_transfers).toBe(0);
  });

  it('reads the whole window, not the first thousand rows', async () => {
    // A year with a dozen linked banks is well past a thousand transactions;
    // a rollup over the newest thousand is a wrong total, not a partial one.
    upsertTransactions(
      db,
      Array.from({ length: 1_200 }, (_, i) =>
        tx(`bulk-${String(i)}`, 'card', '2026-08-12', 1, 'SHOPPING', 'Corner Store'),
      ),
    );
    const r = await call({ group_by: 'merchant', limit: 3 });
    expect(r.transactions).toBeGreaterThan(1_200);
    expect(r.groups.find((g) => g.merchant === 'Corner Store')?.spend_cad).toBe(1_200);
    // `limit` trims the groups shown, never the rows summed.
    expect(r.groups).toHaveLength(3);
  });
});

describe('over MCP', () => {
  it('is a read-only tool that returns the same report', async () => {
    const def = toolDefs(db).find((d) => d.name === 'get_period_report');
    expect(def?.annotations['readOnlyHint']).toBe(true);
    const res = await def!.handler({ period: 'month', month: '2026-08' });
    const body = JSON.parse((res.content[0] as { text: string }).text) as { spend_cad: number; label: string };
    expect(body).toMatchObject({ label: 'August 2026', spend_cad: 300 });
  });
});
