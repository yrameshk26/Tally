/**
 * Tags: labels on top of a transaction's category. A trip ("Italy 2026"),
 * business spending on a personal card, a renovation. Untagged is the ordinary
 * case, so nothing needs tagging to be counted.
 *
 * A tag never changes what counts as spending. It only narrows a view: the
 * trip's spending by category, or the month without the business card's
 * charges. Transfers and card payments stay out of a tagged total exactly as
 * they stay out of every other one (CLAUDE.md rule 12).
 *
 * Tags are the user's own annotation, stored here and nowhere else; nothing
 * is sent to an institution. Names compare without case, so "italy 2026" and
 * "Italy 2026" are one tag, spelled the way it was first written.
 */
import type { DB } from './db.ts';
import { nowISO } from './lib/money.ts';

export const MAX_TAG_LENGTH = 40;

/**
 * Tidy a tag name: no control characters, one space between words, no commas
 * (they separate tags in a form field), at most 40 characters.
 */
export function cleanTag(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

/** "Italy 2026, business" as a list, cleaned, without repeats. */
export function parseTags(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(',')) {
    const t = cleanTag(part);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

function required(tag: string): string {
  const t = cleanTag(tag);
  if (!t) throw new Error('A tag needs a name.');
  return t;
}

/** The spelling a tag already has, so a second spelling never starts a second tag. */
function canonical(db: DB, tag: string): string {
  const row = db.prepare('SELECT tag FROM tx_tags WHERE tag = ? LIMIT 1').get(tag) as { tag: string } | undefined;
  return row?.tag ?? tag;
}

/** Only transactions that exist: a mistyped id must not leave a tag on nothing. */
function existing(db: DB, ids: string[]): string[] {
  const stmt = db.prepare('SELECT 1 FROM transactions WHERE id = ?');
  return [...new Set(ids)].filter((id) => stmt.get(id));
}

/** Tag transactions. Returns how many were newly tagged. */
export function addTag(db: DB, ids: string[], tag: string): number {
  const name = canonical(db, required(tag));
  const stmt = db.prepare('INSERT OR IGNORE INTO tx_tags (transaction_id, tag, created_at) VALUES (?, ?, ?)');
  const ts = nowISO();
  let n = 0;
  db.transaction(() => {
    for (const id of existing(db, ids)) n += stmt.run(id, name, ts).changes;
  })();
  return n;
}

/** Take a tag off transactions. Returns how many had it. */
export function removeTag(db: DB, ids: string[], tag: string): number {
  const name = required(tag);
  const stmt = db.prepare('DELETE FROM tx_tags WHERE transaction_id = ? AND tag = ?');
  let n = 0;
  db.transaction(() => {
    for (const id of new Set(ids)) n += stmt.run(id, name).changes;
  })();
  return n;
}

/** Replace one transaction's tags with exactly these. */
export function setTags(db: DB, id: string, tags: string[]): void {
  if (existing(db, [id]).length === 0) throw new Error('No such transaction.');
  const names = [...new Set(tags.map(cleanTag).filter(Boolean))];
  db.transaction(() => {
    db.prepare('DELETE FROM tx_tags WHERE transaction_id = ?').run(id);
    for (const t of names) addTag(db, [id], t);
  })();
}

/** Every transaction's tags, sorted, for decorating a batch of rows. */
export function tagsByTransaction(db: DB): Map<string, string[]> {
  const rows = db
    .prepare('SELECT transaction_id, tag FROM tx_tags ORDER BY tag COLLATE NOCASE')
    .all() as Array<{ transaction_id: string; tag: string }>;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.transaction_id, [...(out.get(r.transaction_id) ?? []), r.tag]);
  return out;
}

export type TagInfo = {
  tag: string;
  count: number;
  /** The first and last date tagged, which is the tag's natural window. */
  first: string;
  last: string;
};

/** Every tag in use, newest first. */
export function listTags(db: DB): TagInfo[] {
  return db
    .prepare(
      `SELECT g.tag AS tag, COUNT(*) AS count, MIN(t.date) AS first, MAX(t.date) AS last
       FROM tx_tags g JOIN transactions t ON t.id = g.transaction_id
       GROUP BY g.tag ORDER BY MAX(t.date) DESC, g.tag`,
    )
    .all() as TagInfo[];
}

/** Rename a tag everywhere. Renaming onto an existing tag merges the two. */
export function renameTag(db: DB, from: string, to: string): number {
  const old = required(from);
  const next = required(to);
  let n = 0;
  db.transaction(() => {
    const target = old.toLowerCase() === next.toLowerCase() ? next : canonical(db, next);
    const ids = (
      db.prepare('SELECT transaction_id FROM tx_tags WHERE tag = ?').all(old) as Array<{ transaction_id: string }>
    ).map((r) => r.transaction_id);
    db.prepare('DELETE FROM tx_tags WHERE tag = ?').run(old);
    const ins = db.prepare('INSERT OR IGNORE INTO tx_tags (transaction_id, tag, created_at) VALUES (?, ?, ?)');
    const ts = nowISO();
    for (const id of ids) {
      ins.run(id, target, ts);
      n += 1;
    }
  })();
  return n;
}

/** Take a tag off every transaction. The transactions themselves are untouched. */
export function deleteTag(db: DB, tag: string): number {
  return db.prepare('DELETE FROM tx_tags WHERE tag = ?').run(required(tag)).changes;
}
