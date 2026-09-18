/**
 * Resolved provider credentials.
 *
 * Every source adapter reads through here rather than touching `config`
 * directly, so a value set in the UI (database) takes effect on the next sync
 * without a redeploy, while an existing env-only deployment keeps working
 * unchanged. See src/settings.ts for the resolution order.
 */
import type { DB } from './db.ts';
import { config } from './config.ts';
import { getSetting, sourceReady } from './settings.ts';

export function snaptradeCreds(db: DB) {
  return {
    clientId: getSetting(db, 'SNAPTRADE_CLIENT_ID'),
    consumerKey: getSetting(db, 'SNAPTRADE_CONSUMER_KEY'),
    transport: (getSetting(db, 'SNAPTRADE_TRANSPORT') || 'rest') as 'rest' | 'sdk',
    userId: config.snaptrade.userId,
    userSecret: config.snaptrade.userSecret,
    baseUrl: config.snaptrade.baseUrl,
  };
}

export function plaidCreds(db: DB) {
  return {
    clientId: getSetting(db, 'PLAID_CLIENT_ID'),
    secret: getSetting(db, 'PLAID_SECRET'),
    env: getSetting(db, 'PLAID_ENV') || 'production',
  };
}

export function wiseCreds(db: DB) {
  return {
    token: getSetting(db, 'WISE_API_TOKEN'),
    baseUrl: config.wise.baseUrl,
  };
}

export function snaptradeReady(db: DB): boolean {
  return sourceReady(db, 'snaptrade');
}

export function plaidReady(db: DB): boolean {
  return sourceReady(db, 'plaid');
}

export function wiseReady(db: DB): boolean {
  return sourceReady(db, 'wise');
}
