/**
 * A month or a year, summarised: net worth at either end, income, spending by
 * category and by merchant, and the largest expenses.
 *
 * The web UI prints this as a PDF and MCP returns it as JSON, both from this
 * one function, so the page and the model can never disagree about a number.
 * Income and spending come from getCashflow unchanged, which means transfers
 * and card payments are excluded here exactly as they are everywhere else.
 */
import type { DB } from './db.ts';
import { cleanTag } from './tags.ts';
import { nowISO, round2 } from './lib/money.ts';
import {
  NOT_SPENDING_CATEGORIES,
  getCashflow,
  getTransactions,
  isTransferLike,
  type CashflowResult,
} from './queries.ts';

export type ReportPeriod =
  | { kind: 'month'; month: string }
  | { kind: 'year'; year: number }
  /** Everything with one tag, over the dates it covers: a trip that crosses a month end. */
  | { kind: 'tag'; tag: string };

export type PeriodReport = {
  period: 'month' | 'year' | 'tag';
  /** "August 2026", "2026", or the tag's name. */
  label: string;
  /** Set for a tag report: only transactions with this tag are counted. */
  tag: string | null;
  start: string;
  end: string;
  /** The period has not finished yet, so its figures are partial. */
  to_date: boolean;
  profile: string | null;
  generated_at: string;
  net_worth: {
    start_cad: number | null;
    /** Date of the snapshot the start figure came from. */
    start_date: string | null;
    end_cad: number | null;
    end_date: string | null;
    change_cad: number | null;
    /** Household-wide only: snapshots do not split assets by profile. */
    end_assets_cad: number | null;
    end_liabilities_cad: number | null;
    end_by_registered_type: Record<string, number> | null;
    history: Array<{ date: string; net_worth_cad: number }>;
  };
  income_cad: number;
  spend_cad: number;
  net_cad: number;
  /** Share of income kept, or null when there was no income to keep. */
  savings_rate: number | null;
  by_month: CashflowResult['by_month'];
  by_category: Array<{ category: string; spend_cad: number; share: number }>;
  top_merchants: Array<{ merchant: string; spend_cad: number; count: number }>;
  largest_expenses: Array<{
    date: string;
    merchant: string;
    account: string | null;
    category: string | null;
    amount_cad: number;
  }>;
  transactions_counted: number;
  /** What was left out of income and spending, and how much of it. */
  /**
   * Out and in are kept apart on purpose: both sides of a transfer between two
   * of your own accounts are the same money, so adding them would double it.
   */
  excluded: { categories: string[]; count: number; out_cad: number; in_cad: number; pending: number };
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Read a period from loose input (a query string, or a model's tool call).
 * Anything unreadable falls back rather than throwing: the default is the last
 * complete month, which is the question people usually mean.
 */
export function parsePeriod(
  input: { period?: unknown; month?: unknown; year?: unknown; tag?: unknown },
  today = new Date(),
): ReportPeriod {
  if (input.period === 'tag' && typeof input.tag === 'string' && cleanTag(input.tag)) {
    return { kind: 'tag', tag: cleanTag(input.tag) };
  }
  if (input.period === 'year') {
    const y = Number(input.year);
    return { kind: 'year', year: Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : today.getUTCFullYear() };
  }
  const m = typeof input.month === 'string' ? input.month : '';
  if (MONTH_RE.test(m)) return { kind: 'month', month: m };
  // The Reports page sends the month and the year as two fields.
  const y = Number(input.year);
  if (/^(0[1-9]|1[0-2])$/.test(m) && Number.isInteger(y) && y >= 2000 && y <= 2100) {
    return { kind: 'month', month: `${String(y)}-${m}` };
  }
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return { kind: 'month', month: last.toISOString().slice(0, 7) };
}

export function periodBounds(
  p: Exclude<ReportPeriod, { kind: 'tag' }>,
  today = new Date(),
): { start: string; end: string; label: string; to_date: boolean } {
  const todayISO = today.toISOString().slice(0, 10);
  if (p.kind === 'year') {
    const start = `${String(p.year)}-01-01`;
    const end = `${String(p.year)}-12-31`;
    return { start, end, label: String(p.year), to_date: start <= todayISO && todayISO <= end };
  }
  const [y, m] = p.month.split('-').map(Number) as [number, number];
  const start = `${p.month}-01`;
  // Day 0 of the next month is the last day of this one.
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return {
    start,
    end,
    label: `${MONTH_NAMES[m - 1] ?? p.month} ${String(y)}`,
    to_date: start <= todayISO && todayISO <= end,
  };
}

type SnapshotRow = {
  date: string;
  net_worth_cad: number;
  total_assets_cad: number;
  total_liabilities_cad: number;
  by_owner: string | null;
  by_registered_type: string | null;
};

function parseMap(v: string | null): Record<string, number> | null {
  if (!v) return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : null;
  } catch {
    return null;
  }
}

/** Net worth from one snapshot row, for the household or one profile. */
function worth(row: SnapshotRow, profile: string | null): number | null {
  if (!profile) return row.net_worth_cad;
  const v = parseMap(row.by_owner)?.[profile];
  return typeof v === 'number' ? v : null;
}

const NO_NET_WORTH: PeriodReport['net_worth'] = {
  start_cad: null,
  start_date: null,
  end_cad: null,
  end_date: null,
  change_cad: null,
  end_assets_cad: null,
  end_liabilities_cad: null,
  end_by_registered_type: null,
  history: [],
};

/** A tag's window: its first to its last tagged transaction. */
function tagBounds(
  db: DB,
  tag: string,
  today: Date,
): { start: string; end: string; label: string; to_date: boolean } {
  const row = db
    .prepare(
      `SELECT MIN(t.date) AS first, MAX(t.date) AS last FROM tx_tags g
       JOIN transactions t ON t.id = g.transaction_id WHERE g.tag = ?`,
    )
    .get(tag) as { first: string | null; last: string | null };
  const todayISO = today.toISOString().slice(0, 10);
  return { start: row.first ?? todayISO, end: row.last ?? todayISO, label: tag, to_date: false };
}

const SNAPSHOT_COLUMNS = `substr(ts,1,10) AS date, net_worth_cad, total_assets_cad,
  total_liabilities_cad, by_owner, by_registered_type`;

export function buildPeriodReport(
  db: DB,
  opts: { period: ReportPeriod; profile?: string | null },
  today = new Date(),
): PeriodReport {
  const period = opts.period;
  const tag = period.kind === 'tag' ? period.tag : null;
  const { start, end, label, to_date } = period.kind === 'tag' ? tagBounds(db, period.tag, today) : periodBounds(period, today);
  const profile = opts.profile || null;
  const scope = { ...(profile ? { profile } : {}), ...(tag ? { tag } : {}) };

  const cashflow = getCashflow(db, { start, end, ...scope });

  // Net worth at the start is the last snapshot before the period began, which
  // is the closing figure of the day before. With no history that far back,
  // the first snapshot inside the period stands in, and says which day it is.
  const before = db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE substr(ts,1,10) < ? ORDER BY ts DESC LIMIT 1`)
    .get(start) as SnapshotRow | undefined;
  const firstInside = db
    .prepare(
      `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE substr(ts,1,10) BETWEEN ? AND ? ORDER BY ts ASC LIMIT 1`,
    )
    .get(start, end) as SnapshotRow | undefined;
  const last = db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE substr(ts,1,10) <= ? ORDER BY ts DESC LIMIT 1`)
    .get(end) as SnapshotRow | undefined;
  const opening = before ?? firstInside;
  // A last snapshot from before the period, when nothing was recorded during
  // it, would report a change of zero for a month nobody measured.
  const closing = last && last.date >= start ? last : undefined;

  const startWorth = opening ? worth(opening, profile) : null;
  const endWorth = closing ? worth(closing, profile) : null;

  const history = (
    db
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE substr(ts,1,10) BETWEEN ? AND ? ORDER BY ts ASC`,
      )
      .all(start, end) as SnapshotRow[]
  )
    // Several origins can write the same day; the latest one wins.
    .reduce<Map<string, SnapshotRow>>((m, r) => m.set(r.date, r), new Map())
    .values();

  // The ledger for the period, for counts, the excluded total and the largest
  // expenses. Same corrections, same exclusions, same pending rule as cashflow.
  const rows = getTransactions(db, { start, end, ...scope, limit: 50_000 });
  const settled = rows.filter((t) => !t.pending);
  const counted = settled.filter((t) => !isTransferLike(t.category));
  const excluded = settled.filter((t) => isTransferLike(t.category));

  const spend = cashflow.spend_cad;
  // A tag is a slice of spending, not of the household: net worth at the
  // start and end of a trip would describe everything else as well.
  const worthShown = !tag;
  return {
    period: period.kind,
    label,
    tag,
    start,
    end,
    to_date,
    profile,
    generated_at: nowISO(today),
    net_worth: worthShown
      ? {
      start_cad: startWorth,
      start_date: opening?.date ?? null,
      end_cad: endWorth,
      end_date: closing?.date ?? null,
      change_cad: startWorth !== null && endWorth !== null ? round2(endWorth - startWorth) : null,
      end_assets_cad: !profile && closing ? closing.total_assets_cad : null,
      end_liabilities_cad: !profile && closing ? closing.total_liabilities_cad : null,
      end_by_registered_type: !profile && closing ? parseMap(closing.by_registered_type) : null,
      // The opening snapshot leads the series, so the chart's own start-to-end
      // delta is the Change figure above it rather than a second, smaller one.
      history: [...(before ? [before] : []), ...history]
        .map((r) => ({ date: r.date, net_worth_cad: worth(r, profile) }))
        .filter((p): p is { date: string; net_worth_cad: number } => p.net_worth_cad !== null),
    }
      : NO_NET_WORTH,
    income_cad: cashflow.income_cad,
    spend_cad: spend,
    net_cad: cashflow.net_cad,
    savings_rate: cashflow.income_cad > 0 ? round2(cashflow.net_cad / cashflow.income_cad) : null,
    by_month: cashflow.by_month,
    by_category: cashflow.by_category.map((c) => ({
      ...c,
      share: spend > 0 ? round2(c.spend_cad / spend) : 0,
    })),
    top_merchants: cashflow.top_merchants.slice(0, 10),
    largest_expenses: counted
      .filter((t) => t.amount_cad < 0)
      .sort((a, b) => a.amount_cad - b.amount_cad)
      .slice(0, 10)
      .map((t) => ({
        date: t.date,
        merchant: t.merchant ?? t.name ?? 'unknown',
        account: t.account,
        category: t.category,
        amount_cad: t.amount_cad,
      })),
    transactions_counted: counted.length,
    excluded: {
      categories: [...NOT_SPENDING_CATEGORIES],
      count: excluded.length,
      out_cad: round2(excluded.filter((t) => t.amount_cad < 0).reduce((s, t) => s - t.amount_cad, 0)),
      in_cad: round2(excluded.filter((t) => t.amount_cad > 0).reduce((s, t) => s + t.amount_cad, 0)),
      pending: rows.length - settled.length,
    },
  };
}
