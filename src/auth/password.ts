/**
 * Password hashing with Argon2id — the current OWASP recommendation for
 * password storage, and memory-hard in a way scrypt's common parameterisations
 * are not.
 *
 * Parameters follow the OWASP minimum: 19 MiB of memory, 2 iterations, 1 degree
 * of parallelism. The library emits a PHC string that carries its own
 * parameters, so raising the cost later still verifies existing hashes.
 *
 * Note for packagers: `argon2` is a native module. Both the `deps` and `build`
 * stages of the Dockerfile already install python3/make/g++, so it compiles
 * there; a bare `npm ci` on a machine without a toolchain will need one.
 */
import argon2 from 'argon2';
import { timingSafeEqual } from 'node:crypto';

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // KiB — 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error('password must not be empty');
  return argon2.hash(password, OPTIONS);
}

export function isHash(value: string): boolean {
  return value.startsWith('$argon2id$') || value.startsWith('$argon2i$') || value.startsWith('$argon2d$');
}

/**
 * Verify a password against a stored PHC hash. Returns false rather than
 * throwing on a malformed hash, so a misconfigured deployment fails closed
 * instead of 500-ing in a way that distinguishes "bad config" from "bad
 * password".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!password || !stored || !isHash(stored)) return false;
  try {
    return await argon2.verify(stored, password);
  } catch {
    return false;
  }
}

/** Constant-time string compare, for usernames, CSRF tokens and OTP codes. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against itself anyway so the early return is not a timing oracle
    // for length.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
