import { describe, expect, it } from 'vitest';
import { guessRegistered, hasContributionRoom } from '../src/lib/registered.ts';

describe('guessRegistered', () => {
  it('reads the Wealthsimple account names in this household', () => {
    expect(guessRegistered('RRSP')).toBe('RRSP');
    expect(guessRegistered('Self-directed TFSA')).toBe('TFSA');
    expect(guessRegistered('LIRA')).toBe('LIRA');
    expect(guessRegistered('DPSP')).toBe('DPSP');
    expect(guessRegistered('Group RRSP')).toBe('RRSP');
    expect(guessRegistered('Group TFSA')).toBe('TFSA');
  });

  it('keeps spousal and group RRSPs as RRSP', () => {
    expect(guessRegistered('Spousal RRSP')).toBe('RRSP');
    expect(guessRegistered('GRSP — employer match')).toBe('RRSP');
  });

  it('does not let RRIF or LIF fall through to RRSP or LIRA', () => {
    expect(guessRegistered('RRIF')).toBe('RRIF');
    expect(guessRegistered('Life Income Fund')).toBe('LIF');
  });

  it('classifies unregistered accounts', () => {
    expect(guessRegistered('Cash account')).toBe('NON_REG');
    expect(guessRegistered('Questrade Margin')).toBe('NON_REG');
    expect(guessRegistered('Coinbase crypto wallet')).toBe('NON_REG');
    expect(guessRegistered('Everyday Chequing')).toBe('NON_REG');
  });

  it('returns NA when there is nothing to go on', () => {
    expect(guessRegistered()).toBe('NA');
    expect(guessRegistered('', null, undefined)).toBe('NA');
    expect(guessRegistered('Account 4821')).toBe('NA');
  });

  it('searches every string it is given', () => {
    expect(guessRegistered(null, 'CA_TFSA', 'Investment account')).toBe('TFSA');
  });

  it('knows which buckets carry room', () => {
    expect(hasContributionRoom('RRSP')).toBe(true);
    expect(hasContributionRoom('TFSA')).toBe(true);
    expect(hasContributionRoom('FHSA')).toBe(true);
    expect(hasContributionRoom('LIRA')).toBe(false);
    expect(hasContributionRoom('NON_REG')).toBe(false);
  });
});

describe('separator handling', () => {
  it('matches across underscores in SnapTrade raw types', () => {
    expect(guessRegistered('CA_TFSA')).toBe('TFSA');
    expect(guessRegistered('CA_RRSP')).toBe('RRSP');
    expect(guessRegistered('CA_LIRA')).toBe('LIRA');
  });

  it('matches across hyphens in Plaid subtypes', () => {
    expect(guessRegistered('retirement-rrsp')).toBe('RRSP');
    expect(guessRegistered('non-registered')).toBe('NON_REG');
  });
});
