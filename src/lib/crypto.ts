/**
 * AES-256-GCM at-rest encryption for Plaid access tokens.
 *
 * Ciphertext format: enc:v1:<iv-b64>:<tag-b64>:<ct-b64>. Plaintext rows written
 * before TOKEN_ENC_KEY existed stay readable, so the migration in db.ts can
 * encrypt them in place exactly once and re-running it is a no-op.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function keyBytes(rawKey: string): Buffer {
  // Accept either 64 hex chars (preferred) or any passphrase, hashed to 32 bytes.
  if (/^[0-9a-f]{64}$/i.test(rawKey)) return Buffer.from(rawKey, 'hex');
  return createHash('sha256').update(rawKey, 'utf8').digest();
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptToken(plain: string, rawKey: string): string {
  if (!rawKey) return plain;
  if (isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(rawKey), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptToken(stored: string, rawKey: string): string {
  if (!isEncrypted(stored)) return stored;
  if (!rawKey) {
    throw new Error('TOKEN_ENC_KEY is required to read encrypted Plaid tokens');
  }
  const parts = stored.slice(PREFIX.length).split(':');
  const [ivB64, tagB64, ctB64] = parts;
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(rawKey), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
