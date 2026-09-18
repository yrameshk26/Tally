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
import { errMessage } from './lib/logger.ts';

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


export type CredentialCheck = {
  provider: 'snaptrade' | 'plaid' | 'wise';
  configured: boolean;
  ok: boolean;
  detail: string;
};

/**
 * Validate each provider's credentials with the cheapest read-only call that
 * proves them. Without this, a wrong key is only discovered halfway through a
 * Plaid Link flow, which is a poor place to learn it.
 */
export async function testCredentials(db: DB): Promise<CredentialCheck[]> {
  const { snaptradeGet } = await import('./sources/snaptrade.ts');
  const { plaidClient, plaidCountryCodes, plaidErrorDetail } = await import('./sources/plaid.ts');
  const out: CredentialCheck[] = [];

  if (!snaptradeReady(db)) {
    out.push({ provider: 'snaptrade', configured: false, ok: false, detail: 'not configured' });
  } else {
    try {
      const auths = await snaptradeGet<unknown[]>(db, '/authorizations');
      out.push({
        provider: 'snaptrade',
        configured: true,
        ok: true,
        detail: `${Array.isArray(auths) ? auths.length : 0} brokerage connection(s)`,
      });
    } catch (e) {
      out.push({ provider: 'snaptrade', configured: true, ok: false, detail: errMessage(e) });
    }
  }

  if (!plaidReady(db)) {
    out.push({ provider: 'plaid', configured: false, ok: false, detail: 'not configured' });
  } else {
    const env = plaidCreds(db).env;
    try {
      // institutionsGet is the cheapest call that exercises the key pair.
      await plaidClient(db).institutionsGet({
        count: 1,
        offset: 0,
        country_codes: plaidCountryCodes(),
      });
      out.push({ provider: 'plaid', configured: true, ok: true, detail: `keys valid for ${env}` });
    } catch (e) {
      out.push({
        provider: 'plaid',
        configured: true,
        ok: false,
        detail: `${plaidErrorDetail(e)} (currently using PLAID_ENV=${env})`,
      });
    }
  }

  if (!wiseReady(db)) {
    out.push({ provider: 'wise', configured: false, ok: false, detail: 'not configured' });
  } else {
    const { token, baseUrl } = wiseCreds(db);
    try {
      const res = await fetch(`${baseUrl}/v2/profiles`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Wise returned ${res.status} ${res.statusText}`);
      const profiles = (await res.json()) as unknown[];
      out.push({
        provider: 'wise',
        configured: true,
        ok: true,
        detail: `${Array.isArray(profiles) ? profiles.length : 0} profile(s)`,
      });
    } catch (e) {
      out.push({ provider: 'wise', configured: true, ok: false, detail: errMessage(e) });
    }
  }

  return out;
}
