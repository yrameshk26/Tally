/** One-shot sync from the command line. Exits non-zero if any source errored. */
import { getDb } from '../src/db.ts';
import { formatReport, runSync } from '../src/sync.ts';

const report = await runSync(getDb());
process.stdout.write(`${formatReport(report)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
