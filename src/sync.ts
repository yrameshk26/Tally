/**
 * Sync orchestrator. FX first (everything else converts through it), then each
 * source independently — one source failing must never abort the others.
 */
import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { loadRates, refreshFxRatesSafe } from './fx.ts';
import { errMessage, log } from './lib/logger.ts';
import { nowISO } from './lib/money.ts';
import { syncPlaid } from './sources/plaid.ts';
import { syncSnapTrade } from './sources/snaptrade.ts';
import { syncWise } from './sources/wise.ts';
import { writeSnapshot } from './snapshots.ts';
import { listProfiles } from './profiles.ts';

export type SyncReport = {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  fx: Record<string, unknown>;
  /** Per profile, since each has its own provider credentials. */
  profiles: Record<string, {
    name: string;
    snaptrade: Record<string, unknown>;
    plaid: Record<string, unknown>;
    wise: Record<string, unknown>;
  }>;
  /** Merged across profiles, kept so existing readers keep working. */
  snaptrade: Record<string, unknown>;
  plaid: Record<string, unknown>;
  wise: Record<string, unknown>;
  totals: Record<string, unknown>;
  timings_ms: Record<string, number>;
};

async function timed<T>(
  name: string,
  timings: Record<string, number>,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (e) {
    log.error(`sync: ${name} failed`, { error: errMessage(e) });
    return { error: errMessage(e) };
  } finally {
    timings[name] = Date.now() - t0;
  }
}

export async function runSync(db: DB = getDb()): Promise<SyncReport> {
  const startedAt = nowISO();
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  const runId = db
    .prepare('INSERT INTO sync_runs (started_at) VALUES (?)')
    .run(startedAt).lastInsertRowid;

  const fx = await timed('fx', timings, () => refreshFxRatesSafe(db));
  const rates = loadRates(db);

  // Each profile carries its own Plaid team and SnapTrade key, so every source
  // runs once per profile. A profile with no credentials simply reports
  // {skipped} and costs nothing.
  const profiles = listProfiles(db);
  const perProfile: SyncReport['profiles'] = {};
  const results: unknown[] = [fx];

  for (const profile of profiles) {
    const tag = (name: string): string => `${name}:${profile.id}`;
    const snaptrade = await timed(tag('snaptrade'), timings, () =>
      syncSnapTrade(db, rates, profile.id),
    );
    const plaid = await timed(tag('plaid'), timings, () => syncPlaid(db, rates, profile.id));
    const wise = await timed(tag('wise'), timings, () => syncWise(db, rates, profile.id));
    perProfile[profile.id] = {
      name: profile.name,
      snaptrade: snaptrade as Record<string, unknown>,
      plaid: plaid as Record<string, unknown>,
      wise: wise as Record<string, unknown>,
    };
    results.push(snaptrade, plaid, wise);
  }

  const merge = (source: 'snaptrade' | 'plaid' | 'wise'): Record<string, unknown> => {
    const entries = Object.entries(perProfile);
    if (entries.length === 1) return entries[0]![1][source];
    const out: Record<string, unknown> = {};
    for (const [id, r] of entries) out[id] = r[source];
    return out;
  };

  const totals = writeSnapshot(db);

  const ok = !results.some((r) => typeof r === 'object' && r !== null && 'error' in r);

  const report: SyncReport = {
    started_at: startedAt,
    finished_at: nowISO(),
    duration_ms: Date.now() - t0,
    ok,
    fx: fx as Record<string, unknown>,
    profiles: perProfile,
    snaptrade: merge('snaptrade'),
    plaid: merge('plaid'),
    wise: merge('wise'),
    totals: totals as unknown as Record<string, unknown>,
    timings_ms: timings,
  };

  db.prepare('UPDATE sync_runs SET finished_at = ?, ok = ?, report = ? WHERE id = ?').run(
    report.finished_at,
    ok ? 1 : 0,
    JSON.stringify(report),
    runId,
  );

  return report;
}

export function lastSyncReport(db: DB): SyncReport | null {
  const row = db
    .prepare('SELECT report FROM sync_runs WHERE report IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get() as { report: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.report) as SyncReport;
  } catch {
    return null;
  }
}

/** Human-readable one-screen summary, used by `npm run sync` and the cron log. */
export function formatReport(r: SyncReport): string {
  const lines: string[] = [];
  lines.push(`sync ${r.ok ? 'OK' : 'WITH ERRORS'} in ${(r.duration_ms / 1000).toFixed(1)}s`);
  lines.push(`  ${'fx'.padEnd(10)} ${JSON.stringify(r.fx)}`);
  for (const [id, p] of Object.entries(r.profiles ?? {})) {
    lines.push(`  profile ${id} (${p.name})`);
    for (const source of ['snaptrade', 'plaid', 'wise'] as const) {
      lines.push(`    ${source.padEnd(10)} ${JSON.stringify(p[source])}`);
    }
  }
  const t = r.totals as { net_worth_cad?: number; by_registered_type?: Record<string, number> };
  lines.push(`  net worth  ${t.net_worth_cad ?? 0} CAD`);
  if (t.by_registered_type) {
    lines.push(`  by type    ${JSON.stringify(t.by_registered_type)}`);
  }
  return lines.join('\n');
}
