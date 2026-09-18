import { describe, expect, it } from 'vitest';
import type { AccountBase, Transaction } from 'plaid';
import { categoryFor, mapTransaction, normalizeBalance, plaidErrorCode } from '../src/sources/plaid.ts';

const fx = { toBase: (amount: number) => amount };

function account(type: string, current: number, available: number | null = null): AccountBase {
  return {
    account_id: 'a1',
    name: 'Test',
    type,
    subtype: null,
    balances: { current, available, iso_currency_code: 'CAD', unofficial_currency_code: null },
  } as unknown as AccountBase;
}

describe('Plaid balance sign normalisation', () => {
  it('keeps chequing and savings positive', () => {
    expect(normalizeBalance(account('depository', 4210.55))).toBe(4210.55);
  });

  it('makes credit cards negative', () => {
    expect(normalizeBalance(account('credit', 1820.4))).toBe(-1820.4);
  });

  it('makes loans negative', () => {
    expect(normalizeBalance(account('loan', 250000))).toBe(-250000);
  });

  it('does not double-negate a card Plaid already reported as negative', () => {
    expect(normalizeBalance(account('credit', -1820.4))).toBe(-1820.4);
  });

  it('keeps investment accounts positive', () => {
    expect(normalizeBalance(account('investment', 9000))).toBe(9000);
  });

  it('falls back to available when current is missing', () => {
    const a = account('depository', undefined as unknown as number, 75.25);
    expect(normalizeBalance(a)).toBe(75.25);
  });

  it('maps Plaid types onto our categories', () => {
    expect(categoryFor(account('credit', 0))).toBe('LOC');
    expect(categoryFor(account('loan', 0))).toBe('LOAN');
    expect(categoryFor(account('depository', 0))).toBe('DEPOSITORY');
    expect(categoryFor(account('investment', 0))).toBe('INVESTMENT');
    expect(categoryFor(account('brokerage', 0))).toBe('INVESTMENT');
    expect(categoryFor(account('other', 0))).toBe('OTHER');
  });
});

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 't1',
    account_id: 'a1',
    amount: 42.5,
    date: '2026-09-01',
    authorized_date: null,
    name: 'COFFEE',
    merchant_name: 'Coffee Co',
    iso_currency_code: 'CAD',
    unofficial_currency_code: null,
    pending: false,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    ...over,
  } as unknown as Transaction;
}

describe('transaction mapping', () => {
  it('stores Plaid-style amounts unchanged (positive = money out)', () => {
    expect(mapTransaction(tx(), fx).amount).toBe(42.5);
    expect(mapTransaction(tx({ amount: -1200 }), fx).amount).toBe(-1200);
  });

  it('namespaces ids and account ids so sources cannot collide', () => {
    const row = mapTransaction(tx(), fx);
    expect(row.id).toBe('plaid:t1');
    expect(row.account_id).toBe('plaid:a1');
  });

  it('prefers the authorized date over the posted date', () => {
    expect(mapTransaction(tx({ authorized_date: '2026-08-30' }), fx).date).toBe('2026-08-30');
  });

  it('carries the personal finance category through', () => {
    const row = mapTransaction(tx(), fx);
    expect(row.category).toBe('FOOD_AND_DRINK');
    expect(row.category_detailed).toBe('FOOD_AND_DRINK_COFFEE');
  });

  it('falls back to legacy categories when PFC is absent', () => {
    const row = mapTransaction(
      tx({ personal_finance_category: null, category: ['Travel', 'Airlines'] } as Partial<Transaction>),
      fx,
    );
    expect(row.category).toBe('Travel');
    expect(row.category_detailed).toBe('Travel > Airlines');
  });
});

describe('plaidErrorCode', () => {
  it('digs the code out of an axios-shaped error', () => {
    expect(plaidErrorCode({ response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } })).toBe(
      'ITEM_LOGIN_REQUIRED',
    );
  });

  it('returns null for anything else', () => {
    expect(plaidErrorCode(new Error('boom'))).toBeNull();
  });
});

describe('plaidErrorDetail', () => {
  it('surfaces the Plaid error instead of the generic axios message', async () => {
    const { plaidErrorDetail } = await import('../src/sources/plaid.ts');
    const axiosish = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        data: {
          error_type: 'INVALID_REQUEST',
          error_code: 'INVALID_FIELD',
          error_message: 'redirect_uri must be configured in the dashboard',
        },
      },
    });
    const msg = plaidErrorDetail(axiosish);
    expect(msg).toContain('INVALID_FIELD');
    expect(msg).toContain('redirect_uri');
    expect(msg).not.toBe('Request failed with status code 400');
  });

  it('prefers the display message and appends an actionable hint', async () => {
    const { plaidErrorDetail } = await import('../src/sources/plaid.ts');
    const e = {
      response: {
        data: {
          error_code: 'INVALID_API_KEYS',
          error_message: 'invalid client_id or secret provided',
          display_message: 'Invalid credentials',
        },
      },
    };
    const msg = plaidErrorDetail(e);
    expect(msg).toContain('Invalid credentials');
    expect(msg).toContain('PLAID_ENV');
  });

  it('falls back to the error message when the body is not a Plaid error', async () => {
    const { plaidErrorDetail } = await import('../src/sources/plaid.ts');
    expect(plaidErrorDetail(new Error('socket hang up'))).toBe('socket hang up');
  });
});

describe('link token products', () => {
  it('keeps required products minimal and liabilities optional', async () => {
    const { plaidProducts, plaidOptionalProducts } = await import('../src/sources/plaid.ts');
    // Required products restrict which institutions Link offers at all, so a
    // product the account may not have must never sit in the required list.
    expect(plaidProducts().map(String)).toEqual(['transactions']);
    expect(plaidOptionalProducts().map(String)).toContain('liabilities');
  });

  it('never lets a product appear in both lists — Plaid rejects the request', async () => {
    const { plaidProducts, plaidOptionalProducts } = await import('../src/sources/plaid.ts');
    const required = new Set(plaidProducts().map(String));
    for (const p of plaidOptionalProducts().map(String)) expect(required.has(p)).toBe(false);
  });
});
