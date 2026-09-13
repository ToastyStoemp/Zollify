/**
 * AES-256-GCM encrypt/decrypt for the TOTP secret at rest. The key is derived
 * from the server's JWT secret, so there's no new secret to manage.
 */
import { scryptSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBox {
  encrypt(value: unknown): string;
  decrypt<T = unknown>(blob: string): T;
}

export function makeSecretBox(secret: string): SecretBox {
  const key = scryptSync(secret, 'zolltool-totp-v1', 32);
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
    },
    decrypt(blob) {
      const [v, ivB64, tagB64, ctB64] = String(blob).split('.');
      if (v !== 'v1' || !ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted blob.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
      return JSON.parse(pt.toString('utf8'));
    },
  };
}
