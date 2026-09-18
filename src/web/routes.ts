/**
 * The web UI.
 *
 * Mounted only when UI_ENABLED is true and an admin is configured, so the
 * default deployment stays a bare MCP endpoint with no login surface at all.
 *
 * Security posture, all enforced here rather than by convention:
 * every page except /login requires a session; every state-changing request
 * carries a CSRF token; failed logins are rate limited; and the response
 * carries a strict CSP whose only third-party allowance is Plaid Link, on the
 * one page that needs it.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.ts';
import type { TransactionView } from '../queries.ts';
import type { MerchantRule } from '../overrides.ts';
import { config } from '../config.ts';
import { errMessage, log } from '../lib/logger.ts';
import { html, raw } from '../lib/html.ts';
import { notice, page } from './layout.ts';
import {
  connectionsPage,
  loginPage,
  verifyPage,
  overviewPage,
  profilesPage,
  securityPage,
  settingsPage,
  transactionsPage,
  type TxFilters,
} from './pages.ts';
import {
  MAX_PROFILES,
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  moveAccount,
  profileUsage,
  renameProfile,
  type Profile,
} from '../profiles.ts';
import { safeEqual, verifyPassword } from '../auth/password.ts';
import { generateSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';
import {
  adminConfigError,
  adminPasswordHash,
  adminUsername,
  clearTotpSecret,
  getTotpSecret,
  setTotpSecret,
  totpEnabled,
} from '../auth/admin.ts';
import {
  COOKIE_NAME,
  PENDING_TTL_MS,
  SESSION_TTL_MS,
  createSession,
  promoteSession,
  destroyAllSessions,
  destroySession,
  getSession,
  listSessions,
  parseCookies,
  serializeCookie,
  type Session,
} from '../auth/session.ts';
import { describeSettings, setSetting, MANAGED_KEYS, SECRET_KEYS } from '../settings.ts';
import { plaidCreds, plaidReady, snaptradeReady, testCredentials, wiseReady } from '../credentials.ts';
import {
  getCashflow,
  getHoldings,
  getNetWorth,
  getNetWorthHistory,
  getTransactions,
  groupByCategory,
  groupByMerchant,
  knownCategories,
  listAccounts,
} from '../queries.ts';
import {
  addMerchantRule,
  deleteMerchantRule,
  listMerchantRules,
  ruleImpact,
  setAccountCurrency,
  setTransactionOverride,
} from '../overrides.ts';
import { daysAgoISO, todayISO } from '../lib/money.ts';
import {
  createLinkToken,
  PLAID_ITEM_CAP,
  createUpdateLinkToken,
  exchangePublicToken,
  listItems,
  plaidCountryCodes,
  plaidErrorDetail,
  plaidOptionalProducts,
  removeItem,
  syncNewItem,
  unsyncedItems,
  plaidProducts,
  plaidStatus,
} from '../sources/plaid.ts';
import { runSync } from '../sync.ts';
import { loadRates } from '../fx.ts';
import { createFailureLimiter } from '../ratelimit.ts';
import { safeNext } from './oauth.ts';
import { listClients, revokeClient } from '../oauth.ts';

type Ctx = Request & { session?: Session; nonce?: string };

function redirectUriFor(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
  return `${proto}://${req.get('host')}/connections/oauth`;
}

export function createWebRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));
  router.use(express.json({ limit: '64kb' }));

  // Failed sign-ins per 15 minutes, per address. Successes do not count, so a
  // legitimate user is never locked out of their own server by using it.
  const loginLimiter = createFailureLimiter(config.loginRateLimit, 15 * 60_000);

  router.use((req: Ctx, res: Response, next: NextFunction) => {
    const nonce = randomBytes(16).toString('base64');
    req.nonce = nonce;
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}' https://cdn.plaid.com`,
        "img-src 'self' data:",
        "connect-src 'self' https://*.plaid.com",
        'frame-src https://cdn.plaid.com https://*.plaid.com',
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * Which profile a page is scoped to. Falls back to the first profile rather
   * than erroring, so a stale bookmark to a deleted profile still renders.
   */
  const activeProfile = (req: Ctx): Profile => {
    const wanted = typeof req.query['profile'] === 'string' ? String(req.query['profile']) : '';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fromBody = typeof body['profile'] === 'string' ? String(body['profile']) : '';
    return (
      getProfile(db, fromBody || wanted) ?? getProfile(db, 'me') ?? listProfiles(db)[0]!
    );
  };

  /**
   * Like activeProfile(), but refuses to guess.
   *
   * Linking a bank is the one operation where falling back to the default is
   * actively harmful: it consumes the wrong profile's Plaid Item allowance and
   * attributes the accounts to the wrong person, silently. Callers that change
   * state must name the profile.
   */
  const requiredProfile = (req: Ctx): Profile => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = String(body['profile'] ?? req.query['profile'] ?? '');
    if (!id) throw new Error('profile is required');
    const profile = getProfile(db, id);
    if (!profile) throw new Error(`no such profile ${id}`);
    return profile;
  };

  const render = (req: Ctx, res: Response, title: string, body: ReturnType<typeof html>, current?: string, chrome = true): void => {
    res.type('html').send(page({ title, nonce: req.nonce ?? '', current, chrome, body }));
  };

  const sessionOf = (req: Ctx): Session | null =>
    getSession(db, parseCookies(req.headers.cookie)[COOKIE_NAME]);

  /** Every page below this requires a session. */
  const requireAuth = (req: Ctx, res: Response, next: NextFunction): void => {
    const session = sessionOf(req);
    if (!session) {
      res.redirect(303, '/login');
      return;
    }
    // A pending session proves the password only. It grants nothing until the
    // second factor is in.
    if (session.pending) {
      res.redirect(303, '/login/verify');
      return;
    }
    req.session = session;
    next();
  };

  /**
   * CSRF: a per-session token, submitted as a form field or an X-CSRF-Token
   * header. SameSite=Lax already blocks the common cross-site POST, but a
   * token is the thing that actually holds if a browser or a future route
   * relaxes that.
   */
  const requireCsrf = (req: Ctx, res: Response, next: NextFunction): void => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const given = String(body['_csrf'] ?? req.get('x-csrf-token') ?? '');
    if (!req.session || !safeEqual(given, req.session.csrf)) {
      res.status(403).type('text/plain').send('Bad or missing CSRF token. Reload and try again.');
      return;
    }
    next();
  };

  const flash = (req: Request, kind: 'ok' | 'err' | 'warn'): ReturnType<typeof raw> => {
    const msg = typeof req.query[kind] === 'string' ? String(req.query[kind]) : '';
    return msg ? notice(kind, msg) : raw('');
  };

  // --- login / logout ------------------------------------------------------

  router.get('/login', (req: Ctx, res: Response) => {
    if (sessionOf(req)) {
      res.redirect(303, '/');
      return;
    }
    // A pre-session CSRF token would need its own store; instead the login form
    // is protected by SameSite plus the rate limiter, and issues a real token
    // on success.
    render(
      req,
      res,
      'Sign in',
      loginPage({ csrf: '', totpEnabled: totpEnabled(db), next: safeNext(req.query['next']) }),
      undefined,
      false,
    );
  });

  router.post('/login', async (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = String(body['username'] ?? '');
    const password = String(body['password'] ?? '');
    const ip = req.ip ?? 'unknown';

    const next = safeNext(body['next']);
    const fail = (message: string): void => {
      render(
        req,
        res,
        'Sign in',
        loginPage({ csrf: '', totpEnabled: totpEnabled(db), error: message, username, next }),
        undefined,
        false,
      );
    };

    // Checked before the deliberately slow password verification, so a flood
    // cannot be used to pin the CPU.
    if (loginLimiter.blocked(ip)) {
      res.status(429);
      fail('Too many failed sign-in attempts. Wait a few minutes and try again.');
      return;
    }

    const userOk = safeEqual(username, adminUsername());
    const passOk = await verifyPassword(password, adminPasswordHash());
    // Both checks always run so a wrong username and a wrong password are
    // indistinguishable in timing and in the message.
    if (!userOk || !passOk) {
      loginLimiter.fail(ip);
      log.warn('failed sign-in', { ip });
      res.status(401);
      fail('Incorrect username or password.');
      return;
    }

    const meta = { userAgent: req.get('user-agent'), ip };

    // Two steps when a second factor is enrolled: the password buys only a
    // short-lived pending session, which can reach nothing but /login/verify.
    if (totpEnabled(db)) {
      const pending = createSession(db, username, meta, { pending: true });
      res.setHeader(
        'Set-Cookie',
        serializeCookie(COOKIE_NAME, pending.id, {
          maxAge: PENDING_TTL_MS,
          secure: config.cookieSecure,
        }),
      );
      res.redirect(303, next ? `/login/verify?next=${encodeURIComponent(next)}` : '/login/verify');
      return;
    }

    loginLimiter.reset(ip);
    const session = createSession(db, username, meta);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, session.id, {
        maxAge: SESSION_TTL_MS,
        secure: config.cookieSecure,
      }),
    );
    res.redirect(303, next ?? '/');
  });

  /** The half-authenticated session backing step two, or null. */
  const pendingSession = (req: Ctx): Session | null => {
    const s = sessionOf(req);
    return s && s.pending ? s : null;
  };

  router.get('/login/verify', (req: Ctx, res: Response) => {
    const pending = pendingSession(req);
    if (!pending) {
      res.redirect(303, sessionOf(req) ? '/' : '/login');
      return;
    }
    render(
      req,
      res,
      'Two-factor',
      verifyPage({ csrf: pending.csrf, username: pending.username, next: safeNext(req.query['next']) }),
      undefined,
      false,
    );
  });

  router.post('/login/verify', (req: Ctx, res: Response) => {
    const pending = pendingSession(req);
    if (!pending) {
      res.redirect(303, '/login');
      return;
    }
    const ip = req.ip ?? 'unknown';
    if (loginLimiter.blocked(ip)) {
      res.status(429);
      render(
        req,
        res,
        'Two-factor',
        verifyPage({
          csrf: pending.csrf,
          username: pending.username,
          error: 'Too many failed attempts. Wait a few minutes and try again.',
        }),
        undefined,
        false,
      );
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!safeEqual(String(body['_csrf'] ?? ''), pending.csrf)) {
      res.status(403).type('text/plain').send('Bad or missing CSRF token. Reload and try again.');
      return;
    }

    const secret = getTotpSecret(db);
    if (!secret || !verifyTotp(String(body['code'] ?? ''), secret)) {
      loginLimiter.fail(ip);
      log.warn('failed second factor', { ip });
      res.status(401);
      render(
        req,
        res,
        'Two-factor',
        verifyPage({
          csrf: pending.csrf,
          username: pending.username,
          error: 'That authenticator code is not valid.',
        }),
        undefined,
        false,
      );
      return;
    }

    const full = promoteSession(db, pending.id);
    if (!full) {
      res.redirect(303, '/login');
      return;
    }
    loginLimiter.reset(ip);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, full.id, {
        maxAge: SESSION_TTL_MS,
        secure: config.cookieSecure,
      }),
    );
    res.redirect(303, safeNext(body['next']) ?? '/');
  });

  /** Abandon a half-finished sign-in and start over. */
  router.get('/login/cancel', (req: Ctx, res: Response) => {
    const pending = pendingSession(req);
    if (pending) destroySession(db, pending.id);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, '', { expires: new Date(0), secure: config.cookieSecure }),
    );
    res.redirect(303, '/login');
  });

  router.post('/logout', (req: Ctx, res: Response) => {
    const session = sessionOf(req);
    if (session) destroySession(db, session.id);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, '', { expires: new Date(0), secure: config.cookieSecure }),
    );
    res.redirect(303, '/login');
  });

  // --- overview ------------------------------------------------------------

  router.get('/', requireAuth, (req: Ctx, res: Response) => {
    const totals = getNetWorth(db);
    // Six months of cashflow, and whatever daily snapshots exist. Both render
    // an explicit empty state rather than an empty axis when there is no data.
    const end = new Date();
    const start = new Date(end);
    start.setMonth(start.getMonth() - 5);
    start.setDate(1);
    const cashflow = getCashflow(db, {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    }).by_month.map((m) => ({ month: m.month, income: m.income_cad, spend: m.spend_cad }));
    const history = getNetWorthHistory(db, { limit: 90 })
      .map((r) => ({ label: String(r['date']), value: Number(r['net_worth_cad']) }))
      .filter((p) => Number.isFinite(p.value));
    const last = db
      .prepare('SELECT finished_at FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as { finished_at: string } | undefined;
    render(
      req,
      res,
      'Overview',
      overviewPage({
        totals,
        profiles: listProfiles(db),
        nonce: req.nonce ?? '',
        accounts: listAccounts(db),
        holdings: getHoldings(db),
        history,
        cashflow,
        lastSync: last?.finished_at ?? null,
        fxAsOf: totals.fx_as_of,
        csrf: req.session!.csrf,
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/',
    );
  });

  router.post('/sync', requireAuth, requireCsrf, async (_req: Ctx, res: Response) => {
    try {
      const report = await runSync(db);
      const failed = (['fx', 'snaptrade', 'plaid', 'wise'] as const).filter(
        (k) => report[k] && 'error' in (report[k] as object),
      );
      res.redirect(
        303,
        failed.length
          ? `/?err=${encodeURIComponent(`Sync finished with errors in: ${failed.join(', ')}`)}`
          : `/?ok=${encodeURIComponent('Sync complete.')}`,
      );
    } catch (e) {
      res.redirect(303, `/?err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  // --- settings ------------------------------------------------------------

  const settings = (
    req: Ctx,
    res: Response,
    checks: Awaited<ReturnType<typeof testCredentials>> | null,
  ): void => {
    render(
      req,
      res,
      'Settings',
      settingsPage({
        settings: describeSettings(db, activeProfile(req).id),
        profiles: listProfiles(db),
        activeProfile: activeProfile(req),
        csrf: req.session!.csrf,
        encryptionReady: Boolean(config.tokenEncKey),
        checks,
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/settings',
    );
  };

  router.get('/settings', requireAuth, (req: Ctx, res: Response) => settings(req, res, null));

  router.post('/settings/test', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    try {
      settings(req, res, await testCredentials(db, activeProfile(req).id));
    } catch (e) {
      res.redirect(303, `/settings?err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  router.post('/settings', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profileId = activeProfile(req).id;
    const saved: string[] = [];
    try {
      for (const key of MANAGED_KEYS) {
        const value = String(body[key] ?? '').trim();
        // A blank secret means "keep what is stored" — otherwise every save
        // would silently wipe credentials the form never displays.
        if (!value && SECRET_KEYS.has(key)) continue;
        if (!value) continue;
        setSetting(db, key, value, profileId);
        saved.push(key);
      }
    } catch (e) {
      res.redirect(
        303,
        `/settings?profile=${encodeURIComponent(profileId)}&err=${encodeURIComponent(errMessage(e))}`,
      );
      return;
    }
    const back = `/settings?profile=${encodeURIComponent(profileId)}`;
    res.redirect(
      303,
      saved.length
        ? `${back}&ok=${encodeURIComponent(`Saved ${saved.length} setting(s).`)}`
        : `${back}&ok=${encodeURIComponent('Nothing changed.')}`,
    );
  });

  // --- connections ---------------------------------------------------------

  const connections = (req: Ctx, res: Response): void => {
    const profile = activeProfile(req);
    render(
      req,
      res,
      'Connections',
      connectionsPage({
        profiles: listProfiles(db),
        activeProfile: profile,
        items: plaidStatus(db, profile.id),
        unsynced: unsyncedItems(db).filter((i) => i.profile_id === profile.id).length,
        snaptradeReady: snaptradeReady(db, profile.id),
        plaidReady: plaidReady(db, profile.id),
        wiseReady: wiseReady(db, profile.id),
        redirectUri: redirectUriFor(req),
        plaidEnv: plaidCreds(db, profile.id).env,
        products: plaidProducts().map(String),
        optionalProducts: plaidOptionalProducts().map(String),
        countryCodes: plaidCountryCodes().map(String),
        csrf: req.session!.csrf,
        nonce: req.nonce ?? '',
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/connections',
    );
  };

  router.get('/connections', requireAuth, connections);
  // Plaid bounces OAuth institutions back here; the page resumes Link itself.
  router.get('/connections/oauth', requireAuth, connections);

  router.post('/api/plaid/link-token', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    try {
      const profile = requiredProfile(req);
      if (listItems(db, profile.id).length >= PLAID_ITEM_CAP) {
        throw new Error(
          `All ${PLAID_ITEM_CAP} Plaid Items are already in use for profile "${profile.name}". ` +
            'Each profile has its own allowance — add another profile, or remove a connection here.',
        );
      }
      res.json({ link_token: await createLinkToken(db, redirectUriFor(req), profile.id) });
    } catch (e) {
      log.warn('plaid link-token failed', { error: plaidErrorDetail(e) });
      res.status(400).json({ error: plaidErrorDetail(e) });
    }
  });

  router.post('/api/plaid/relink', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    try {
      const itemId = String((req.body as { item_id?: string })?.item_id ?? '');
      res.json({
        link_token: await createUpdateLinkToken(db, itemId, redirectUriFor(req), requiredProfile(req).id),
      });
    } catch (e) {
      res.status(400).json({ error: plaidErrorDetail(e) });
    }
  });

  router.post('/api/plaid/exchange', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    try {
      const publicToken = String((req.body as { public_token?: string })?.public_token ?? '');
      if (!publicToken) throw new Error('public_token is required');
      const profile = requiredProfile(req);
      const saved = await exchangePublicToken(db, publicToken, profile.id);
      log.info(`linked ${saved.institution_name ?? saved.item_id} to profile ${profile.id}`);
      // Pull balances straight away so the new row is not sitting at zero
      // accounts until the nightly sync. Failure here is not a failed link.
      let accounts = 0;
      try {
        accounts = await syncNewItem(db, saved.item_id, loadRates(db), profile.id);
      } catch (e) {
        log.warn(`initial sync for ${saved.item_id} failed (${errMessage(e)})`);
      }
      res.json({ ok: true, profile: profile.id, accounts, ...saved });
    } catch (e) {
      res.status(400).json({ error: plaidErrorDetail(e) });
    }
  });

  router.post('/connections/remove', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const itemId = String(body['item_id'] ?? '');
    const purge = String(body['purge'] ?? '') === 'yes';
    const back = `/connections?profile=${encodeURIComponent(activeProfile(req).id)}`;
    try {
      const r = await removeItem(db, itemId, { purge });
      res.redirect(
        303,
        `${back}&ok=${encodeURIComponent(
          `Disconnected — ${r.plaid}; ${r.accounts} account(s) ${purge ? 'deleted' : 'deactivated'}.`,
        )}`,
      );
    } catch (e) {
      res.redirect(303, `${back}&err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  // --- profiles ------------------------------------------------------------

  router.get('/profiles', requireAuth, (req: Ctx, res: Response) => {
    render(
      req,
      res,
      'Profiles',
      profilesPage({
        profiles: listProfiles(db).map((p) => ({ ...p, usage: profileUsage(db, p.id) })),
        max: MAX_PROFILES,
        csrf: req.session!.csrf,
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/profiles',
    );
  });

  router.post('/profiles', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    try {
      const p = createProfile(db, String((req.body as Record<string, unknown>)['name'] ?? ''));
      res.redirect(303, `/settings?profile=${encodeURIComponent(p.id)}&ok=${encodeURIComponent(`Profile “${p.name}” created — add its credentials.`)}`);
    } catch (e) {
      res.redirect(303, `/profiles?err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  router.post('/profiles/rename', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      renameProfile(db, String(body['profile'] ?? ''), String(body['name'] ?? ''));
      res.redirect(303, `/profiles?ok=${encodeURIComponent('Renamed.')}`);
    } catch (e) {
      res.redirect(303, `/profiles?err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  router.post('/profiles/delete', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const id = String((req.body as Record<string, unknown>)['profile'] ?? '');
    const result = deleteProfile(db, id);
    res.redirect(
      303,
      result.deleted
        ? `/profiles?ok=${encodeURIComponent('Profile deleted.')}`
        : `/profiles?err=${encodeURIComponent(result.reason ?? 'could not delete')}`,
    );
  });

  router.post('/accounts/move', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const moved = moveAccount(db, String(body['account_id'] ?? ''), String(body['profile'] ?? ''));
      res.redirect(
        303,
        moved
          ? `/?ok=${encodeURIComponent('Account moved.')}`
          : `/?err=${encodeURIComponent('No such account.')}`,
      );
    } catch (e) {
      res.redirect(303, `/?err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  // --- transactions --------------------------------------------------------

  /**
   * Filters come from the query string so a filtered view is a shareable,
   * bookmarkable URL, and so an edit can post back to exactly where the user
   * was. `back` is validated as a same-site path before any redirect.
   */
  const readFilters = (req: Ctx): TxFilters => {
    const q = req.query as Record<string, string | undefined>;
    const str = (k: string): string => (typeof q[k] === 'string' ? q[k].slice(0, 120) : '');
    const date = (k: string, fallback: string): string =>
      /^\d{4}-\d{2}-\d{2}$/.test(str(k)) ? str(k) : fallback;
    const dir = str('direction');
    const grp = str('group');
    return {
      start: date('start', daysAgoISO(90)),
      end: date('end', todayISO()),
      profile: str('profile'),
      account_id: str('account_id'),
      category: str('category'),
      search: str('search'),
      direction: dir === 'out' || dir === 'in' ? dir : 'all',
      min_amount: /^\d+(\.\d+)?$/.test(str('min_amount')) ? str('min_amount') : '',
      group: grp === 'merchant' || grp === 'category' ? grp : 'none',
    };
  };

  /** Never redirect to whatever a form said; only to our own transactions view. */
  const backTo = (body: Record<string, unknown>, message: string, key = 'ok'): string => {
    const raw = String(body['back'] ?? '/transactions');
    const path = raw.startsWith('/transactions') ? raw : '/transactions';
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}${key}=${encodeURIComponent(message)}`;
  };

  /** Above this, the totals stop describing the filter and start lying about it. */
  const TX_PAGE_LIMIT = 1000;

  router.get('/transactions', requireAuth, (req: Ctx, res: Response) => {
    const f = readFilters(req);
    const rows = getTransactions(db, {
      start: f.start,
      end: f.end,
      ...(f.profile ? { profile: f.profile } : {}),
      ...(f.account_id ? { account_id: f.account_id } : {}),
      ...(f.category ? { category: f.category } : {}),
      ...(f.search ? { search: f.search } : {}),
      ...(f.min_amount ? { min_amount_cad: Number(f.min_amount) } : {}),
      limit: TX_PAGE_LIMIT,
    }).filter((t) =>
      f.direction === 'out' ? t.amount_cad < 0 : f.direction === 'in' ? t.amount_cad > 0 : true,
    );

    render(
      req,
      res,
      'Transactions',
      transactionsPage({
        nonce: req.nonce ?? '',
        csrf: req.session?.csrf ?? '',
        filters: f,
        rows,
        merchants: groupByMerchant(rows),
        categoryGroups: groupByCategory(rows),
        accounts: listAccounts(db, {}),
        categories: knownCategories(db),
        profiles: listProfiles(db),
        rules: listMerchantRules(db).map((r: MerchantRule) => ({
          ...r,
          matching_transactions: ruleImpact(db, r),
        })),
        truncated: rows.length >= TX_PAGE_LIMIT,
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/transactions',
    );
  });

  router.post('/transactions/override', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      setTransactionOverride(db, String(body['transaction_id'] ?? ''), {
        merchant: String(body['merchant'] ?? '').trim() || null,
        category: String(body['category'] ?? '').trim() || null,
      });
      res.redirect(303, backTo(body, 'Transaction updated.'));
    } catch (e) {
      res.redirect(303, backTo(body, errMessage(e), 'err'));
    }
  });

  router.post('/transactions/rule', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const pattern = String(body['pattern'] ?? '').trim();
      const merchant = String(body['merchant'] ?? '').trim();
      const category = String(body['category'] ?? '').trim();
      const affected = ruleImpact(db, { pattern });
      addMerchantRule(db, {
        pattern,
        merchant: merchant || null,
        category: category || null,
      });
      res.redirect(
        303,
        backTo(body, `Rule added — ${String(affected)} transaction(s) now read as “${merchant || pattern}”.`),
      );
    } catch (e) {
      res.redirect(303, backTo(body, errMessage(e), 'err'));
    }
  });

  router.post('/transactions/rule/delete', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const id = Number(body['rule_id']);
      res.redirect(
        303,
        deleteMerchantRule(db, id)
          ? backTo(body, 'Rule deleted.')
          : backTo(body, 'No such rule.', 'err'),
      );
    } catch (e) {
      res.redirect(303, backTo(body, errMessage(e), 'err'));
    }
  });

  router.post('/accounts/currency', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const code = String(body['currency'] ?? '').trim();
      const id = String(body['account_id'] ?? '');
      const done = setAccountCurrency(db, id, code === '' ? null : code);
      res.redirect(
        303,
        done
          ? `/?ok=${encodeURIComponent(code ? `Account now read as ${code.toUpperCase()}.` : 'Currency override cleared.')}`
          : `/?err=${encodeURIComponent('No such account.')}`,
      );
    } catch (e) {
      res.redirect(303, `/?err=${encodeURIComponent(errMessage(e))}`);
    }
  });

  // --- security ------------------------------------------------------------

  /** The full connector URL, including the secret. Built from the host in use. */
  const connectorUrl = (req: Ctx): string => {
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    return `${proto}://${req.get('host')}/mcp/${config.mcpSecret}`;
  };

  const security = (
    req: Ctx,
    res: Response,
    enrolling: { secret: string; uri: string } | null,
    showConnector = false,
  ): void => {
    render(
      req,
      res,
      'Security',
      securityPage({
        username: req.session!.username,
        mcpUrl: `${(req.headers['x-forwarded-proto'] as string) ?? req.protocol}://${req.get('host')}/mcp`,
        legacyEnabled: config.mcpAllowPathSecret,
        connectorUrl: showConnector ? connectorUrl(req) : null,
        clients: listClients(db),
        totpEnabled: totpEnabled(db),
        sessions: listSessions(db),
        currentSessionId: req.session!.id,
        enrolling,
        csrf: req.session!.csrf,
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/security',
    );
  };

  router.get('/security', requireAuth, (req: Ctx, res: Response) => security(req, res, null));

  // Revealed only on an explicit POST, so the secret never appears in the page
  // source — or in a screenshot — until it is asked for.
  router.post('/security/connector', requireAuth, requireCsrf, (req: Ctx, res: Response) =>
    security(req, res, null, true),
  );

  router.post('/security/totp/start', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const secret = generateSecret();
    // Not persisted until a code proves the app holds the same secret —
    // otherwise a half-finished enrolment locks the account out.
    security(req, res, { secret, uri: otpauthUri(secret, req.session!.username) });
  });

  router.post('/security/totp/confirm', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const secret = String(body['secret'] ?? '');
    const code = String(body['code'] ?? '');
    if (!secret || !verifyTotp(code, secret)) {
      res.redirect(303, `/security?err=${encodeURIComponent('That code did not match. Try again.')}`);
      return;
    }
    setTotpSecret(db, secret);
    res.redirect(303, `/security?ok=${encodeURIComponent('Two-factor authentication is on.')}`);
  });

  router.post('/security/totp/disable', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const code = String((req.body as Record<string, unknown>)?.['code'] ?? '');
    const secret = getTotpSecret(db);
    if (!secret || !verifyTotp(code, secret)) {
      res.redirect(303, `/security?err=${encodeURIComponent('A valid current code is required to disable it.')}`);
      return;
    }
    clearTotpSecret(db);
    res.redirect(303, `/security?ok=${encodeURIComponent('Two-factor authentication is off.')}`);
  });

  router.post('/security/apps/revoke', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const id = String((req.body as Record<string, unknown>)['client_id'] ?? '');
    const removed = revokeClient(db, id);
    res.redirect(
      303,
      removed
        ? `/security?ok=${encodeURIComponent('Access revoked. That app must be authorized again to reconnect.')}`
        : `/security?err=${encodeURIComponent('No such app.')}`,
    );
  });

  router.post('/security/sessions/revoke', requireAuth, requireCsrf, (_req: Ctx, res: Response) => {
    destroyAllSessions(db);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, '', { expires: new Date(0), secure: config.cookieSecure }),
    );
    res.redirect(303, '/login');
  });

  return router;
}

/** Null when the UI can be mounted, otherwise why it cannot. */
export function webDisabledReason(): string | null {
  if (!config.uiEnabled) return 'UI_ENABLED is not true';
  return adminConfigError();
}
