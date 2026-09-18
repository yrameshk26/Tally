/**
 * HTTP entrypoint: health check + the MCP streamable-HTTP endpoint, plus the
 * in-process nightly sync.
 *
 * The MCP transport is stateless — a fresh server and transport per request —
 * because Claude.ai custom connectors reconnect freely and there is no session
 * state worth keeping. Authentication is the unguessable secret in the path,
 * which is why a wrong secret returns a plain 404 rather than a 401: the
 * endpoint should look like it does not exist.
 */
import express, { type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { errMessage, log } from './lib/logger.ts';
import { buildServer } from './mcp.ts';
import { startScheduler } from './scheduler.ts';
import { createRateLimiter } from './ratelimit.ts';
import { createWebRouter, webDisabledReason } from './web/routes.ts';
import { createOAuthRouter } from './web/oauth.ts';
import { verifyAccessToken } from './oauth.ts';
import { faviconSvg } from './web/logo.ts';

export { createRateLimiter };

/** Compare secrets in constant time regardless of length. */
export function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Rate-limit bucket key. With `trust proxy` set correctly this is the real
 * client address; with no proxy configured it is the socket address. It is
 * never derived from a header we do not trust.
 */
export function clientKey(req: Pick<Request, 'ip'>): string {
  return req.ip ?? 'unknown';
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Express defaults to not trusting proxies, which would make req.ip the
  // proxy's address for every request. Only trust as many hops as are
  // actually deployed — trusting blindly lets a client spoof X-Forwarded-For.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '4mb' }));

  const db = getDb();
  const allow = createRateLimiter(config.mcpRateLimit);

  app.get('/favicon.svg', (_req: Request, res: Response) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(faviconSvg());
  });

  app.get('/health', (_req: Request, res: Response) => {
    try {
      const accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE active = 1').get() as {
        n: number;
      };
      const last = db
        .prepare('SELECT finished_at FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
        .get() as { finished_at: string } | undefined;
      res.json({
        ok: true,
        accounts: accounts.n,
        last_sync: last?.finished_at ?? null,
        base_currency: config.baseCurrency,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  /** Shared MCP handler; auth is decided by whichever route reached it. */
  const serveMcp = async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      // Stateless: no server-initiated stream to GET, nothing to DELETE.
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST.' },
        id: null,
      });
      return;
    }
    const server = buildServer(db);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error('mcp request failed', { error: errMessage(e) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const tooMany = (res: Response): void => {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Too many requests' },
      id: null,
    });
  };

  /**
   * The login-authenticated endpoint. A missing or bad bearer token gets a
   * 401 whose WWW-Authenticate header tells the client where to discover the
   * authorization server — that header is what starts the OAuth flow.
   */
  app.all('/mcp', async (req: Request, res: Response) => {
    if (!allow(clientKey(req))) {
      tooMany(res);
      return;
    }
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
    const metadata = `${proto}://${req.get('host')}/.well-known/oauth-protected-resource`;
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const identity = token ? verifyAccessToken(db, token) : null;
    if (!identity) {
      res
        .status(401)
        .set(
          'WWW-Authenticate',
          `Bearer realm="tally", resource_metadata="${metadata}"` +
            (token ? ', error="invalid_token"' : ''),
        )
        .json({ error: 'unauthorized', resource_metadata: metadata });
      return;
    }
    await serveMcp(req, res);
  });

  app.all('/mcp/:secret', async (req: Request, res: Response) => {
    if (!allow(clientKey(req))) {
      tooMany(res);
      return;
    }
    // Legacy: secret in the path. Kept only for the migration window, and only
    // while MCP_ALLOW_PATH_SECRET is on — the path is written to reverse-proxy
    // logs on every request.
    if (
      !config.mcpAllowPathSecret ||
      !secretMatches(String(req.params['secret'] ?? ''), config.mcpSecret)
    ) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    await serveMcp(req, res);
  });

  const uiOff = webDisabledReason();
  if (uiOff === null) {
    // OAuth needs somewhere for a person to sign in, so it rides on the UI.
    app.use('/', createOAuthRouter(db));
    app.use('/', createWebRouter(db));
    log.info('web UI enabled (OAuth sign-in for /mcp available)');
  } else {
    log.info(`web UI disabled: ${uiOff}`);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('Not Found');
  });

  return app;
}

function main(): void {
  if (!config.mcpSecret) {
    log.error('MCP_SECRET is not set. Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
  if (config.mcpSecret.length < 24) {
    log.error('MCP_SECRET is too short — use at least 32 hex characters.');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    log.info(`tally listening on :${config.port} (MCP at /mcp/<secret>)`);
  });

  const stopScheduler = startScheduler();

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    stopScheduler();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only start a listener when run directly, so tests can import createApp().
if (process.argv[1] && /index\.(ts|js)$/.test(process.argv[1])) main();
