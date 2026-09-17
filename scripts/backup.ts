/** Manual backup + prune, same code path the nightly run uses. */
import { getDb } from '../src/db.ts';
import { pruneBackups, writeBackup } from '../src/backup.ts';

const file = writeBackup(getDb());
const pruned = pruneBackups();
process.stdout.write(`backup: ${file}\npruned: ${pruned}\n`);
