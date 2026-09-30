/**
 * Getting more transaction history for a bank that is already connected.
 *
 * Plaid fixes how far back an Item's transactions go when it is linked
 * (`days_requested`, 90 by default, 730 at most), and "once Transactions has
 * been added to an Item, this value cannot be updated". So two years of
 * history means linking the bank again, and the new Item has to take over from
 * the old one without anything being lost or counted twice:
 *
 *   1. The new Item is saved with `replaces_item_id` and left alone (no
 *      balances, no transactions) until Plaid says its historical pull is
 *      complete. Until then the old Item keeps working as before, so net worth
 *      and spending never see both.
 *   2. Once it is ready, the sync stores the new Item's accounts and full
 *      history, removes the old Item at Plaid, and hands over (below).
 *
 * The handover pairs each old account with the new one by its last four digits
 * and type, then for each old transaction: inside the new history, its tags and
 * hand correction move to the matching new transaction and the old row goes;
 * older than the new history reaches, the row moves to the new account as it
 * is. The account's profile and currency choice move too. An old account with
 * no clear partner is left deactivated with its history, exactly as a plain
 * disconnect leaves it.
 */
import type { DB } from '../db.ts';
import { round2 } from '../lib/money.ts';

/** The most Plaid allows, and what "get the full history" asks for. */
export const MAX_HISTORY_DAYS = 730;
/** What an Item gets when nothing is asked for. */
export const DEFAULT_HISTORY_DAYS = 90;

/**
 * Plaid's word that every day of history asked for has arrived. A status Plaid
 * cannot report (UNKNOWN) is waited out for three days, then trusted: a
 * handover stuck forever would leave the old Item billed and the new one idle.
 */
export function historyReady(status: string | null | undefined, linkedAt: string, now = new Date()): boolean {
  if (status === 'HISTORICAL_UPDATE_COMPLETE') return true;
  if (status === 'NOT_READY' || status === 'INITIAL_UPDATE_COMPLETE') return false;
  return now.getTime() - Date.parse(linkedAt) > 3 * 86_400_000;
}

type Acct = {
  id: string;
  name: string | null;
  mask: string | null;
  account_subtype: string | null;
  profile_id: string;
  currency_override: string | null;
};

type Tx = { id: string; date: string; amount: number; name: string | null; merchant: string | null };

export type HandoverResult = {
  /** Old account id → new account id. */
  accounts: Record<string, string>;
  /** Old accounts with no clear partner, left deactivated with their history. */
  unmatched_accounts: string[];
  /** Transactions whose tags or correction moved to the new copy. */
  carried: number;
  /** Old rows the new history covers, removed as duplicates. */
  replaced: number;
  /** Old rows from before the new history, moved to the new account. */
  kept_older: number;
  /** Tagged or corrected rows with no match in the new history (their notes are dropped). */
  unmatched_annotated: number;
};

/**
 * Pair old accounts with new ones. Last four digits and type when the bank
 * sends a mask, then the account name when two cards share those (American
 * Express reuses the last four across a business card's family); the name
 * alone when there is no mask. Only a single, unclaimed candidate counts: a
 * guess would put one card's history on another.
 */
export function pairAccounts(oldAccts: Acct[], newAccts: Acct[]): Map<string, string> {
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  const name = (a: Acct): string => (a.name ?? '').trim().toLowerCase();
  const byMask = (a: Acct): string | null =>
    a.mask ? `${a.mask}|${(a.account_subtype ?? '').toLowerCase()}` : null;
  for (const o of oldAccts) {
    const open = newAccts.filter((n) => !taken.has(n.id));
    let candidates = byMask(o)
      ? open.filter((n) => byMask(n) === byMask(o))
      : name(o)
        ? open.filter((n) => !n.mask && name(n) === name(o))
        : [];
    if (candidates.length > 1 && name(o)) candidates = candidates.filter((n) => name(n) === name(o));
    if (candidates.length !== 1) continue;
    pairs.set(o.id, candidates[0]!.id);
    taken.add(candidates[0]!.id);
  }
  return pairs;
}

/**
 * Old accounts a handover could not pair at the time, finished later: the old
 * Item is gone from plaid_items but its accounts, and their transactions, are
 * still stored next to the new connection's copies. For each such Item, when
 * exactly one live connection of the same bank exists on the same profile,
 * the handover runs again for what is left. It moves nothing it cannot pair,
 * so running it on every sync is safe, and it also mends a bank that was
 * disconnected and added again by hand.
 */
export function finishHandovers(db: DB, profileId: string): Array<{ from: string; to: string; result: HandoverResult }> {
  const leftovers = db
    .prepare(
      `SELECT DISTINCT a.item_id, a.institution FROM accounts a
       WHERE a.source = 'plaid' AND a.source_profile_id = ? AND a.item_id IS NOT NULL
         AND a.item_id NOT IN (SELECT item_id FROM plaid_items)
         AND EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id)`,
    )
    .all(profileId) as Array<{ item_id: string; institution: string | null }>;
  const done: Array<{ from: string; to: string; result: HandoverResult }> = [];
  for (const left of leftovers) {
    if (!left.institution) continue;
    const live = db
      .prepare(
        `SELECT item_id FROM plaid_items
         WHERE profile_id = ? AND institution_name = ? AND replaces_item_id IS NULL`,
      )
      .all(profileId, left.institution) as Array<{ item_id: string }>;
    if (live.length !== 1) continue;
    const result = handOver(db, left.item_id, live[0]!.item_id);
    if (Object.keys(result.accounts).length) done.push({ from: left.item_id, to: live[0]!.item_id, result });
  }
  return done;
}

/**
 * Move everything the household added from the old Item's accounts to the new
 * Item's. Local only and idempotent: the caller has already removed the old
 * Item at Plaid, so nothing here can leave a billed connection behind.
 */
export function handOver(db: DB, oldItemId: string, newItemId: string): HandoverResult {
  const accts = (itemId: string): Acct[] =>
    db
      .prepare('SELECT id, name, mask, account_subtype, profile_id, currency_override FROM accounts WHERE item_id = ?')
      .all(itemId) as Acct[];
  const oldAccts = accts(oldItemId);
  const newAccts = accts(newItemId);
  const pairs = pairAccounts(oldAccts, newAccts);

  const result: HandoverResult = {
    accounts: Object.fromEntries(pairs),
    unmatched_accounts: oldAccts.filter((a) => !pairs.has(a.id)).map((a) => a.id),
    carried: 0,
    replaced: 0,
    kept_older: 0,
    unmatched_annotated: 0,
  };

  const txOf = db.prepare('SELECT id, date, amount, name, merchant FROM transactions WHERE account_id = ?');
  const annotated = db.prepare(
    `SELECT (SELECT COUNT(*) FROM tx_tags WHERE transaction_id = ?) + (SELECT COUNT(*) FROM tx_overrides WHERE transaction_id = ?) AS n`,
  );
  const moveTags = db.prepare(
    'INSERT OR IGNORE INTO tx_tags (transaction_id, tag, created_at) SELECT ?, tag, created_at FROM tx_tags WHERE transaction_id = ?',
  );
  const moveOverride = db.prepare(
    `UPDATE tx_overrides SET transaction_id = ? WHERE transaction_id = ?
       AND NOT EXISTS (SELECT 1 FROM tx_overrides WHERE transaction_id = ?)`,
  );
  const dropTags = db.prepare('DELETE FROM tx_tags WHERE transaction_id = ?');
  const dropOverride = db.prepare('DELETE FROM tx_overrides WHERE transaction_id = ?');
  const dropTx = db.prepare('DELETE FROM transactions WHERE id = ?');
  const rehome = db.prepare('UPDATE transactions SET account_id = ? WHERE id = ?');

  db.transaction(() => {
    for (const [oldId, newId] of pairs) {
      const old = oldAccts.find((a) => a.id === oldId)!;
      db.prepare(
        'UPDATE accounts SET profile_id = ?, currency_override = COALESCE(currency_override, ?) WHERE id = ?',
      ).run(old.profile_id, old.currency_override, newId);

      const fresh = txOf.all(newId) as Tx[];
      const earliest = fresh.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null);
      const claimed = new Set<string>();
      // The new copy of an old row: same day and amount, and the same bank text
      // when there is a choice. Within three days on the amount alone when the
      // bank dated it differently. Each new row is claimed once.
      const partner = (t: Tx): Tx | undefined => {
        const amount = round2(t.amount);
        const open = fresh.filter((f) => !claimed.has(f.id) && round2(f.amount) === amount);
        const sameDay = open.filter((f) => f.date === t.date);
        const named = sameDay.filter((f) => (f.name ?? '') === (t.name ?? ''));
        if (named.length >= 1) return named[0];
        if (sameDay.length === 1) return sameDay[0];
        const near = open.filter((f) => Math.abs(Date.parse(f.date) - Date.parse(t.date)) <= 3 * 86_400_000);
        return near.length === 1 ? near[0] : undefined;
      };

      for (const t of txOf.all(oldId) as Tx[]) {
        if (earliest === null || t.date < earliest) {
          // Before anything the new Item has: history only the old one held.
          rehome.run(newId, t.id);
          result.kept_older += 1;
          continue;
        }
        const hasNotes = (annotated.get(t.id, t.id) as { n: number }).n > 0;
        const p = partner(t);
        if (p) {
          claimed.add(p.id);
          if (hasNotes) {
            moveTags.run(p.id, t.id);
            moveOverride.run(p.id, t.id, p.id);
            result.carried += 1;
          }
        } else if (hasNotes) {
          result.unmatched_annotated += 1;
        }
        dropTags.run(t.id);
        dropOverride.run(t.id);
        dropTx.run(t.id);
        result.replaced += 1;
      }

      db.prepare('DELETE FROM card_details WHERE account_id = ?').run(oldId);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(oldId);
    }
    db.prepare('UPDATE plaid_items SET replaces_item_id = NULL WHERE item_id = ?').run(newItemId);
  })();
  return result;
}
