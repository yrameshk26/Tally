/**
 * SnapTrade — brokerages (Wealthsimple, Questrade, Coinbase). Read-only.
 *
 * ONLY these endpoints are ever called: /authorizations, /accounts,
 * /accounts/{id}/holdings, /accounts/{id}/activities and (optionally)
 * /accounts/{id}/balanceHistory. Order endpoints are deliberately absent and
 * must stay that way.
 *
 * Personal API keys identify the user by the key itself, so `userId` and
 * `userSecret` are not sent. The TypeScript SDK marks both as required, which
 * is why the default transport here is a small signed fetch client rather than
 * the SDK: it lets us omit the fields entirely instead of sending empty
 * strings. Set SNAPTRADE_TRANSPORT=sdk to go back through the SDK (needed for
 * a Commercial key, where the two fields are real).
 * See https://docs.snaptrade.com/docs/personal-vs-commercial
 */
import { createHmac } from 'node:crypto';
import type { DB } from '../db.ts';
import { config, snaptradeConfigured } from '../config.ts';
import { errMessage, log } from '../lib/logger.ts';
import { ccy, num, round2 } from '../lib/money.ts';
import { guessRegistered, type RegisteredType } from '../lib/registered.ts';
import {
  deactivateMissing,
  replaceHoldings,
  upsertAccount,
  upsertActivities,
  type ActivityRow,
  type HoldingRow,
} from '../store.ts';
import type { RateMap } from '../fx.ts';
import { makeConverter } from '../fx.ts';

/** Stable JSON with sorted keys — SnapTrade signs this exact byte sequence. */
function stringifyOrdered(obj: unknown): string {
  const keys: string[] = [];
  const seen = new Set<string>();
  JSON.stringify(obj, (k, v) => {
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
    return v;
  });
  keys.sort();
  return JSON.stringify(obj, keys);
}

export function signRequest(
  consumerKey: string,
  path: string,
  query: string,
  content: unknown = null,
): string {
  const sigContent = stringifyOrdered({ content, path, query });
  return createHmac('sha256', encodeURI(consumerKey)).update(sigContent).digest('base64');
}

/** Signed GET against the SnapTrade REST API. */
export async function snaptradeGet<T>(
  path: string,
  extraQuery: Record<string, string> = {},
): Promise<T> {
  const { clientId, consumerKey, userId, userSecret, baseUrl, transport } = config.snaptrade;
  const params = new URLSearchParams();
  params.set('clientId', clientId);
  params.set('timestamp', String(Math.floor(Date.now() / 1000)));
  // Personal keys: omit entirely. Commercial keys (transport=sdk) need them.
  if (transport === 'sdk' || userId) {
    if (userId) params.set('userId', userId);
    if (userSecret) params.set('userSecret', userSecret);
  }
  for (const [k, v] of Object.entries(extraQuery)) params.set(k, v);

  const query = params.toString();
  const url = `${baseUrl}${path}?${query}`;
  const signature = signRequest(consumerKey, `/api/v1${path}`, query, null);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      Signature: signature,
      'User-Agent': 'tally-finmcp/0.1',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SnapTrade ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// --- shapes we actually read (SnapTrade returns a lot more) -----------------

type StCurrency = { code?: string } | null | undefined;

export type StAccount = {
  id: string;
  brokerage_authorization?: string;
  name?: string | null;
  number?: string | null;
  institution_name?: string | null;
  status?: string | null;
  raw_type?: string | null;
  meta?: Record<string, unknown> | null;
  balance?: { total?: { amount?: number | null; currency?: string | null } | null } | null;
};

export type StPosition = {
  symbol?: {
    symbol?: {
      symbol?: string | null;
      description?: string | null;
      currency?: StCurrency;
      type?: { code?: string | null; description?: string | null } | null;
    } | null;
    option_symbol?: { ticker?: string | null; option_type?: string | null } | null;
  } | null;
  units?: number | null;
  price?: number | null;
  currency?: StCurrency;
  average_purchase_price?: number | null;
  open_pnl?: number | null;
};

export type StBalance = { currency?: StCurrency; cash?: number | null };

export type StHoldings = {
  account?: StAccount;
  balances?: StBalance[] | null;
  positions?: StPosition[] | null;
  option_positions?: StPosition[] | null;
  total_value?: { value?: number | null; currency?: string | null } | null;
};

export type StAuthorization = {
  id: string;
  name?: string | null;
  disabled?: boolean | null;
  brokerage?: { name?: string | null; slug?: string | null } | null;
};

// --- classification ---------------------------------------------------------

const CARD_RE = /credit\s*card|\bvisa\b|\bmastercard\b|\bamex\b|line\s+of\s+credit|\bloc\b/i;
const LOAN_RE = /\bloan\b|\bmortgage\b/i;
const CRYPTO_RE = /crypto|coinbase|\bbtc\b|\beth\b/i;

export function classifyAccount(a: StAccount): string {
  // Separators flattened for the same reason as in guessRegistered(): SnapTrade
  // raw types look like `CREDIT_CARD`, which \s* alone would not match.
  const hay = [a.name, a.raw_type, a.institution_name, JSON.stringify(a.meta ?? {})]
    .filter(Boolean)
    .join(' ')
    .replace(/[_\-/.,]+/g, ' ');
  if (CARD_RE.test(hay)) return 'LOC';
  if (LOAN_RE.test(hay)) return 'LOAN';
  if (CRYPTO_RE.test(hay)) return 'CRYPTO';
  return 'INVESTMENT';
}

/** Closed and archived accounts must not appear in net worth. */
export function isLiveAccount(a: StAccount): boolean {
  const status = (a.status ?? 'open').toLowerCase();
  return status !== 'closed' && status !== 'archived' && status !== 'deleted';
}

export function registeredFor(a: StAccount): RegisteredType {
  const metaType =
    a.meta && typeof a.meta === 'object'
      ? [a.meta['type'], a.meta['account_type'], a.meta['nickname']].filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
  return guessRegistered(a.name, a.raw_type, ...metaType);
}

export type SnapTradeReport = {
  skipped?: true;
  reason?: string;
  authorizations?: number;
  accounts?: number;
  excluded_closed?: number;
  cards_deactivated?: number;
  holdings?: number;
  deactivated?: number;
  by_registered_type?: Record<string, number>;
  total_cad?: number;
  balance_history_days?: number;
  activities?: number;
  fx_misses?: string[];
  error?: string;
};

export async function syncSnapTrade(db: DB, rates: RateMap): Promise<SnapTradeReport> {
  if (!snaptradeConfigured()) {
    return { skipped: true, reason: 'SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY not set' };
  }

  const fx = makeConverter(rates);
  const report: SnapTradeReport = {
    authorizations: 0,
    accounts: 0,
    excluded_closed: 0,
    cards_deactivated: 0,
    holdings: 0,
    by_registered_type: {},
    total_cad: 0,
  };

  const auths = await snaptradeGet<StAuthorization[]>('/authorizations').catch((e) => {
    log.warn(`snaptrade: /authorizations failed (${errMessage(e)})`);
    return [] as StAuthorization[];
  });
  report.authorizations = auths.length;

  const accounts = await snaptradeGet<StAccount[]>('/accounts');
  const seen: string[] = [];

  for (const acct of accounts) {
    const live = isLiveAccount(acct);
    if (!live) {
      report.excluded_closed = (report.excluded_closed ?? 0) + 1;
    }

    const id = `snaptrade:${acct.id}`;
    const category = classifyAccount(acct);
    const currency = ccy(acct.balance?.total?.currency, config.baseCurrency);
    const rawBalance = num(acct.balance?.total?.amount);
    // Liabilities are negative. SnapTrade reports card balances as a positive
    // amount owed (usually 0 for the Chase cards), so flip the sign here.
    const isLiability = category === 'LOC' || category === 'LOAN';
    const balance = isLiability ? -Math.abs(rawBalance) : rawBalance;

    // Chase cards arrive here with $0 balances; Plaid owns cards.
    const suppressedCard = isLiability && category === 'LOC' && config.snaptrade.excludeCards;
    if (suppressedCard) report.cards_deactivated = (report.cards_deactivated ?? 0) + 1;

    const active = live && !suppressedCard;
    const registered = registeredFor(acct);
    const balanceCad = fx.toBase(balance, currency);

    upsertAccount(db, {
      id,
      source: 'snaptrade',
      institution: acct.institution_name ?? auths.find((a) => a.id === acct.brokerage_authorization)?.brokerage?.name ?? null,
      name: acct.name ?? null,
      mask: acct.number ? String(acct.number).slice(-4) : null,
      account_category: category,
      account_subtype: acct.raw_type ?? null,
      registered_type: registered,
      currency,
      balance,
      balance_cad: balanceCad,
      available: null,
      active,
      status: acct.status ?? null,
      item_id: acct.brokerage_authorization ?? null,
    });
    if (active) {
      seen.push(id);
      report.accounts = (report.accounts ?? 0) + 1;
      report.total_cad = round2((report.total_cad ?? 0) + balanceCad);
      const bucket = report.by_registered_type ?? {};
      bucket[registered] = round2((bucket[registered] ?? 0) + balanceCad);
      report.by_registered_type = bucket;
    }

    if (!active) continue;

    try {
      const holdings = await snaptradeGet<StHoldings>(`/accounts/${acct.id}/holdings`);
      const rows = mapHoldings(id, holdings, currency, fx);
      replaceHoldings(db, id, rows);
      report.holdings = (report.holdings ?? 0) + rows.length;
    } catch (e) {
      log.warn(`snaptrade: holdings for ${acct.name ?? acct.id} failed (${errMessage(e)})`);
    }

    try {
      const acts = await fetchActivities(db, acct.id, id, currency, fx);
      report.activities = (report.activities ?? 0) + acts;
    } catch (e) {
      log.warn(`snaptrade: activities for ${acct.name ?? acct.id} failed (${errMessage(e)})`);
    }
  }

  report.deactivated = deactivateMissing(db, 'snaptrade', seen);

  if (config.snaptrade.balanceHistory) {
    report.balance_history_days = await importBalanceHistory(db, accounts.filter(isLiveAccount), fx);
  }

  const misses = fx.misses();
  if (misses.length) report.fx_misses = misses;
  return report;
}

export function mapHoldings(
  accountId: string,
  h: StHoldings,
  accountCurrency: string,
  fx: { toBase: (amount: number, from: string) => number },
): HoldingRow[] {
  const rows: HoldingRow[] = [];

  for (const b of h.balances ?? []) {
    const cash = num(b.cash);
    if (cash === 0) continue;
    const cur = ccy(b.currency?.code, accountCurrency);
    rows.push({
      account_id: accountId,
      symbol: `CASH.${cur}`,
      description: `Cash (${cur})`,
      asset_type: 'cash',
      quantity: cash,
      price: 1,
      currency: cur,
      market_value: cash,
      market_value_cad: fx.toBase(cash, cur),
      cost_basis: cash,
      cost_basis_cad: fx.toBase(cash, cur),
    });
  }

  const push = (p: StPosition, multiplier: number, fallbackType: string): void => {
    const sym = p.symbol?.symbol;
    const ticker = sym?.symbol ?? p.symbol?.option_symbol?.ticker ?? null;
    const units = num(p.units);
    const price = num(p.price);
    const cur = ccy(p.currency?.code ?? sym?.currency?.code, accountCurrency);
    const mv = units * price * multiplier;
    const avg = p.average_purchase_price;
    const cost = avg === null || avg === undefined ? null : num(avg) * units * multiplier;
    rows.push({
      account_id: accountId,
      symbol: ticker,
      description: sym?.description ?? null,
      asset_type: sym?.type?.code ?? fallbackType,
      quantity: units,
      price,
      currency: cur,
      market_value: mv,
      market_value_cad: fx.toBase(mv, cur),
      cost_basis: cost,
      cost_basis_cad: cost === null ? null : fx.toBase(cost, cur),
    });
  };

  for (const p of h.positions ?? []) push(p, 1, 'security');
  // An option contract covers 100 shares and SnapTrade prices it per share.
  for (const p of h.option_positions ?? []) push(p, 100, 'option');

  return rows;
}

type StBalanceHistoryPoint = {
  date?: string | null;
  balance?: { amount?: number | null; currency?: string | null } | null;
};

/**
 * Experimental SnapTrade endpoint (1 year lookback, must be enabled as a
 * dashboard add-on). Imported with origin='snaptrade' so it never collides
 * with the daily snapshots this server writes itself.
 */
export async function importBalanceHistory(
  db: DB,
  accounts: StAccount[],
  fx: { toBase: (amount: number, from: string) => number },
): Promise<number> {
  const byDate = new Map<string, number>();
  for (const acct of accounts) {
    try {
      const points = await snaptradeGet<StBalanceHistoryPoint[]>(
        `/accounts/${acct.id}/balanceHistory`,
      );
      for (const p of points ?? []) {
        const day = (p.date ?? '').slice(0, 10);
        if (!day) continue;
        const amount = fx.toBase(num(p.balance?.amount), ccy(p.balance?.currency, config.baseCurrency));
        byDate.set(day, round2((byDate.get(day) ?? 0) + amount));
      }
    } catch (e) {
      log.warn(`snaptrade: balanceHistory for ${acct.id} unavailable (${errMessage(e)})`);
      return 0;
    }
  }
  if (byDate.size === 0) return 0;

  const stmt = db.prepare(
    `INSERT INTO snapshots (ts, total_assets_cad, total_liabilities_cad, net_worth_cad, by_owner, by_registered_type, origin)
     VALUES (?, ?, 0, ?, NULL, NULL, 'snaptrade')
     ON CONFLICT(substr(ts,1,10), origin) DO UPDATE SET
       total_assets_cad = excluded.total_assets_cad,
       net_worth_cad    = excluded.net_worth_cad`,
  );
  db.transaction(() => {
    for (const [day, total] of byDate) stmt.run(`${day}T00:00:00.000Z`, total, total);
  })();
  return byDate.size;
}

type StActivity = {
  id?: string | null;
  trade_date?: string | null;
  settlement_date?: string | null;
  type?: string | null;
  description?: string | null;
  amount?: number | null;
  currency?: StCurrency;
  symbol?: { symbol?: string | null } | null;
};

/**
 * Pull activity back to the start of last year. We only need contributions and
 * deposits for the room tracker, but storing the rest costs nothing and lets
 * Claude answer "what dividends did I get" without another API.
 */
export async function fetchActivities(
  db: DB,
  snaptradeAccountId: string,
  accountId: string,
  accountCurrency: string,
  fx: { toBase: (amount: number, from: string) => number },
): Promise<number> {
  const startDate = `${new Date().getUTCFullYear() - 1}-01-01`;
  const endDate = new Date().toISOString().slice(0, 10);
  const rows: ActivityRow[] = [];
  const limit = 250;

  for (let offset = 0; offset < 5000; offset += limit) {
    const page = await snaptradeGet<StActivity[] | { data?: StActivity[] }>(
      `/accounts/${snaptradeAccountId}/activities`,
      { startDate, endDate, offset: String(offset), limit: String(limit) },
    );
    const items = Array.isArray(page) ? page : (page.data ?? []);
    if (items.length === 0) break;
    for (const a of items) {
      const date = (a.trade_date ?? a.settlement_date ?? '').slice(0, 10);
      if (!date) continue;
      const cur = ccy(a.currency?.code, accountCurrency);
      const amount = num(a.amount);
      rows.push({
        id: `snaptrade:act:${a.id ?? `${snaptradeAccountId}:${date}:${a.type ?? ''}:${amount}`}`,
        account_id: accountId,
        date,
        type: (a.type ?? null) && String(a.type).toUpperCase(),
        description: a.description ?? null,
        symbol: a.symbol?.symbol ?? null,
        amount,
        currency: cur,
        amount_cad: fx.toBase(amount, cur),
      });
    }
    if (items.length < limit) break;
  }

  upsertActivities(db, rows);
  return rows.length;
}
