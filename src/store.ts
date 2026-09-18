/**
 * Write helpers shared by every source adapter. Keeping the upserts here is
 * what stops a source from inventing its own sign convention or clobbering the
 * owner tag the user set by hand.
 */
import type { DB } from './db.ts';
import { nowISO, round2 } from './lib/money.ts';
import type { RegisteredType } from './lib/registered.ts';
import { DEFAULT_PROFILE_ID } from './profiles.ts';

export type AccountRow = {
  id: string;
  source: 'snaptrade' | 'plaid' | 'wise' | 'manual';
  institution: string | null;
  name: string | null;
  mask: string | null;
  account_category: string | null;
  account_subtype: string | null;
  registered_type: RegisteredType;
  currency: string;
  /** Native currency. Assets positive, liabilities negative. */
  balance: number;
  balance_cad: number;
  available: number | null;
  /** Credit or loan limit, when the institution reports one. */
  credit_limit?: number | null;
  active: boolean;
  status: string | null;
  item_id: string | null;
};

export type HoldingRow = {
  account_id: string;
  symbol: string | null;
  description: string | null;
  asset_type: string | null;
  quantity: number;
  price: number | null;
  currency: string;
  market_value: number;
  market_value_cad: number;
  cost_basis: number | null;
  cost_basis_cad: number | null;
};

export type TransactionRow = {
  id: string;
  account_id: string;
  date: string;
  name: string | null;
  merchant: string | null;
  /** Plaid-style: positive = money out of the account. */
  amount: number;
  currency: string;
  amount_cad: number;
  category: string | null;
  category_detailed: string | null;
  pending: boolean;
};

/**
 * Insert or update an account. `owner` is only written on insert — once the
 * user has tagged an account through set_account_owner, no sync may overwrite
 * it. New accounts inherit DEFAULT_OWNER.
 */
export function upsertAccount(
  db: DB,
  a: AccountRow,
  sourceProfileId = DEFAULT_PROFILE_ID,
): void {
  const ts = nowISO();
  db.prepare(
    `INSERT INTO accounts (
       id, source, institution, name, mask, account_category, account_subtype,
       registered_type, currency, balance, balance_cad, available, credit_limit, owner, profile_id,
       source_profile_id, active, status, item_id, first_seen, updated_at
     ) VALUES (
       @id, @source, @institution, @name, @mask, @account_category, @account_subtype,
       @registered_type, @currency, @balance, @balance_cad, @available, @credit_limit, @owner, @profile_id,
       @source_profile_id, @active, @status, @item_id, @ts, @ts
     )
     ON CONFLICT(id) DO UPDATE SET
       source           = excluded.source,
       institution      = excluded.institution,
       name             = excluded.name,
       mask             = excluded.mask,
       account_category = excluded.account_category,
       account_subtype  = excluded.account_subtype,
       registered_type  = excluded.registered_type,
       currency         = excluded.currency,
       balance          = excluded.balance,
       balance_cad      = excluded.balance_cad,
       available        = excluded.available,
       credit_limit     = excluded.credit_limit,
       active            = excluded.active,
       status            = excluded.status,
       item_id           = excluded.item_id,
       source_profile_id = excluded.source_profile_id,
       updated_at        = excluded.updated_at`,
  ).run({
    id: a.id,
    source: a.source,
    institution: a.institution,
    name: a.name,
    mask: a.mask,
    account_category: a.account_category,
    account_subtype: a.account_subtype,
    registered_type: a.registered_type,
    currency: a.currency,
    balance: round2(a.balance),
    balance_cad: round2(a.balance_cad),
    available: a.available === null ? null : round2(a.available),
    credit_limit: a.credit_limit == null ? null : round2(a.credit_limit),
    // owner and profile_id are written on INSERT only. A nightly sync that
    // reset a hand-set attribution would silently corrupt every per-profile
    // number, and it would look like a market move rather than a bug.
    owner: sourceProfileId,
    profile_id: sourceProfileId,
    source_profile_id: sourceProfileId,
    active: a.active ? 1 : 0,
    status: a.status,
    item_id: a.item_id,
    ts,
  });
}

/** Holdings are a full snapshot per account: delete then insert, in one tx. */
export function replaceHoldings(db: DB, accountId: string, rows: HoldingRow[]): void {
  const ts = nowISO();
  const del = db.prepare('DELETE FROM holdings WHERE account_id = ?');
  const ins = db.prepare(
    `INSERT INTO holdings (
       account_id, symbol, description, asset_type, quantity, price, currency,
       market_value, market_value_cad, cost_basis, cost_basis_cad, updated_at
     ) VALUES (
       @account_id, @symbol, @description, @asset_type, @quantity, @price, @currency,
       @market_value, @market_value_cad, @cost_basis, @cost_basis_cad, @ts
     )`,
  );
  db.transaction(() => {
    del.run(accountId);
    for (const r of rows) {
      ins.run({
        ...r,
        quantity: r.quantity,
        market_value: round2(r.market_value),
        market_value_cad: round2(r.market_value_cad),
        cost_basis: r.cost_basis === null ? null : round2(r.cost_basis),
        cost_basis_cad: r.cost_basis_cad === null ? null : round2(r.cost_basis_cad),
        ts,
      });
    }
  })();
}

export function upsertTransactions(db: DB, rows: TransactionRow[]): number {
  const ts = nowISO();
  const stmt = db.prepare(
    `INSERT INTO transactions (
       id, account_id, date, name, merchant, amount, currency, amount_cad,
       category, category_detailed, pending, updated_at
     ) VALUES (
       @id, @account_id, @date, @name, @merchant, @amount, @currency, @amount_cad,
       @category, @category_detailed, @pending, @ts
     )
     ON CONFLICT(id) DO UPDATE SET
       account_id        = excluded.account_id,
       date              = excluded.date,
       name              = excluded.name,
       merchant          = excluded.merchant,
       amount            = excluded.amount,
       currency          = excluded.currency,
       amount_cad        = excluded.amount_cad,
       category          = excluded.category,
       category_detailed = excluded.category_detailed,
       pending           = excluded.pending,
       updated_at        = excluded.updated_at`,
  );
  const tx = db.transaction((items: TransactionRow[]) => {
    for (const r of items) {
      stmt.run({
        ...r,
        amount: round2(r.amount),
        amount_cad: round2(r.amount_cad),
        pending: r.pending ? 1 : 0,
        ts,
      });
    }
  });
  tx(rows);
  return rows.length;
}

export function removeTransactions(db: DB, ids: string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM transactions WHERE id = ?');
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
  return ids.length;
}

/**
 * Anything from `source` we did not see in this sync is no longer live (the
 * account was closed, or an Item was removed). Deactivate rather than delete so
 * history and owner tags survive.
 */
/**
 * Scoped to the credentials that just ran. Without the source_profile_id filter
 * one profile's sync would deactivate every other profile's accounts, which
 * would read as the household losing most of its money overnight.
 */
export function deactivateMissing(
  db: DB,
  source: string,
  seenIds: string[],
  sourceProfileId = DEFAULT_PROFILE_ID,
): number {
  const rows = db
    .prepare(
      'SELECT id FROM accounts WHERE source = ? AND source_profile_id = ? AND active = 1',
    )
    .all(source, sourceProfileId) as Array<{ id: string }>;
  const seen = new Set(seenIds);
  const stale = rows.map((r) => r.id).filter((id) => !seen.has(id));
  if (stale.length === 0) return 0;
  const stmt = db.prepare('UPDATE accounts SET active = 0, updated_at = ? WHERE id = ?');
  const ts = nowISO();
  db.transaction(() => {
    for (const id of stale) stmt.run(ts, id);
  })();
  return stale.length;
}

export function setCardDetails(
  db: DB,
  d: {
    account_id: string;
    statement_balance: number | null;
    minimum_payment: number | null;
    due_date: string | null;
    last_payment_amount: number | null;
    last_payment_date: string | null;
    apr_percentage: number | null;
    is_overdue: boolean | null;
  },
): void {
  db.prepare(
    `INSERT INTO card_details (
       account_id, statement_balance, minimum_payment, due_date,
       last_payment_amount, last_payment_date, apr_percentage, is_overdue, updated_at
     ) VALUES (
       @account_id, @statement_balance, @minimum_payment, @due_date,
       @last_payment_amount, @last_payment_date, @apr_percentage, @is_overdue, @ts
     )
     ON CONFLICT(account_id) DO UPDATE SET
       statement_balance   = excluded.statement_balance,
       minimum_payment     = excluded.minimum_payment,
       due_date            = excluded.due_date,
       last_payment_amount = excluded.last_payment_amount,
       last_payment_date   = excluded.last_payment_date,
       apr_percentage      = excluded.apr_percentage,
       is_overdue          = excluded.is_overdue,
       updated_at          = excluded.updated_at`,
  ).run({
    ...d,
    is_overdue: d.is_overdue === null ? null : d.is_overdue ? 1 : 0,
    ts: nowISO(),
  });
}

export type ActivityRow = {
  id: string;
  account_id: string;
  date: string;
  type: string | null;
  description: string | null;
  symbol: string | null;
  /** Signed as the brokerage reports it: a contribution/deposit is positive. */
  amount: number;
  currency: string;
  amount_cad: number;
};

/** Brokerage activity (contributions, dividends, fees) — used by get_contribution_room. */
export function upsertActivities(db: DB, rows: ActivityRow[]): number {
  const ts = nowISO();
  const stmt = db.prepare(
    `INSERT INTO activities (
       id, account_id, date, type, description, symbol, amount, currency, amount_cad, updated_at
     ) VALUES (
       @id, @account_id, @date, @type, @description, @symbol, @amount, @currency, @amount_cad, @ts
     )
     ON CONFLICT(id) DO UPDATE SET
       account_id  = excluded.account_id,
       date        = excluded.date,
       type        = excluded.type,
       description = excluded.description,
       symbol      = excluded.symbol,
       amount      = excluded.amount,
       currency    = excluded.currency,
       amount_cad  = excluded.amount_cad,
       updated_at  = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const r of rows) {
      stmt.run({ ...r, amount: round2(r.amount), amount_cad: round2(r.amount_cad), ts });
    }
  })();
  return rows.length;
}
