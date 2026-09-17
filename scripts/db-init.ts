/** Create the database file and schema, then seed contribution room if present. */
import { existsSync, readFileSync } from 'node:fs';
import { config } from '../src/config.ts';
import { initDb, openDb } from '../src/db.ts';
import { setRoomLimit } from '../src/queries.ts';
import { log } from '../src/lib/logger.ts';

const db = initDb(openDb());
log.info(`database ready at ${config.dbPath}`);

const seedFile = process.env['ROOM_FILE'] ?? 'room.json';
if (existsSync(seedFile)) {
  const rows = JSON.parse(readFileSync(seedFile, 'utf8')) as Array<{
    person: string;
    account_type: string;
    year: number;
    limit: number;
    note?: string;
  }>;
  for (const r of rows) setRoomLimit(db, r.person, r.account_type, r.year, r.limit, r.note);
  log.info(`seeded ${rows.length} contribution-room row(s) from ${seedFile}`);
} else {
  log.info(`no ${seedFile} found — seed limits later with the set_room_limit tool`);
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as Array<{ name: string }>;
process.stdout.write(`tables: ${tables.map((t) => t.name).join(', ')}\n`);
db.close();
