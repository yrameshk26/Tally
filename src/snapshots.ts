/**
 * Daily net-worth snapshots. One row per calendar day per origin, so re-running
 * the sync on the same day updates that day rather than growing history.
 */
import type { DB } from './db.ts';
import { nowISO, round2 } from './lib/money.ts';

export type NetWorthTotals = {
  total_assets_cad: number;
  total_liabilities_cad: number;
  net_worth_cad: number;
  by_profile: Record<string, number>;
  by_registered_type: Record<string, number>;
  by_source: Record<string, number>;
  by_institution: Record<string, number>;
};

export function computeTotals(db: DB, profileId?: string): NetWorthTotals {
  const where = profileId ? 'WHERE active = 1 AND profile_id = ?' : 'WHERE active = 1';
  const args = profileId ? [profileId] : [];
  const rows = db
    .prepare(
      `SELECT profile_id, registered_type, source, institution, balance_cad FROM accounts ${where}`,
    )
    .all(...args) as Array<{
    profile_id: string;
    registered_type: string;
    source: string;
    institution: string | null;
    balance_cad: number;
  }>;

  const totals: NetWorthTotals = {
    total_assets_cad: 0,
    total_liabilities_cad: 0,
    net_worth_cad: 0,
    by_profile: {},
    by_registered_type: {},
    by_source: {},
    by_institution: {},
  };

  const add = (bucket: Record<string, number>, key: string, v: number): void => {
    bucket[key] = round2((bucket[key] ?? 0) + v);
  };

  for (const r of rows) {
    const v = r.balance_cad;
    if (v >= 0) totals.total_assets_cad = round2(totals.total_assets_cad + v);
    else totals.total_liabilities_cad = round2(totals.total_liabilities_cad + v);
    totals.net_worth_cad = round2(totals.net_worth_cad + v);
    add(totals.by_profile, r.profile_id, v);
    add(totals.by_registered_type, r.registered_type, v);
    add(totals.by_source, r.source, v);
    add(totals.by_institution, r.institution ?? 'unknown', v);
  }
  return totals;
}

/**
 * Record today's totals.
 *
 * A sync that fetched nothing — first boot, no credentials yet, every source
 * failing — must not leave a $0 row behind. History is drawn as a line, so one
 * zero at the start renders as a fall to nothing and a same-day recovery, which
 * is a more confident lie than an empty chart. Returns null when it declines.
 */
/**
 * Drop snapshot rows that record a zero net worth with nothing behind them.
 * Written by earlier versions, which snapshotted unconditionally; kept as a
 * migration because the chart is wrong until they are gone.
 */
export function pruneEmptySnapshots(db: DB): number {
  return db
    .prepare(
      `DELETE FROM snapshots
       WHERE net_worth_cad = 0 AND total_assets_cad = 0 AND total_liabilities_cad = 0`,
    )
    .run().changes;
}

export function writeSnapshot(db: DB, origin = 'sync'): NetWorthTotals | null {
  const t = computeTotals(db);
  const active = (
    db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE active = 1').get() as { n: number }
  ).n;
  if (active === 0) return null;
  db.prepare(
    `INSERT INTO snapshots (ts, total_assets_cad, total_liabilities_cad, net_worth_cad, by_owner, by_registered_type, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(substr(ts,1,10), origin) DO UPDATE SET
       ts                    = excluded.ts,
       total_assets_cad      = excluded.total_assets_cad,
       total_liabilities_cad = excluded.total_liabilities_cad,
       net_worth_cad         = excluded.net_worth_cad,
       by_owner              = excluded.by_owner,
       by_registered_type    = excluded.by_registered_type`,
  ).run(
    nowISO(),
    t.total_assets_cad,
    t.total_liabilities_cad,
    t.net_worth_cad,
    JSON.stringify(t.by_profile),
    JSON.stringify(t.by_registered_type),
    origin,
  );
  return t;
}
