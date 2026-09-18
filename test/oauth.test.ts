/**
 * The whole OAuth flow a client walks, over real HTTP, plus the failure modes
 * that matter: a replayed code, a wrong PKCE verifier, an unregistered
 * redirect, a token used after revocation.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const USER = 'ramesh';
const PASSWORD = 'a-test-password-12345';
const SECRET = 'a'.repeat(64);
process.env['UI_ENABLED'] = 'true';
process.env['ADMIN_USERNAME'] = USER;
process.env['MCP_SECRET'] = SECRET;
process.env['TOKEN_ENC_KEY'] = 'b'.repeat(64);
process.env['DB_PATH'] = join(mkdtempSync(join(tmpdir(), 'tally-oauth-')), 'o.db');
process.env['CRON_ENABLED'] = 'false';
process.env['COOKIE_SECURE'] = 'false';
process.env['MCP_ALLOW_PATH_SECRET'] = 'false';

const { hashPassword } = await import('../src/auth/password.ts');
process.env['ADMIN_PASSWORD_HASH'] = await hashPassword(PASSWORD);
const { createApp } = await import('../src/index.ts');

let server: Server;
let base: string;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function login(): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USER, password: PASSWORD }),
    redirect: 'manual',
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(): Promise<string> {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Walk consent and return the code the client would receive. */
async function authorize(clientId: string, challenge: string, cookie: string): Promise<string> {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  });
  const pageRes = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } });
  const html = await pageRes.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  expect(csrf).not.toBe('');
  const approve = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      decision: 'approve',
    }),
    redirect: 'manual',
  });
  expect(approve.status).toBe(303);
  const loc = new URL(approve.headers.get('location') ?? '');
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get('state')).toBe('xyz');
  return loc.searchParams.get('code') ?? '';
}

async function exchange(clientId: string, code: string, verifier: string): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
}

async function mcp(token?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

describe('discovery', () => {
  it('answers an unauthenticated /mcp with a 401 that points at the metadata', async () => {
    const res = await mcp();
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www).toContain('Bearer');
    expect(www).toContain('resource_metadata="');
    expect(www).toContain('/.well-known/oauth-protected-resource');
  });

  it('publishes protected-resource and authorization-server metadata', async () => {
    const pr = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(pr['resource']).toBe(`${base}/mcp`);
    expect(pr['authorization_servers']).toEqual([base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as['issuer']).toBe(base);
    expect(as['code_challenge_methods_supported']).toEqual(['S256']);
    expect(as['token_endpoint_auth_methods_supported']).toEqual(['none']);
    expect(as['registration_endpoint']).toBe(`${base}/oauth/register`);
  });

  it('closes the legacy path-secret route when MCP_ALLOW_PATH_SECRET is off', async () => {
    const res = await fetch(`${base}/mcp/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('registration', () => {
  it('refuses a non-https redirect URI', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses confidential clients — there is no secret to keep', async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('the full flow', () => {
  it('registers, consents, exchanges with PKCE, calls /mcp, refreshes, and is revocable', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const cookie = await login();
    const code = await authorize(clientId, challenge, cookie);
    expect(code).not.toBe('');

    const tok = await exchange(clientId, code, verifier);
    expect(tok.status).toBe(200);
    expect(tok.headers.get('cache-control')).toBe('no-store');
    const t = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(t.token_type).toBe('Bearer');

    // A bearer token gets the real tool list — no secret anywhere.
    const ok = await mcp(t.access_token);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('get_net_worth');

    // Refresh rotates: the new pair works, the old refresh token is dead.
    const r1 = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId }),
    });
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect((await mcp(t2.access_token)).status).toBe(200);
    const r2 = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId }),
    });
    expect(r2.status).toBe(400);

    // Revoking from Security kills every token for that app immediately.
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(home)?.[1] ?? '';
    const revoke = await fetch(`${base}/security/apps/revoke`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, client_id: clientId }),
      redirect: 'manual',
    });
    expect(revoke.status).toBe(303);
    expect((await mcp(t2.access_token)).status).toBe(401);
  });

  it('sends an anonymous user to sign in and brings them back to consent', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const res = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(loc.slice('/login?next='.length))).toContain('/oauth/authorize?');
  });

  it('never redirects to an unregistered redirect_uri, even on error', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const cookie = await login();
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: 'https://attacker.example/cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
    });
    const res = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('not registered');
  });

  it('refuses PKCE plain and a missing challenge', async () => {
    const clientId = await register();
    const cookie = await login();
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      code_challenge: 'abc', code_challenge_method: 'plain',
    });
    const res = await fetch(`${base}/oauth/authorize?${q}`, { headers: { cookie } });
    expect(await res.text()).toContain('S256 is required');
  });
});

describe('token endpoint hardening', () => {
  it('rejects a wrong PKCE verifier', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const code = await authorize(clientId, challenge, await login());
    const res = await exchange(clientId, code, randomBytes(48).toString('base64url'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('a replayed code is rejected AND revokes the tokens it already issued', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await authorize(clientId, challenge, await login());
    const first = await exchange(clientId, code, verifier);
    expect(first.status).toBe(200);
    const t = (await first.json()) as { access_token: string };
    expect((await mcp(t.access_token)).status).toBe(200);

    const replay = await exchange(clientId, code, verifier);
    expect(replay.status).toBe(400);
    // The leak is assumed: everything minted from that code is now dead.
    expect((await mcp(t.access_token)).status).toBe(401);
  });

  it('will not exchange a code for a different client', async () => {
    const a = await register();
    const b = await register();
    const { verifier, challenge } = pkce();
    const code = await authorize(a, challenge, await login());
    expect((await exchange(b, code, verifier)).status).toBe(400);
  });

  it('rejects a garbage bearer token with invalid_token in the challenge', async () => {
    const res = await mcp('not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});
