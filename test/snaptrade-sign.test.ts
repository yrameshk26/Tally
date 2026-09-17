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

describe('holdings mapping', () => {
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
