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
import { DEFAULT_PROFILE_ID } from './profiles.ts';
import { errMessage } from './lib/logger.ts';

export function snaptradeCreds(db: DB, profileId = DEFAULT_PROFILE_ID) {
  return {
    clientId: getSetting(db, 'SNAPTRADE_CLIENT_ID', profileId),
    consumerKey: getSetting(db, 'SNAPTRADE_CONSUMER_KEY', profileId),
    transport: (getSetting(db, 'SNAPTRADE_TRANSPORT', profileId) || 'rest') as 'rest' | 'sdk',
    userId: config.snaptrade.userId,
    userSecret: config.snaptrade.userSecret,
    baseUrl: config.snaptrade.baseUrl,
  };
}

export function plaidCreds(db: DB, profileId = DEFAULT_PROFILE_ID) {
  return {
    clientId: getSetting(db, 'PLAID_CLIENT_ID', profileId),
    secret: getSetting(db, 'PLAID_SECRET', profileId),
    env: getSetting(db, 'PLAID_ENV', profileId) || 'production',
  };
}

export function wiseCreds(db: DB, profileId = DEFAULT_PROFILE_ID) {
  return {
    token: getSetting(db, 'WISE_API_TOKEN', profileId),
    baseUrl: config.wise.baseUrl,
  };
}

export function snaptradeReady(db: DB, profileId = DEFAULT_PROFILE_ID): boolean {
  return sourceReady(db, 'snaptrade', profileId);
}

export function plaidReady(db: DB, profileId = DEFAULT_PROFILE_ID): boolean {
  return sourceReady(db, 'plaid', profileId);
}

export function wiseReady(db: DB, profileId = DEFAULT_PROFILE_ID): boolean {
  return sourceReady(db, 'wise', profileId);
}


export type CredentialCheck = {
  provider: 'snaptrade' | 'plaid' | 'wise' | 'assistant';
  configured: boolean;
  ok: boolean;
  detail: string;
};

/**
 * Validate each provider's credentials with the cheapest read-only call that
 * proves them. Without this, a wrong key is only discovered halfway through a
 * Plaid Link flow, which is a poor place to learn it.
 */
export async function testCredentials(
  db: DB,
  profileId = DEFAULT_PROFILE_ID,
): Promise<CredentialCheck[]> {
  const { snaptradeGet } = await import('./sources/snaptrade.ts');
  const { plaidClient, plaidCountryCodes, plaidErrorDetail } = await import('./sources/plaid.ts');
  const out: CredentialCheck[] = [];

  if (!snaptradeReady(db, profileId)) {
    out.push({ provider: 'snaptrade', configured: false, ok: false, detail: 'not configured' });
  } else {
    try {
      const auths = await snaptradeGet<unknown[]>(db, profileId, '/authorizations');
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

  if (!plaidReady(db, profileId)) {
    out.push({ provider: 'plaid', configured: false, ok: false, detail: 'not configured' });
  } else {
    const env = plaidCreds(db, profileId).env;
    try {
      // institutionsGet is the cheapest call that exercises the key pair.
      await plaidClient(db, profileId).institutionsGet({
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

  if (!wiseReady(db, profileId)) {
    out.push({ provider: 'wise', configured: false, ok: false, detail: 'not configured' });
  } else {
    const { token, baseUrl } = wiseCreds(db, profileId);
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

  // The assistant is install-level rather than per profile, so it is only
  // checked once, on the default profile's settings page.
  if (profileId === DEFAULT_PROFILE_ID) {
    const { llmConfig, llmReady, complete } = await import('./llm/provider.ts');
    const cfg = llmConfig(db);
    if (!llmReady(db)) {
      out.push({ provider: 'assistant', configured: false, ok: false, detail: 'not configured' });
    } else {
      try {
        // One token against the configured model: enough to prove the key, the
        // base URL and the model name together, which is what actually fails.
        const reply = await complete(cfg, 'Reply with the single word: ok.', [{ role: 'user', text: 'ping' }], [], 20_000);
        out.push({
          provider: 'assistant',
          configured: true,
          ok: true,
          detail: `${cfg.provider} answered as ${reply.model}`,
        });
      } catch (e) {
        out.push({ provider: 'assistant', configured: true, ok: false, detail: errMessage(e) });
      }
    }
  }

  return out;
}
