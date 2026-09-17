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

/** Compare secrets in constant time regardless of length. */
export function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Fixed-window limiter, per IP. Small and in-memory: one household, one process. */
export function createRateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  return function allow(key: string, now = Date.now()): boolean {
    const cutoff = now - windowMs;
    const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 1000) {
      for (const [k, v] of hits) if (v.every((t) => t <= cutoff)) hits.delete(k);
    }
    return true;
  };
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  const db = getDb();
  const allow = createRateLimiter(config.mcpRateLimit);

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

  app.all('/mcp/:secret', async (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    if (!allow(ip)) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Too many requests' },
        id: null,
      });
      return;
    }
    if (!secretMatches(String(req.params['secret'] ?? ''), config.mcpSecret)) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
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
  });

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
