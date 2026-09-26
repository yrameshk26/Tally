/**
 * Seed a demo database: `npm run demo`.
 *
 * The point is evaluation without credentials. Plaid Production access takes
 * days and a signed agreement, so without this the only way to see whether the
 * app is worth running is to read the source. This fills a throwaway database
 * with a household's worth of plausible-but-invented data and starts the
 * server, so the answer takes two minutes instead.
 *
 * Every institution, merchant and figure below is fictional. Nothing here
 * touches the network, and it refuses to run against a database that already
 * has real accounts in it.
 */
import { existsSync, rmSync } from 'node:fs';
import { initDb, openDb } from '../src/db.ts';
import { createProfile } from '../src/profiles.ts';
import { replaceHoldings, upsertAccount, upsertActivities, upsertTransactions } from '../src/store.ts';
import { setAccountProfile, setRoomLimit } from '../src/queries.ts';
import { addMerchantRule } from '../src/overrides.ts';
import { writeSnapshot } from '../src/snapshots.ts';
import { nowISO } from '../src/lib/money.ts';
import type { RegisteredType } from '../src/lib/registered.ts';

/**
 * Deliberately does not read .env: `npm run demo` there would point DB_PATH at
 * the real database. Set it on the command line to override.
 */
const DB_PATH = process.env['DB_PATH'] ?? 'data/demo.db';

// --- fictional institutions and merchants -----------------------------------

const MERCHANTS: Array<[string, string, number, number]> = [
  // name, category, typical amount, times per month
  ['Northgate Grocery', 'FOOD_AND_DRINK', 84.5, 4],
  ['Corner Coffee', 'FOOD_AND_DRINK', 6.25, 9],
  ['Rosewood Diner', 'FOOD_AND_DRINK', 52.4, 2],
  ['Metro Transit', 'TRANSPORTATION', 3.35, 14],
  ['Harbour Fuel', 'TRANSPORTATION', 68.9, 2],
  ['Lumen Electric', 'RENT_AND_UTILITIES', 96.2, 1],
  ['Vista Internet', 'RENT_AND_UTILITIES', 79.99, 1],
  ['Meridian Apartments', 'RENT_AND_UTILITIES', 1850, 1],
  ['Atlas Outfitters', 'GENERAL_MERCHANDISE', 124.75, 1],
  ['Pinewood Pharmacy', 'MEDICAL', 28.4, 1],
  ['Skyline Air', 'TRAVEL', 412.6, 0.4],
  ['Cedar Cinema', 'ENTERTAINMENT', 31.5, 1],
  // Deliberately two spellings of one company, so the Merchants tab has
  // something real to merge on a first visit.
  ['Bluewater Insurance Co', 'GENERAL_SERVICES', 188.4, 0.5],
  ['Bluewater Insurance Company', 'GENERAL_SERVICES', 188.4, 0.5],
];

/** Plaid's detailed category, where the demo has one: rent versus the bills. */
const DETAILED: Record<string, string> = {
  'Meridian Apartments': 'RENT_AND_UTILITIES_RENT',
  'Lumen Electric': 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',
  'Vista Internet': 'RENT_AND_UTILITIES_INTERNET_AND_CABLE',
};

function dayISO(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** Deterministic jitter, so a rerun produces the same demo. */
function wobble(seed: number, spread: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return 1 + (x - Math.floor(x) - 0.5) * spread;
}

function main(): void {
  if (existsSync(DB_PATH) && !process.env['DEMO_FORCE']) {
    const probe = initDb(openDb(DB_PATH));
    const real = probe
      .prepare("SELECT COUNT(*) AS n FROM accounts WHERE id NOT LIKE 'demo:%'")
      .get() as { n: number };
    probe.close();
    if (real.n > 0) {
      process.stderr.write(
        `${DB_PATH} already holds ${String(real.n)} real account(s). Refusing to overwrite it.\n` +
          'Point DB_PATH somewhere else, or set DEMO_FORCE=1 if you are certain.\n',
      );
      process.exit(1);
    }
    rmSync(DB_PATH, { force: true });
    for (const suffix of ['-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });
  }

  const db = initDb(openDb(DB_PATH));
  createProfile(db, 'Partner');

  db.prepare(
    `INSERT INTO fx_rates (pair, rate, as_of, fetched_at) VALUES ('USDCAD', 1.38, ?, ?)
     ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate`,
  ).run(dayISO(1), nowISO());

  const account = (
    id: string,
    name: string,
    institution: string,
    registered: RegisteredType,
    balance: number,
    over: Record<string, unknown> = {},
  ): void => {
    // Real source names, so the by-source breakdown and every source filter
    // behave exactly as they would against live data. Demo rows are identified
    // by their `demo:` id prefix instead.
    upsertAccount(db, {
      id,
      source: id.includes('usd') ? 'wise' : id.match(/rrsp|tfsa|lira/) ? 'snaptrade' : 'plaid',
      institution,
      name,
      // Four digits, like a real account mask — id.slice(-4) produced "rrsp"
      // and "o:mc", which reads as a bug in the screenshot, and keying off the
      // id's length gave half the accounts the same four digits.
      mask: String(1000 + [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9000, 7)),
      account_category: 'INVESTMENT',
      account_subtype: null,
      registered_type: registered,
      currency: 'CAD',
      balance,
      balance_cad: balance,
      available: null,
      active: true,
      status: 'ok',
      item_id: null,
      ...over,
    });
  };

  // Brokerage — one person's registered accounts, one partner's.
  account('demo:rrsp', 'Evergreen RRSP', 'Evergreen Invest', 'RRSP' as RegisteredType, 844_860);
  account('demo:tfsa', 'Evergreen TFSA', 'Evergreen Invest', 'TFSA' as RegisteredType, 231_570);
  account('demo:lira', 'Evergreen LIRA', 'Evergreen Invest', 'LIRA' as RegisteredType, 167_990);
  account('demo:p-tfsa', 'Evergreen TFSA', 'Evergreen Invest', 'TFSA' as RegisteredType, 128_000);

  // Banking and cards.
  account('demo:chq', 'Everyday Chequing', 'Northwind Bank', 'NON_REG' as RegisteredType, 24_820.55, {
    account_category: 'DEPOSITORY',
    account_subtype: 'checking',
    available: 24_820.55,
  });
  account('demo:save', 'Rainy Day Savings', 'Northwind Bank', 'NON_REG' as RegisteredType, 95_000, {
    account_category: 'DEPOSITORY',
    account_subtype: 'savings',
  });
  account('demo:visa', 'Northwind Rewards Visa', 'Northwind Bank', 'NA' as RegisteredType, -2_640.18, {
    account_category: 'LOC',
    account_subtype: 'credit card',
    available: 7_359.82,
    credit_limit: 10_000,
  });
  account('demo:mc', 'Summit Mastercard', 'Summit Credit Union', 'NA' as RegisteredType, -889.4, {
    account_category: 'LOC',
    account_subtype: 'credit card',
    available: 4_110.6,
    credit_limit: 5_000,
  });
  account('demo:usd', 'USD Balance', 'Wavelength', 'NON_REG' as RegisteredType, 0, {
    account_category: 'DEPOSITORY',
    currency: 'USD',
    balance: 8_900,
    balance_cad: 12_282,
  });

  setAccountProfile(db, 'demo:p-tfsa', 'partner');

  // Holdings: one broad-market ETF dominating, which is what makes the
  // concentration number on the Overview say something.
  replaceHoldings(db, 'demo:rrsp', [
    holding('demo:rrsp', 'VGRO', 'Vanguard Growth ETF Portfolio', 22_000, 34.2, 28.9),
    holding('demo:rrsp', 'ZAG', 'BMO Aggregate Bond Index ETF', 6_900, 13.4, 13.9),
  ]);
  replaceHoldings(db, 'demo:tfsa', [
    holding('demo:tfsa', 'VGRO', 'Vanguard Growth ETF Portfolio', 4_800, 34.2, 30.1),
    holding('demo:tfsa', 'XEF', 'iShares Core MSCI EAFE IMI', 2_100, 32.1, 29.4),
  ]);
  replaceHoldings(db, 'demo:lira', [
    holding('demo:lira', 'VGRO', 'Vanguard Growth ETF Portfolio', 4_912, 34.2, 31.8),
  ]);
  replaceHoldings(db, 'demo:p-tfsa', [
    holding('demo:p-tfsa', 'VEQT', 'Vanguard All-Equity ETF Portfolio', 3_299, 38.8, 35.2),
  ]);

  // Brokerage activity, so get_activities and contribution room have something.
  const activities = [];
  for (let m = 0; m < 6; m += 1) {
    activities.push({
      id: `demo:act:div:${String(m)}`,
      account_id: 'demo:rrsp',
      date: dayISO(m * 30 + 12),
      type: 'DIVIDEND',
      description: 'VGRO distribution',
      symbol: 'VGRO',
      amount: 1_840 * wobble(m + 1, 0.2),
      currency: 'CAD',
      amount_cad: 1_840 * wobble(m + 1, 0.2),
    });
    activities.push({
      id: `demo:act:con:${String(m)}`,
      account_id: 'demo:tfsa',
      date: dayISO(m * 30 + 3),
      type: 'CONTRIBUTION',
      description: 'Monthly contribution',
      symbol: null,
      amount: 500,
      currency: 'CAD',
      amount_cad: 500,
    });
  }
  upsertActivities(db, activities);

  // Six months of card and bank activity.
  const txs = [];
  let n = 0;
  for (let day = 1; day <= 182; day += 1) {
    for (const [merchant, category, amount, perMonth] of MERCHANTS) {
      // perMonth as a probability per day. wobble(_, 2) is uniform over [0, 2),
      // so keeping when it falls below (perMonth/30)*2 gives perMonth hits a
      // month. The comparison was the other way round at first, which produced
      // ten times the transactions a household actually has.
      if (wobble(day * 31 + merchant.length * 7, 2) >= (perMonth / 30) * 2) continue;
      n += 1;
      const value = Math.round(amount * wobble(n, 0.3) * 100) / 100;
      txs.push({
        id: `demo:tx:${String(n)}`,
        account_id: n % 5 === 0 ? 'demo:mc' : n % 3 === 0 ? 'demo:chq' : 'demo:visa',
        date: dayISO(day),
        name: merchant.toUpperCase(),
        merchant,
        amount: value,
        currency: 'CAD',
        amount_cad: value,
        category,
        category_detailed: DETAILED[merchant] ?? null,
        pending: day <= 2,
      });
    }
    // Paying the card off from chequing, and moving money to savings. Both
    // sides of each are real rows, which is what makes the Transactions tab's
    // transfers filter and the report's exclusions have something to exclude.
    if (day % 30 === 6) {
      for (const [account, name, amount] of [
        ['demo:chq', 'NORTHWIND VISA PAYMENT', 2_150],
        ['demo:visa', 'PAYMENT - THANK YOU', -2_150],
      ] as const) {
        n += 1;
        txs.push({
          id: `demo:tx:${String(n)}`,
          account_id: account,
          date: dayISO(day),
          name,
          merchant: null,
          amount,
          currency: 'CAD',
          amount_cad: amount,
          category: 'LOAN_PAYMENTS',
          category_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
          pending: false,
        });
      }
    }
    if (day % 30 === 16) {
      for (const [account, name, amount, category] of [
        ['demo:chq', 'TRANSFER TO RAINY DAY SAVINGS', 1_000, 'TRANSFER_OUT'],
        ['demo:save', 'TRANSFER FROM EVERYDAY CHEQUING', -1_000, 'TRANSFER_IN'],
      ] as const) {
        n += 1;
        txs.push({
          id: `demo:tx:${String(n)}`,
          account_id: account,
          date: dayISO(day),
          name,
          merchant: null,
          amount,
          currency: 'CAD',
          amount_cad: amount,
          category,
          category_detailed: null,
          pending: false,
        });
      }
    }
    if (day % 14 === 0) {
      n += 1;
      txs.push({
        id: `demo:tx:${String(n)}`,
        account_id: 'demo:chq',
        date: dayISO(day),
        name: 'ACME LOGISTICS PAYROLL',
        merchant: 'Acme Logistics',
        amount: -4_200,
        currency: 'CAD',
        amount_cad: -4_200,
        category: 'INCOME',
        category_detailed: 'INCOME_WAGES',
        pending: false,
      });
    }
  }
  upsertTransactions(db, txs);

  // One rule already in place, so the Merchants tab shows what a rule does
  // rather than only describing it.
  addMerchantRule(db, {
    pattern: 'bluewater insurance',
    merchant: 'Bluewater Insurance',
    category: 'GENERAL_SERVICES',
  });

  setRoomLimit(db, 'me', 'RRSP', new Date().getUTCFullYear(), 31_500, 'demo figure');
  setRoomLimit(db, 'me', 'TFSA', new Date().getUTCFullYear(), 7_000, 'demo figure');

  // A history to draw. Real deployments accumulate this one day at a time.
  const totals = writeSnapshot(db);
  const target = totals?.net_worth_cad ?? 0;
  for (let day = 180; day >= 1; day -= 1) {
    const drift = 1 - day / 900;
    const value = Math.round(target * drift * wobble(day, 0.01) * 100) / 100;
    db.prepare(
      `INSERT INTO snapshots (ts, total_assets_cad, total_liabilities_cad, net_worth_cad, by_owner, by_registered_type, origin)
       VALUES (?, ?, ?, ?, '{}', '{}', 'demo')
       ON CONFLICT(substr(ts,1,10), origin) DO NOTHING`,
    ).run(`${dayISO(day)}T12:00:00.000Z`, value + 3_530, -3_530, value);
  }

  db.prepare(
    `INSERT INTO sync_runs (started_at, finished_at, ok, report) VALUES (?, ?, 1, ?)`,
  ).run(
    nowISO(),
    nowISO(),
    JSON.stringify({
      started_at: nowISO(),
      finished_at: nowISO(),
      duration_ms: 1_200,
      ok: true,
      fx: { ok: true, updated: 1 },
      profiles: {},
      snaptrade: { demo: true },
      plaid: { demo: true },
      wise: { demo: true },
      totals,
      timings_ms: {},
    }),
  );

  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
              (SELECT COUNT(*) FROM transactions) AS transactions,
              (SELECT COUNT(*) FROM holdings) AS holdings`,
    )
    .get() as { accounts: number; transactions: number; holdings: number };
  db.close();

  process.stdout.write(
    `Demo data written to ${DB_PATH}\n` +
      `  ${String(counts.accounts)} accounts, ${String(counts.holdings)} positions, ` +
      `${String(counts.transactions)} transactions, 180 days of history\n\n` +
      'Start it with:\n' +
      `  DB_PATH=${DB_PATH} UI_ENABLED=true ADMIN_USERNAME=demo \\\n` +
      "    ADMIN_PASSWORD_HASH=\"$(npm run --silent hash-password -- 'demo-password-123' | cut -d= -f2-)\" \\\n" +
      '    MCP_SECRET=$(openssl rand -hex 32) TOKEN_ENC_KEY=$(openssl rand -hex 32) \\\n' +
      '    COOKIE_SECURE=false npm run dev\n\n' +
      'Then open http://localhost:8787 and sign in as demo / demo-password-123.\n' +
      'Every figure is invented. Nothing here talks to a bank.\n',
  );
}

function holding(
  accountId: string,
  symbol: string,
  description: string,
  quantity: number,
  price: number,
  costPerUnit: number,
): Parameters<typeof replaceHoldings>[2][number] {
  return {
    account_id: accountId,
    symbol,
    description,
    asset_type: 'etf',
    quantity,
    price,
    currency: 'CAD',
    market_value: quantity * price,
    market_value_cad: quantity * price,
    cost_basis: quantity * costPerUnit,
    cost_basis_cad: quantity * costPerUnit,
  };
}

main();
