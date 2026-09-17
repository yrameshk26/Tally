/**
 * Nightly sync, in-process.
 *
 * Deliberately not a cron daemon: the container runs one process, so a missed
 * tick cannot go unnoticed and there is no second copy of the environment to
 * keep in step. Each run appends a line to sync.log next to the database —
 * that is the file to check the morning after a deploy.
 */
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { errMessage, log } from './lib/logger.ts';
import { formatReport, runSync } from './sync.ts';
import { pruneBackups, writeBackup } from './backup.ts';

export function syncLogPath(): string {
  return join(dirname(config.dbPath) || '.', 'sync.log');
}

/** Milliseconds until the next HH:MM in local time, always in the future. */
export function msUntilNext(hour: number, minute: number, now = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function append(line: string): void {
  try {
    appendFileSync(syncLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch (e) {
    log.warn(`could not write sync.log (${errMessage(e)})`);
  }
}

export async function nightly(): Promise<void> {
  const db = getDb();
  try {
    const report = await runSync(db);
    append(formatReport(report).replace(/\n/g, ' | '));
  } catch (e) {
    append(`sync FAILED ${errMessage(e)}`);
    log.error('nightly sync failed', { error: errMessage(e) });
  }
  try {
    const file = writeBackup(db);
    const removed = pruneBackups();
    append(`backup ${file} (pruned ${removed})`);
  } catch (e) {
    append(`backup FAILED ${errMessage(e)}`);
  }
}

export function startScheduler(): () => void {
  if (!config.cronEnabled) {
    log.info('nightly sync disabled (CRON_ENABLED=false)');
    return () => {};
  }
  let timer: NodeJS.Timeout;
  const schedule = (): void => {
    const delay = msUntilNext(config.cronHour, config.cronMinute);
    log.info(`next sync in ${(delay / 3_600_000).toFixed(1)}h`);
    timer = setTimeout(() => {
      void nightly().finally(schedule);
    }, delay);
    timer.unref();
  };
  schedule();
  return () => clearTimeout(timer);
}
