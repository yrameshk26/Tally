/**
 * An uploaded logo is served from this origin, to a signed-in browser, next to
 * every balance in the household. So the tests are mostly about what must not
 * get through: an SVG (a document that can run script), HTML dressed up with an
 * image's name, and anything too large to be a logo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initDb, openDb, type DB } from '../src/db.ts';
import { MAX_LOGO_BYTES, deleteLogo, getLogo, logoUrl, setLogo, sniffImage } from '../src/brand.ts';
import { page } from '../src/web/layout.ts';
import { html } from '../src/lib/html.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

let db: DB;
beforeEach(() => {
  db = initDb(openDb(':memory:'));
});

describe('telling what a file is', () => {
  it('knows the three raster formats by their bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(WEBP)).toBe('image/webp');
  });

  it('refuses SVG in every spelling', () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg/>',
      '﻿<svg onload="alert(1)"/>',
    ]) {
      expect(sniffImage(text(svg)), svg).toBeNull();
    }
  });

  it('refuses HTML, whatever it is called', () => {
    expect(sniffImage(text('<html><script>alert(document.cookie)</script>'))).toBeNull();
  });

  it('refuses formats it does not serve, and fragments too short to judge', () => {
    expect(sniffImage(text('GIF89a'))).toBeNull();
    expect(sniffImage(Uint8Array.from([0x89, 0x50]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe('storing a logo', () => {
  it('keeps a valid image, with the type its bytes declare', () => {
    setLogo(db, PNG);
    expect(getLogo(db)?.mime).toBe('image/png');
  });

  it('says why it refused, in words a person can act on', () => {
    expect(() => setLogo(db, text('<svg/>'))).toThrow(/SVG is not accepted/);
    expect(() => setLogo(db, new Uint8Array())).toThrow(/empty/);
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(PNG);
    expect(() => setLogo(db, big)).toThrow(/256 KB/);
    expect(getLogo(db)).toBeNull();
  });

  it('changes its URL whenever the image changes, so a year of caching is safe', () => {
    expect(logoUrl(db)).toBeNull();
    setLogo(db, PNG);
    const first = logoUrl(db);
    setLogo(db, JPEG);
    expect(logoUrl(db)).not.toBe(first);
    expect(logoUrl(db)).toMatch(/^\/brand\/logo\?v=[0-9a-f]{16}$/);
  });

  it('goes back to the built-in mark when removed', () => {
    setLogo(db, PNG);
    expect(deleteLogo(db)).toBe(true);
    expect(logoUrl(db)).toBeNull();
  });
});

describe('the page', () => {
  it('uses the uploaded logo for the mark and the tab icon', () => {
    const out = page({ title: 't', nonce: 'n', body: html``, logoUrl: '/brand/logo?v=abc' });
    expect(out).toContain('<img class="mark mark-img" src="/brand/logo?v=abc"');
    expect(out).toContain('<link rel="icon" href="/brand/logo?v=abc">');
    expect(out).not.toContain('/favicon.svg');
  });

  it('keeps the built-in mark when there is none', () => {
    const out = page({ title: 't', nonce: 'n', body: html`` });
    expect(out).toContain('/favicon.svg');
    expect(out).not.toContain('<img class="mark');
  });
});
