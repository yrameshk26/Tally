/**
 * Tags sit on top of categories: a trip, or business spending on a personal
 * card. What matters is that they narrow a view without changing any total,
 * follow a charge from pending to posted, and never tag something that is not
 * spending when a range is tagged in one go.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { upsertAccount, upsertTransactions, removeTransactions } from '../src/store.ts';
import { getCashflow, getTransactions } from '../src/queries.ts';
import {
  addTag,
  cleanTag,
  deleteTag,
  listTags,
  parseTags,
  removeTag,
  renameTag,
  setTags,
} from '../src/tags.ts';
import { buildPeriodReport, parsePeriod } from '../src/report.ts';
import { setTransactionOverride } from '../src/overrides.ts';
import { reportPage, transactionsPage, UNTAGGED } from '../src/web/pages.ts';
import type { RegisteredType } from '../src/lib/registered.ts';

let db: DB;

const row = (
  id: string,
  date: string,
  merchant: string,
  amount: number,
  category = 'FOOD_AND_DRINK',
  detailed: string | null = 'FOOD_AND_DRINK_RESTAURANT',
  extra: { pending?: boolean; replaces?: string } = {},
) => ({
  id,
  account_id: 'visa',
  date,
  name: merchant.toUpperCase(),
  merchant,
  amount,
  currency: 'CAD',
  amount_cad: amount,
  category,
  category_detailed: detailed,
  pending: extra.pending ?? false,
  replaces: extra.replaces ?? null,
});

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  upsertAccount(db, {
    id: 'visa', source: 'plaid', institution: 'Test Bank', name: 'Travel Visa', mask: null,
    account_category: 'LOC', account_subtype: 'credit card', registered_type: 'NON_REG' as RegisteredType,
    currency: 'CAD', balance: -100, balance_cad: -100, available: null, active: true, status: 'ok', item_id: null,
  });
  upsertTransactions(db, [
    // Home, before the trip.
    row('home1', '2026-07-01', 'FreshCo', 120, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'),
    // The trip crosses a month end.
    row('trip1', '2026-07-29', 'Trattoria Roma', 90),
    row('trip2', '2026-07-30', 'Hotel Centrale', 400, 'TRAVEL', 'TRAVEL_LODGING'),
    row('trip3', '2026-08-02', 'Esso Firenze', 70, 'TRANSPORTATION', 'TRANSPORTATION_GAS'),
    row('pay', '2026-07-31', 'Card payment', 500, 'LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'),
    // Home again.
    row('home2', '2026-08-10', 'FreshCo', 80, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'),
  ]);
});

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id).sort();

describe('tag names', () => {
  it('are tidied, and a list is split on commas without repeats', () => {
    expect(cleanTag('  Italy \t 2026\n')).toBe('Italy 2026');
    expect(cleanTag('x'.repeat(60))).toHaveLength(40);
    expect(parseTags('Italy 2026, business,  ITALY 2026 ,')).toEqual(['Italy 2026', 'business']);
  });

  it('ignore case, keeping the first spelling', () => {
    addTag(db, ['trip1'], 'Italy 2026');
    addTag(db, ['trip2'], 'italy 2026');
    expect(listTags(db)).toEqual([{ tag: 'Italy 2026', count: 2, first: '2026-07-29', last: '2026-07-30' }]);
  });

  it('refuse a blank name, and never tag a transaction that does not exist', () => {
    expect(() => addTag(db, ['trip1'], '  ')).toThrow(/needs a name/);
    expect(addTag(db, ['nope', 'trip1'], 'Italy 2026')).toBe(1);
  });
});

describe('a tagged view', () => {
  beforeEach(() => {
    addTag(db, ['trip1', 'trip2', 'trip3'], 'Italy 2026');
  });

  it('carries its tags on every transaction', () => {
    const t = getTransactions(db).find((r) => r.id === 'trip1');
    expect(t?.tags).toEqual(['Italy 2026']);
    expect(getTransactions(db).find((r) => r.id === 'home1')?.tags).toEqual([]);
  });

  it('filters to the tag, or to everything untagged', () => {
    expect(ids(getTransactions(db, { tag: 'italy 2026' }))).toEqual(['trip1', 'trip2', 'trip3']);
    // Spelled loosely, as a model or a URL might.
    expect(ids(getTransactions(db, { tag: ' italy  2026 ' }))).toEqual(['trip1', 'trip2', 'trip3']);
    expect(ids(getTransactions(db, { untagged: true }))).toEqual(['home1', 'home2', 'pay']);
  });

  it('splits the month without changing its total', () => {
    const july = { start: '2026-07-01', end: '2026-07-31' };
    const all = getCashflow(db, july).spend_cad;
    const trip = getCashflow(db, { ...july, tag: 'Italy 2026' }).spend_cad;
    const rest = getCashflow(db, { ...july, untagged: true }).spend_cad;
    expect([all, trip, rest]).toEqual([610, 490, 120]);
  });

  it('reports a trip across a month end, by category, with no net worth', () => {
    const r = buildPeriodReport(db, { period: parsePeriod({ period: 'tag', tag: 'Italy 2026' }) });
    expect([r.period, r.label, r.tag, r.start, r.end]).toEqual(['tag', 'Italy 2026', 'Italy 2026', '2026-07-29', '2026-08-02']);
    expect(r.spend_cad).toBe(560);
    expect(r.by_month.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
    expect(r.by_category.map((c) => c.category)).toEqual([
      'TRAVEL_AND_VACATION_LODGING',
      'FOOD_DINING',
      'AUTO_AND_TRANSPORT_FUEL',
    ]);
    expect(r.net_worth.end_cad).toBeNull();
    const page = reportPage({ nonce: 'n', report: r, profiles: [], tags: listTags(db) }).value;
    expect(page).toContain('Tag summary: Italy 2026');
    expect(page).not.toContain('<h2>Net worth</h2>');
    expect(page).toContain('Income and spending by month');
  });

  it('falls back to the last month when no tag is named', () => {
    expect(parsePeriod({ period: 'tag', tag: '  ' }, new Date('2026-09-15')).kind).toBe('month');
  });
});

describe('changing tags', () => {
  it('replaces one row’s tags from a comma list', () => {
    setTags(db, 'trip1', ['Italy 2026', 'Business']);
    expect(getTransactions(db).find((r) => r.id === 'trip1')?.tags).toEqual(['Business', 'Italy 2026']);
    setTags(db, 'trip1', []);
    expect(getTransactions(db).find((r) => r.id === 'trip1')?.tags).toEqual([]);
  });

  it('removes, renames, merges and deletes', () => {
    addTag(db, ['trip1', 'trip2'], 'Italy');
    addTag(db, ['trip3'], 'Italy 2026');
    expect(removeTag(db, ['trip2'], 'ITALY')).toBe(1);
    // Renaming onto an existing tag merges the two.
    expect(renameTag(db, 'Italy', 'Italy 2026')).toBe(1);
    expect(listTags(db)).toEqual([{ tag: 'Italy 2026', count: 2, first: '2026-07-29', last: '2026-08-02' }]);
    expect(deleteTag(db, 'italy 2026')).toBe(2);
    expect(listTags(db)).toEqual([]);
    // The transactions themselves are untouched.
    expect(getTransactions(db)).toHaveLength(6);
  });
});

describe('a charge that posts', () => {
  it('keeps its tags and its hand correction under the new id', () => {
    upsertTransactions(db, [row('pend', '2026-08-03', 'Gelateria', 12, 'FOOD_AND_DRINK', null, { pending: true })]);
    addTag(db, ['pend'], 'Italy 2026');
    setTransactionOverride(db, 'pend', { category: 'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK' });
    // Plaid sends the posted charge, pointing at the pending one, then removes it.
    upsertTransactions(db, [row('posted', '2026-08-03', 'Gelateria', 12, 'FOOD_AND_DRINK', null, { replaces: 'pend' })]);
    removeTransactions(db, ['pend']);
    const t = getTransactions(db).find((r) => r.id === 'posted');
    expect(t?.tags).toEqual(['Italy 2026']);
    expect(t?.corrected_by).toBe('override');
    expect(listTags(db)[0]?.count).toBe(1);
  });

  it('drops a removed transaction’s tags rather than leaving them on nothing', () => {
    addTag(db, ['home1'], 'Groceries run');
    removeTransactions(db, ['home1']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tx_tags').get()).toEqual({ n: 0 });
  });
});

describe('the Transactions page', () => {
  const filters = {
    transfers: 'hide' as const,
    start: '2026-07-01',
    end: '2026-08-31',
    profile: '',
    account_id: '',
    category: '',
    search: '',
    direction: 'all' as const,
    min_amount: '',
    group: 'none' as const,
    tag: '',
  };
  const render = (tag: string): string => {
    addTag(db, ['trip1'], 'Italy 2026');
    return transactionsPage({
      nonce: 'n',
      csrf: 'c',
      filters: { ...filters, tag },
      rows: getTransactions(db),
      merchants: [],
      categoryGroups: [],
      accounts: [],
      categories: [],
      profiles: [],
      tags: listTags(db),
      rules: [],
      hiddenTransfers: 0,
      truncated: false,
    }).value;
  };

  it('shows each tag as a link to its report, and offers the tag filter', () => {
    const out = render('');
    expect(out).toContain('<a class="pill tag" href="/report?period=tag&amp;tag=Italy%202026"');
    expect(out).toContain(`<option value="${UNTAGGED}">Untagged only</option>`);
    expect(out).toContain('action="/transactions/tags"');
    expect(out).toContain('name="tags" value="Italy 2026"');
  });

  it('says what an untagged view is', () => {
    expect(render(UNTAGGED)).toContain('trips and business set aside');
  });
});
