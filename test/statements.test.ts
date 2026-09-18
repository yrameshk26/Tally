/**
 * Statements are the most sensitive thing this system can touch — full account
 * numbers, the mailing address and every line item in one file. The invariant
 * worth defending is that they are never persisted, which no unit test can
 * observe directly, so it is asserted against the source itself: a future edit
 * that adds a cache or a temp file fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_STATEMENT_BYTES, statementWindow, statementsEnabled } from '../src/sources/statements.ts';
import { config } from '../src/config.ts';

const source = readFileSync(new URL('../src/sources/statements.ts', import.meta.url), 'utf8');

describe('statements are never persisted', () => {
  it('imports no filesystem module', () => {
    expect(source).not.toMatch(/from '(node:)?fs(\/promises)?'/);
    expect(source).not.toMatch(/require\(['"](node:)?fs/);
  });

  it('calls no write API', () => {
    for (const forbidden of [
      'writeFile',
      'createWriteStream',
      'appendFile',
      'mkdtemp',
      'tmpdir',
      'INSERT INTO',
      'UPDATE ',
    ]) {
      expect(source, `statements.ts must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never logs the file or a token', () => {
    const logs = source.match(/log\.(info|warn|error)\([^)]*\)/gs) ?? [];
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      // Facts about the file are fine — its size is not its contents. The
      // buffer itself, an encoding of it, or a credential are not.
      const withoutSizes = line.replace(/\bpdf\.byteLength\b/g, 'N');
      expect(withoutSizes, line).not.toMatch(/\bpdf\b|access_token|accessTokenFor|base64|secret/i);
    }
  });

  it('buffers as binary, because axios would otherwise corrupt the PDF', () => {
    expect(source).toContain("responseType: 'arraybuffer'");
  });
});

describe('statementWindow', () => {
  it('asks for whole months back from today, starting on the 1st', () => {
    const w = statementWindow(new Date('2026-09-18T00:00:00Z'));
    expect(w.end_date).toBe('2026-09-18');
    expect(w.start_date).toBe('2024-10-01');
  });

  it('never exceeds the 24 months Plaid allows', () => {
    const w = statementWindow(new Date('2026-09-18T00:00:00Z'));
    const months =
      (Number(w.end_date.slice(0, 4)) - Number(w.start_date.slice(0, 4))) * 12 +
      (Number(w.end_date.slice(5, 7)) - Number(w.start_date.slice(5, 7)));
    expect(months).toBeLessThanOrEqual(24);
  });

  it('crosses a year boundary correctly', () => {
    expect(statementWindow(new Date('2026-01-15T00:00:00Z')).start_date).toBe('2024-02-01');
  });
});

describe('configuration', () => {
  it('is off until statements is named as a Plaid product', () => {
    // The default product set is deliberately minimal — every product listed at
    // link time narrows which institutions Link will even offer.
    expect(statementsEnabled()).toBe(
      [...config.plaid.products, ...config.plaid.optionalProducts].includes('statements'),
    );
  });

  it('caps a single statement well under anything that could exhaust memory', () => {
    expect(MAX_STATEMENT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});

describe('consent is asked for, without taking Repair down with it', () => {
  const source = readFileSync(new URL('../src/sources/plaid.ts', import.meta.url), 'utf8');

  function body(fn: string): string {
    const start = source.indexOf(`export function ${fn}(`) >= 0
      ? source.indexOf(`export function ${fn}(`)
      : source.indexOf(`export async function ${fn}(`);
    expect(start, `${fn} not found`).toBeGreaterThan(-1);
    const next = source.indexOf('\nexport ', start + 10);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it('a plain repair names no products at all', () => {
    // Naming products in update mode made Plaid Link fail with an opaque
    // "internal error", which broke re-authentication for every bank —
    // including the ones whose logins were genuinely expired.
    const fn = body('createUpdateLinkToken');
    expect(fn).not.toContain("products: ['statements'");
    expect(fn).not.toContain('statements: statementWindow()');
  });

  it('consent is opt-in per call, so it cannot block a repair', () => {
    const fn = body('createUpdateLinkToken');
    expect(fn).toContain('opts.consent');
    expect(fn).toContain('additional_consented_products');
  });

  it('statements is consent-only, never an initialised product', () => {
    // In `products` it would hide every institution that lacks statements; in
    // `optional_products` it would be initialised and billed on every Item.
    const required = body('plaidOptionalProducts');
    expect(required).toContain('CONSENT_ONLY');
    expect(statementsEnabled()).toBe(
      [...config.plaid.products, ...config.plaid.optionalProducts].includes('statements'),
    );
  });

  it('a new link collects the consent up front', () => {
    const fn = body('createLinkToken');
    expect(fn).toContain('additional_consented_products');
    expect(fn).toContain('statements: statementWindow()');
  });
});

describe('institution support is per bank, and tri-state', () => {
  const plaid = readFileSync(new URL('../src/sources/plaid.ts', import.meta.url), 'utf8');
  const stmts = readFileSync(new URL('../src/sources/statements.ts', import.meta.url), 'utf8');

  it('treats unknown as "offer it anyway", never as a no', () => {
    // Hiding a capability we have not checked is worse than an action that
    // might fail with a clear message.
    expect(plaid).toContain('products === null ? null : products.includes');
    expect(stmts).toContain("supportsStatements(item) === false");
  });

  it('skips the API call for a bank that cannot serve statements', () => {
    // BMO (US) does not offer the product. Calling anyway returns an error that
    // tells the user to re-consent — advice that can never succeed.
    const i = stmts.indexOf('supportsStatements(item) === false');
    const after = stmts.slice(i, i + 500);
    expect(after).toContain('does not offer statements');
    expect(after).toContain('continue;');
  });

  it('does not send a redirect-URI hint for an unrelated INVALID_FIELD', () => {
    // "statements not supported by BMO (US) — add the redirect URI to the
    // dashboard" sent the reader to the wrong page entirely.
    expect(plaid).toContain('function contextualHint');
    const hints = plaid.slice(plaid.indexOf('const HINTS'), plaid.indexOf('const HINTS') + 900);
    expect(hints).not.toContain('INVALID_FIELD:');
  });

  it('looks the institution up even when the Item itself is broken', () => {
    // What a bank offers has nothing to do with whether this connection's login
    // has expired, and the lookup needs no access token. Inside the try block,
    // a login_required Item stayed "unknown" forever.
    const sync = plaid.slice(plaid.indexOf('export async function syncPlaid'));
    const call = sync.indexOf('refreshInstitutionProducts(db, item)');
    const tryBlock = sync.indexOf('    try {');
    expect(call).toBeGreaterThan(-1);
    expect(call, 'the lookup must precede the try block').toBeLessThan(tryBlock);
  });

  it('caches the lookup rather than calling Plaid per page render', () => {
    expect(plaid).toContain('institution_products');
    expect(plaid).toContain('refreshInstitutionProducts');
    // A failed lookup must leave the cache alone, not record a wrong answer.
    const fn = plaid.slice(plaid.indexOf('export async function refreshInstitutionProducts'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toContain('return null;');
  });
});
