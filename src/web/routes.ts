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
import { config } from '../config.ts';
import { errMessage, log } from '../lib/logger.ts';
import { html, raw } from '../lib/html.ts';
import { notice, page } from './layout.ts';
import {
  connectionsPage,
  loginPage,
  overviewPage,
  securityPage,
  settingsPage,
} from './pages.ts';
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
  SESSION_TTL_MS,
  createSession,
  destroyAllSessions,
  destroySession,
  getSession,
  listSessions,
  parseCookies,
  serializeCookie,
  type Session,
} from '../auth/session.ts';
import { describeSettings, setSetting, MANAGED_KEYS, SECRET_KEYS } from '../settings.ts';
import { plaidReady, snaptradeReady, wiseReady } from '../credentials.ts';
import { getHoldings, getNetWorth, listAccounts } from '../queries.ts';
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  listItems,
  plaidErrorDetail,
  plaidStatus,
} from '../sources/plaid.ts';
import { runSync } from '../sync.ts';
import { createFailureLimiter } from '../ratelimit.ts';

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
    render(req, res, 'Sign in', loginPage({ csrf: '', totpEnabled: totpEnabled(db) }), undefined, false);
  });

  router.post('/login', async (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = String(body['username'] ?? '');
    const password = String(body['password'] ?? '');
    const code = String(body['code'] ?? '');
    const ip = req.ip ?? 'unknown';

    const fail = (message: string): void => {
      render(
        req,
        res,
        'Sign in',
        loginPage({ csrf: '', totpEnabled: totpEnabled(db), error: message, username }),
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

    if (totpEnabled(db)) {
      const secret = getTotpSecret(db);
      if (!secret || !verifyTotp(code, secret)) {
        loginLimiter.fail(ip);
        log.warn('failed second factor', { ip });
        res.status(401);
        fail('That authenticator code is not valid.');
        return;
      }
    }

    loginLimiter.reset(ip);
    const session = createSession(db, username, { userAgent: req.get('user-agent'), ip });
    res.setHeader(
      'Set-Cookie',
      serializeCookie(COOKIE_NAME, session.id, {
        maxAge: SESSION_TTL_MS,
        secure: config.cookieSecure,
      }),
    );
    res.redirect(303, '/');
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
    const last = db
      .prepare('SELECT finished_at FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as { finished_at: string } | undefined;
    render(
      req,
      res,
      'Overview',
      overviewPage({
        totals,
        accounts: listAccounts(db),
        holdings: getHoldings(db),
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

  router.get('/settings', requireAuth, (req: Ctx, res: Response) => {
    render(
      req,
      res,
      'Settings',
      settingsPage({
        settings: describeSettings(db),
        csrf: req.session!.csrf,
        encryptionReady: Boolean(config.tokenEncKey),
        flash: raw(flash(req, 'ok').value + flash(req, 'err').value),
      }),
      '/settings',
    );
  });

  router.post('/settings', requireAuth, requireCsrf, (req: Ctx, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved: string[] = [];
    try {
      for (const key of MANAGED_KEYS) {
        const value = String(body[key] ?? '').trim();
        // A blank secret means "keep what is stored" — otherwise every save
        // would silently wipe credentials the form never displays.
        if (!value && SECRET_KEYS.has(key)) continue;
        if (!value) continue;
        setSetting(db, key, value);
        saved.push(key);
      }
    } catch (e) {
      res.redirect(303, `/settings?err=${encodeURIComponent(errMessage(e))}`);
      return;
    }
    res.redirect(
      303,
      saved.length
        ? `/settings?ok=${encodeURIComponent(`Saved ${saved.length} setting(s).`)}`
        : `/settings?ok=${encodeURIComponent('Nothing changed.')}`,
    );
  });

  // --- connections ---------------------------------------------------------

  const connections = (req: Ctx, res: Response): void => {
    render(
      req,
      res,
      'Connections',
      connectionsPage({
        items: plaidStatus(db),
        snaptradeReady: snaptradeReady(db),
        plaidReady: plaidReady(db),
        wiseReady: wiseReady(db),
        redirectUri: redirectUriFor(req),
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
      if (listItems(db).length >= 10) throw new Error('All 10 Plaid Items are already in use');
      res.json({ link_token: await createLinkToken(db, redirectUriFor(req)) });
    } catch (e) {
      log.warn('plaid link-token failed', { error: plaidErrorDetail(e) });
      res.status(400).json({ error: plaidErrorDetail(e) });
    }
  });

  router.post('/api/plaid/relink', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    try {
      const itemId = String((req.body as { item_id?: string })?.item_id ?? '');
      res.json({ link_token: await createUpdateLinkToken(db, itemId, redirectUriFor(req)) });
    } catch (e) {
      res.status(400).json({ error: plaidErrorDetail(e) });
    }
  });

  router.post('/api/plaid/exchange', requireAuth, requireCsrf, async (req: Ctx, res: Response) => {
    try {
      const publicToken = String((req.body as { public_token?: string })?.public_token ?? '');
      if (!publicToken) throw new Error('public_token is required');
      const saved = await exchangePublicToken(db, publicToken);
      log.info(`linked ${saved.institution_name ?? saved.item_id}`);
      res.json({ ok: true, ...saved });
    } catch (e) {
      res.status(400).json({ error: plaidErrorDetail(e) });
    }
  });

  // --- security ------------------------------------------------------------

  const security = (req: Ctx, res: Response, enrolling: { secret: string; uri: string } | null): void => {
    render(
      req,
      res,
      'Security',
      securityPage({
        username: req.session!.username,
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
