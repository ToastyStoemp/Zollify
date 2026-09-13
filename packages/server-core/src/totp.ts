/**
 * RFC 6238 TOTP (authenticator 2FA) + recovery codes. SHA-1, 6 digits, 30s —
 * the universal authenticator-app default. Zero-dep (node:crypto).
 */
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri({ secret, account, issuer }: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

function hotp(secretBuf: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

export function generateToken(secret: string, now = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(now / 1000 / 30));
}

export function verifyToken(secret: string, token: string, { window = 1, now = Date.now() } = {}): boolean {
  const code = String(token || '').replace(/\D/g, '');
  if (code.length !== 6) return false;
  const secretBuf = base32Decode(secret);
  if (!secretBuf.length) return false;
  const counter = Math.floor(now / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretBuf, counter + i);
    if (expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}

export function generateRecoveryCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = randomBytes(5).toString('hex');
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export const hashRecovery = (code: string): string =>
  createHash('sha256').update(String(code).toLowerCase().replace(/\s/g, '')).digest('hex');
