/** Money helpers. Rounding is half-away-from-zero so -0.005 -> -0.01. */

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = n < 0 ? -1 : 1;
  return (s * Math.round(Math.abs(n) * 100)) / 100;
}

export function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function ccy(v: unknown, fallback = 'CAD'): string {
  return typeof v === 'string' && v.length === 3 ? v.toUpperCase() : fallback;
}

export function todayISO(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function nowISO(d = new Date()): string {
  return d.toISOString();
}

/** The 1st of the month `today` falls in: the default start of a month-to-date view. */
export function monthStartISO(d = new Date()): string {
  return `${todayISO(d).slice(0, 8)}01`;
}

export function daysAgoISO(days: number, from = new Date()): string {
  const d = new Date(from.getTime() - days * 86400_000);
  return todayISO(d);
}
