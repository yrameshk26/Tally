/**
 * Nightly sqlite backup. Uses sqlite's own online backup via better-sqlite3's
 * VACUUM INTO, which is safe to run against a live WAL database.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from './db.ts';
import { config } from './config.ts';
import { log } from './lib/logger.ts';

export function backupDir(): string {
  return join(dirname(config.dbPath) || '.', 'backups');
}

export function writeBackup(db: DB, now = new Date()): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `finmcp-${now.toISOString().slice(0, 10)}.db`);
  if (existsSync(file)) rmSync(file);
  // VACUUM INTO is sqlite's transactional copy — no torn reads mid-write.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  log.info(`backup written to ${file}`);
  return file;
}

export function pruneBackups(keepDays = config.backupKeepDays, now = new Date()): number {
  const dir = backupDir();
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - keepDays * 86_400_000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    const full = join(dir, name);
    if (statSync(full).mtimeMs < cutoff) {
      rmSync(full);
      removed += 1;
    }
  }
  return removed;
}
