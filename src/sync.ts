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

export type SyncReport = {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  fx: Record<string, unknown>;
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

  const snaptrade = await timed('snaptrade', timings, () => syncSnapTrade(db, rates));
  const plaid = await timed('plaid', timings, () => syncPlaid(db, rates));
  const wise = await timed('wise', timings, () => syncWise(db, rates));

  const totals = writeSnapshot(db);

  const ok = ![fx, snaptrade, plaid, wise].some(
    (r) => typeof r === 'object' && r !== null && 'error' in r,
  );

  const report: SyncReport = {
    started_at: startedAt,
    finished_at: nowISO(),
    duration_ms: Date.now() - t0,
    ok,
    fx: fx as Record<string, unknown>,
    snaptrade: snaptrade as Record<string, unknown>,
    plaid: plaid as Record<string, unknown>,
    wise: wise as Record<string, unknown>,
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
  for (const source of ['fx', 'snaptrade', 'plaid', 'wise'] as const) {
    lines.push(`  ${source.padEnd(10)} ${JSON.stringify(r[source])}`);
  }
  const t = r.totals as { net_worth_cad?: number; by_registered_type?: Record<string, number> };
  lines.push(`  net worth  ${t.net_worth_cad ?? 0} CAD`);
  if (t.by_registered_type) {
    lines.push(`  by type    ${JSON.stringify(t.by_registered_type)}`);
  }
  return lines.join('\n');
}
