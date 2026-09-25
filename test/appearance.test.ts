/**
 * Three small things a user asked for after running it: calling the app
 * something other than "tally", a Plaid redirect URI that survives a chain of
 * proxies, and the transfer categories always being on offer so a mislabelled
 * card payment can be hidden by hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { initDb, openDb, type DB } from '../src/db.ts';
import { appName, cleanAppName, getSetting, setSetting } from '../src/settings.ts';
import { createProfile } from '../src/profiles.ts';
import { knownCategories, NOT_SPENDING_CATEGORIES } from '../src/queries.ts';
import { originOf } from '../src/web/oauth.ts';
import { page } from '../src/web/layout.ts';
import { connectionsPage, loginPage } from '../src/web/pages.ts';
import { html } from '../src/lib/html.ts';

let db: DB;

beforeEach(() => {
  db = initDb(openDb(':memory:'));
});

afterEach(() => {
  delete process.env['APP_NAME'];
});

describe('the app name', () => {
  it('is "tally" until someone says otherwise', () => {
    expect(appName(db)).toBe('tally');
  });

  it('comes from Settings, or from the environment', () => {
    process.env['APP_NAME'] = 'Household Money';
    expect(appName(db)).toBe('Household Money');
    setSetting(db, 'APP_NAME', 'Vinny Finance');
    // The database wins, like every other setting.
    expect(appName(db)).toBe('Vinny Finance');
  });

  it('is tidied before it is stored', () => {
    expect(cleanAppName('  Our \t  Money\n')).toBe('Our Money');
    expect(cleanAppName('bell\u0007name')).toBe('bellname');
    expect(cleanAppName('x'.repeat(80))).toHaveLength(40);
  });

  it('refuses a blank name rather than storing one', () => {
    expect(() => setSetting(db, 'APP_NAME', '   ')).toThrow(/cannot be blank/);
    expect(getSetting(db, 'APP_NAME')).toBe('');
  });

  it('belongs to the install, so a second profile cannot set it', () => {
    createProfile(db, 'Partner');
    expect(() => setSetting(db, 'APP_NAME', 'Theirs', 'partner')).toThrow(/whole install/);
  });

  it('reaches the navigation, the tab title and the sign-in screen, escaped', () => {
    const out = page({ title: 'Overview', nonce: 'n', body: html`<p>x</p>`, appName: '<b>Ours</b>' });
    expect(out).toContain('<title>Overview · &lt;b&gt;Ours&lt;/b&gt;</title>');
    expect(out).toContain('<span class="brand-name">&lt;b&gt;Ours&lt;/b&gt;</span>');
    expect(out).not.toContain('<b>Ours</b>');
    expect(loginPage({ csrf: '', totpEnabled: false, appName: 'Our Money' }).value).toContain(
      '<h1>Our Money</h1>',
    );
  });

  it('keeps crediting the project in the footer after a rename', () => {
    const renamed = page({ title: 't', nonce: 'n', body: html``, appName: 'Our Money' });
    expect(renamed).toContain('Our Money runs on tally, open source, MIT.');
    expect(renamed).toContain('github.com/yrameshk26/Tally');
    const plain = page({ title: 't', nonce: 'n', body: html`` });
    expect(plain).toContain('tally — open source, MIT.');
  });
});

describe('the address the browser used', () => {
  const req = (proto: string | string[] | undefined, protocol = 'http'): Request =>
    ({
      headers: proto === undefined ? {} : { 'x-forwarded-proto': proto },
      protocol,
      get: (h: string) => (h.toLowerCase() === 'host' ? 'money.example.com' : undefined),
    }) as unknown as Request;

  it('takes the scheme from the proxy', () => {
    expect(originOf(req('https'))).toBe('https://money.example.com');
  });

  it('takes the first entry when a chain of proxies each added one', () => {
    // A CDN in front of Caddy: the browser spoke https to the CDN.
    expect(originOf(req('https, http'))).toBe('https://money.example.com');
    expect(originOf(req(['https', 'http']))).toBe('https://money.example.com');
  });

  it('ignores a header that is not a scheme, rather than building a URL from it', () => {
    expect(originOf(req('javascript'))).toBe('http://money.example.com');
    expect(originOf(req(undefined, 'https'))).toBe('https://money.example.com');
  });
});

describe('the Plaid setup panel', () => {
  const panel = (redirectUri: string): string =>
    connectionsPage({
      profiles: [],
      activeProfile: { id: 'me', name: 'Me' } as never,
      unsynced: 0,
      items: [],
      snaptradeReady: false,
      wiseReady: false,
      plaidReady: true,
      redirectUri,
      plaidEnv: 'production',
      products: ['transactions'],
      optionalProducts: [],
      statementsEnabled: false,
      countryCodes: ['CA'],
      csrf: 'c',
      nonce: 'n',
    }).value;

  it('says why an http redirect URI on a real domain will not match', () => {
    // A TLS-terminating proxy that does not pass the scheme on.
    expect(panel('http://money.example.com/connections/oauth')).toContain('X-Forwarded-Proto');
  });

  it('stays quiet for https, and for local development', () => {
    expect(panel('https://money.example.com/connections/oauth')).not.toContain('X-Forwarded-Proto');
    expect(panel('http://localhost:8787/connections/oauth')).not.toContain('X-Forwarded-Proto');
    expect(panel('http://127.0.0.1:8787/connections/oauth')).not.toContain('X-Forwarded-Proto');
  });
});

describe('the category picker', () => {
  it('offers the transfer categories before any row has one', () => {
    // An empty database: nothing synced, no rules, no custom categories.
    for (const c of NOT_SPENDING_CATEGORIES) expect(knownCategories(db)).toContain(c);
  });

  it('lists each one once, in order', () => {
    const cats = knownCategories(db);
    expect(new Set(cats).size).toBe(cats.length);
    expect([...cats].sort()).toEqual(cats);
  });
});
