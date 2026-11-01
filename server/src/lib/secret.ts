import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption for identity and bank numbers (PAN, Aadhaar, account numbers) held in the database:
 * AES-256-GCM with a key the database never sees (NES_DATA_KEY, 32 bytes in base64). Only the last
 * four characters are kept in clear for display. In production the key must be set; the test
 * system uses a fixed development key.
 */
let key: Buffer | null = null;
function dataKey() {
  if (key) return key;
  const k = process.env.NES_DATA_KEY;
  if (k) key = Buffer.from(k, 'base64');
  else if (process.env.NODE_ENV === 'production') throw new Error('NES_DATA_KEY is not set; identity and bank numbers cannot be stored.');
  else key = createHash('sha256').update('navshiksha-development-key-not-for-production').digest();
  if (key.length !== 32) throw new Error('NES_DATA_KEY must be 32 bytes, base64-encoded.');
  return key;
}

export function seal(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`;
}

export function open(sealed: string) {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown sealed value.');
  const d = createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

export const last4 = (s: string) => s.slice(-4);
export const mask = (l4: string | null | undefined, len = 10) => (l4 ? `${'•'.repeat(Math.max(0, len - 4))}${l4}` : '');

/** Files (question papers, answer keys): AES-256-GCM as one buffer, iv · tag · body. */
export function sealBytes(plain: Buffer | Uint8Array) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dataKey(), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function openBytes(sealed: Buffer | Uint8Array) {
  const b = Buffer.from(sealed);
  const d = createDecipheriv('aes-256-gcm', dataKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
