/**
 * A custom logo, uploaded from Settings.
 *
 * The one rule that matters: raster images only, identified by their bytes.
 * An SVG is a document that can carry script, and anyone who opened its URL
 * directly would run that script on this origin, inside the signed-in
 * session of an app that shows every balance in the household. A PNG, JPEG or
 * WebP served with its exact type and `nosniff` cannot do that. The name the
 * browser gave the file and the type it claimed are never trusted; the first
 * bytes decide.
 */
import { createHash } from 'node:crypto';
import type { DB } from './db.ts';
import { nowISO } from './lib/money.ts';

/** A nav mark is 22px and a sign-in mark 56px; this is generous for both. */
export const MAX_LOGO_BYTES = 256 * 1024;

export type LogoMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** What the bytes say they are, or null for anything else, SVG included. */
export function sniffImage(bytes: Uint8Array): LogoMime | null {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
      b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  const ascii = (from: number, to: number): string =>
    String.fromCharCode(...Array.from(bytes.subarray(from, to)));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export type Logo = { mime: LogoMime; data: Buffer; sha: string };

export function getLogo(db: DB): Logo | null {
  const row = db
    .prepare("SELECT mime, data, sha FROM brand_assets WHERE name = 'logo'")
    .get() as { mime: LogoMime; data: Buffer; sha: string } | undefined;
  return row ?? null;
}

/** Validates, then stores. Throws a message fit to show the user. */
export function setLogo(db: DB, bytes: Uint8Array): Logo {
  if (bytes.length === 0) throw new Error('That file is empty.');
  if (bytes.length > MAX_LOGO_BYTES) {
    throw new Error(`That file is ${String(Math.ceil(bytes.length / 1024))} KB; the limit is 256 KB.`);
  }
  const mime = sniffImage(bytes);
  if (!mime) throw new Error('Use a PNG, JPEG or WebP image. SVG is not accepted, since it can carry script.');
  const data = Buffer.from(bytes);
  const sha = createHash('sha256').update(data).digest('hex').slice(0, 16);
  db.prepare(
    `INSERT INTO brand_assets (name, mime, data, sha, updated_at) VALUES ('logo', ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET mime = excluded.mime, data = excluded.data,
                                     sha = excluded.sha, updated_at = excluded.updated_at`,
  ).run(mime, data, sha, nowISO());
  return { mime, data, sha };
}

export function deleteLogo(db: DB): boolean {
  return db.prepare("DELETE FROM brand_assets WHERE name = 'logo'").run().changes > 0;
}

/**
 * Where the page should load the logo from, or null for the built-in mark.
 * The content hash in the query makes the URL change whenever the image does,
 * so it can be cached for a year without ever showing a stale logo.
 */
export function logoUrl(db: DB): string | null {
  const row = db.prepare("SELECT sha FROM brand_assets WHERE name = 'logo'").get() as
    | { sha: string }
    | undefined;
  return row ? `/brand/logo?v=${row.sha}` : null;
}
