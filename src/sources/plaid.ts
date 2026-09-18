/**
 * Plaid — banks and cards (US + Canada), Trial plan, 10 Items max. Read-only:
 * balances, transactions and liabilities. No auth/transfer/payment products.
 *
 * Sign conventions. Plaid reports a credit card or loan `balances.current` as a
 * positive amount owed; we store it negative so `sum(balance)` is net worth.
 * Transaction amounts are kept exactly as Plaid sends them (positive = money
 * out of the account) and negated at read time in the MCP tools.
 */
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type Transaction,
} from 'plaid';
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { plaidCreds, plaidReady } from '../credentials.ts';
import { decryptToken, encryptToken } from '../lib/crypto.ts';
import { errMessage, log } from '../lib/logger.ts';
import { ccy, nowISO, num, round2 } from '../lib/money.ts';
import { guessRegistered } from '../lib/registered.ts';
import {
  deactivateMissing,
  removeTransactions,
  setCardDetails,
  upsertAccount,
  upsertTransactions,
  type TransactionRow,
} from '../store.ts';
import { makeConverter, type RateMap } from '../fx.ts';

export type PlaidItemRow = {
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  access_token: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  cursor: string | null;
  consent_expiration: string | null;
  last_synced_at: string | null;
};

let client: PlaidApi | null = null;
let clientKey = '';

/**
 * Cached per credential set: rotating the secret in the UI must take effect
 * immediately, so the cache key is the credentials themselves rather than a
 * bare "already built" flag.
 */
export function plaidClient(db: DB): PlaidApi {
  const creds = plaidCreds(db);
  const key = `${creds.env}:${creds.clientId}:${creds.secret.length}:${creds.secret.slice(-4)}`;
  if (client && clientKey === key) return client;
  const basePath = PlaidEnvironments[creds.env] ?? PlaidEnvironments['production'];
  client = new PlaidApi(
    new Configuration({
      basePath,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': creds.clientId,
          'PLAID-SECRET': creds.secret,
        },
      },
    }),
  );
  clientKey = key;
  return client;
}

export function plaidProducts(): Products[] {
  return config.plaid.products.map((p) => p as Products);
}

export function plaidCountryCodes(): CountryCode[] {
  return config.plaid.countryCodes.map((c) => {
    const key = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
    return (CountryCode as Record<string, CountryCode>)[key] ?? (c as CountryCode);
  });
}

export function listItems(db: DB): PlaidItemRow[] {
  return db.prepare('SELECT * FROM plaid_items ORDER BY institution_name').all() as PlaidItemRow[];
}

export function accessTokenFor(item: PlaidItemRow): string {
  return decryptToken(item.access_token, config.tokenEncKey);
}

export function saveItem(
  db: DB,
  item: {
    item_id: string;
    access_token: string;
    institution_id?: string | null;
    institution_name?: string | null;
  },
): void {
  const ts = nowISO();
  db.prepare(
    `INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token, status, created_at, updated_at)
     VALUES (@item_id, @institution_id, @institution_name, @access_token, 'ok', @ts, @ts)
     ON CONFLICT(item_id) DO UPDATE SET
       institution_id   = COALESCE(excluded.institution_id, plaid_items.institution_id),
       institution_name = COALESCE(excluded.institution_name, plaid_items.institution_name),
       access_token     = excluded.access_token,
       status           = 'ok',
       error_code       = NULL,
       error_message    = NULL,
       updated_at       = excluded.updated_at`,
  ).run({
    item_id: item.item_id,
    institution_id: item.institution_id ?? null,
    institution_name: item.institution_name ?? null,
    access_token: encryptToken(item.access_token, config.tokenEncKey),
    ts,
  });
}

export function setItemStatus(
  db: DB,
  itemId: string,
  status: string,
  errorCode: string | null = null,
  errorMessage: string | null = null,
): void {
  db.prepare(
    `UPDATE plaid_items SET status = ?, error_code = ?, error_message = ?, updated_at = ?
     WHERE item_id = ?`,
  ).run(status, errorCode, errorMessage, nowISO(), itemId);
}

/** Plaid nests its real error under response.data. Pull out the code we act on. */
export function plaidErrorCode(e: unknown): string | null {
  const data = (e as { response?: { data?: { error_code?: string } } })?.response?.data;
  return data?.error_code ?? null;
}

const LIABILITY_TYPES = new Set(['credit', 'loan']);

/** Normalise a Plaid account balance to the assets-positive convention. */
export function normalizeBalance(account: AccountBase): number {
  const type = String(account.type ?? '').toLowerCase();
  const current = num(account.balances?.current, num(account.balances?.available));
  if (LIABILITY_TYPES.has(type)) return -Math.abs(current);
  return current;
}

export function categoryFor(account: AccountBase): string {
  const type = String(account.type ?? '').toLowerCase();
  if (type === 'credit') return 'LOC';
  if (type === 'loan') return 'LOAN';
  if (type === 'depository') return 'DEPOSITORY';
  if (type === 'investment' || type === 'brokerage') return 'INVESTMENT';
  return 'OTHER';
}

export type PlaidReport = Record<string, unknown> & { skipped?: true; reason?: string };

export async function syncPlaid(db: DB, rates: RateMap): Promise<PlaidReport> {
  if (!plaidReady(db)) {
    return { skipped: true, reason: 'PLAID_CLIENT_ID / PLAID_SECRET not set' };
  }
  const items = listItems(db);
  if (items.length === 0) return { items: 0, note: 'no Items linked yet — run `npm run link`' };

  const fx = makeConverter(rates);
  const api = plaidClient(db);
  const perItem: Record<string, unknown> = {};
  const seen: string[] = [];
  let accountCount = 0;
  let txCount = 0;

  for (const item of items) {
    const label = item.institution_name ?? item.item_id;
    try {
      const token = accessTokenFor(item);
      const balances = await api.accountsBalanceGet({ access_token: token });

      for (const acct of balances.data.accounts) {
        const id = `plaid:${acct.account_id}`;
        const category = categoryFor(acct);
        const currency = ccy(
          acct.balances?.iso_currency_code ?? acct.balances?.unofficial_currency_code,
          config.baseCurrency,
        );
        const balance = normalizeBalance(acct);
        upsertAccount(db, {
          id,
          source: 'plaid',
          institution: item.institution_name,
          name: acct.name ?? acct.official_name ?? null,
          mask: acct.mask ?? null,
          account_category: category,
          account_subtype: acct.subtype ? String(acct.subtype) : null,
          registered_type: guessRegistered(acct.name, acct.official_name, String(acct.subtype ?? '')),
          currency,
          balance,
          balance_cad: fx.toBase(balance, currency),
          available: acct.balances?.available ?? null,
          active: true,
          status: 'ok',
          item_id: item.item_id,
        });
        seen.push(id);
        accountCount += 1;
      }

      const tx = await syncItemTransactions(db, item, token, fx);
      txCount += tx.added + tx.modified;

      let liabilities: number | undefined;
      if (config.plaid.products.includes('liabilities')) {
        liabilities = await syncLiabilities(db, token, label);
      }

      db.prepare('UPDATE plaid_items SET last_synced_at = ?, updated_at = ? WHERE item_id = ?').run(
        nowISO(),
        nowISO(),
        item.item_id,
      );
      setItemStatus(db, item.item_id, 'ok');
      perItem[label] = {
        accounts: balances.data.accounts.length,
        ...tx,
        ...(liabilities === undefined ? {} : { liability_accounts: liabilities }),
      };
    } catch (e) {
      const code = plaidErrorCode(e);
      const status = code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
      setItemStatus(db, item.item_id, status, code, errMessage(e).slice(0, 300));
      log.warn(`plaid: ${label} -> ${status}`, { code });
      perItem[label] = { status, error_code: code };
    }
  }

  // Note: accounts under an Item that failed this run are intentionally left
  // active — a login_required Item still holds real money.
  const failedItems = new Set(
    listItems(db)
      .filter((i) => i.status !== 'ok')
      .map((i) => i.item_id),
  );
  const keep = (db.prepare('SELECT id, item_id FROM accounts WHERE source = ?').all('plaid') as
    Array<{ id: string; item_id: string | null }>)
    .filter((r) => r.item_id !== null && failedItems.has(r.item_id))
    .map((r) => r.id);
  const deactivated = deactivateMissing(db, 'plaid', [...seen, ...keep]);

  const misses = fx.misses();
  return {
    items: items.length,
    accounts: accountCount,
    transactions: txCount,
    deactivated,
    ...(misses.length ? { fx_misses: misses } : {}),
    detail: perItem,
  };
}

async function syncItemTransactions(
  db: DB,
  item: PlaidItemRow,
  token: string,
  fx: { toBase: (amount: number, from: string) => number },
): Promise<{ added: number; modified: number; removed: number }> {
  const api = plaidClient(db);
  let cursor = item.cursor ?? undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await api.transactionsSync({
      access_token: token,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });
    const d = res.data;
    upsertTransactions(db, d.added.map((t) => mapTransaction(t, fx)));
    upsertTransactions(db, d.modified.map((t) => mapTransaction(t, fx)));
    removed += removeTransactions(
      db,
      d.removed.map((r) => `plaid:${r.transaction_id}`),
    );
    added += d.added.length;
    modified += d.modified.length;
    cursor = d.next_cursor;
    hasMore = d.has_more;
  }

  db.prepare('UPDATE plaid_items SET cursor = ?, updated_at = ? WHERE item_id = ?').run(
    cursor ?? null,
    nowISO(),
    item.item_id,
  );
  return { added, modified, removed };
}

export function mapTransaction(
  t: Transaction,
  fx: { toBase: (amount: number, from: string) => number },
): TransactionRow {
  const currency = ccy(t.iso_currency_code ?? t.unofficial_currency_code, config.baseCurrency);
  const amount = num(t.amount);
  const pf = t.personal_finance_category;
  return {
    id: `plaid:${t.transaction_id}`,
    account_id: `plaid:${t.account_id}`,
    date: (t.authorized_date ?? t.date ?? '').slice(0, 10),
    name: t.name ?? null,
    merchant: t.merchant_name ?? null,
    amount,
    currency,
    amount_cad: fx.toBase(amount, currency),
    category: pf?.primary ?? (t.category?.[0] ?? null),
    category_detailed: pf?.detailed ?? (t.category?.join(' > ') ?? null),
    pending: Boolean(t.pending),
  };
}

/** Statement balance / minimum payment / due date for credit cards. */
async function syncLiabilities(db: DB, token: string, label: string): Promise<number> {
  try {
    const res = await plaidClient(db).liabilitiesGet({ access_token: token });
    const credit = res.data.liabilities?.credit ?? [];
    for (const c of credit) {
      if (!c.account_id) continue;
      setCardDetails(db, {
        account_id: `plaid:${c.account_id}`,
        statement_balance: c.last_statement_balance ?? null,
        minimum_payment: c.minimum_payment_amount ?? null,
        due_date: c.next_payment_due_date ?? null,
        last_payment_amount: c.last_payment_amount ?? null,
        last_payment_date: c.last_payment_date ?? null,
        apr_percentage: c.aprs?.[0]?.apr_percentage ?? null,
        is_overdue: c.is_overdue ?? null,
      });
    }
    return credit.length;
  } catch (e) {
    // A Trial-plan Item without the liabilities product simply 400s here.
    log.debug(`plaid: liabilities unavailable for ${label} (${errMessage(e)})`);
    return 0;
  }
}

// --- Link helpers (used only by link-server.ts, never by the MCP server) ----

export async function createLinkToken(db: DB, redirectUri?: string): Promise<string> {
  const redirect = redirectUri ?? config.plaid.redirectUri;
  const res = await plaidClient(db).linkTokenCreate({
    user: { client_user_id: 'household' },
    client_name: 'tally',
    products: plaidProducts(),
    country_codes: plaidCountryCodes(),
    language: 'en',
    ...(redirect ? { redirect_uri: redirect } : {}),
  });
  return res.data.link_token;
}

/** Update-mode token: re-authenticates an existing Item without re-linking. */
export async function createUpdateLinkToken(
  db: DB,
  itemId: string,
  redirectUri?: string,
): Promise<string> {
  const item = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId) as
    | PlaidItemRow
    | undefined;
  if (!item) throw new Error(`unknown Plaid item_id ${itemId}`);
  const res = await plaidClient(db).linkTokenCreate({
    user: { client_user_id: 'household' },
    client_name: 'tally',
    country_codes: plaidCountryCodes(),
    language: 'en',
    access_token: accessTokenFor(item),
    ...((redirectUri ?? config.plaid.redirectUri) ? { redirect_uri: redirectUri ?? config.plaid.redirectUri } : {}),
  });
  return res.data.link_token;
}

export async function exchangePublicToken(
  db: DB,
  publicToken: string,
): Promise<{ item_id: string; institution_name: string | null }> {
  const api = plaidClient(db);
  const ex = await api.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = ex.data.access_token;
  const itemId = ex.data.item_id;

  let institutionId: string | null = null;
  let institutionName: string | null = null;
  try {
    const item = await api.itemGet({ access_token: accessToken });
    institutionId = item.data.item.institution_id ?? null;
    if (institutionId) {
      const inst = await api.institutionsGetById({
        institution_id: institutionId,
        country_codes: plaidCountryCodes(),
      });
      institutionName = inst.data.institution.name ?? null;
    }
  } catch (e) {
    log.warn(`plaid: could not resolve institution (${errMessage(e)})`);
  }

  saveItem(db, {
    item_id: itemId,
    access_token: accessToken,
    institution_id: institutionId,
    institution_name: institutionName,
  });
  return { item_id: itemId, institution_name: institutionName };
}

export function plaidStatus(db: DB): Array<Record<string, unknown>> {
  return listItems(db).map((i) => ({
    item_id: i.item_id,
    institution: i.institution_name ?? i.institution_id ?? 'unknown',
    status: i.status,
    error_code: i.error_code,
    last_synced_at: i.last_synced_at,
    accounts: (
      db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE item_id = ?').get(i.item_id) as {
        n: number;
      }
    ).n,
    balance_cad: round2(
      (
        db
          .prepare('SELECT COALESCE(SUM(balance_cad),0) AS s FROM accounts WHERE item_id = ? AND active = 1')
          .get(i.item_id) as { s: number }
      ).s,
    ),
  }));
}
