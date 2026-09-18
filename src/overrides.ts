/**
 * Hand corrections to what an institution reported.
 *
 * Three kinds, applied on read so a nightly sync can never undo them:
 *
 *  - an account currency override, for when a bank labels a card in the wrong
 *    currency (everything native is reinterpreted, and CAD is recomputed);
 *  - a per-transaction merchant/category override, for one-offs;
 *  - a merchant rule, which rewrites every row matching a pattern — past and
 *    future — so "Primmum Insurance Co" and "Primmum Insurance Comp" stop being
 *    two different merchants.
 *
 * Precedence is narrowest first: transaction override, then the first matching
 * rule, then what the institution said.
 */
import type { DB } from './db.ts';
import { config } from './config.ts';
import { loadRates, tryConvert } from './fx.ts';
import { nowISO, round2 } from './lib/money.ts';

export type TxOverride = { merchant: string | null; category: string | null; note: string | null };

export type MerchantRule = {
  id: number;
  match_type: 'contains' | 'prefix' | 'exact' | 'merchant';
  pattern: string;
  merchant: string | null;
  category: string | null;
  position: number;
};

/**
 * How a rule decides whether a row is its business.
 *
 * `contains`/`prefix`/`exact` test the institution's raw text (merchant field
 * and description joined), which is what merges misspellings. `merchant` tests
 * the single name the merchant directory groups under, which is what makes
 * "file this merchant under X" precise: a contains rule for "Amazon" would also
 * capture "Amazon Web Services", and filing one merchant must not relabel
 * another that merely starts the same way.
 */
export const MATCH_TYPES = ['contains', 'prefix', 'exact', 'merchant'] as const;

// --- account currency -------------------------------------------------------

/**
 * Reinterpret an account's native currency. Pass null to go back to trusting
 * the institution. Recomputes the stored CAD figures for the account and every
 * transaction on it, so history stops being wrong immediately rather than at
 * the next sync.
 */
export function setAccountCurrency(db: DB, accountId: string, currency: string | null): boolean {
  const code = currency ? currency.toUpperCase() : null;
  if (code !== null && !/^[A-Z]{3}$/.test(code)) throw new Error('currency must be a 3-letter code');
  const row = db.prepare('SELECT currency FROM accounts WHERE id = ?').get(accountId) as
    | { currency: string }
    | undefined;
  if (!row) return false;

  const rates = loadRates(db);
  const effective = code ?? row.currency;
  const conv = (amount: number): number =>
    tryConvert(amount, effective, config.baseCurrency, rates) ?? round2(amount);

  db.transaction(() => {
    db.prepare('UPDATE accounts SET currency_override = ?, updated_at = ? WHERE id = ?').run(
      code,
      nowISO(),
      accountId,
    );
    const acct = db.prepare('SELECT balance, available FROM accounts WHERE id = ?').get(accountId) as {
      balance: number;
      available: number | null;
    };
    db.prepare('UPDATE accounts SET balance_cad = ? WHERE id = ?').run(conv(acct.balance), accountId);

    const txs = db
      .prepare('SELECT id, amount FROM transactions WHERE account_id = ?')
      .all(accountId) as Array<{ id: string; amount: number }>;
    const stmt = db.prepare('UPDATE transactions SET amount_cad = ?, currency = ? WHERE id = ?');
    for (const t of txs) stmt.run(conv(t.amount), effective, t.id);
  })();
  return true;
}

/** The currency an account's amounts should be read as. */
export function effectiveCurrency(row: { currency: string; currency_override?: string | null }): string {
  return row.currency_override || row.currency;
}

// --- per-transaction overrides ----------------------------------------------

export function setTransactionOverride(
  db: DB,
  transactionId: string,
  patch: Partial<TxOverride>,
): void {
  const existing = db
    .prepare('SELECT merchant, category, note FROM tx_overrides WHERE transaction_id = ?')
    .get(transactionId) as TxOverride | undefined;
  const next: TxOverride = {
    merchant: patch.merchant !== undefined ? patch.merchant : (existing?.merchant ?? null),
    category: patch.category !== undefined ? patch.category : (existing?.category ?? null),
    note: patch.note !== undefined ? patch.note : (existing?.note ?? null),
  };
  // An override with nothing left in it is deleted rather than kept as a row of
  // nulls, so "has this been touched?" stays a simple existence check.
  if (next.merchant === null && next.category === null && next.note === null) {
    db.prepare('DELETE FROM tx_overrides WHERE transaction_id = ?').run(transactionId);
    return;
  }
  db.prepare(
    `INSERT INTO tx_overrides (transaction_id, merchant, category, note, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       merchant = excluded.merchant, category = excluded.category,
       note = excluded.note, updated_at = excluded.updated_at`,
  ).run(transactionId, next.merchant, next.category, next.note, nowISO());
}

export function txOverrides(db: DB): Map<string, TxOverride> {
  const rows = db.prepare('SELECT * FROM tx_overrides').all() as Array<
    TxOverride & { transaction_id: string }
  >;
  return new Map(
    rows.map((r) => [r.transaction_id, { merchant: r.merchant, category: r.category, note: r.note }]),
  );
}

// --- categories -------------------------------------------------------------

/**
 * Plaid's taxonomy is fixed and generic; a household's is neither. A category
 * lives in its own table so it can exist before anything is filed under it —
 * derived-from-usage would make "create the category, then assign it"
 * impossible.
 */
export function normalizeCategory(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export function addCategory(db: DB, name: string): string {
  const key = normalizeCategory(name);
  if (!key) throw new Error('a category needs a name');
  db.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(
    key,
    nowISO(),
  );
  return key;
}

/** Only removes the user-defined row; transactions filed under it are untouched. */
export function deleteCategory(db: DB, name: string): boolean {
  return db.prepare('DELETE FROM categories WHERE name = ?').run(normalizeCategory(name)).changes > 0;
}

export function customCategories(db: DB): string[] {
  return (db.prepare('SELECT name FROM categories ORDER BY name').all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

/**
 * Assign a category to a merchant by name.
 *
 * Updates the rule that produced that name when one exists, rather than adding
 * a second: a merchant already renamed by a rule ("Sdm" -> "Shoppers Drug
 * Mart") cannot be matched by a new rule on the new name, because rules match
 * the institution's raw text.
 */
export function setMerchantCategory(
  db: DB,
  merchant: string,
  category: string | null,
): MerchantRule | null {
  const name = merchant.trim();
  if (!name) throw new Error('which merchant?');
  const cat = category ? normalizeCategory(category) : null;
  if (cat) addCategory(db, cat);

  // Either shape counts as "the rule for this merchant": one that renamed
  // something to this name, or one this function created keyed on it.
  const existing = listMerchantRules(db).find(
    (r) => r.merchant === name || (r.match_type === 'merchant' && r.pattern === name),
  );

  if (existing) {
    // A rule with nothing left to say is deleted rather than kept as a no-op
    // that still shows up in the rules list and still costs a match per row.
    if (cat === null && existing.merchant === null) {
      deleteMerchantRule(db, existing.id);
      return null;
    }
    db.prepare('UPDATE merchant_rules SET category = ?, updated_at = ? WHERE id = ?').run(
      cat,
      nowISO(),
      existing.id,
    );
    return { ...existing, category: cat };
  }

  // Uncategorising something that was never categorised is not an error.
  if (cat === null) return null;
  return addMerchantRule(db, { pattern: name, category: cat, match_type: 'merchant' });
}

// --- merchant rules ---------------------------------------------------------

export function listMerchantRules(db: DB): MerchantRule[] {
  return db
    .prepare('SELECT * FROM merchant_rules ORDER BY position, id')
    .all() as MerchantRule[];
}

export function addMerchantRule(
  db: DB,
  rule: { pattern: string; merchant?: string | null; category?: string | null; match_type?: string },
): MerchantRule {
  const pattern = rule.pattern.trim();
  if (!pattern) throw new Error('a rule needs a pattern to match');
  if (!rule.merchant && !rule.category) throw new Error('a rule must set a merchant, a category, or both');
  const type = (MATCH_TYPES as readonly string[]).includes(rule.match_type ?? '')
    ? (rule.match_type as MerchantRule['match_type'])
    : 'contains';
  const ts = nowISO();
  const pos =
    ((db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM merchant_rules').get() as { p: number })
      .p ?? 0) + 1;
  const info = db
    .prepare(
      `INSERT INTO merchant_rules (match_type, pattern, merchant, category, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(type, pattern, rule.merchant ?? null, rule.category ?? null, pos, ts, ts);
  return {
    id: Number(info.lastInsertRowid),
    match_type: type,
    pattern,
    merchant: rule.merchant ?? null,
    category: rule.category ?? null,
    position: pos,
  };
}

export function deleteMerchantRule(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM merchant_rules WHERE id = ?').run(id).changes > 0;
}

function matches(rule: MerchantRule, row: Correctable): boolean {
  const p = rule.pattern.toLowerCase();
  if (rule.match_type === 'merchant') {
    // The directory's key for this row, which is what the user pointed at.
    return (row.merchant ?? row.name ?? '').toLowerCase() === p;
  }
  const h = `${row.merchant ?? ''} ${row.name ?? ''}`.trim().toLowerCase();
  if (!h) return false;
  if (rule.match_type === 'exact') return h === p;
  if (rule.match_type === 'prefix') return h.startsWith(p);
  return h.includes(p);
}

export type Correctable = {
  id: string;
  name: string | null;
  merchant: string | null;
  category: string | null;
};

export type Corrected<T> = T & {
  /** How this row's merchant and category were arrived at. */
  corrected_by: 'override' | 'rule' | null;
  rule_id?: number;
};

/**
 * Apply overrides and rules to a batch of rows. Built once per query rather
 * than per row, because a rule list is read for every transaction.
 */
export function corrector(db: DB): <T extends Correctable>(row: T) => Corrected<T> {
  const overrides = txOverrides(db);
  const rules = listMerchantRules(db);

  return <T extends Correctable>(row: T): Corrected<T> => {
    const over = overrides.get(row.id);
    if (over && (over.merchant !== null || over.category !== null)) {
      return {
        ...row,
        merchant: over.merchant ?? row.merchant,
        category: over.category ?? row.category,
        corrected_by: 'override',
      };
    }
    for (const rule of rules) {
      if (!matches(rule, row)) continue;
      return {
        ...row,
        merchant: rule.merchant ?? row.merchant,
        category: rule.category ?? row.category,
        corrected_by: 'rule',
        rule_id: rule.id,
      };
    }
    return { ...row, corrected_by: null };
  };
}

/** How many stored transactions a rule would touch. Used to preview a rule. */
export function ruleImpact(db: DB, rule: { pattern: string; match_type?: string }): number {
  const type = (MATCH_TYPES as readonly string[]).includes(rule.match_type ?? '')
    ? (rule.match_type as MerchantRule['match_type'])
    : 'contains';
  const p = rule.pattern.toLowerCase();
  if (type === 'merchant') {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE LOWER(COALESCE(NULLIF(merchant,''), name, '')) = ?`,
      )
      .get(p) as { n: number };
    return row.n;
  }
  const like = type === 'exact' ? p : type === 'prefix' ? `${p}%` : `%${p}%`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE LOWER(TRIM(COALESCE(merchant,'') || ' ' || COALESCE(name,''))) LIKE ?`,
    )
    .get(like) as { n: number };
  return row.n;
}
