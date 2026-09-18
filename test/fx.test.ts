import { describe, expect, it } from 'vitest';
import { convert, FxError, tryConvert, type RateMap } from '../src/fx.ts';
import { round2 } from '../src/lib/money.ts';

const RATES: RateMap = {
  CADCAD: 1,
  USDCAD: 1.3542,
  EURCAD: 1.4711,
  GBPCAD: 1.7233,
  JPYCAD: 0.00912,
};

describe('convert', () => {
  it('is the identity for the same currency', () => {
    expect(convert(100, 'CAD', 'CAD', RATES)).toBe(100);
    expect(convert(100.005, 'USD', 'USD', RATES)).toBe(100.01);
  });

  it('converts into CAD', () => {
    expect(convert(1000, 'USD', 'CAD', RATES)).toBe(1354.2);
    expect(convert(100, 'JPY', 'CAD', RATES)).toBe(0.91);
  });

  it('converts out of CAD', () => {
    expect(convert(1354.2, 'CAD', 'USD', RATES)).toBe(1000);
  });

  it('pivots cross rates through CAD', () => {
    const viaCad = round2((1000 * RATES['USDCAD']!) / RATES['EURCAD']!);
    expect(convert(1000, 'USD', 'EUR', RATES)).toBe(viaCad);
  });

  it('preserves sign so liabilities stay negative', () => {
    expect(convert(-2500, 'USD', 'CAD', RATES)).toBe(-3385.5);
    expect(convert(-2500, 'USD', 'CAD', RATES)).toBeLessThan(0);
  });

  it('rounds half away from zero, symmetrically', () => {
    expect(convert(0.005, 'CAD', 'CAD', RATES)).toBe(0.01);
    expect(convert(-0.005, 'CAD', 'CAD', RATES)).toBe(-0.01);
    expect(convert(2.345, 'CAD', 'CAD', RATES)).toBe(2.35);
    expect(convert(-2.345, 'CAD', 'CAD', RATES)).toBe(-2.35);
  });

  it('is case insensitive on currency codes', () => {
    expect(convert(10, 'usd', 'cad', RATES)).toBe(convert(10, 'USD', 'CAD', RATES));
  });

  it('treats non-finite input as zero rather than NaN', () => {
    expect(convert(Number.NaN, 'USD', 'CAD', RATES)).toBe(0);
  });

  it('throws on a missing rate instead of inventing one', () => {
    expect(() => convert(10, 'ZWL', 'CAD', RATES)).toThrow(FxError);
    expect(() => convert(10, 'CAD', 'ZWL', RATES)).toThrow(FxError);
  });

  it('tryConvert returns null for a missing rate', () => {
    expect(tryConvert(10, 'ZWL', 'CAD', RATES)).toBeNull();
    expect(tryConvert(10, 'USD', 'CAD', RATES)).toBe(13.54);
  });

  it('rejects a zero or negative rate', () => {
    expect(() => convert(10, 'USD', 'CAD', { USDCAD: 0 })).toThrow(FxError);
  });
});
