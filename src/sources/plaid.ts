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
import { DEFAULT_PROFILE_ID } from '../profiles.ts';
import { plaidCreds, plaidReady } from '../credentials.ts';
import { statementWindow, statementsEnabled } from './statements.ts';
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
  /** JSON array of the products this institution offers; null = not looked up. */
  institution_products: string | null;
  last_synced_at: string | null;
  profile_id: string;
};

// One client per profile: two profiles are two different Plaid teams, and
// sharing a client between them would link a bank to the wrong allowance.
const clients = new Map<string, { key: string; api: PlaidApi }>();

/**
 * Cached per credential set: rotating the secret in the UI must take effect
 * immediately, so the cache key is the credentials themselves rather than a
 * bare "already built" flag.
 */
export function plaidClient(db: DB, profileId = DEFAULT_PROFILE_ID): PlaidApi {
  const creds = plaidCreds(db, profileId);
  // Cached on the credentials themselves so rotating a secret in the UI takes
  // effect immediately rather than on the next restart.
  const key = `${creds.env}:${creds.clientId}:${creds.secret.length}:${creds.secret.slice(-4)}`;
  const cached = clients.get(profileId);
  if (cached && cached.key === key) return cached.api;
  const basePath = PlaidEnvironments[creds.env] ?? PlaidEnvironments['production'];
  const api = new PlaidApi(
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
  clients.set(profileId, { key, api });
  return api;
}

export function plaidProducts(): Products[] {
  return config.plaid.products.map((p) => p as Products);
}

export function plaidOptionalProducts(): Products[] {
  // Never overlap with `products` or `additional_consented_products` — Plaid
  // rejects the request if any of the three lists share an entry.
  const required = new Set(config.plaid.products);
  return config.plaid.optionalProducts
    .filter((p) => !required.has(p) && !CONSENT_ONLY.has(p))
    .map((p) => p as Products);
}

/**
 * Products we collect consent for but never initialise at link time.
 *
 * Statements is the case: naming it in `products` narrows Link to institutions
 * that support it, and naming it in `optional_products` initialises (and bills)
 * it on every Item. `additional_consented_products` collects the consent,
 * leaves institutions that lack it visible, and costs nothing until a
 * statements endpoint is actually called.
 */
const CONSENT_ONLY = new Set(['statements']);

export function plaidConsentProducts(): Products[] {
  const required = new Set(config.plaid.products);
  return [...config.plaid.products, ...config.plaid.optionalProducts]
    .filter((p) => CONSENT_ONLY.has(p) && !required.has(p))
    .map((p) => p as Products);
}

export function plaidCountryCodes(): CountryCode[] {
  return config.plaid.countryCodes.map((c) => {
    const key = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
    return (CountryCode as Record<string, CountryCode>)[key] ?? (c as CountryCode);
  });
}

/**
 * Plaid's Trial plan caps linked Items **per team**, and a profile is its own
 * team — its own client_id and secret. So the budget is per profile, never a
 * household pool: two profiles each holding an Amex connection are two teams
 * with one Item each, not a duplicate.
 */
export const PLAID_ITEM_CAP = 10;

export function listItems(db: DB, profileId?: string): PlaidItemRow[] {
  return (
    profileId === undefined
      ? db.prepare('SELECT * FROM plaid_items ORDER BY institution_name').all()
      : db
          .prepare('SELECT * FROM plaid_items WHERE profile_id = ? ORDER BY institution_name')
          .all(profileId)
  ) as PlaidItemRow[];
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
  profileId = DEFAULT_PROFILE_ID,
): void {
  const ts = nowISO();
  db.prepare(
    `INSERT INTO plaid_items (item_id, institution_id, institution_name, access_token, status, profile_id, created_at, updated_at)
     VALUES (@item_id, @institution_id, @institution_name, @access_token, 'ok', @profile_id, @ts, @ts)
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
    profile_id: profileId,
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

type PlaidErrorBody = {
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
  error_type?: string;
};

/**
 * A message worth showing a human.
 *
 * Axios reports every Plaid rejection as "Request failed with status code 400",
 * which says nothing — the actual cause is in the response body. This pulls it
 * out and, for the handful of misconfigurations that actually happen during
 * setup, says what to do about it.
 */
export function plaidErrorDetail(e: unknown): string {
  const body = (e as { response?: { data?: PlaidErrorBody } })?.response?.data;
  if (!body?.error_code) {
    return e instanceof Error ? e.message : String(e);
  }
  const base = `${body.error_code}: ${body.display_message ?? body.error_message ?? ''}`.trim();
  const hint = HINTS[body.error_code] ?? contextualHint(base);
  return hint ? `${base} — ${hint}` : base;
}

/**
 * Some codes, INVALID_FIELD above all, cover unrelated failures. Reading the
 * message is the only way to pick a hint that points at the right fix.
 */
function contextualHint(message: string): string | undefined {
  const m = message.toLowerCase();
  if (m.includes('redirect')) {
    return 'add the exact redirect URI shown below to Plaid dashboard → Developers → API → Allowed redirect URIs, then try again';
  }
  if (m.includes('not supported by')) {
    return 'this institution does not offer that product, so no amount of re-consenting will help — it is a limit of the bank, not your setup';
  }
  return undefined;
}

const HINTS: Record<string, string> = {
  INVALID_API_KEYS:
    'check PLAID_CLIENT_ID and PLAID_SECRET under Settings, and that the secret matches PLAID_ENV (a Sandbox secret will not work against production)',
  // INVALID_FIELD covers everything from a bad redirect URI to an unsupported
  // product, so its hint is chosen from the message in plaidErrorDetail rather
  // than stated here — a redirect-URI instruction on a product error sends the
  // reader to the wrong dashboard page.
  INVALID_PRODUCT:
    'your Plaid account does not have this product enabled — remove it from PLAID_PRODUCTS, or request access in the dashboard',
  PRODUCTS_NOT_SUPPORTED:
    'the selected institution does not support a required product; move it to PLAID_OPTIONAL_PRODUCTS',
  INVALID_INPUT: 'check the client ID, secret and environment under Settings',
  ITEM_LOGIN_REQUIRED: 'this Item needs re-authentication — use Repair',
  ADDITIONAL_CONSENT_REQUIRED:
    'the product set changed since this Item was linked; use Repair to re-consent',
};

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

export async function syncPlaid(
  db: DB,
  rates: RateMap,
  profileId = DEFAULT_PROFILE_ID,
): Promise<PlaidReport> {
  if (!plaidReady(db, profileId)) {
    return { skipped: true, reason: 'PLAID_CLIENT_ID / PLAID_SECRET not set' };
  }
  const items = listItems(db, profileId);
  if (items.length === 0) return { items: 0, note: 'no Items linked yet — run `npm run link`' };

  const fx = makeConverter(rates);
  const api = plaidClient(db, profileId);
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
        upsertAccount(
          db,
          {
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
          credit_limit: acct.balances?.limit ?? null,
          active: true,
          status: 'ok',
            item_id: item.item_id,
          },
          profileId,
        );
        seen.push(id);
        accountCount += 1;
      }

      const tx = await syncItemTransactions(db, item, token, fx, profileId);
      txCount += tx.added + tx.modified;

      // Cheap, once a night, and it is what lets the UI stop offering an action
      // the bank cannot perform.
      await refreshInstitutionProducts(db, item);

      let liabilities: number | undefined;
      if (config.plaid.products.includes('liabilities')) {
        liabilities = await syncLiabilities(db, token, label, profileId);
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
    listItems(db, profileId)
      .filter((i) => i.status !== 'ok')
      .map((i) => i.item_id),
  );
  const keep = (db
    .prepare('SELECT id, item_id FROM accounts WHERE source = ? AND source_profile_id = ?')
    .all('plaid', profileId) as Array<{ id: string; item_id: string | null }>)
    .filter((r) => r.item_id !== null && failedItems.has(r.item_id))
    .map((r) => r.id);
  const deactivated = deactivateMissing(db, 'plaid', [...seen, ...keep], profileId);

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
  profileId: string,
): Promise<{ added: number; modified: number; removed: number }> {
  const api = plaidClient(db, profileId);
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
async function syncLiabilities(
  db: DB,
  token: string,
  label: string,
  profileId: string,
): Promise<number> {
  try {
    const res = await plaidClient(db, profileId).liabilitiesGet({ access_token: token });
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

/**
 * What the institution itself offers, cached on the Item.
 *
 * Product support is per bank, not per account: BMO (US) simply does not do
 * statements, so re-consenting it can never work. Knowing that turns "use
 * Repair to re-consent" — advice that cannot succeed — into an honest "this
 * bank does not offer it". Refreshed on each sync; a lookup failure leaves the
 * cache untouched rather than recording a wrong answer.
 */
export async function refreshInstitutionProducts(db: DB, item: PlaidItemRow): Promise<string[] | null> {
  if (!item.institution_id) return null;
  try {
    const res = await plaidClient(db, item.profile_id).institutionsGetById({
      institution_id: item.institution_id,
      country_codes: plaidCountryCodes(),
    });
    const products = (res.data.institution.products ?? []).map(String);
    db.prepare('UPDATE plaid_items SET institution_products = ?, updated_at = ? WHERE item_id = ?').run(
      JSON.stringify(products),
      nowISO(),
      item.item_id,
    );
    return products;
  } catch (e) {
    log.warn('plaid: institution lookup failed', {
      institution: item.institution_name ?? item.institution_id,
    });
    return null;
  }
}

/** Cached answer only. Null means unknown — callers must not read that as "no". */
export function institutionProducts(item: PlaidItemRow): string[] | null {
  if (!item.institution_products) return null;
  try {
    const v = JSON.parse(item.institution_products) as unknown;
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Tri-state on purpose. An unknown institution still gets the button: hiding a
 * capability we have not checked is worse than an action that might fail with a
 * clear message.
 */
export function supportsStatements(item: PlaidItemRow): boolean | null {
  const products = institutionProducts(item);
  return products === null ? null : products.includes('statements');
}

export async function createLinkToken(
  db: DB,
  redirectUri?: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<string> {
  const redirect = redirectUri ?? config.plaid.redirectUri;
  const res = await plaidClient(db, profileId).linkTokenCreate({
    user: { client_user_id: `household-${profileId}` },
    client_name: 'tally',
    products: plaidProducts(),
    ...(plaidOptionalProducts().length ? { optional_products: plaidOptionalProducts() } : {}),
    // Consent only: keeps every institution visible in Link and bills nothing
    // until a statements endpoint is called.
    ...(plaidConsentProducts().length
      ? { additional_consented_products: plaidConsentProducts() }
      : {}),
    ...(statementsEnabled() ? { statements: statementWindow() } : {}),
    country_codes: plaidCountryCodes(),
    language: 'en',
    ...(redirect ? { redirect_uri: redirect } : {}),
  });
  return res.data.link_token;
}

/**
 * Update-mode token: re-authenticates an existing Item without re-linking.
 *
 * With `consent`, it also asks for consent to the products enabled since the
 * Item was linked — Plaid fixes the consented set at link time, so turning on
 * Statements does nothing for banks already connected until each re-consents.
 *
 * The two are deliberately separate calls. Folding consent into every repair
 * meant one rejected configuration took re-authentication down with it, and a
 * bank with a broken login must be fixable whatever else is misconfigured.
 */
export async function createUpdateLinkToken(
  db: DB,
  itemId: string,
  redirectUri?: string,
  profileId = DEFAULT_PROFILE_ID,
  opts: { consent?: boolean } = {},
): Promise<string> {
  const item = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId) as
    | PlaidItemRow
    | undefined;
  if (!item) throw new Error(`unknown Plaid item_id ${itemId}`);
  const res = await plaidClient(db, item.profile_id ?? profileId).linkTokenCreate({
    user: { client_user_id: `household-${item.profile_id ?? profileId}` },
    client_name: 'tally',
    country_codes: plaidCountryCodes(),
    language: 'en',
    access_token: accessTokenFor(item),
    // Only when the caller asked for it. A plain repair must stay plain: naming
    // products in update mode is what made Link fail with an opaque "internal
    // error", and a bank whose login is broken has to be fixable regardless of
    // whether the consent flow works.
    ...(opts.consent && plaidConsentProducts().length
      ? { additional_consented_products: plaidConsentProducts() }
      : {}),
    ...((redirectUri ?? config.plaid.redirectUri) ? { redirect_uri: redirectUri ?? config.plaid.redirectUri } : {}),
  });
  return res.data.link_token;
}

export async function exchangePublicToken(
  db: DB,
  publicToken: string,
  profileId = DEFAULT_PROFILE_ID,
): Promise<{ item_id: string; institution_name: string | null }> {
  const api = plaidClient(db, profileId);
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

  saveItem(
    db,
    {
      item_id: itemId,
      access_token: accessToken,
      institution_id: institutionId,
      institution_name: institutionName,
    },
    profileId,
  );
  return { item_id: itemId, institution_name: institutionName };
}

/**
 * Pull one Item's accounts immediately after linking.
 *
 * Without this a freshly linked bank shows zero accounts and no balance until
 * the next sync, which reads as a broken connection rather than a pending one.
 * Balances only — transactions can wait for the nightly run.
 */
export async function syncNewItem(
  db: DB,
  itemId: string,
  rates: RateMap,
  profileId = DEFAULT_PROFILE_ID,
): Promise<number> {
  const item = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId) as
    | PlaidItemRow
    | undefined;
  if (!item) return 0;
  const fx = makeConverter(rates);
  const res = await plaidClient(db, profileId).accountsBalanceGet({
    access_token: accessTokenFor(item),
  });
  for (const acct of res.data.accounts) {
    const currency = ccy(
      acct.balances?.iso_currency_code ?? acct.balances?.unofficial_currency_code,
      config.baseCurrency,
    );
    const balance = normalizeBalance(acct);
    upsertAccount(
      db,
      {
        id: `plaid:${acct.account_id}`,
        source: 'plaid',
        institution: item.institution_name,
        name: acct.name ?? acct.official_name ?? null,
        mask: acct.mask ?? null,
        account_category: categoryFor(acct),
        account_subtype: acct.subtype ? String(acct.subtype) : null,
        registered_type: guessRegistered(acct.name, acct.official_name, String(acct.subtype ?? '')),
        currency,
        balance,
        balance_cad: fx.toBase(balance, currency),
        available: acct.balances?.available ?? null,
        active: true,
        status: 'ok',
        item_id: item.item_id,
      },
      profileId,
    );
  }
  db.prepare('UPDATE plaid_items SET last_synced_at = ?, updated_at = ? WHERE item_id = ?').run(
    nowISO(),
    nowISO(),
    itemId,
  );
  return res.data.accounts.length;
}

/**
 * Healthy Items that have never been read.
 *
 * An Item in this state shows zero accounts and no balance, which is
 * indistinguishable from a broken connection. It should only ever exist for the
 * seconds between linking and the initial fetch — anything still here later
 * means that fetch failed, or the row predates it being done at link time.
 * Items awaiting repair are excluded: they cannot sync until re-authenticated.
 */
export function unsyncedItems(db: DB): PlaidItemRow[] {
  return db
    .prepare("SELECT * FROM plaid_items WHERE last_synced_at IS NULL AND status = 'ok'")
    .all() as PlaidItemRow[];
}

/** Best-effort catch-up for the above. Never throws; reports what it managed. */
export async function syncUnsyncedItems(
  db: DB,
  rates: RateMap,
): Promise<{ attempted: number; recovered: number }> {
  const pending = unsyncedItems(db);
  let recovered = 0;
  for (const item of pending) {
    try {
      await syncNewItem(db, item.item_id, rates, item.profile_id);
      recovered += 1;
    } catch (e) {
      log.warn(`catch-up sync failed for ${item.institution_name ?? item.item_id}`, {
        error: errMessage(e),
      });
    }
  }
  if (pending.length) {
    log.info(`catch-up sync: ${recovered}/${pending.length} previously unread Item(s)`);
  }
  return { attempted: pending.length, recovered };
}

/** Items used against the per-profile cap, so "9 of 10" is never read as "12 of 10". */
export function plaidUsage(
  db: DB,
  profileId?: string,
): Array<{ profile: string; items: number; cap: number; remaining: number; needs_attention: number }> {
  const rows = listItems(db, profileId);
  const byProfile = new Map<string, { items: number; needs_attention: number }>();
  for (const i of rows) {
    const v = byProfile.get(i.profile_id) ?? { items: 0, needs_attention: 0 };
    v.items += 1;
    if (i.status !== 'ok') v.needs_attention += 1;
    byProfile.set(i.profile_id, v);
  }
  return [...byProfile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, v]) => ({
      profile,
      items: v.items,
      cap: PLAID_ITEM_CAP,
      remaining: Math.max(0, PLAID_ITEM_CAP - v.items),
      needs_attention: v.needs_attention,
    }));
}

export function plaidStatus(db: DB, profileId?: string): Array<Record<string, unknown>> {
  return listItems(db, profileId).map((i) => ({
    item_id: i.item_id,
    profile_id: i.profile_id,
    institution: i.institution_name ?? i.institution_id ?? 'unknown',
    status: i.status,
    error_code: i.error_code,
    last_synced_at: i.last_synced_at,
    supports_statements: supportsStatements(i),
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

/**
 * Disconnect a bank.
 *
 * `/item/remove` at Plaid is the part that matters: it invalidates the access
 * token and ends the billing subscription for that Item. Deleting only our own
 * row would leave a live, billed connection at Plaid that we can no longer see.
 *
 * Accounts are deactivated rather than deleted, matching how a closed account
 * is handled everywhere else — they leave net worth but their transaction
 * history survives. `purge` deletes the rows outright for a connection linked
 * by mistake.
 */
export async function removeItem(
  db: DB,
  itemId: string,
  opts: { purge?: boolean } = {},
): Promise<{ removed: boolean; accounts: number; plaid: string }> {
  const item = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId) as
    | PlaidItemRow
    | undefined;
  if (!item) throw new Error(`unknown Plaid item_id ${itemId}`);

  let plaidResult = 'removed at Plaid';
  try {
    await plaidClient(db, item.profile_id).itemRemove({ access_token: accessTokenFor(item) });
  } catch (e) {
    const code = plaidErrorCode(e);
    // Already gone at Plaid — nothing to bill, safe to clean up locally.
    if (code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN') {
      plaidResult = `already absent at Plaid (${code})`;
    } else {
      // Anything else and we stop: deleting our row would orphan a live,
      // billed Item that we could no longer reach.
      throw new Error(
        `Plaid refused to remove this Item, so it was left in place: ${plaidErrorDetail(e)}`,
      );
    }
  }

  const ids = (
    db.prepare('SELECT id FROM accounts WHERE item_id = ?').all(itemId) as Array<{ id: string }>
  ).map((r) => r.id);

  db.transaction(() => {
    if (opts.purge) {
      const delTx = db.prepare('DELETE FROM transactions WHERE account_id = ?');
      const delAcct = db.prepare('DELETE FROM accounts WHERE id = ?');
      const delCard = db.prepare('DELETE FROM card_details WHERE account_id = ?');
      for (const id of ids) {
        delTx.run(id);
        delCard.run(id);
        delAcct.run(id);
      }
    } else {
      const deactivate = db.prepare(
        "UPDATE accounts SET active = 0, status = 'removed', updated_at = ? WHERE id = ?",
      );
      for (const id of ids) deactivate.run(nowISO(), id);
    }
    db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(itemId);
  })();

  log.info(`removed Plaid item ${item.institution_name ?? itemId}`, { accounts: ids.length });
  return { removed: true, accounts: ids.length, plaid: plaidResult };
}
