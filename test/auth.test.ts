import { describe, expect, it } from 'vitest';
import { hashPassword, isHash, safeEqual, verifyPassword } from '../src/auth/password.ts';
import {
  base32Decode,
  base32Encode,
  generateSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from '../src/auth/totp.ts';

describe('argon2id password hashing', () => {
  it('produces a PHC string with the OWASP parameters', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(h).toContain('m=19456');
    expect(h).toContain('t=2');
    expect(h).toContain('p=1');
    expect(isHash(h)).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(await verifyPassword('s3cret-pass', h)).toBe(true);
    expect(await verifyPassword('s3cret-pasS', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('salts — the same password hashes differently every time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('fails closed on a malformed or empty stored hash', async () => {
    expect(await verifyPassword('pw', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('pw', '')).toBe(false);
    expect(await verifyPassword('pw', '$argon2id$garbage')).toBe(false);
  });

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(/must not be empty/);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('handles differing lengths without throwing', () => {
    expect(safeEqual('a', 'abcdef')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('base32 (RFC 4648)', () => {
  it('matches the published vectors', () => {
    expect(base32Encode(Buffer.from(''))).toBe('');
    expect(base32Encode(Buffer.from('f'))).toBe('MY======');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ====');
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6===');
    expect(base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ=');
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI======');
  });

  it('round-trips', () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', '12345678901234567890']) {
      expect(base32Decode(base32Encode(Buffer.from(s))).toString()).toBe(s);
    }
  });

  it('tolerates lowercase and whitespace, as authenticator apps emit', () => {
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
  });

  it('rejects an invalid character rather than silently producing garbage', () => {
    expect(() => base32Decode('MZXW1!!!')).toThrow(/invalid base32/);
  });
});

describe('HOTP (RFC 4226 Appendix D)', () => {
  const secret = Buffer.from('12345678901234567890');
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  it('matches all ten published vectors', () => {
    expected.forEach((code, counter) => {
      expect(hotp(secret, counter)).toBe(code);
    });
  });
});

describe('TOTP (RFC 6238 Appendix B)', () => {
  // The published vectors use an 8-digit code and the ASCII seed below.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it('matches the published SHA-1 vectors', () => {
    for (const [time, code] of vectors) {
      expect(totp(secret, { time, digits: 8 })).toBe(code);
    }
  });

  it('accepts the current code', () => {
    const s = generateSecret();
    expect(verifyTotp(totp(s, { time: 1_000_000 }), s, { time: 1_000_000 })).toBe(true);
  });

  it('tolerates one step of clock drift either way', () => {
    const s = generateSecret();
    const now = 1_000_000;
    expect(verifyTotp(totp(s, { time: now - 30 }), s, { time: now })).toBe(true);
    expect(verifyTotp(totp(s, { time: now + 30 }), s, { time: now })).toBe(true);
  });

  it('rejects a code two steps out', () => {
    const s = generateSecret();
    const now = 1_000_000;
    expect(verifyTotp(totp(s, { time: now - 90 }), s, { time: now })).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    const s = generateSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(bad, s, { time: 1_000_000 })).toBe(false);
    }
  });

  it('generates a 32-character base32 secret (20 bytes)', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });

  it('builds an otpauth URI an authenticator can consume', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'ramesh');
    expect(uri.startsWith('otpauth://totp/tally%3Aramesh?')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=tally');
    expect(uri).toContain('period=30');
  });
});
