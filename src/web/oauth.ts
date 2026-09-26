/**
 * OAuth 2.1 endpoints that make the MCP server a login-authenticated resource.
 *
 * The flow a client (Claude.ai) walks, with no secret shared out of band:
 *   1. POST /mcp with no token → 401 + WWW-Authenticate pointing at metadata
 *   2. GET /.well-known/oauth-protected-resource → which authorization server
 *   3. GET /.well-known/oauth-authorization-server → endpoints and capabilities
 *   4. POST /oauth/register → a client_id (dynamic registration, RFC 7591)
 *   5. User is sent to /oauth/authorize → signs in (password + TOTP) → consents
 *   6. POST /oauth/token with the code and PKCE verifier → bearer tokens
 *   7. POST /mcp with Authorization: Bearer …
 *
 * Steps 2–4 and 6 are unauthenticated and cookie-free by design, so they get
 * permissive CORS; step 5 is the only page and lives behind the UI session.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { DB } from '../db.ts';
import { config } from '../config.ts';
import { errMessage, log } from '../lib/logger.ts';
import { html } from '../lib/html.ts';
import { notice, page } from './layout.ts';
import { csrfField } from './layout.ts';
import { safeEqual } from '../auth/password.ts';
import { COOKIE_NAME, getSession, parseCookies, type Session } from '../auth/session.ts';
import { appName } from '../settings.ts';
import { logoUrl } from '../brand.ts';
import {
  SCOPE,
  clientRedirectUris,
  consumeCode,
  getClient,
  hashToken,
  issueCode,
  issueTokens,
  refreshTokens,
  registerClient,
} from '../oauth.ts';
import { createFailureLimiter } from '../ratelimit.ts';
import { randomBytes } from 'node:crypto';

/**
 * The scheme and host the browser used to reach this server. Every absolute
 * URL we hand out goes through here: the OAuth issuer, the MCP connector URL,
 * and the redirect URI Plaid must find registered character for character.
 *
 * Behind a chain of proxies (a CDN in front of Caddy, say) X-Forwarded-Proto
 * arrives as "https, http", and only the first entry is what the browser saw.
 * Taking the header whole built "https, http://host/connections/oauth", a
 * redirect URI nobody registered, and Plaid refused Link with INVALID_FIELD.
 */
export function originOf(req: Request): string {
  const header = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim().toLowerCase();
  const proto = first === 'https' || first === 'http' ? first : req.protocol;
  return `${proto}://${req.get('host') ?? 'localhost'}`;
}

/** Where the web UI's Plaid Link returns after an OAuth bank. */
export const PLAID_RETURN_PATH = '/connections/oauth';

export type PlaidRedirect = {
  uri: string;
  /** "env" when PLAID_REDIRECT_URI supplied it, "request" when built from the address. */
  source: 'env' | 'request';
  /** A PLAID_REDIRECT_URI that was set but not used, and why it was not. */
  ignored?: { value: string; reason: string };
};

/**
 * The redirect URI the web UI sends to Plaid. An explicit PLAID_REDIRECT_URI
 * wins, because it is what the operator registered in the dashboard, and a
 * built value that differs from the registered one only fails later, on the
 * first OAuth bank. It is used only when it points at this app's own return
 * path: the variable's documented default is the local Link helper's address,
 * and sending Link back there from a server would return to nothing.
 */
export function plaidRedirectFor(req: Request, configured: string): PlaidRedirect {
  const built = `${originOf(req)}${PLAID_RETURN_PATH}`;
  const value = configured.trim();
  if (!value) return { uri: built, source: 'request' };
  let path = '';
  try {
    const u = new URL(value);
    path = /^https?:$/.test(u.protocol) ? u.pathname.replace(/\/+$/, '') : '';
  } catch {
    path = '';
  }
  if (path === PLAID_RETURN_PATH) return { uri: value, source: 'env' };
  return {
    uri: built,
    source: 'request',
    ignored: {
      value,
      reason: path
        ? `it returns to ${path}, which is the local Link helper, not this server`
        : 'it is not an http(s) address',
    },
  };
}

/** The canonical resource identifier every token is minted for. */
export function resourceUrl(req: Request): string {
  return `${originOf(req)}/mcp`;
}

function json(res: Response, status: number, body: unknown): void {
  res.status(status).set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json(body);
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  json(res, status, { error, error_description: description });
}

/** Public, cookie-free endpoints may be fetched cross-origin by any client. */
function cors(_req: Request, res: Response, next: NextFunction): void {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/** Only relative paths, never protocol-relative — an open redirect otherwise. */
export function safeNext(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

export function createOAuthRouter(db: DB): express.Router {
  const router = express.Router();
  // Failed token exchanges per address: brute-forcing a code or a verifier
  // through here should be as slow as brute-forcing the login.
  const tokenLimiter = createFailureLimiter(20, 15 * 60_000);

  // --- discovery -----------------------------------------------------------

  const protectedResource = (req: Request, res: Response): void => {
    json(res, 200, {
      resource: resourceUrl(req),
      authorization_servers: [originOf(req)],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'tally',
    });
  };
  router.get('/.well-known/oauth-protected-resource', cors, protectedResource);
  router.get('/.well-known/oauth-protected-resource/mcp', cors, protectedResource);

  router.get('/.well-known/oauth-authorization-server', cors, (req: Request, res: Response) => {
    const origin = originOf(req);
    json(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      service_documentation: `${origin}/security`,
    });
  });

  // --- dynamic client registration (RFC 7591) ------------------------------

  router.options('/oauth/register', cors);
  router.post('/oauth/register', cors, express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(body['redirect_uris'])
      ? (body['redirect_uris'] as unknown[]).filter((u): u is string => typeof u === 'string')
      : [];
    const method = String(body['token_endpoint_auth_method'] ?? 'none');
    if (method !== 'none') {
      oauthError(res, 400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported');
      return;
    }
    try {
      const client = registerClient(db, {
        client_name: typeof body['client_name'] === 'string' ? body['client_name'].slice(0, 120) : null,
        redirect_uris: uris,
      });
      log.info('oauth client registered', { client: client.client_name ?? client.client_id });
      json(res, 201, {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: clientRedirectUris(client),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
      });
    } catch (e) {
      oauthError(res, 400, 'invalid_redirect_uri', errMessage(e));
    }
  });

  // --- authorization + consent ---------------------------------------------

  type AuthzParams = {
    client_id: string;
    redirect_uri: string;
    state: string | null;
    code_challenge: string;
    code_challenge_method: string;
    scope: string | null;
    resource: string | null;
  };

  /**
   * Validate the request BEFORE involving the user. Errors in client_id or
   * redirect_uri are shown, never redirected: redirecting to an unverified URI
   * is the classic open-redirect hole.
   */
  const parseAuthz = (
    src: Record<string, unknown>,
    req: Request,
  ): { ok: true; params: AuthzParams } | { ok: false; error: string } => {
    const clientId = String(src['client_id'] ?? '');
    const client = getClient(db, clientId);
    if (!client) return { ok: false, error: 'Unknown client_id. The app must register first.' };
    const redirectUri = String(src['redirect_uri'] ?? '');
    if (!clientRedirectUris(client).includes(redirectUri)) {
      return { ok: false, error: 'redirect_uri is not registered for this client.' };
    }
    if (String(src['response_type'] ?? '') !== 'code') {
      return { ok: false, error: 'Only response_type=code is supported.' };
    }
    const challenge = String(src['code_challenge'] ?? '');
    const method = String(src['code_challenge_method'] ?? '');
    if (!challenge || method !== 'S256') {
      return { ok: false, error: 'PKCE with code_challenge_method=S256 is required.' };
    }
    const resource = typeof src['resource'] === 'string' ? src['resource'] : null;
    if (resource && resource !== resourceUrl(req)) {
      return { ok: false, error: `This server issues tokens only for ${resourceUrl(req)}.` };
    }
    return {
      ok: true,
      params: {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: typeof src['state'] === 'string' ? src['state'] : null,
        code_challenge: challenge,
        code_challenge_method: method,
        scope: typeof src['scope'] === 'string' ? src['scope'] : null,
        resource,
      },
    };
  };

  const sessionOf = (req: Request): Session | null => {
    const s = getSession(db, parseCookies(req.headers.cookie)[COOKIE_NAME]);
    return s && !s.pending ? s : null;
  };

  /**
   * `formAction` is the client's already-validated redirect URI.
   *
   * Chrome applies form-action to the redirect that FOLLOWS a submission, not
   * just to the POST target — so a bare `form-action 'self'` silently blocks
   * the hop back to the client and the Allow button appears to do nothing.
   * The origin is safe to name here precisely because parseAuthz has already
   * checked it against the client's registered list.
   */
  const renderPage = (
    res: Response,
    title: string,
    body: ReturnType<typeof html>,
    formAction?: string,
  ): void => {
    const nonce = randomBytes(16).toString('base64');
    let extra = '';
    if (formAction) {
      try {
        extra = ` ${new URL(formAction).origin}`;
      } catch {
        extra = '';
      }
    }
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        "img-src 'self' data:",
        `form-action 'self'${extra}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(page({ title, nonce, chrome: false, body, appName: appName(db), logoUrl: logoUrl(db) }));
  };

  router.get('/oauth/authorize', (req: Request, res: Response) => {
    const parsed = parseAuthz(req.query as Record<string, unknown>, req);
    if (!parsed.ok) {
      renderPage(
        res,
        'Cannot authorize',
        html`<div class="login"><h1>Cannot authorize</h1>${notice('err', parsed.error)}</div>`,
      );
      return;
    }
    const session = sessionOf(req);
    if (!session) {
      // Come back here after signing in. The full query string is preserved.
      res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    const client = getClient(db, parsed.params.client_id)!;
    const p = parsed.params;
    renderPage(
      res,
      'Authorize',
      html`<div class="login">
        <h1>Authorize access</h1>
        <p class="sub"><strong>${client.client_name ?? 'An application'}</strong> is asking to read
          your financial data through ${appName(db)}, as <strong>${session.username}</strong>.</p>
        <section>
          <p class="hint mb-sm">It will be able to see balances, holdings, transactions and
            contribution room across every profile. It cannot move money — no such capability
            exists on this server. You can revoke this at any time from Security.</p>
          <form method="post" action="/oauth/authorize">
            ${csrfField(session.csrf)}
            <input type="hidden" name="client_id" value="${p.client_id}">
            <input type="hidden" name="redirect_uri" value="${p.redirect_uri}">
            <input type="hidden" name="state" value="${p.state ?? ''}">
            <input type="hidden" name="code_challenge" value="${p.code_challenge}">
            <input type="hidden" name="code_challenge_method" value="${p.code_challenge_method}">
            <input type="hidden" name="scope" value="${p.scope ?? ''}">
            <input type="hidden" name="resource" value="${p.resource ?? ''}">
            <input type="hidden" name="response_type" value="code">
            <div class="row">
              <button type="submit" name="decision" value="approve">Allow</button>
              <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
            </div>
          </form>
        </section>
      </div>`,
      p.redirect_uri,
    );
  });

  router.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = sessionOf(req);
    if (!session) {
      res.redirect(303, '/login');
      return;
    }
    if (!safeEqual(String(body['_csrf'] ?? ''), session.csrf)) {
      res.status(403).type('text/plain').send('Bad or missing CSRF token. Reload and try again.');
      return;
    }
    const parsed = parseAuthz(body, req);
    if (!parsed.ok) {
      renderPage(
        res,
        'Cannot authorize',
        html`<div class="login"><h1>Cannot authorize</h1>${notice('err', parsed.error)}</div>`,
      );
      return;
    }
    const p = parsed.params;
    const back = new URL(p.redirect_uri);
    if (p.state) back.searchParams.set('state', p.state);

    if (String(body['decision']) !== 'approve') {
      back.searchParams.set('error', 'access_denied');
      res.redirect(303, back.toString());
      return;
    }
    const code = issueCode(db, {
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      challenge_method: p.code_challenge_method,
      scope: p.scope || SCOPE,
      resource: p.resource,
      username: session.username,
    });
    back.searchParams.set('code', code);
    log.info('oauth consent granted', { client: p.client_id, user: session.username });
    res.redirect(303, back.toString());
  });

  // --- token ---------------------------------------------------------------

  router.options('/oauth/token', cors);
  router.post(
    '/oauth/token',
    cors,
    express.urlencoded({ extended: false, limit: '16kb' }),
    express.json({ limit: '16kb' }),
    (req: Request, res: Response) => {
      const ip = req.ip ?? 'unknown';
      if (tokenLimiter.blocked(ip)) {
        oauthError(res, 429, 'slow_down', 'too many failed token requests');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grant = String(body['grant_type'] ?? '');
      const clientId = String(body['client_id'] ?? '');
      if (!getClient(db, clientId)) {
        tokenLimiter.fail(ip);
        oauthError(res, 401, 'invalid_client', 'unknown client_id');
        return;
      }

      if (grant === 'authorization_code') {
        const result = consumeCode(
          db,
          String(body['code'] ?? ''),
          clientId,
          String(body['redirect_uri'] ?? ''),
          String(body['code_verifier'] ?? ''),
        );
        if (!result.ok) {
          tokenLimiter.fail(ip);
          oauthError(res, 400, result.error, 'code is invalid, expired, already used, or the PKCE verifier does not match');
          return;
        }
        tokenLimiter.reset(ip);
        json(res, 200, issueTokens(db, { client_id: clientId, username: result.row.username, scope: result.row.scope }));
        return;
      }

      if (grant === 'refresh_token') {
        const issued = refreshTokens(db, String(body['refresh_token'] ?? ''), clientId);
        if (!issued) {
          tokenLimiter.fail(ip);
          oauthError(res, 400, 'invalid_grant', 'refresh token is invalid or expired');
          return;
        }
        tokenLimiter.reset(ip);
        json(res, 200, issued);
        return;
      }

      oauthError(res, 400, 'unsupported_grant_type', 'use authorization_code or refresh_token');
    },
  );

  // RFC 7009. Idempotent by spec: unknown tokens still return 200.
  router.options('/oauth/revoke', cors);
  router.post('/oauth/revoke', cors, express.urlencoded({ extended: false, limit: '16kb' }), (req: Request, res: Response) => {
    const token = String((req.body as Record<string, unknown>)?.['token'] ?? '');
    if (token) {
      const h = hashToken(token);
      db.prepare('DELETE FROM oauth_tokens WHERE access_hash = ? OR refresh_hash = ?').run(h, h);
    }
    res.status(200).set('Cache-Control', 'no-store').end();
  });

  return router;
}

