/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), with RFC 4648 base32.
 *
 * Implemented rather than depended upon: it is roughly sixty lines, the spec
 * publishes test vectors so correctness is demonstrable, and this repository is
 * published — every dependency in it is a link in a supply chain that ends at
 * someone's bank credentials.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte secret, base32 encoded — the size RFC 4226 recommends. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6, algorithm = 'sha1'): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(buf).digest();
  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(
  secretBase32: string,
  opts: { time?: number; step?: number; digits?: number; algorithm?: string } = {},
): string {
  const { time = Date.now() / 1000, step = 30, digits = 6, algorithm = 'sha1' } = opts;
  return hotp(base32Decode(secretBase32), Math.floor(time / step), digits, algorithm);
}

/**
 * Verify a code, allowing `window` steps of clock drift either side (default
 * ±1 step = ±30s). Comparison is constant time, and every candidate is checked
 * so a match late in the window does not take measurably longer.
 */
export function verifyTotp(
  token: string,
  secretBase32: string,
  opts: { time?: number; step?: number; digits?: number; window?: number } = {},
): boolean {
  const { time = Date.now() / 1000, step = 30, digits = 6, window = 1 } = opts;
  const candidate = token.replace(/\s+/g, '');
  if (!/^\d+$/.test(candidate) || candidate.length !== digits) return false;

  const given = Buffer.from(candidate, 'utf8');
  let ok = false;
  for (let i = -window; i <= window; i += 1) {
    const expected = Buffer.from(totp(secretBase32, { time: time + i * step, step, digits }), 'utf8');
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

/** The URI an authenticator app consumes, by QR or manual entry. */
export function otpauthUri(secretBase32: string, account: string, issuer = 'tally'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
