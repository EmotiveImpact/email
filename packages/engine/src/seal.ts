/**
 * Seals secrets we must keep but never show, such as a booking system's access tokens, with
 * AES-256-GCM under a key derived from the platform's signing secret. A database copy alone is
 * not enough to use them.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const keyFrom = (secret: string) => createHash('sha256').update(`seal:v1:${secret}`).digest();

export function seal(secret: string, plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

export function unseal(secret: string, sealed: string) {
  const [version, iv, body, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !body || !tag) throw new Error('Not a sealed value.');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
