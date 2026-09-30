/**
 * Two years of history for a bank that is already linked means linking it
 * again (Plaid fixes the history at link time). These pin the handover: the new
 * link stays out of every total until Plaid has all of it, then takes over
 * without a transaction counted twice or a tag, correction or account setting
 * lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db.ts';

process.env['TOKEN_ENC_KEY'] = 'e'.repeat(64);
process.env['PLAID_CLIENT_ID'] = 'test-client';
process.env['PLAID_SECRET'] = 'test-secret';
const { initDb, openDb } = await import('../src/db.ts');
const { PlaidApi } = await import('plaid');
const { exchangePublicToken, saveItem, syncPlaid, plaidStatus, unsyncedItems } = await import('../src/sources/plaid.ts');
const { plaidHistoryDays, setSetting } = await import('../src/settings.ts');
const { finishHandovers, handOver, historyReady, pairAccounts } = await import('../src/sources/plaid-history.ts');
const { upsertAccount, upsertTransactions } = await import('../src/store.ts');
const { addTag } = await import('../src/tags.ts');
const { setTransactionOverride } = await import('../src/overrides.ts');
const { getCashflow, getTransactions } = await import('../src/queries.ts');
const { createProfile } = await import('../src/profiles.ts');
const { connectionsPage, handoverProgress } = await import('../src/web/pages.ts');

let db: DB;

const account = (id: string, item: string, mask: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  source: 'plaid' as const,
  institution: 'Test Bank',
  name: `Card ${mask ?? ''}`,
  mask,
  account_category: 'LOC',
  account_subtype: 'credit card',
  registered_type: 'NA' as never,
  currency: 'CAD',
  balance: -500,
  balance_cad: -500,
  available: null,
  active: true,
  status: 'ok',
  item_id: item,
  ...extra,
});

const tx = (id: string, acct: string, date: string, amount: number, name: string) => ({
  id,
  account_id: acct,
  date,
  name,
  merchant: name,
  amount,
  currency: 'CAD',
  amount_cad: amount,
  category: 'FOOD_AND_DRINK',
  category_detailed: 'FOOD_AND_DRINK_RESTAURANT',
  pending: false,
});

beforeEach(() => {
  db = initDb(openDb(':memory:'));
});

describe('when the full history has arrived', () => {
  const linked = '2026-09-01T00:00:00Z';
  it('waits for Plaid to say so', () => {
    expect(historyReady('HISTORICAL_UPDATE_COMPLETE', linked)).toBe(true);
    expect(historyReady('INITIAL_UPDATE_COMPLETE', linked, new Date('2026-09-20'))).toBe(false);
    expect(historyReady('NOT_READY', linked, new Date('2026-09-20'))).toBe(false);
  });

  it('trusts a status Plaid cannot report, but only after three days', () => {
    expect(historyReady('TRANSACTIONS_UPDATE_STATUS_UNKNOWN', linked, new Date('2026-09-02'))).toBe(false);
    expect(historyReady('', linked, new Date('2026-09-05'))).toBe(true);
  });
});

describe('pairing accounts', () => {
  const a = (id: string, mask: string | null, subtype = 'credit card', name = 'Card') => ({
    id,
    name,
    mask,
    account_subtype: subtype,
    profile_id: 'me',
    currency_override: null,
  });

  it('pairs by last four digits and type, and only when there is one candidate', () => {
    const pairs = pairAccounts(
      [a('o1', '1111'), a('o2', '2222'), a('o3', '3333'), a('o4', null, 'checking', 'Chequing')],
      [a('n1', '1111'), a('n2', '2222', 'checking'), a('n3a', '3333'), a('n3b', '3333'), a('n4', null, 'checking', 'chequing')],
    );
    expect(Object.fromEntries(pairs)).toEqual({ o1: 'n1', o4: 'n4' });
  });
});

describe('the handover', () => {
  beforeEach(() => {
    createProfile(db, 'Partner');
    upsertAccount(db, account('old:card', 'old', '4242', { currency_override: 'USD' }));
    db.prepare("UPDATE accounts SET profile_id = 'partner', currency_override = 'USD' WHERE id = 'old:card'").run();
    upsertAccount(db, account('old:spare', 'old', '9999'));
    upsertTransactions(db, [
      tx('old:ancient', 'old:card', '2026-05-01', 20, 'OLD DINER'), // before the new history
      tx('old:trip', 'old:card', '2026-08-10', 90, 'TRATTORIA'), // tagged
      tx('old:fix', 'old:card', '2026-08-12', 40, 'SOMEWHERE'), // corrected
      tx('old:plain', 'old:card', '2026-08-15', 12, 'COFFEE'),
      tx('old:coffee2', 'old:card', '2026-08-15', 12, 'COFFEE'),
      tx('old:spare1', 'old:spare', '2026-08-01', 5, 'SPARE'),
    ]);
    addTag(db, ['old:trip'], 'Italy 2026');
    setTransactionOverride(db, 'old:fix', { category: 'FOOD_AND_DRINK_GROCERIES' });

    upsertAccount(db, account('new:card', 'new', '4242'));
    upsertTransactions(db, [
      tx('new:1', 'new:card', '2026-06-01', 30, 'LUNCH'),
      tx('new:trip', 'new:card', '2026-08-10', 90, 'TRATTORIA'),
      tx('new:fix', 'new:card', '2026-08-13', 40, 'SOMEWHERE LTD'), // posted a day later, renamed
      tx('new:c1', 'new:card', '2026-08-15', 12, 'COFFEE'),
      tx('new:c2', 'new:card', '2026-08-15', 12, 'COFFEE'),
    ]);
  });

  it('moves tags and corrections to the new copies, and removes the old ones', () => {
    const r = handOver(db, 'old', 'new');
    expect(r.accounts).toEqual({ 'old:card': 'new:card' });
    expect(r.carried).toBe(2);
    expect(r.replaced).toBe(4);
    const rows = getTransactions(db, { limit: 100 });
    expect(rows.find((t) => t.id === 'new:trip')?.tags).toEqual(['Italy 2026']);
    expect(rows.find((t) => t.id === 'new:fix')?.corrected_by).toBe('override');
    expect(rows.some((t) => ['old:trip', 'old:fix', 'old:plain', 'old:coffee2'].includes(t.id))).toBe(false);
  });

  it('keeps history the new link does not reach, on the new account', () => {
    const r = handOver(db, 'old', 'new');
    expect(r.kept_older).toBe(1);
    expect(getTransactions(db, { limit: 100 }).find((t) => t.id === 'old:ancient')?.account_id).toBe('new:card');
  });

  it('counts every purchase once', () => {
    handOver(db, 'old', 'new');
    // 20 older + 30 + 90 + 40 + 12 + 12 on the card, plus the unmatched spare.
    expect(getCashflow(db, { start: '2026-01-01', end: '2026-12-31' }).spend_cad).toBe(209);
  });

  it('carries the profile and currency set by hand', () => {
    handOver(db, 'old', 'new');
    expect(db.prepare("SELECT profile_id, currency_override FROM accounts WHERE id = 'new:card'").get()).toEqual({
      profile_id: 'partner',
      currency_override: 'USD',
    });
    expect(db.prepare("SELECT 1 FROM accounts WHERE id = 'old:card'").get()).toBeUndefined();
  });

  it('leaves an account with no clear partner, and its history, where a disconnect would', () => {
    const r = handOver(db, 'old', 'new');
    expect(r.unmatched_accounts).toEqual(['old:spare']);
    expect(getTransactions(db, { limit: 100 }).find((t) => t.id === 'old:spare1')?.account_id).toBe('old:spare');
  });

  it('is safe to run twice', () => {
    handOver(db, 'old', 'new');
    const again = handOver(db, 'old', 'new');
    expect([again.carried, again.replaced, again.kept_older]).toEqual([0, 0, 0]);
  });
});

describe('the sync', () => {
  const stubs = (status: string) => {
    const remove = vi.spyOn(PlaidApi.prototype, 'itemRemove').mockResolvedValue({ data: {} } as never);
    vi.spyOn(PlaidApi.prototype, 'institutionsGetById').mockResolvedValue({
      data: { institution: { name: 'Test Bank', products: ['transactions'] } },
    } as never);
    vi.spyOn(PlaidApi.prototype, 'liabilitiesGet').mockResolvedValue({ data: { liabilities: { credit: [] } } } as never);
    vi.spyOn(PlaidApi.prototype, 'accountsBalanceGet').mockImplementation(((req: { access_token: string }) =>
      Promise.resolve({
        data: {
          accounts: [
            {
              account_id: req.access_token === 'tok-new' ? 'N1' : 'O1',
              name: 'Visa',
              mask: '4242',
              type: 'credit',
              subtype: 'credit card',
              balances: { current: 500, iso_currency_code: 'CAD' },
            },
          ],
        },
      })) as never);
    vi.spyOn(PlaidApi.prototype, 'transactionsSync').mockImplementation(((req: { access_token: string }) => {
      const fresh = req.access_token === 'tok-new';
      return Promise.resolve({
        data: {
          added: fresh
            ? [
                { transaction_id: 'T-OLDEST', account_id: 'N1', date: '2025-01-15', amount: 50, name: 'BOOKS', iso_currency_code: 'CAD', pending: false },
                { transaction_id: 'T-TRIP', account_id: 'N1', date: '2026-08-10', amount: 90, name: 'TRATTORIA', iso_currency_code: 'CAD', pending: false },
              ]
            : [],
          modified: [],
          removed: [],
          next_cursor: 'c',
          has_more: false,
          transactions_update_status: fresh ? status : 'HISTORICAL_UPDATE_COMPLETE',
        },
      });
    }) as never);
    return remove;
  };

  beforeEach(() => {
    saveItem(db, { item_id: 'old', access_token: 'tok-old', institution_id: 'ins_1', institution_name: 'Test Bank' });
    upsertAccount(db, account('plaid:O1', 'old', '4242'));
    upsertTransactions(db, [tx('plaid:OLD-TRIP', 'plaid:O1', '2026-08-10', 90, 'TRATTORIA')]);
    addTag(db, ['plaid:OLD-TRIP'], 'Italy 2026');
    saveItem(db, {
      item_id: 'new',
      access_token: 'tok-new',
      institution_id: 'ins_1',
      institution_name: 'Test Bank',
      history_days: 730,
      replaces_item_id: 'old',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('leaves a replacement out of everything until its history is complete', async () => {
    const remove = stubs('INITIAL_UPDATE_COMPLETE');
    const report = (await syncPlaid(db, {})) as { detail: Record<string, unknown> };
    expect(remove).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE item_id = 'new'").get()).toEqual({ n: 0 });
    expect(getCashflow(db, { start: '2025-01-01', end: '2026-12-31' }).spend_cad).toBe(90);
    expect(JSON.stringify(report.detail)).toContain('waiting_for_history');
    // Nor does the catch-up for never-read connections touch it.
    expect(unsyncedItems(db).map((i) => i.item_id)).not.toContain('new');
    const status = plaidStatus(db);
    expect(status.find((s) => s['item_id'] === 'old')?.['replaced_by']).toBe('new');
    expect(status.find((s) => s['item_id'] === 'new')?.['history_status']).toBe('INITIAL_UPDATE_COMPLETE');
  });

  it('takes over once it is: old link removed at Plaid, history in, tag kept, nothing twice', async () => {
    const remove = stubs('HISTORICAL_UPDATE_COMPLETE');
    await syncPlaid(db, {});
    expect(remove).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT item_id, replaces_item_id FROM plaid_items').all()).toEqual([
      { item_id: 'new', replaces_item_id: null },
    ]);
    const rows = getTransactions(db, { start: '2025-01-01', limit: 100 });
    expect(rows.map((t) => t.id).sort()).toEqual(['plaid:T-OLDEST', 'plaid:T-TRIP']);
    expect(rows.find((t) => t.id === 'plaid:T-TRIP')?.tags).toEqual(['Italy 2026']);
    expect(getCashflow(db, { start: '2025-01-01', end: '2026-12-31' }).spend_cad).toBe(140);
  });
});

describe('linking again', () => {
  const linkAs = (institution: string) => {
    vi.spyOn(PlaidApi.prototype, 'itemPublicTokenExchange').mockResolvedValue({
      data: { access_token: 'tok-2', item_id: 'item-2' },
    } as never);
    vi.spyOn(PlaidApi.prototype, 'itemGet').mockResolvedValue({ data: { item: { institution_id: institution } } } as never);
    vi.spyOn(PlaidApi.prototype, 'institutionsGetById').mockResolvedValue({
      data: { institution: { name: institution === 'ins_1' ? 'Test Bank' : 'Other Bank' } },
    } as never);
  };
  beforeEach(() => {
    saveItem(db, { item_id: 'item-1', access_token: 'tok-1', institution_id: 'ins_1', institution_name: 'Test Bank' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('replaces the connection when it is the same bank', async () => {
    linkAs('ins_1');
    const r = await exchangePublicToken(db, 'public', 'me', { replaces: 'item-1', historyDays: 730 });
    expect(r.replacing).toBe('item-1');
    expect(db.prepare("SELECT history_days, replaces_item_id FROM plaid_items WHERE item_id = 'item-2'").get()).toEqual({
      history_days: 730,
      replaces_item_id: 'item-1',
    });
  });

  it('adds a different bank as a new connection, and says so', async () => {
    linkAs('ins_2');
    const r = await exchangePublicToken(db, 'public', 'me', { replaces: 'item-1', historyDays: 730 });
    expect(r.replacing).toBeNull();
    expect(r.note).toMatch(/not the same bank as Test Bank/);
    expect(db.prepare("SELECT replaces_item_id FROM plaid_items WHERE item_id = 'item-2'").get()).toEqual({
      replaces_item_id: null,
    });
  });
});

describe('the history setting for new banks', () => {
  afterEach(() => {
    delete process.env['PLAID_TRANSACTION_DAYS'];
  });

  it("is Plaid's default until set, and takes 30 to 730 days", () => {
    expect(plaidHistoryDays(db)).toBeNull();
    setSetting(db, 'PLAID_TRANSACTION_DAYS', '730');
    expect(plaidHistoryDays(db)).toBe(730);
    expect(() => setSetting(db, 'PLAID_TRANSACTION_DAYS', '1000')).toThrow(/30 to 730/);
    expect(() => setSetting(db, 'PLAID_TRANSACTION_DAYS', 'two years')).toThrow(/30 to 730/);
  });
});

describe('the Connections page', () => {
  const render = (items: Array<Record<string, unknown>>): string =>
    connectionsPage({
      profiles: [],
      activeProfile: { id: 'me', name: 'Me' } as never,
      unsynced: 0,
      items,
      snaptradeReady: false,
      wiseReady: false,
      plaidReady: true,
      redirectUri: 'https://money.example.com/connections/oauth',
      plaidEnv: 'production',
      products: ['transactions'],
      optionalProducts: [],
      statementsEnabled: false,
      countryCodes: ['CA'],
      csrf: 'c',
      nonce: 'n',
    }).value;
  const item = (extra: Record<string, unknown>) => ({
    item_id: 'i1',
    institution: 'Test Bank',
    status: 'ok',
    accounts: 1,
    balance_cad: 0,
    history_days: 90,
    replaces_item_id: null,
    replaced_by: null,
    ...extra,
  });

  it('offers two years for a bank linked with less, and says how much it has', () => {
    const out = render([item({})]);
    expect(out).toContain('History: 90 days');
    expect(out).toContain('data-history="i1"');
  });

  it('does not offer it again during a handover, or once it has two years', () => {
    expect(render([item({ replaced_by: 'i2' })])).not.toContain('data-history=');
    expect(render([item({ replaces_item_id: 'i0' })])).toContain('>taking over</span>');
    expect(render([item({ history_days: 730 })])).toContain('History: 2 years');
    expect(render([item({ history_days: 730 })])).not.toContain('data-history=');
  });
});

describe('handover progress', () => {
  it('says where Plaid is, in words', () => {
    expect(handoverProgress('INITIAL_UPDATE_COMPLETE', '2026-09-30T12:00:00Z')).toMatch(/recent months and is gathering the rest/);
    expect(handoverProgress('HISTORICAL_UPDATE_COMPLETE', '2026-09-30T12:00:00Z')).toMatch(/next refresh/);
    expect(handoverProgress(null, null)).toMatch(/Press Refresh now/);
  });
});

describe('two cards with the same last four digits', () => {
  // American Express reuses the last four across a business card family.
  const oldCards = [
    account('old:blue', 'old', '2002', { name: 'Blue Business Plus Card' }),
    account('old:bonvoy', 'old', '2002', { name: 'Bonvoy Business Amex Card' }),
  ];
  const newCards = [
    account('new:bonvoy', 'new', '2002', { name: 'Bonvoy Business Amex Card' }),
    account('new:blue', 'new', '2002', { name: 'Blue Business Plus Card' }),
  ];

  it('are told apart by name', () => {
    const asAcct = (a: ReturnType<typeof account>) => ({ ...a, profile_id: 'me', currency_override: null });
    expect(Object.fromEntries(pairAccounts(oldCards.map(asAcct), newCards.map(asAcct)))).toEqual({
      'old:blue': 'new:blue',
      'old:bonvoy': 'new:bonvoy',
    });
  });

  it('are finished on a later sync when an earlier handover left them, without counting twice', () => {
    // The state an earlier handover left: old Item gone, its two cards and their
    // rows still stored next to the new connection's copies.
    saveItem(db, { item_id: 'new', access_token: 'tok', institution_id: 'ins_1', institution_name: 'Test Bank', history_days: 730 });
    for (const a of [...oldCards, ...newCards]) upsertAccount(db, a);
    db.prepare("UPDATE accounts SET active = 0, status = 'removed' WHERE item_id = 'old'").run();
    upsertTransactions(db, [
      tx('o1', 'old:bonvoy', '2026-08-10', 300, 'HOTEL'),
      tx('n1', 'new:bonvoy', '2026-08-10', 300, 'HOTEL'),
      tx('n0', 'new:bonvoy', '2025-02-01', 80, 'OLDER HOTEL'),
    ]);
    addTag(db, ['o1'], 'Business');
    expect(getCashflow(db, { start: '2025-01-01', end: '2026-12-31' }).spend_cad).toBe(680);

    const done = finishHandovers(db, 'me');
    expect(done).toHaveLength(1);
    expect(getCashflow(db, { start: '2025-01-01', end: '2026-12-31' }).spend_cad).toBe(380);
    expect(getTransactions(db, { tag: 'Business', start: '2025-01-01' }).map((t) => t.id)).toEqual(['n1']);
    // Nothing left to do the second time.
    expect(finishHandovers(db, 'me')).toEqual([]);
  });

  it('leaves them alone when it cannot tell which connection took over', () => {
    saveItem(db, { item_id: 'a', access_token: 'tok', institution_id: 'ins_1', institution_name: 'Test Bank' });
    saveItem(db, { item_id: 'b', access_token: 'tok', institution_id: 'ins_1', institution_name: 'Test Bank' });
    upsertAccount(db, oldCards[0]!);
    upsertTransactions(db, [tx('o1', 'old:blue', '2026-08-10', 300, 'HOTEL')]);
    expect(finishHandovers(db, 'me')).toEqual([]);
    expect(getTransactions(db).map((t) => t.id)).toEqual(['o1']);
  });
});
