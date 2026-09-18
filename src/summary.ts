/**
 * The whole financial picture in one call.
 *
 * Claude can already assemble this from the individual tools, but that costs a
 * round trip per section and leaves it guessing at which ones exist. This module
 * composes them once, server-side, and lets the caller ask for exactly the
 * sections it wants — so "how am I doing?" is one call, and "what did I spend on
 * groceries?" is still one small one.
 *
 * Every section is a pure read of sqlite. Nothing here touches the network.
 */
import type { DB } from './db.ts';
import { config } from './config.ts';
import { round2, todayISO } from './lib/money.ts';
import {
  getActivities,
  getCashflow,
  getContributionRoom,
  getHoldings,
  getHoldingsByAccount,
  getNetWorth,
  getNetWorthHistory,
  getTransactions,
  isLiabilityAccount,
  listAccounts,
} from './queries.ts';
import { MAX_PROFILES, listProfiles, profileUsage } from './profiles.ts';
import { plaidStatus, plaidUsage } from './sources/plaid.ts';
import { lastSyncReport } from './sync.ts';

/**
 * Order matters: this is the order sections appear in the response, arranged so
 * the headline numbers come first and the long tables last.
 */
export const SUMMARY_SECTIONS = [
  'net_worth',
  'profiles',
  'accounts',
  'cards',
  'holdings',
  'holdings_by_account',
  'activities',
  'cashflow',
  'transactions',
  'history',
  'contribution_room',
  'connections',
  'fx',
  'sync',
] as const;

export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

/** What you get when `sections` is omitted: the headline picture, no raw rows. */
export const DEFAULT_SECTIONS: SummarySection[] = [
  'net_worth',
  'profiles',
  'accounts',
  'cards',
  'holdings',
  'cashflow',
  'contribution_room',
  'connections',
  'sync',
];

export type SummaryOptions = {
  sections?: readonly SummarySection[];
  profile?: string;
  start?: string;
  end?: string;
  months?: number;
  limit?: number;
  include_inactive?: boolean;
};

/** Caps on the row-level sections, so "everything" cannot return a novel. */
const LIMITS = { holdings: 100, activities: 250, transactions: 250, history: 400 };

function clamp(n: number | undefined, max: number, fallback: number): number {
  if (n === undefined) return Math.min(fallback, max);
  return Math.max(1, Math.min(n, max));
}

/** First day of the month `months` back, so ranges land on month boundaries. */
export function monthsAgoISO(months: number, from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months + 1, 1));
  return todayISO(d);
}

export type Summary = {
  generated_at: string;
  base_currency: string;
  /** The window every period-scoped section (cashflow, transactions, activities) used. */
  period: { start: string; end: string };
  profile: string | null;
  sections: SummarySection[];
  omitted_sections: SummarySection[];
  hint?: string;
} & Record<string, unknown>;

/**
 * Build the picture. Unknown sections are ignored rather than thrown, so a
 * caller asking for a section from a newer version still gets an answer.
 */
export function buildSummary(db: DB, opts: SummaryOptions = {}): Summary {
  const wanted = new Set<SummarySection>(
    (opts.sections?.length ? opts.sections : DEFAULT_SECTIONS).filter((s): s is SummarySection =>
      (SUMMARY_SECTIONS as readonly string[]).includes(s),
    ),
  );
  const want = (s: SummarySection): boolean => wanted.has(s);

  const end = opts.end ?? todayISO();
  const start = opts.start ?? monthsAgoISO(opts.months ?? 6, new Date(`${end}T00:00:00Z`));
  const profile = opts.profile ?? null;
  const scope = profile ? { profile } : {};

  const out: Summary = {
    generated_at: new Date().toISOString(),
    base_currency: config.baseCurrency,
    period: { start, end },
    profile,
    sections: SUMMARY_SECTIONS.filter(want),
    omitted_sections: SUMMARY_SECTIONS.filter((s) => !want(s)),
  };

  if (want('net_worth')) out['net_worth'] = getNetWorth(db, profile ?? undefined);

  if (want('profiles')) {
    out['profiles'] = {
      max: MAX_PROFILES,
      profiles: listProfiles(db).map((p) => ({
        id: p.id,
        name: p.name,
        usage: profileUsage(db, p.id),
      })),
    };
  }

  const accounts = want('accounts') || want('cards')
    ? listAccounts(db, { ...scope, include_inactive: opts.include_inactive })
    : [];

  if (want('accounts')) {
    out['accounts'] = {
      count: accounts.length,
      by_source: accounts.reduce<Record<string, number>>((acc, a) => {
        acc[a.source] = (acc[a.source] ?? 0) + 1;
        return acc;
      }, {}),
      accounts,
    };
  }

  if (want('cards')) {
    const cards = accounts.filter(isLiabilityAccount);
    out['cards'] = {
      count: cards.length,
      total_owing_cad: round2(cards.reduce((s, c) => s + c.balance_cad, 0)),
      total_limit: round2(cards.reduce((s, c) => s + (c.credit_limit ?? 0), 0)),
      limits_missing: cards.filter((c) => c.credit_limit == null).length,
      cards: cards.map((c) => ({
        id: c.id,
        name: c.name,
        institution: c.institution,
        mask: c.mask,
        profile: c.profile,
        balance_cad: c.balance_cad,
        available: c.available,
        credit_limit: c.credit_limit,
        utilization_pct: c.utilization_pct,
        ...(c.card ?? {}),
      })),
    };
  }

  if (want('holdings')) {
    out['holdings'] = getHoldings(db, { ...scope, limit: clamp(opts.limit, LIMITS.holdings, 50) });
  }

  if (want('holdings_by_account')) {
    out['holdings_by_account'] = getHoldingsByAccount(db, scope);
  }

  if (want('activities')) {
    out['activities'] = getActivities(db, {
      ...scope,
      start,
      end,
      limit: clamp(opts.limit, LIMITS.activities, 100),
    });
  }

  if (want('cashflow')) out['cashflow'] = getCashflow(db, { ...scope, start, end });

  if (want('transactions')) {
    const limit = clamp(opts.limit, LIMITS.transactions, 100);
    const rows = getTransactions(db, { ...scope, start, end, limit });
    out['transactions'] = {
      start,
      end,
      count: rows.length,
      truncated: rows.length === limit,
      note:
        rows.length === limit
          ? `Capped at ${limit} rows — call get_transactions with a narrower range or a higher limit for the rest.`
          : undefined,
      transactions: rows,
    };
  }

  if (want('history')) {
    out['history'] = getNetWorthHistory(db, { start, end, limit: LIMITS.history });
  }

  if (want('contribution_room')) {
    const year = new Date(`${end}T00:00:00Z`).getUTCFullYear();
    out['contribution_room'] = { year, room: getContributionRoom(db, { year }) };
  }

  if (want('connections')) {
    const items = plaidStatus(db, profile ?? undefined);
    out['connections'] = {
      plaid: {
        count: items.length,
        needs_attention: items.filter((i) => i['status'] !== 'ok').length,
        // The Trial cap is per profile — each has its own client_id and secret.
        cap_is_per_profile: true,
        by_profile: plaidUsage(db, profile ?? undefined),
        items,
      },
      sources_with_accounts: [...new Set(listAccounts(db, {}).map((a) => a.source))].sort(),
    };
  }

  if (want('fx')) {
    out['fx'] = {
      base: config.baseCurrency,
      rates: db.prepare('SELECT pair, rate, as_of FROM fx_rates ORDER BY pair').all(),
    };
  }

  if (want('sync')) {
    const report = lastSyncReport(db);
    if (!report) {
      out['sync'] = { ran: false, hint: 'No sync has completed yet — call sync_now.' };
    } else {
      const ageMs = Date.now() - Date.parse(report.finished_at);
      const known = Number.isFinite(ageMs);
      out['sync'] = {
        ran: true,
        finished_at: report.finished_at ?? null,
        // An unreadable timestamp reads as stale, never as fresh — otherwise a
        // malformed report would quietly pass hours-old numbers off as current.
        age_hours: known ? round2(ageMs / 3_600_000) : null,
        stale: !known || ageMs > 36 * 3_600_000,
        ok: report.ok,
        sources: { fx: report.fx, snaptrade: report.snaptrade, plaid: report.plaid, wise: report.wise },
      };
    }
  }

  if (out['omitted_sections'] && (out['omitted_sections'] as string[]).length) {
    out.hint =
      `Sections not included in this call: ${(out['omitted_sections'] as string[]).join(', ')}. ` +
      'Pass `sections` to choose, or `sections: ["all"]` for everything.';
  }
  return out;
}
