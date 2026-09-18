/**
 * Fixed-window limiter, per key, in memory. One household, one process — a
 * shared store would be more machinery than the problem deserves. It resets on
 * restart, which is documented in SECURITY.md rather than pretended away.
 */
export function createRateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  return function allow(key: string, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 1000) {
      for (const [k, v] of hits) if (v.every((t) => t <= cutoff)) hits.delete(k);
    }
    return true;
  };
}

/**
 * Failure-only limiter, for sign-in.
 *
 * A plain request limiter is wrong here: counting successful logins throttles
 * the one legitimate user out of their own server, while doing nothing extra
 * against an attacker, who is generating failures either way. So only failures
 * are counted, a success clears the record, and the check runs before the
 * (deliberately slow) password verification.
 */
export function createFailureLimiter(limit: number, windowMs = 15 * 60_000) {
  const failures = new Map<string, number[]>();

  const recent = (key: string, now: number): number[] => {
    const cutoff = now - windowMs;
    const kept = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };

  return {
    blocked(key: string, now = Date.now()): boolean {
      return recent(key, now).length >= limit;
    },
    fail(key: string, now = Date.now()): void {
      const kept = recent(key, now);
      kept.push(now);
      failures.set(key, kept);
      if (failures.size > 1000) {
        for (const [k] of failures) if (recent(k, now).length === 0) failures.delete(k);
      }
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}
