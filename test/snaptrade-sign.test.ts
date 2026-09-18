import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyAccount,
  isLiveAccount,
  mapHoldings,
  registeredFor,
  signRequest,
  type StAccount,
  type StHoldings,
} from '../src/sources/snaptrade.ts';

const fx = { toBase: (amount: number, from: string) => (from === 'USD' ? amount * 1.3542 : amount) };

describe('request signing', () => {
  it('matches the scheme the SnapTrade SDK uses', () => {
    const consumerKey = 'test-consumer-key';
    const path = '/api/v1/accounts';
    const query = 'clientId=ACME&timestamp=1760000000';
    const expected = createHmac('sha256', encodeURI(consumerKey))
      .update(JSON.stringify({ content: null, path, query }, ['content', 'path', 'query']))
      .digest('base64');
    expect(signRequest(consumerKey, path, query)).toBe(expected);
  });

  it('is deterministic for the same inputs', () => {
    expect(signRequest('k', '/api/v1/accounts', 'a=1')).toBe(signRequest('k', '/api/v1/accounts', 'a=1'));
  });

  it('changes when any part of the request changes', () => {
    const base = signRequest('k', '/api/v1/accounts', 'a=1');
    expect(signRequest('k', '/api/v1/accounts', 'a=2')).not.toBe(base);
    expect(signRequest('k', '/api/v1/holdings', 'a=1')).not.toBe(base);
    expect(signRequest('k2', '/api/v1/accounts', 'a=1')).not.toBe(base);
  });
});

function account(over: Partial<StAccount> = {}): StAccount {
  return { id: 'x', name: 'TFSA', status: 'open', ...over };
}

describe('account classification', () => {
  it('spots credit cards so Plaid can own them', () => {
    expect(classifyAccount(account({ name: 'Chase Sapphire Credit Card' }))).toBe('LOC');
    expect(classifyAccount(account({ raw_type: 'CREDIT_CARD' }))).toBe('LOC');
  });

  it('spots crypto wallets', () => {
    expect(classifyAccount(account({ institution_name: 'Coinbase', name: 'BTC Wallet' }))).toBe('CRYPTO');
  });

  it('defaults to investment', () => {
    expect(classifyAccount(account({ name: 'RRSP' }))).toBe('INVESTMENT');
  });

  it('excludes closed and archived accounts', () => {
    expect(isLiveAccount(account({ status: 'open' }))).toBe(true);
    expect(isLiveAccount(account({ status: 'closed' }))).toBe(false);
    expect(isLiveAccount(account({ status: 'archived' }))).toBe(false);
    expect(isLiveAccount(account({ status: null }))).toBe(true);
  });

  it('reads the registered type out of the account meta too', () => {
    expect(registeredFor(account({ name: 'Account 1', meta: { type: 'CA_LIRA' } }))).toBe('LIRA');
  });
});

describe('holdings mapping — current API shape', () => {
  // Captured verbatim from a live /accounts/{id}/positions/all response:
  // numbers arrive as strings, the security is under `instrument`, and
  // cost_basis is per unit.
  const live = {
    positions: [
      {
        instrument: {
          kind: 'etf',
          id: '9f7330fe',
          symbol: 'XEQT.TO',
          raw_symbol: 'XEQT',
          description: 'iShares Core Equity ETF Portfolio',
          currency: 'CAD',
          exchange: 'XTSE',
        },
        units: '1234.5678',
        price: '40.25',
        cost_basis: '32.17500000',
        currency: 'CAD',
      },
    ],
    balances: [{ currency: 'CAD', cash: '12.50' }],
  };

  it('reads string numerics and the instrument block', () => {
    const rows = mapHoldings('snaptrade:a', live, 'CAD', fx);
    const xeqt = rows.find((r) => r.symbol === 'XEQT')!;
    expect(xeqt.quantity).toBeCloseTo(1234.5678, 4);
    expect(xeqt.price).toBe(40.25);
    expect(xeqt.description).toBe('iShares Core Equity ETF Portfolio');
    expect(xeqt.asset_type).toBe('etf');
  });

  it('values the position to the account balance', () => {
    const xeqt = mapHoldings('snaptrade:a', live, 'CAD', fx).find((r) => r.symbol === 'XEQT')!;
    // units x price against the total the brokerage itself reports for the
    // account. Agreeing to within a cent or two is the check that the whole
    // mapping is right, not merely that it produced a number.
    const ACCOUNT_TOTAL = 49691.384950;
    expect(Math.abs(xeqt.market_value_cad - ACCOUNT_TOTAL)).toBeLessThan(1);
  });

  it('multiplies the per-unit cost basis out to a position total', () => {
    const xeqt = mapHoldings('snaptrade:a', live, 'CAD', fx).find((r) => r.symbol === 'XEQT')!;
    // 32.17500000 x 1234.5678 — NOT the bare per-unit figure.
    expect(xeqt.cost_basis_cad).toBeCloseTo(39722.22, 0);
    expect(xeqt.cost_basis_cad).not.toBeCloseTo(32.175, 1);
  });

  it('prefers raw_symbol so the ticker is not exchange-suffixed', () => {
    const rows = mapHoldings('snaptrade:a', live, 'CAD', fx);
    expect(rows.some((r) => r.symbol === 'XEQT')).toBe(true);
    expect(rows.some((r) => r.symbol === 'XEQT.TO')).toBe(false);
  });

  it('reads a plain-string currency on balances', () => {
    const cash = mapHoldings('snaptrade:a', live, 'CAD', fx).find((r) => r.asset_type === 'cash')!;
    expect(cash.symbol).toBe('CASH.CAD');
    expect(cash.market_value).toBe(12.5);
  });

  it('prices an option contract at 100 shares via instrument.kind', () => {
    const opt = mapHoldings(
      'snaptrade:a',
      { positions: [{ instrument: { kind: 'option', symbol: 'SPY 500C' }, units: '2', price: '3.5', currency: 'USD' }] },
      'CAD',
      fx,
    )[0]!;
    expect(opt.market_value).toBe(700);
  });
});

describe('holdings mapping — legacy shape', () => {
  const holdings: StHoldings = {
    balances: [{ currency: { code: 'CAD' }, cash: 250.5 }, { currency: { code: 'USD' }, cash: 0 }],
    positions: [
      {
        symbol: { symbol: { symbol: 'XEQT', description: 'iShares Core Equity', currency: { code: 'CAD' }, type: { code: 'et' } } },
        units: 100,
        price: 36.74,
        average_purchase_price: 30,
      },
      {
        symbol: { symbol: { symbol: 'VTI', description: 'Vanguard Total', currency: { code: 'USD' }, type: { code: 'et' } } },
        units: 10,
        price: 280,
        currency: { code: 'USD' },
        average_purchase_price: 250,
      },
    ],
    option_positions: [
      {
        symbol: { option_symbol: { ticker: 'SPY 500C' } },
        units: 2,
        price: 3.5,
        currency: { code: 'USD' },
      },
    ],
  };

  it('converts USD positions to CAD', () => {
    const rows = mapHoldings('snaptrade:a', holdings, 'CAD', fx);
    const vti = rows.find((r) => r.symbol === 'VTI')!;
    expect(vti.market_value).toBe(2800);
    expect(vti.market_value_cad).toBe(3791.76);
  });

  it('keeps CAD positions at face value', () => {
    const xeqt = mapHoldings('snaptrade:a', holdings, 'CAD', fx).find((r) => r.symbol === 'XEQT')!;
    expect(xeqt.market_value).toBe(3674);
    expect(xeqt.market_value_cad).toBe(3674);
    expect(xeqt.cost_basis_cad).toBe(3000);
  });

  it('prices an option contract at 100 shares', () => {
    const opt = mapHoldings('snaptrade:a', holdings, 'CAD', fx).find((r) => r.asset_type === 'option')!;
    expect(opt.market_value).toBe(700);
  });

  it('adds non-zero cash as a holding and skips zero balances', () => {
    const rows = mapHoldings('snaptrade:a', holdings, 'CAD', fx);
    expect(rows.filter((r) => r.asset_type === 'cash')).toHaveLength(1);
    expect(rows.find((r) => r.asset_type === 'cash')!.symbol).toBe('CASH.CAD');
  });
});

describe('positions envelope', () => {
  const row = { instrument: { kind: 'etf', raw_symbol: 'XEQT' }, units: '10', price: '40.25' };

  it('reads `results`, which is what the unified endpoint actually returns', async () => {
    const { extractPositions } = await import('../src/sources/snaptrade.ts');
    expect(extractPositions({ results: [row] })).toHaveLength(1);
  });

  it('also accepts `positions`, which is how some tooling renames it', async () => {
    const { extractPositions } = await import('../src/sources/snaptrade.ts');
    expect(extractPositions({ positions: [row] })).toHaveLength(1);
  });

  it('accepts a bare array, which the older endpoint returns', async () => {
    const { extractPositions } = await import('../src/sources/snaptrade.ts');
    expect(extractPositions([row])).toHaveLength(1);
  });

  it('returns empty — never throws — for an unexpected body', async () => {
    const { extractPositions } = await import('../src/sources/snaptrade.ts');
    for (const bad of [null, undefined, {}, '', 0, { results: 'nope' }]) {
      expect(extractPositions(bad)).toEqual([]);
    }
  });

  it('prefers results over positions when both are present', async () => {
    const { extractPositions } = await import('../src/sources/snaptrade.ts');
    const out = extractPositions({ results: [row], positions: [row, row] });
    expect(out).toHaveLength(1);
  });
});
