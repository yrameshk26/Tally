/**
 * Plaid Link helper. Runs ONLY on the developer's machine — it is never built
 * into the deployed image and port 8788 must not be exposed anywhere. Its job
 * is to turn a bank login into an access_token stored in the local database,
 * which is then copied to the server's volume once.
 */
import express, { type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { plaidReady } from './credentials.ts';
import { getDb } from './db.ts';
import { errMessage, log } from './lib/logger.ts';
import {
  createLinkToken,
  createUpdateLinkToken,
  exchangePublicToken,
  listItems,
} from './sources/plaid.ts';

const here = dirname(fileURLToPath(import.meta.url));

function page(): string {
  return readFileSync(join(here, '..', 'public', 'link.html'), 'utf8');
}

export function createLinkApp(): express.Express {
  const app = express();
  app.use(express.json());
  const db = getDb();

  app.get('/', (_req: Request, res: Response) => res.type('html').send(page()));
  // Plaid redirects OAuth banks back here; link.html resumes the flow.
  app.get('/oauth-return', (_req: Request, res: Response) => res.type('html').send(page()));

  app.get('/api/items', (_req: Request, res: Response) => {
    res.json(
      listItems(db).map((i) => ({
        item_id: i.item_id,
        institution: i.institution_name ?? i.institution_id ?? 'unknown',
        status: i.status,
        error_code: i.error_code,
        last_synced_at: i.last_synced_at,
      })),
    );
  });

  app.get('/api/link-token', async (_req: Request, res: Response) => {
    try {
      res.json({ link_token: await createLinkToken(db) });
    } catch (e) {
      res.status(500).json({ error: errMessage(e) });
    }
  });

  app.post('/api/relink', async (req: Request, res: Response) => {
    try {
      const itemId = String((req.body as { item_id?: string })?.item_id ?? '');
      res.json({ link_token: await createUpdateLinkToken(db, itemId) });
    } catch (e) {
      res.status(500).json({ error: errMessage(e) });
    }
  });

  app.post('/api/exchange', async (req: Request, res: Response) => {
    try {
      const publicToken = String((req.body as { public_token?: string })?.public_token ?? '');
      if (!publicToken) throw new Error('public_token is required');
      const saved = await exchangePublicToken(db, publicToken);
      log.info(`linked ${saved.institution_name ?? saved.item_id}`);
      res.json({ ok: true, ...saved, items: listItems(db).length });
    } catch (e) {
      res.status(500).json({ error: errMessage(e) });
    }
  });

  return app;
}

function main(): void {
  if (!plaidReady(getDb())) {
    log.error('PLAID_CLIENT_ID / PLAID_SECRET must be set before linking');
    process.exit(1);
  }
  createLinkApp().listen(config.plaid.linkPort, '127.0.0.1', () => {
    log.info(`Link helper on http://localhost:${config.plaid.linkPort} — local only, do not deploy`);
  });
}

if (process.argv[1] && /link-server\.(ts|js)$/.test(process.argv[1])) main();
