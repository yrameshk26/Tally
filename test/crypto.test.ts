import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, isEncrypted } from '../src/lib/crypto.ts';

const KEY = 'a'.repeat(64);

describe('token encryption', () => {
  it('round-trips', () => {
    const token = 'access-production-7c9f1b2e-0000-4a1d-9c3e-11deadbeef22';
    const enc = encryptToken(token, KEY);
    expect(enc).not.toContain(token);
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptToken(enc, KEY)).toBe(token);
  });

  it('uses a fresh IV, so the same token encrypts differently each time', () => {
    expect(encryptToken('same', KEY)).not.toBe(encryptToken('same', KEY));
  });

  it('is idempotent — encrypting twice does not double-wrap', () => {
    const once = encryptToken('tok', KEY);
    expect(encryptToken(once, KEY)).toBe(once);
  });

  it('passes plaintext through when no key is configured', () => {
    expect(encryptToken('tok', '')).toBe('tok');
    expect(decryptToken('tok', '')).toBe('tok');
  });

  it('accepts a passphrase as well as 64 hex chars', () => {
    const enc = encryptToken('tok', 'correct horse battery staple');
    expect(decryptToken(enc, 'correct horse battery staple')).toBe('tok');
  });

  it('rejects the wrong key rather than returning garbage', () => {
    const enc = encryptToken('tok', KEY);
    expect(() => decryptToken(enc, 'b'.repeat(64))).toThrow();
  });

  it('detects tampering via the GCM auth tag', () => {
    const enc = encryptToken('tok', KEY);
    const parts = enc.split(':');
    const ct = Buffer.from(parts[4]!, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    parts[4] = ct.toString('base64');
    expect(() => decryptToken(parts.join(':'), KEY)).toThrow();
  });

  it('refuses to read an encrypted token without the key', () => {
    const enc = encryptToken('tok', KEY);
    expect(() => decryptToken(enc, '')).toThrow(/TOKEN_ENC_KEY/);
  });
});
