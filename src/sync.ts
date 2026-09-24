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
import { computeTotals, writeSnapshot } from './snapshots.ts';
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

/**
 * What a run is doing right now, for the Overview's progress bar. Module state
 * is enough: one household, one process (CLAUDE.md), so there is exactly one
 * place a sync can be running.
 */
export type SyncProgress = {
  running: boolean;
  started_at: string | null;
  /** Human label for the step in flight, e.g. "Banks · Partner". */
  step: string | null;
  done: number;
  total: number;
};

const idle: SyncProgress = { running: false, started_at: null, step: null, done: 0, total: 0 };
let progress: SyncProgress = { ...idle };
let inFlight: Promise<SyncReport> | null = null;

export function syncProgress(): SyncProgress {
  return { ...progress };
}

const SOURCE_LABEL: Record<string, string> = {
  snaptrade: 'Brokerages',
  plaid: 'Banks and cards',
  wise: 'Wise',
};

/**
 * Which sources failed, by name and profile. Reading `report.plaid` for an
 * `error` key is not enough: with more than one profile the merged entry is
 * keyed by profile, so a failed bank looked like a clean run.
 */
export function failedSources(report: SyncReport): string[] {
  const failed: string[] = [];
  const isErr = (v: unknown): boolean => typeof v === 'object' && v !== null && 'error' in v;
  if (isErr(report.fx)) failed.push('Exchange rates');
  const many = Object.keys(report.profiles).length > 1;
  for (const p of Object.values(report.profiles)) {
    for (const source of ['snaptrade', 'plaid', 'wise'] as const) {
      if (isErr(p[source])) failed.push(many ? `${SOURCE_LABEL[source]} (${p.name})` : SOURCE_LABEL[source]!);
    }
  }
  return failed;
}

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

/**
 * Run a sync, or join the one already running. The Refresh button, the nightly
 * job and MCP's sync_now all come through here, so a click during the nightly
 * run waits for it instead of starting a second pass over every bank, which
 * doubled the Plaid calls and raced the writes.
 */
export function runSync(db: DB = getDb()): Promise<SyncReport> {
  if (inFlight) return inFlight;
  inFlight = runOnce(db).finally(() => {
    inFlight = null;
    progress = { ...idle };
  });
  return inFlight;
}

async function runOnce(db: DB): Promise<SyncReport> {
  const startedAt = nowISO();
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  const runId = db
    .prepare('INSERT INTO sync_runs (started_at) VALUES (?)')
    .run(startedAt).lastInsertRowid;

  const profiles = listProfiles(db);
  progress = { running: true, started_at: startedAt, step: 'Exchange rates', done: 0, total: 1 + profiles.length * 3 };
  const step = (label: string): void => {
    progress = { ...progress, step: label };
  };
  const stepDone = (): void => {
    progress = { ...progress, done: progress.done + 1 };
  };

  const fx = await timed('fx', timings, () => refreshFxRatesSafe(db));
  stepDone();
  const rates = loadRates(db);

  // Each profile carries its own Plaid team and SnapTrade key, so every source
  // runs once per profile. A profile with no credentials simply reports
  // {skipped} and costs nothing.
  const who = (name: string): string => (profiles.length > 1 ? ` · ${name}` : '');
  const perProfile: SyncReport['profiles'] = {};
  const results: unknown[] = [fx];

  for (const profile of profiles) {
    const tag = (name: string): string => `${name}:${profile.id}`;
    step(`Brokerages${who(profile.name)}`);
    const snaptrade = await timed(tag('snaptrade'), timings, () =>
      syncSnapTrade(db, rates, profile.id),
    );
    stepDone();
    step(`Banks and cards${who(profile.name)}`);
    const plaid = await timed(tag('plaid'), timings, () => syncPlaid(db, rates, profile.id));
    stepDone();
    step(`Wise${who(profile.name)}`);
    const wise = await timed(tag('wise'), timings, () => syncWise(db, rates, profile.id));
    stepDone();
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

  step('Saving');
  // Declines to record a $0 day when nothing is linked yet; the report still
  // carries the computed totals so the caller sees zeros without history doing.
  const snapshot = writeSnapshot(db);
  const totals = snapshot ?? computeTotals(db);

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
