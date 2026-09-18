/**
 * End-to-end over real HTTP: the MCP endpoint answers tools/list and a tool
 * call, the secret gates access, and the rate limiter bites. This is the
 * Phase 1 checkpoint, automated.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SECRET = 'f'.repeat(64);
process.env['MCP_SECRET'] = SECRET;
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'tally-')), 'test.db');
process.env['MCP_RATE_LIMIT'] = '60';
process.env['CRON_ENABLED'] = 'false';
process.env['TRUST_PROXY'] = '1';

const { clientKey, createApp, createRateLimiter, secretMatches } = await import('../src/index.ts');

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function rpc(method: string, params: unknown = {}, secret = SECRET): Promise<Response> {
  return fetch(`${base}/mcp/${secret}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** The transport may answer as SSE; pull the JSON payload out either way. */
async function body(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const line = text
    .split('\n')
    .map((l) => (l.startsWith('data:') ? l.slice(5).trim() : l))
    .find((l) => l.trim().startsWith('{'));
  return JSON.parse(line ?? text) as Record<string, unknown>;
}

describe('health', () => {
  it('reports ok with a live database', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json['ok']).toBe(true);
    expect(json['base_currency']).toBe('CAD');
  });
});

describe('auth', () => {
  it('404s a wrong secret, giving nothing away', async () => {
    const res = await rpc('tools/list', {}, 'a'.repeat(64));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('treats an empty secret as the OAuth endpoint and challenges for a token', async () => {
    // /mcp/ resolves to /mcp, which authenticates by bearer token now.
    const res = await fetch(`${base}/mcp/`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata');
  });

  it('405s a GET on the right secret — the transport is stateless', async () => {
    const res = await fetch(`${base}/mcp/${SECRET}`);
    expect(res.status).toBe(405);
  });

  it('compares secrets in constant time and rejects a short prefix', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET.slice(0, 32), SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches(SECRET, '')).toBe(false);
  });
});

describe('tools', () => {
  it('lists every tool, and no tool that can move money', async () => {
    const res = await rpc('tools/list');
    expect(res.status).toBe(200);
    const json = await body(res);
    const tools = (json['result'] as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'backup_now',
      'create_profile',
      'delete_merchant_rule',
      'delete_profile',
      'fx_rates',
      'get_activities',
      'get_cashflow',
      'get_contribution_room',
      'get_financial_summary',
      'get_holdings',
      'get_net_worth',
      'get_net_worth_history',
      'get_spend_by_merchant',
      'get_transactions',
      'list_accounts',
      'list_merchant_rules',
      'list_profiles',
      'move_account',
      'plaid_relink_url',
      'plaid_status',
      'rename_profile',
      'set_account_currency',
      'set_contributed',
      'set_merchant_rule',
      'set_room_limit',
      'set_transaction_category',
      'sync_now',
      'sync_report',
    ]);
    expect(names.some((n) => /trade|order|buy|sell|transfer|withdraw|pay/.test(n))).toBe(false);
  });

  it('answers get_net_worth on an empty database with zeros, not an error', async () => {
    const json = await body(await rpc('tools/call', { name: 'get_net_worth', arguments: {} }));
    const result = json['result'] as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as Record<string, number>;
    expect(payload['net_worth_cad']).toBe(0);
  });

  it('answers get_financial_summary over HTTP with every section present', async () => {
    const json = await body(
      await rpc('tools/call', {
        name: 'get_financial_summary',
        arguments: { sections: ['all'] },
      }),
    );
    const result = json['result'] as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload['omitted_sections']).toEqual([]);
    for (const section of ['net_worth', 'accounts', 'holdings', 'activities', 'cashflow', 'transactions', 'connections', 'sync']) {
      expect(payload[section], section).toBeDefined();
    }
  });

  it('rejects a bad argument instead of guessing', async () => {
    const json = await body(
      await rpc('tools/call', { name: 'get_cashflow', arguments: { start: 'last-june', end: 'now' } }),
    );
    const result = json['result'] as { isError?: boolean } | undefined;
    expect(result?.isError ?? json['error'] !== undefined).toBe(true);
  });

  it('reports a missing account when moving it to a profile', async () => {
    const json = await body(
      await rpc('tools/call', {
        name: 'move_account',
        arguments: { account_id: 'snaptrade:does-not-exist', profile: 'me' },
      }),
    );
    const result = json['result'] as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('does-not-exist');
  });

  it('lists the default profile and caps creation at five', async () => {
    const listed = await body(await rpc('tools/call', { name: 'list_profiles', arguments: {} }));
    const payload = JSON.parse(
      (listed['result'] as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { count: number; max: number };
    expect(payload.max).toBe(5);
    expect(payload.count).toBeGreaterThanOrEqual(1);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit then blocks within the window', () => {
    const allow = createRateLimiter(3, 60_000);
    const t = Date.now();
    expect(allow('ip', t)).toBe(true);
    expect(allow('ip', t)).toBe(true);
    expect(allow('ip', t)).toBe(true);
    expect(allow('ip', t)).toBe(false);
  });

  it('lets the window slide', () => {
    const allow = createRateLimiter(1, 1000);
    const t = Date.now();
    expect(allow('ip', t)).toBe(true);
    expect(allow('ip', t + 500)).toBe(false);
    expect(allow('ip', t + 1500)).toBe(true);
  });

  it('tracks callers independently', () => {
    const allow = createRateLimiter(1, 60_000);
    const t = Date.now();
    expect(allow('a', t)).toBe(true);
    expect(allow('b', t)).toBe(true);
    expect(allow('a', t)).toBe(false);
  });
});

describe('proxy awareness', () => {
  it('applies the configured proxy-hop count to the app', () => {
    // Without this, req.ip is the reverse proxy's address for every request and
    // the per-IP limiter collapses into one bucket shared by the whole internet.
    expect(createApp().get('trust proxy')).toBe(1);
  });

  it('keys the limiter on the resolved client address', () => {
    expect(clientKey({ ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('falls back to a constant rather than throwing when there is no address', () => {
    expect(clientKey({ ip: undefined })).toBe('unknown');
  });
});

describe('login failure limiter', () => {
  it('counts failures, not successes — a busy legitimate user is never locked out', async () => {
    const { createFailureLimiter } = await import('../src/ratelimit.ts');
    const lim = createFailureLimiter(3, 60_000);
    const t = Date.now();
    // A hundred successful sign-ins must not move it at all.
    for (let i = 0; i < 100; i += 1) lim.reset('ip');
    expect(lim.blocked('ip', t)).toBe(false);

    lim.fail('ip', t);
    lim.fail('ip', t);
    expect(lim.blocked('ip', t)).toBe(false);
    lim.fail('ip', t);
    expect(lim.blocked('ip', t)).toBe(true);
  });

  it('clears the record on a success, so one typo does not linger', async () => {
    const { createFailureLimiter } = await import('../src/ratelimit.ts');
    const lim = createFailureLimiter(2, 60_000);
    const t = Date.now();
    lim.fail('ip', t);
    lim.fail('ip', t);
    expect(lim.blocked('ip', t)).toBe(true);
    lim.reset('ip');
    expect(lim.blocked('ip', t)).toBe(false);
  });

  it('lets the window expire', async () => {
    const { createFailureLimiter } = await import('../src/ratelimit.ts');
    const lim = createFailureLimiter(1, 1000);
    const t = Date.now();
    lim.fail('ip', t);
    expect(lim.blocked('ip', t + 500)).toBe(true);
    expect(lim.blocked('ip', t + 1500)).toBe(false);
  });

  it('tracks addresses independently', async () => {
    const { createFailureLimiter } = await import('../src/ratelimit.ts');
    const lim = createFailureLimiter(1, 60_000);
    const t = Date.now();
    lim.fail('a', t);
    expect(lim.blocked('a', t)).toBe(true);
    expect(lim.blocked('b', t)).toBe(false);
  });
});
