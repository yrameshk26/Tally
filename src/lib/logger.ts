/**
 * Tiny stderr logger. Redacts anything that looks like a secret before it is
 * printed — access tokens must never reach a log file (CLAUDE.md rule).
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type Level = keyof typeof LEVELS;

const SECRET_KEYS =
  /(access_?token|public_?token|link_?token|consumer_?key|secret|api_?token|password|signature|authorization)/i;

function redactValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}…***`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? redactValue(v) : redact(v, depth + 1);
  }
  return out;
}

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL ?? 'info') as Level;
  return LEVELS[lvl] ?? LEVELS.info;
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] > threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  if (extra === undefined) process.stderr.write(`${line}\n`);
  else process.stderr.write(`${line} ${JSON.stringify(redact(extra))}\n`);
}

export const log = {
  error: (m: string, e?: unknown) => emit('error', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  debug: (m: string, e?: unknown) => emit('debug', m, e),
};

/** Error -> short printable string, never leaking request bodies wholesale. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(redact(e)).slice(0, 500);
  } catch {
    return String(e);
  }
}
