/**
 * The orchestrator's own promises: only one run at a time however many things
 * ask for one, progress that the Overview can draw, and a failure report that
 * names the source that actually failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { failedSources, runSync, syncProgress, type SyncReport } from '../src/sync.ts';

let db: DB;

beforeEach(() => {
  db = initDb(openDb(':memory:'));
  // FX is the only step that goes out when nothing is linked. Hold it open
  // until the test lets go, so "while a run is in flight" is a real window
  // rather than a race.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('offline in tests');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('one run at a time', () => {
  it('joins a run already in flight instead of starting a second', async () => {
    const first = runSync(db);
    const second = runSync(db);
    expect(second).toBe(first);
    await first;
    const runs = db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get() as { n: number };
    expect(runs.n).toBe(1);
  });

  it('starts a fresh run once the last one has finished', async () => {
    await runSync(db);
    await runSync(db);
    const runs = db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get() as { n: number };
    expect(runs.n).toBe(2);
  });
});

describe('progress', () => {
  it('reports the step in flight, then goes idle', async () => {
    expect(syncProgress().running).toBe(false);
    const run = runSync(db);
    const during = syncProgress();
    expect(during.running).toBe(true);
    expect(during.step).toBe('Exchange rates');
    // FX, then three sources for the one default profile.
    expect(during.total).toBe(4);
    await run;
    expect(syncProgress()).toMatchObject({ running: false, step: null, done: 0 });
  });

  it('goes idle even when a run blows up', async () => {
    db.close();
    await expect(runSync(db)).rejects.toThrow();
    expect(syncProgress().running).toBe(false);
  });
});

describe('naming what failed', () => {
  const base = (profiles: SyncReport['profiles'], fx: Record<string, unknown> = {}): SyncReport => ({
    started_at: '',
    finished_at: '',
    duration_ms: 0,
    ok: false,
    fx,
    profiles,
    snaptrade: {},
    plaid: {},
    wise: {},
    totals: {},
    timings_ms: {},
  });

  it("names the profile whose bank failed when there is more than one", () => {
    // The old check looked for `error` on the merged plaid entry, which with
    // two profiles is keyed by profile, so this read as a clean run.
    const report = base({
      me: { name: 'Me', snaptrade: {}, plaid: { items: 3 }, wise: {} },
      partner: { name: 'Partner', snaptrade: {}, plaid: { error: 'ITEM_LOGIN_REQUIRED' }, wise: {} },
    });
    expect(failedSources(report)).toEqual(['Banks and cards (Partner)']);
  });

  it('leaves the profile off when there is only one, and includes FX', () => {
    const report = base(
      { me: { name: 'Me', snaptrade: { error: 'x' }, plaid: {}, wise: {} } },
      { error: 'timeout' },
    );
    expect(failedSources(report)).toEqual(['Exchange rates', 'Brokerages']);
  });

  it('is empty for a clean run', () => {
    expect(failedSources(base({ me: { name: 'Me', snaptrade: {}, plaid: {}, wise: {} } }))).toEqual([]);
  });
});
