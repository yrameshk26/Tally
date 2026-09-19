/** Central env parsing. Nothing else in the codebase reads process.env directly. */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export type OwnerTag = 'me' | 'spouse' | 'joint';

export const config = {
  port: int('PORT', 8787),
  mcpSecret: str('MCP_SECRET'),
  dbPath: str('DB_PATH', 'data/finmcp.db'),
  mcpRateLimit: int('MCP_RATE_LIMIT', 60),
  /**
   * Keep the legacy /mcp/<secret> route alive. On by default so an existing
   * connector keeps working through the migration to OAuth; turn it off once
   * the connector has been re-added, because a secret in a URL path ends up in
   * reverse-proxy access logs.
   */
  mcpAllowPathSecret: bool('MCP_ALLOW_PATH_SECRET', true),
  // Hops of reverse proxy in front of us. 0 = direct. Behind Traefik/Dokploy
  // this must be 1, or every request appears to come from the proxy's IP and
  // the rate limiter degrades into one shared bucket for the whole internet.
  trustProxy: int('TRUST_PROXY', 0),
  logLevel: str('LOG_LEVEL', 'info'),

  baseCurrency: str('BASE_CURRENCY', 'CAD').toUpperCase(),
  defaultOwner: str('DEFAULT_OWNER', 'me') as OwnerTag,

  cronEnabled: bool('CRON_ENABLED', true),
  cronHour: int('CRON_HOUR', 4),
  cronMinute: int('CRON_MINUTE', 15),
  backupKeepDays: int('BACKUP_KEEP_DAYS', 14),

  snaptrade: {
    clientId: str('SNAPTRADE_CLIENT_ID'),
    consumerKey: str('SNAPTRADE_CONSUMER_KEY'),
    transport: str('SNAPTRADE_TRANSPORT', 'rest') as 'rest' | 'sdk',
    userId: str('SNAPTRADE_USER_ID'),
    userSecret: str('SNAPTRADE_USER_SECRET'),
    excludeCards: bool('EXCLUDE_SNAPTRADE_CARDS', true),
    balanceHistory: bool('SNAPTRADE_BALANCE_HISTORY', false),
    baseUrl: str('SNAPTRADE_BASE_URL', 'https://api.snaptrade.com/api/v1'),
  },

  plaid: {
    clientId: str('PLAID_CLIENT_ID'),
    secret: str('PLAID_SECRET'),
    env: str('PLAID_ENV', 'production'),
    // Required products limit which institutions Link will even offer, so keep
    // this minimal. Anything nice-to-have goes in optionalProducts, which Plaid
    // fetches best-effort and which never blocks Item creation.
    products: list('PLAID_PRODUCTS', ['transactions']),
    optionalProducts: list('PLAID_OPTIONAL_PRODUCTS', ['liabilities']),
    countryCodes: list('PLAID_COUNTRY_CODES', ['US', 'CA']),
    linkPort: int('PLAID_LINK_PORT', 8788),
    redirectUri: str('PLAID_REDIRECT_URI'),
    transactionDays: int('PLAID_TRANSACTION_DAYS', 730),
    /** How far back Link asks for statements. Plaid's own cap is 24 months. */
    statementMonths: int('PLAID_STATEMENT_MONTHS', 24),
  },

  wise: {
    token: str('WISE_API_TOKEN'),
    baseUrl: str('WISE_API_BASE', 'https://api.transferwise.com'),
  },

  /**
   * The built-in chat assistant. Off unless a key is configured: turning it on
   * means this server sends account data to a third party on every message,
   * which is a different trust model from the rest of the app, where the data
   * only ever leaves in response to a request the user's own MCP client made.
   */
  llm: {
    provider: str('LLM_PROVIDER', 'anthropic'),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL'),
    baseUrl: str('LLM_BASE_URL'),
    /** How many tool round trips one answer may take before it must conclude. */
    maxSteps: int('LLM_MAX_STEPS', 8),
    /** Wall clock for one provider request. */
    timeoutMs: int('LLM_TIMEOUT_MS', 120_000),
  },

  // --- web UI ---
  uiEnabled: bool('UI_ENABLED', false),
  adminUsername: str('ADMIN_USERNAME'),
  /** Argon2id PHC string. Generate with `npm run hash-password`. */
  adminPasswordHash: str('ADMIN_PASSWORD_HASH'),
  /** Send the session cookie only over HTTPS. Defaults on behind a proxy. */
  cookieSecure: bool('COOKIE_SECURE', int('TRUST_PROXY', 0) > 0),
  /** Failed logins allowed per 15 minutes, per IP. */
  loginRateLimit: int('LOGIN_RATE_LIMIT', 10),
  /**
   * Sign the browser out after this many minutes without activity. This holds
   * every balance and transaction you own, so a tab left open on a machine
   * someone else can reach should not stay signed in. 0 turns it off and
   * leaves only the absolute lifetime in `src/auth/session.ts`. MCP is
   * unaffected: a connector authenticates with an OAuth token, not this
   * cookie, so Claude keeps working while the browser signs out.
   */
  sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 30),

  tokenEncKey: str('TOKEN_ENC_KEY'),
} as const;

export function snaptradeConfigured(): boolean {
  return Boolean(config.snaptrade.clientId && config.snaptrade.consumerKey);
}

export function plaidConfigured(): boolean {
  return Boolean(config.plaid.clientId && config.plaid.secret);
}

export function wiseConfigured(): boolean {
  return Boolean(config.wise.token);
}
