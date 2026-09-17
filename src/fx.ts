/**
 * FX. Every currency conversion in this codebase goes through `convert()`.
 *
 * Rates come from the Bank of Canada Valet API and are stored as pairs of the
 * form `<CCY>CAD`, meaning "1 <CCY> = rate CAD". Cross rates (say USD -> EUR)
 * pivot through CAD. BoC publishes nothing on weekends and holidays, so we ask
 * for `recent=1` and keep whatever observation date comes back.
 */
import type { DB } from './db.ts';
import { round2 } from './lib/money.ts';
import { errMessage, log } from './lib/logger.ts';
import { config } from './config.ts';

export type RateMap = Record<string, number>;

export const VALET_BASE = 'https://www.bankofcanada.ca/valet/observations';

/** Currencies BoC publishes that we might plausibly hold (Wise, US brokerages). */
export const DEFAULT_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AUD', 'JPY', 'CHF', 'NZD', 'SEK', 'NOK',
  'HKD', 'SGD', 'INR', 'MXN', 'CNY', 'ZAR', 'BRL', 'KRW', 'TRY',
];

export class FxError extends Error {}

function pair(from: string, to: string): string {
  return `${from.toUpperCase()}${to.toUpperCase()}`;
}

/**
 * Pure conversion. Sign is preserved (a -100 USD liability stays negative) and
 * the result is rounded half-away-from-zero to cents.
 */
export function convert(amount: number, from: string, to: string, rates: RateMap): number {
  const f = (from || 'CAD').toUpperCase();
  const t = (to || 'CAD').toUpperCase();
  if (!Number.isFinite(amount)) return 0;
  if (f === t) return round2(amount);

  const inCad = f === 'CAD' ? amount : amount * rateOrThrow(rates, f);
  if (t === 'CAD') return round2(inCad);
  return round2(inCad / rateOrThrow(rates, t));
}

function rateOrThrow(rates: RateMap, ccy: string): number {
  const r = rates[pair(ccy, 'CAD')];
  if (!r || !Number.isFinite(r) || r <= 0) {
    throw new FxError(`no FX rate for ${pair(ccy, 'CAD')}`);
  }
  return r;
}

/** Same as convert() but returns null instead of throwing on a missing rate. */
export function tryConvert(
  amount: number,
  from: string,
  to: string,
  rates: RateMap,
): number | null {
  try {
    return convert(amount, from, to, rates);
  } catch (e) {
    if (e instanceof FxError) return null;
    throw e;
  }
}

export function loadRates(db: DB): RateMap {
  const rows = db.prepare('SELECT pair, rate FROM fx_rates').all() as Array<{
    pair: string;
    rate: number;
  }>;
  const map: RateMap = { CADCAD: 1 };
  for (const r of rows) map[r.pair] = r.rate;
  return map;
}

/**
 * A converter bound to the rates currently in the DB. Missing rates fall back
 * to the native amount and are counted, so a sync reports "3 amounts could not
 * be converted" rather than silently inventing a number.
 */
export function makeConverter(rates: RateMap): {
  toBase: (amount: number, from: string) => number;
  misses: () => string[];
} {
  const misses = new Set<string>();
  return {
    toBase(amount: number, from: string): number {
      const v = tryConvert(amount, from, config.baseCurrency, rates);
      if (v === null) {
        misses.add(from.toUpperCase());
        return round2(amount);
      }
      return v;
    },
    misses: () => [...misses],
  };
}

type ValetResponse = {
  observations?: Array<Record<string, string | { v?: string }>>;
};

/** Fetch the latest observation for each currency and upsert into fx_rates. */
export async function refreshFxRates(
  db: DB,
  currencies: string[] = DEFAULT_CURRENCIES,
): Promise<{ updated: number; as_of: string | null; missing: string[] }> {
  const series = currencies.map((c) => `FX${c.toUpperCase()}CAD`);
  const url = `${VALET_BASE}/${series.join(',')}/json?recent=1`;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Bank of Canada Valet returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ValetResponse;
  const obs = body.observations?.[0];
  if (!obs) throw new Error('Bank of Canada Valet returned no observations');

  const asOf = typeof obs['d'] === 'string' ? (obs['d'] as string) : null;
  const fetchedAt = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO fx_rates (pair, rate, as_of, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, as_of = excluded.as_of,
                                     fetched_at = excluded.fetched_at`,
  );

  const missing: string[] = [];
  let updated = 0;
  const tx = db.transaction(() => {
    stmt.run('CADCAD', 1, asOf ?? fetchedAt.slice(0, 10), fetchedAt);
    for (const ccy of currencies) {
      const key = `FX${ccy.toUpperCase()}CAD`;
      const cell = obs[key];
      const raw = typeof cell === 'object' && cell !== null ? cell.v : undefined;
      const rate = raw === undefined ? Number.NaN : Number.parseFloat(raw);
      if (!Number.isFinite(rate) || rate <= 0) {
        missing.push(ccy.toUpperCase());
        continue;
      }
      stmt.run(pair(ccy, 'CAD'), rate, asOf ?? fetchedAt.slice(0, 10), fetchedAt);
      updated += 1;
    }
  });
  tx();

  if (missing.length) log.warn('valet: no rate published for', { missing });
  return { updated, as_of: asOf, missing };
}

export async function refreshFxRatesSafe(
  db: DB,
): Promise<{ ok: boolean; updated: number; as_of: string | null; error?: string }> {
  try {
    const r = await refreshFxRates(db);
    return { ok: true, updated: r.updated, as_of: r.as_of };
  } catch (e) {
    log.error(`fx refresh failed: ${errMessage(e)}`);
    return { ok: false, updated: 0, as_of: null, error: errMessage(e) };
  }
}
