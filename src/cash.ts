/**
 * Cash spending entered by hand.
 *
 * Banks cannot see cash, so a household that pays some things in cash has a
 * gap between what it spent and what the linked accounts show. This adds the
 * missing expenses as ordinary transactions on one "Cash" account per profile,
 * so categories, tags, rules, reports and every total treat them like any other
 * row, with no second code path to keep honest.
 *
 * What it deliberately does not do:
 *
 * - **Categorise the ATM withdrawal.** A withdrawal is money moving from the
 *   bank into a pocket, so it stays a transfer (hidden, hard rule 12) and the
 *   expenses it paid for are counted when they are recorded. One withdrawal
 *   spent on several things needs no splitting: record each thing. The
 *   reconciliation (`cashReconciliation`) shows withdrawn versus recorded, so
 *   forgotten cash spending shows up as a number rather than a hunch.
 * - **Touch net worth.** The Cash account holds a zero balance.
 * - **Record income.** Money coming in arrives through a bank as a transfer and
 *   is filed there (Income › Rent for rent paid by Zelle).
 *
 * Only these rows can be changed or deleted here. A bank's rows cannot be
 * deleted: the next sync would put them back.
 */
import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { config } from './config.ts';
import { loadRates, tryConvert } from './fx.ts';
import { DEFAULT_PROFILE_ID, profileExists } from './profiles.ts';
import { todayISO, round2 } from './lib/money.ts';
import { isTransferLike } from './queries.ts';
import { normalizeCategory } from './overrides.ts';
import { setTags, parseTags } from './tags.ts';
import { upsertAccount, upsertTransactions, type TransactionRow } from './store.ts';

/** Ids of cash accounts and cash transactions start with this. */
export const MANUAL_PREFIX = 'manual:';
export const CASH_ACCOUNT_PREFIX = 'manual:cash:';
export const MAX_CASH_AMOUNT = 1_000_000;
/** The code Plaid files an ATM or counter withdrawal under. */
export const WITHDRAWAL_CODE = 'TRANSFER_OUT_WITHDRAWAL';

export const cashAccountId = (profile: string): string => `${CASH_ACCOUNT_PREFIX}${profile}`;
export const isCashTransactionId = (id: string): boolean => id.startsWith(MANUAL_PREFIX);

/** The profile's Cash account, created on first use with a zero balance. */
export function ensureCashAccount(db: DB, profile = DEFAULT_PROFILE_ID): string {
  if (!profileExists(db, profile)) throw new Error(`No such profile “${profile}”.`);
  const id = cashAccountId(profile);
  const exists = db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id);
  if (!exists) {
    upsertAccount(
      db,
      {
        id,
        source: 'manual',
        institution: 'Cash',
        name: 'Cash',
        mask: null,
        account_category: 'DEPOSITORY',
        account_subtype: 'cash',
        registered_type: 'NON_REG',
        currency: config.baseCurrency,
        balance: 0,
        balance_cad: 0,
        available: null,
        active: true,
        status: 'ok',
        item_id: null,
      },
      profile,
    );
  }
  return id;
}

export type CashInput = {
  amount: number;
  description: string;
  /** YYYY-MM-DD; defaults to today. */
  date?: string;
  /** A category code from the pickers; blank is uncategorised. */
  category?: string | null;
  /** Tags to set, by name. */
  tags?: string[];
  /** ISO code when not the base currency; converted at the latest rate. */
  currency?: string;
  profile?: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(input: { amount?: number; description?: string; date?: string; category?: string | null }): void {
  if (input.amount !== undefined) {
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('The amount must be more than zero.');
    if (input.amount > MAX_CASH_AMOUNT) throw new Error('That amount is too large to be cash.');
  }
  if (input.description !== undefined && !input.description.trim()) {
    throw new Error('Say what it was, even briefly (“market”, “haircut”).');
  }
  if (input.date !== undefined) {
    const t = Date.parse(`${input.date}T00:00:00Z`);
    // Date.parse rolls 2026-02-31 over to March, so compare what it read with what was typed.
    if (!DATE.test(input.date) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== input.date) {
      throw new Error('The date must look like 2026-10-07.');
    }
    if (t > Date.parse(`${todayISO()}T00:00:00Z`) + 86_400_000) throw new Error('That date is in the future.');
  }
  if (input.category && isTransferLike(normalizeCategory(input.category))) {
    // A transfer is left out of spending, which would make the entry vanish.
    throw new Error('That category is not spending, so the entry would not count. Pick an expense category.');
  }
}

function cleanDescription(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Convert to the base currency, or say why not. */
function toBase(db: DB, amount: number, currency: string): number {
  const ccy = currency.trim().toUpperCase();
  if (ccy === config.baseCurrency) return amount;
  const v = tryConvert(amount, ccy, config.baseCurrency, loadRates(db));
  if (v === null) throw new Error(`No exchange rate for ${ccy} yet, so it cannot be converted. Try again after a sync.`);
  return round2(v);
}

/** Record a cash expense. Returns the new transaction's id. */
export function addCashExpense(db: DB, input: CashInput): string {
  check(input);
  const profile = input.profile || DEFAULT_PROFILE_ID;
  const account = ensureCashAccount(db, profile);
  const id = `${MANUAL_PREFIX}${randomUUID()}`;
  const description = cleanDescription(input.description);
  const currency = (input.currency || config.baseCurrency).trim().toUpperCase();
  const amount = round2(input.amount);
  const row: TransactionRow = {
    id,
    account_id: account,
    date: input.date ?? todayISO(),
    name: description,
    merchant: description,
    // Stored Plaid-style: positive is money out.
    amount,
    currency,
    amount_cad: toBase(db, amount, currency),
    category: input.category ? normalizeCategory(input.category) : null,
    category_detailed: null,
    pending: false,
  };
  db.transaction(() => {
    upsertTransactions(db, [row]);
    if (input.tags?.length) setTags(db, id, input.tags);
  })();
  return id;
}

function requireCash(db: DB, id: string): void {
  const row = db.prepare('SELECT account_id FROM transactions WHERE id = ?').get(id) as { account_id: string } | undefined;
  if (!row) throw new Error('No such transaction.');
  if (!isCashTransactionId(id) || !row.account_id.startsWith(CASH_ACCOUNT_PREFIX)) {
    throw new Error('Only cash entries made here can be changed or deleted. A bank’s transactions come back on the next sync.');
  }
}

export type CashPatch = Partial<Pick<CashInput, 'amount' | 'description' | 'date' | 'category' | 'currency'>> & {
  tags?: string[];
};

/** Change a cash entry. Only the fields given are touched. */
export function updateCashExpense(db: DB, id: string, patch: CashPatch): void {
  requireCash(db, id);
  check(patch);
  const row = db.prepare('SELECT amount, currency FROM transactions WHERE id = ?').get(id) as {
    amount: number;
    currency: string;
  };
  const amount = patch.amount !== undefined ? round2(patch.amount) : row.amount;
  const currency = (patch.currency || row.currency).trim().toUpperCase();
  db.transaction(() => {
    const sets: string[] = ['updated_at = ?'];
    const args: unknown[] = [new Date().toISOString()];
    if (patch.amount !== undefined || patch.currency !== undefined) {
      sets.push('amount = ?', 'currency = ?', 'amount_cad = ?');
      args.push(amount, currency, toBase(db, amount, currency));
    }
    if (patch.description !== undefined) {
      const d = cleanDescription(patch.description);
      sets.push('name = ?', 'merchant = ?');
      args.push(d, d);
    }
    if (patch.date !== undefined) {
      sets.push('date = ?');
      args.push(patch.date);
    }
    if (patch.category !== undefined) {
      sets.push('category = ?');
      args.push(patch.category ? normalizeCategory(patch.category) : null);
    }
    db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    if (patch.tags) setTags(db, id, patch.tags);
  })();
}

/** Delete a cash entry, with its tags and any hand correction. */
export function deleteCashExpense(db: DB, id: string): void {
  requireCash(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM tx_tags WHERE transaction_id = ?').run(id);
    db.prepare('DELETE FROM tx_overrides WHERE transaction_id = ?').run(id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  })();
}

export type CashReconciliation = {
  start: string;
  end: string;
  /** Cash taken out of bank accounts (ATM and counter withdrawals). */
  withdrawn_cad: number;
  withdrawals: number;
  /** Cash spending recorded by hand. */
  recorded_cad: number;
  entries: number;
  /** Withdrawn minus recorded: cash spending not yet entered (or still in a wallet). */
  unaccounted_cad: number;
};

/**
 * Cash taken out against cash spending recorded, for a window. Withdrawals are
 * recognised by Plaid's own code (`TRANSFER_OUT_WITHDRAWAL`); a bank that files
 * them differently shows none, and the tile says so rather than guessing from
 * the description. Pending rows are left out, as they are everywhere.
 */
export function cashReconciliation(
  db: DB,
  opts: { start: string; end: string; profile?: string },
): CashReconciliation {
  const profile = opts.profile ? 'AND a.profile_id = ?' : '';
  const extra = opts.profile ? [opts.profile] : [];
  const sum = (where: string): { total: number; n: number } => {
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(t.amount_cad), 0) AS total, COUNT(*) AS n
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         WHERE t.date >= ? AND t.date <= ? AND t.pending = 0 AND t.amount_cad > 0 ${profile} ${where}`,
      )
      .get(opts.start, opts.end, ...extra) as { total: number; n: number };
    return { total: round2(r.total), n: r.n };
  };
  const out = sum(`AND t.category_detailed = '${WITHDRAWAL_CODE}' AND a.source != 'manual'`);
  const rec = sum(`AND a.id LIKE '${CASH_ACCOUNT_PREFIX}%'`);
  return {
    start: opts.start,
    end: opts.end,
    withdrawn_cad: out.total,
    withdrawals: out.n,
    recorded_cad: rec.total,
    entries: rec.n,
    unaccounted_cad: round2(out.total - rec.total),
  };
}

/** Parse "Italy 2026, cash" the way the forms send it. */
export const tagsFromField = (v: unknown): string[] => parseTags(String(v ?? ''));
