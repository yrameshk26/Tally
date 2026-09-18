/**
 * Read models behind the MCP tools. Everything here is a pure read of sqlite —
 * no network, no writes (except the explicit setters at the bottom, which only
 * touch user-owned tagging tables).
 *
 * Transaction sign: the DB stores Plaid-style amounts (positive = money out).
 * Every read below flips them so Claude sees the intuitive convention —
 * negative is money leaving, positive is money arriving.
 */
import type { DB } from './db.ts';
import { round2, todayISO } from './lib/money.ts';
import { computeTotals, type NetWorthTotals } from './snapshots.ts';
import { moveAccount } from './profiles.ts';

export type AccountView = {
  id: string;
  source: string;
  institution: string | null;
  name: string | null;
  mask: string | null;
  category: string | null;
  subtype: string | null;
  registered_type: string;
  currency: string;
  balance: number;
  balance_cad: number;
  available: number | null;
  profile: string;
  status: string | null;
  updated_at: string;
  card?: Record<string, unknown>;
};

export function listAccounts(
  db: DB,
  opts: { profile?: string; source?: string; include_inactive?: boolean } = {},
): AccountView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.include_inactive) where.push('a.active = 1');
  if (opts.profile) {
    where.push('a.profile_id = ?');
    args.push(opts.profile);
  }
  if (opts.source) {
    where.push('a.source = ?');
    args.push(opts.source);
  }
  const sql = `
    SELECT a.*, c.statement_balance, c.minimum_payment, c.due_date,
           c.last_payment_amount, c.last_payment_date, c.apr_percentage, c.is_overdue
    FROM accounts a
    LEFT JOIN card_details c ON c.account_id = a.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.balance_cad DESC`;

  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const view: AccountView = {
      id: String(r['id']),
      source: String(r['source']),
      institution: (r['institution'] as string) ?? null,
      name: (r['name'] as string) ?? null,
      mask: (r['mask'] as string) ?? null,
      category: (r['account_category'] as string) ?? null,
      subtype: (r['account_subtype'] as string) ?? null,
      registered_type: String(r['registered_type']),
      currency: String(r['currency']),
      balance: Number(r['balance']),
      balance_cad: Number(r['balance_cad']),
      available: r['available'] === null ? null : Number(r['available']),
      profile: String(r['profile_id']),
      status: (r['status'] as string) ?? null,
      updated_at: String(r['updated_at']),
    };
    if (r['statement_balance'] !== null && r['statement_balance'] !== undefined) {
      view.card = {
        statement_balance: r['statement_balance'],
        minimum_payment: r['minimum_payment'],
        due_date: r['due_date'],
        last_payment_amount: r['last_payment_amount'],
        last_payment_date: r['last_payment_date'],
        apr_percentage: r['apr_percentage'],
        is_overdue: r['is_overdue'] === null ? null : Boolean(r['is_overdue']),
      };
    }
    return view;
  });
}

export function getNetWorth(
  db: DB,
  profileId?: string,
): NetWorthTotals & { as_of: string; fx_as_of: string | null } {
  const totals = computeTotals(db, profileId);
  const fx = db.prepare('SELECT as_of FROM fx_rates ORDER BY as_of DESC LIMIT 1').get() as
    | { as_of: string }
    | undefined;
  return { ...totals, as_of: todayISO(), fx_as_of: fx?.as_of ?? null };
}

export function getNetWorthHistory(
  db: DB,
  opts: { start?: string; end?: string; limit?: number } = {},
): Array<Record<string, unknown>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.start) {
    where.push('substr(ts,1,10) >= ?');
    args.push(opts.start);
  }
  if (opts.end) {
    where.push('substr(ts,1,10) <= ?');
    args.push(opts.end);
  }
  const rows = db
    .prepare(
      `SELECT substr(ts,1,10) AS date, total_assets_cad, total_liabilities_cad, net_worth_cad,
              by_owner, by_registered_type, origin
       FROM snapshots
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 400) as Array<Record<string, unknown>>;

  return rows
    .map((r) => ({
      date: r['date'],
      net_worth_cad: r['net_worth_cad'],
      total_assets_cad: r['total_assets_cad'],
      total_liabilities_cad: r['total_liabilities_cad'],
      origin: r['origin'],
      by_profile: safeJson(r['by_owner']),
      by_registered_type: safeJson(r['by_registered_type']),
    }))
    .reverse();
}

function safeJson(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export type HoldingsResult = {
  total_invested_cad: number;
  positions: Array<{
    symbol: string;
    description: string | null;
    asset_type: string | null;
    quantity: number;
    market_value_cad: number;
    weight_pct: number;
    cost_basis_cad: number | null;
    unrealized_pnl_cad: number | null;
    accounts: string[];
    currencies: string[];
  }>;
};

/** Positions rolled up across accounts, largest first, with concentration %. */
export function getHoldings(
  db: DB,
  opts: { profile?: string; account_id?: string; include_cash?: boolean; limit?: number } = {},
): HoldingsResult {
  const where = ['a.active = 1'];
  const args: unknown[] = [];
  if (opts.profile) {
    where.push('a.profile_id = ?');
    args.push(opts.profile);
  }
  if (opts.account_id) {
    where.push('h.account_id = ?');
    args.push(opts.account_id);
  }
  if (!opts.include_cash) where.push("COALESCE(h.asset_type,'') != 'cash'");

  const rows = db
    .prepare(
      `SELECT h.symbol, h.description, h.asset_type, h.quantity, h.market_value_cad,
              h.cost_basis_cad, h.currency, a.name AS account_name
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       WHERE ${where.join(' AND ')}`,
    )
    .all(...args) as Array<{
    symbol: string | null;
    description: string | null;
    asset_type: string | null;
    quantity: number;
    market_value_cad: number;
    cost_basis_cad: number | null;
    currency: string;
    account_name: string | null;
  }>;

  const bySymbol = new Map<string, HoldingsResult['positions'][number]>();
  let total = 0;
  for (const r of rows) {
    const key = r.symbol ?? r.description ?? 'UNKNOWN';
    total = round2(total + r.market_value_cad);
    const existing = bySymbol.get(key);
    if (existing) {
      existing.quantity = round2(existing.quantity + r.quantity);
      existing.market_value_cad = round2(existing.market_value_cad + r.market_value_cad);
      existing.cost_basis_cad =
        existing.cost_basis_cad === null || r.cost_basis_cad === null
          ? existing.cost_basis_cad
          : round2(existing.cost_basis_cad + r.cost_basis_cad);
      if (r.account_name && !existing.accounts.includes(r.account_name)) {
        existing.accounts.push(r.account_name);
      }
      if (!existing.currencies.includes(r.currency)) existing.currencies.push(r.currency);
    } else {
      bySymbol.set(key, {
        symbol: key,
        description: r.description,
        asset_type: r.asset_type,
        quantity: r.quantity,
        market_value_cad: round2(r.market_value_cad),
        weight_pct: 0,
        cost_basis_cad: r.cost_basis_cad,
        unrealized_pnl_cad: null,
        accounts: r.account_name ? [r.account_name] : [],
        currencies: [r.currency],
      });
    }
  }

  const positions = [...bySymbol.values()]
    .map((p) => ({
      ...p,
      weight_pct: total === 0 ? 0 : round2((p.market_value_cad / total) * 100),
      unrealized_pnl_cad:
        p.cost_basis_cad === null ? null : round2(p.market_value_cad - p.cost_basis_cad),
    }))
    .sort((a, b) => b.market_value_cad - a.market_value_cad);

  return {
    total_invested_cad: total,
    positions: opts.limit ? positions.slice(0, opts.limit) : positions,
  };
}

export type TransactionView = {
  id: string;
  date: string;
  account: string | null;
  profile: string;
  name: string | null;
  merchant: string | null;
  /** Negative = money out. Flipped from the Plaid-style value in storage. */
  amount_cad: number;
  amount: number;
  currency: string;
  category: string | null;
  category_detailed: string | null;
  pending: boolean;
};

export function getTransactions(
  db: DB,
  opts: {
    start?: string;
    end?: string;
    account_id?: string;
    profile?: string;
    search?: string;
    category?: string;
    min_amount_cad?: number;
    limit?: number;
  } = {},
): TransactionView[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.start) {
    where.push('t.date >= ?');
    args.push(opts.start);
  }
  if (opts.end) {
    where.push('t.date <= ?');
    args.push(opts.end);
  }
  if (opts.account_id) {
    where.push('t.account_id = ?');
    args.push(opts.account_id);
  }
  if (opts.profile) {
    where.push('a.profile_id = ?');
    args.push(opts.profile);
  }
  if (opts.category) {
    where.push('t.category = ?');
    args.push(opts.category);
  }
  if (opts.search) {
    where.push('(t.name LIKE ? OR t.merchant LIKE ?)');
    args.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  if (opts.min_amount_cad !== undefined) {
    where.push('ABS(t.amount_cad) >= ?');
    args.push(opts.min_amount_cad);
  }

  const rows = db
    .prepare(
      `SELECT t.*, a.name AS account_name, a.profile_id AS profile
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.date DESC, t.id
       LIMIT ?`,
    )
    .all(...args, opts.limit ?? 200) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r['id']),
    date: String(r['date']),
    account: (r['account_name'] as string) ?? null,
    profile: String(r['profile'] ?? 'me'),
    name: (r['name'] as string) ?? null,
    merchant: (r['merchant'] as string) ?? null,
    amount_cad: round2(-Number(r['amount_cad'])),
    amount: round2(-Number(r['amount'])),
    currency: String(r['currency']),
    category: (r['category'] as string) ?? null,
    category_detailed: (r['category_detailed'] as string) ?? null,
    pending: Boolean(r['pending']),
  }));
}

/** Categories that move money between the household's own accounts. */
export const TRANSFER_CATEGORIES = ['TRANSFER_IN', 'TRANSFER_OUT'];
/** Card and loan payments — excluded by default so card spend is not double counted. */
export const PAYMENT_CATEGORIES = ['LOAN_PAYMENTS'];

export type CashflowResult = {
  start: string;
  end: string;
  income_cad: number;
  spend_cad: number;
  net_cad: number;
  by_month: Array<{ month: string; income_cad: number; spend_cad: number; net_cad: number }>;
  by_category: Array<{ category: string; spend_cad: number }>;
  top_merchants: Array<{ merchant: string; spend_cad: number; count: number }>;
  by_profile: Array<{ profile: string; income_cad: number; spend_cad: number }>;
  excluded_categories: string[];
};

export function getCashflow(
  db: DB,
  opts: {
    start: string;
    end: string;
    profile?: string;
    include_transfers?: boolean;
    include_loan_payments?: boolean;
  },
): CashflowResult {
  const excluded: string[] = [];
  if (!opts.include_transfers) excluded.push(...TRANSFER_CATEGORIES);
  if (!opts.include_loan_payments) excluded.push(...PAYMENT_CATEGORIES);

  const where = ['t.date >= ?', 't.date <= ?', 't.pending = 0'];
  const args: unknown[] = [opts.start, opts.end];
  if (opts.profile) {
    where.push('a.profile_id = ?');
    args.push(opts.profile);
  }
  if (excluded.length) {
    where.push(`COALESCE(t.category,'') NOT IN (${excluded.map(() => '?').join(',')})`);
    args.push(...excluded);
  }

  const rows = db
    .prepare(
      `SELECT t.date, t.amount_cad, t.category, t.merchant, t.name, a.profile_id AS profile
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE ${where.join(' AND ')}`,
    )
    .all(...args) as Array<{
    date: string;
    amount_cad: number;
    category: string | null;
    merchant: string | null;
    name: string | null;
    profile: string | null;
  }>;

  const months = new Map<string, { income: number; spend: number }>();
  const categories = new Map<string, number>();
  const merchants = new Map<string, { spend: number; count: number }>();
  const profilesSeen = new Map<string, { income: number; spend: number }>();
  let income = 0;
  let spend = 0;

  for (const r of rows) {
    // Stored Plaid-style: positive = money out.
    const out = r.amount_cad > 0 ? r.amount_cad : 0;
    const inn = r.amount_cad < 0 ? -r.amount_cad : 0;
    income = round2(income + inn);
    spend = round2(spend + out);

    const month = r.date.slice(0, 7);
    const m = months.get(month) ?? { income: 0, spend: 0 };
    m.income = round2(m.income + inn);
    m.spend = round2(m.spend + out);
    months.set(month, m);

    if (out > 0) {
      const cat = r.category ?? 'UNCATEGORIZED';
      categories.set(cat, round2((categories.get(cat) ?? 0) + out));
      const key = r.merchant ?? r.name ?? 'unknown';
      const mer = merchants.get(key) ?? { spend: 0, count: 0 };
      mer.spend = round2(mer.spend + out);
      mer.count += 1;
      merchants.set(key, mer);
    }

    const pid = r.profile ?? 'me';
    const o = profilesSeen.get(pid) ?? { income: 0, spend: 0 };
    o.income = round2(o.income + inn);
    o.spend = round2(o.spend + out);
    profilesSeen.set(pid, o);
  }

  return {
    start: opts.start,
    end: opts.end,
    income_cad: income,
    spend_cad: spend,
    net_cad: round2(income - spend),
    by_month: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({
        month,
        income_cad: v.income,
        spend_cad: v.spend,
        net_cad: round2(v.income - v.spend),
      })),
    by_category: [...categories.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, spend_cad]) => ({ category, spend_cad })),
    top_merchants: [...merchants.entries()]
      .sort((a, b) => b[1].spend - a[1].spend)
      .slice(0, 20)
      .map(([merchant, v]) => ({ merchant, spend_cad: v.spend, count: v.count })),
    by_profile: [...profilesSeen.entries()].map(([profile, v]) => ({
      profile,
      income_cad: v.income,
      spend_cad: v.spend,
    })),
    excluded_categories: excluded,
  };
}

// --- contribution room ------------------------------------------------------

/** SnapTrade activity types that represent money added to a registered account. */
export const CONTRIBUTION_TYPES = ['CONTRIBUTION', 'DEPOSIT', 'TRANSFER_IN'];
/** Bank transfers that look like a Wealthsimple top-up. Heuristic, reported separately. */
export const BROKERAGE_TRANSFER_RE = '%WEALTHSIMPLE%';

export type RoomRow = {
  person: string;
  account_type: string;
  year: number;
  limit_amount: number;
  contributed_manual: number;
  note: string | null;
};

export type RoomResult = {
  person: string;
  account_type: string;
  year: number;
  limit_cad: number;
  contributed_detected_cad: number;
  contributed_manual_cad: number;
  contributed_used_cad: number;
  remaining_cad: number;
  basis: 'manual' | 'detected';
  confidence: 'high' | 'low';
  note: string | null;
  unattributed_brokerage_transfers_cad: number;
};

/**
 * Remaining room per person per account type.
 *
 * Detection is deliberately conservative. Brokerage activity tagged
 * CONTRIBUTION/DEPOSIT is attributable to a specific registered account, so it
 * counts as high confidence. Bank transfers into Wealthsimple cannot be split
 * across RRSP/TFSA from the bank side, so they are reported separately as
 * `unattributed_brokerage_transfers_cad` and never silently subtracted. A
 * manual figure set through set_contributed always wins.
 */
export function getContributionRoom(
  db: DB,
  opts: { year?: number; person?: string } = {},
): RoomResult[] {
  const year = opts.year ?? new Date().getUTCFullYear();
  const where = ['year = ?'];
  const args: unknown[] = [year];
  if (opts.person) {
    where.push('person = ?');
    args.push(opts.person);
  }
  const rooms = db
    .prepare(`SELECT * FROM room WHERE ${where.join(' AND ')} ORDER BY person, account_type`)
    .all(...args) as RoomRow[];

  const detectedStmt = db.prepare(
    `SELECT COALESCE(SUM(act.amount_cad), 0) AS total
     FROM activities act
     JOIN accounts a ON a.id = act.account_id
     WHERE a.profile_id = ? AND a.registered_type = ?
       AND substr(act.date,1,4) = ?
       AND UPPER(COALESCE(act.type,'')) IN (${CONTRIBUTION_TYPES.map(() => '?').join(',')})`,
  );

  const transfersStmt = db.prepare(
    `SELECT COALESCE(SUM(t.amount_cad), 0) AS total
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.profile_id = ? AND a.source = 'plaid' AND substr(t.date,1,4) = ?
       AND t.amount_cad > 0
       AND (UPPER(COALESCE(t.merchant,'')) LIKE ? OR UPPER(COALESCE(t.name,'')) LIKE ?)`,
  );

  return rooms.map((r) => {
    const detected = round2(
      (
        detectedStmt.get(r.person, r.account_type, String(year), ...CONTRIBUTION_TYPES) as {
          total: number;
        }
      ).total,
    );
    const transfers = round2(
      (
        transfersStmt.get(
          r.person,
          String(year),
          BROKERAGE_TRANSFER_RE,
          BROKERAGE_TRANSFER_RE,
        ) as { total: number }
      ).total,
    );
    const manual = round2(r.contributed_manual);
    const basis: 'manual' | 'detected' = manual > 0 ? 'manual' : 'detected';
    const used = basis === 'manual' ? manual : detected;
    return {
      person: r.person,
      account_type: r.account_type,
      year: r.year,
      limit_cad: round2(r.limit_amount),
      contributed_detected_cad: detected,
      contributed_manual_cad: manual,
      contributed_used_cad: used,
      remaining_cad: round2(r.limit_amount - used),
      basis,
      confidence: basis === 'manual' || detected > 0 ? 'high' : 'low',
      note: r.note,
      unattributed_brokerage_transfers_cad: transfers,
    };
  });
}

// --- user-owned setters -----------------------------------------------------

/** Re-attribute an account to another profile. Its connection does not move. */
export function setAccountProfile(db: DB, accountId: string, profileId: string): boolean {
  return moveAccount(db, accountId, profileId);
}

export function setContributed(
  db: DB,
  person: string,
  accountType: string,
  year: number,
  contributed: number,
  note?: string,
): void {
  db.prepare(
    `INSERT INTO room (person, account_type, year, limit_amount, contributed_manual, note, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(person, account_type, year) DO UPDATE SET
       contributed_manual = excluded.contributed_manual,
       note               = COALESCE(excluded.note, room.note),
       updated_at         = excluded.updated_at`,
  ).run(person, accountType, year, contributed, note ?? null, new Date().toISOString());
}

export function setRoomLimit(
  db: DB,
  person: string,
  accountType: string,
  year: number,
  limit: number,
  note?: string,
): void {
  db.prepare(
    `INSERT INTO room (person, account_type, year, limit_amount, contributed_manual, note, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(person, account_type, year) DO UPDATE SET
       limit_amount = excluded.limit_amount,
       note         = COALESCE(excluded.note, room.note),
       updated_at   = excluded.updated_at`,
  ).run(person, accountType, year, limit, note ?? null, new Date().toISOString());
}
