/**
 * Wise — multi-currency balances, read-only API token.
 *
 * Both STANDARD balances and SAVINGS jars are pulled, across every profile the
 * token can see, so a household with a personal and a business profile gets
 * "Wise USD (personal)" and "Wise USD (business)" as separate accounts.
 */
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { wiseCreds, wiseReady } from '../credentials.ts';
import { errMessage, log } from '../lib/logger.ts';
import { ccy, num, round2 } from '../lib/money.ts';
import { deactivateMissing, upsertAccount } from '../store.ts';
import { makeConverter, type RateMap } from '../fx.ts';

export type WiseProfile = { id: number; type?: string | null; fullName?: string | null };

export type WiseBalance = {
  id: number;
  currency?: string | null;
  type?: string | null;
  name?: string | null;
  amount?: { value?: number | null; currency?: string | null } | null;
  reservedAmount?: { value?: number | null } | null;
  cashAmount?: { value?: number | null } | null;
};

async function wiseGet<T>(db: DB, profileId: string, path: string): Promise<T> {
  const { token, baseUrl } = wiseCreds(db, profileId);
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Wise ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export type WiseReport = Record<string, unknown> & { skipped?: true; reason?: string };

export async function syncWise(
  db: DB,
  rates: RateMap,
  profileId: string,
): Promise<WiseReport> {
  if (!wiseReady(db, profileId)) return { skipped: true, reason: 'WISE_API_TOKEN not set' };

  const fx = makeConverter(rates);
  const profiles = await wiseGet<WiseProfile[]>(db, profileId, '/v2/profiles');
  const seen: string[] = [];
  let total = 0;
  let count = 0;

  for (const profile of profiles) {
    const kind = (profile.type ?? 'personal').toLowerCase();
    for (const type of ['STANDARD', 'SAVINGS']) {
      let balances: WiseBalance[];
      try {
        balances = await wiseGet<WiseBalance[]>(db, profileId, `/v4/profiles/${profile.id}/balances?types=${type}`);
      } catch (e) {
        // SAVINGS 404s for accounts with no jars — not an error worth failing on.
        log.debug(`wise: ${type} balances for profile ${profile.id} (${errMessage(e)})`);
        continue;
      }
      for (const b of balances) {
        const currency = ccy(b.amount?.currency ?? b.currency, config.baseCurrency);
        const value = num(b.amount?.value);
        const id = `wise:${profile.id}:${b.id}`;
        const suffix = type === 'SAVINGS' ? ` jar${b.name ? ` "${b.name}"` : ''}` : '';
        const cad = fx.toBase(value, currency);
        upsertAccount(
          db,
          {
          id,
          source: 'wise',
          institution: 'Wise',
          name: `Wise ${currency} (${kind})${suffix}`,
          mask: null,
          account_category: 'DEPOSITORY',
          account_subtype: type.toLowerCase(),
          registered_type: 'NON_REG',
          currency,
          balance: value,
          balance_cad: cad,
          available: b.cashAmount?.value ?? null,
          active: true,
          status: 'ok',
            item_id: `wise:${profile.id}`,
          },
          profileId,
        );
        seen.push(id);
        total = round2(total + cad);
        count += 1;
      }
    }
  }

  const deactivated = deactivateMissing(db, 'wise', seen, profileId);
  const misses = fx.misses();
  return {
    profiles: profiles.length,
    accounts: count,
    total_cad: total,
    deactivated,
    ...(misses.length ? { fx_misses: misses } : {}),
  };
}
