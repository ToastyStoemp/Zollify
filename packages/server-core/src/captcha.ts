/**
 * Zero-dep proof-of-work CAPTCHA for account registration. The server issues a
 * signed challenge; the client must find a `solution` whose sha256(nonce:solution)
 * begins with N zero bits before registering. Cheap for a real device, expensive
 * for mass automated signups. (Swappable for Turnstile later.)
 */
import { createHmac, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const DIFFICULTY = Math.min(24, Math.max(8, Number(process.env.CAPTCHA_BITS || 18)));
const TTL_MS = 10 * 60 * 1000;

/**
 * The signing key. Derived from the gateway's own secret (configureCaptchaKey,
 * called at boot); until then a random per-process key - never a value from
 * the source, which anyone could use to forge an easy challenge.
 */
let key: Buffer = randomBytes(32);
export function configureCaptchaKey(gatewaySecret: string): void {
  key = Buffer.from(hkdfSync('sha256', gatewaySecret, 'zollify-captcha', 'challenge-signing-v1', 32));
}
/** The least work a challenge may ask for, whatever it says: a forged or tampered easy one fails. */
const MIN_BITS: Record<ChallengePurpose, number> = { register: DIFFICULTY, receipt: 10, signup: 10 };
const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (payload: string): string => b64url(createHmac('sha256', key).update(payload).digest());

/**
 * A challenge is bound to what it unlocks. The online receipt page uses a far
 * cheaper difficulty than registration, so without the purpose in the signed
 * payload a receipt challenge would be a discount on signing up.
 */
export type ChallengePurpose = 'register' | 'receipt' | 'signup';

export function issueChallenge(
  purpose: ChallengePurpose = 'register',
  difficulty: number = DIFFICULTY,
): { token: string; nonce: string; difficulty: number } {
  const nonce = randomBytes(16).toString('hex');
  const exp = Date.now() + TTL_MS;
  const payload = b64url(Buffer.from(JSON.stringify({ nonce, difficulty, exp, purpose })));
  return { token: `${payload}.${sign(payload)}`, nonce, difficulty };
}

function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    for (let m = 7; m >= 0; m--) {
      if ((byte >> m) & 1) return bits;
      bits += 1;
    }
    break;
  }
  return bits;
}

const usedNonces = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [n, e] of usedNonces) if (now >= e) usedNonces.delete(n);
}, 5 * 60 * 1000).unref?.();

export function verifyChallenge(
  token: string,
  solution: string | number,
  purpose: ChallengePurpose = 'register',
): { ok: boolean; error?: string } {
  if (!token || solution == null) return { ok: false, error: 'Missing CAPTCHA.' };
  const dot = String(token).lastIndexOf('.');
  if (dot < 1) return { ok: false, error: 'Malformed CAPTCHA.' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return { ok: false, error: 'Invalid CAPTCHA.' };
  }
  let data: { nonce: string; difficulty: number; exp: number; purpose?: ChallengePurpose };
  try {
    data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  } catch {
    return { ok: false, error: 'Malformed CAPTCHA.' };
  }
  // Challenges minted before purposes existed were all for registration.
  if ((data.purpose ?? 'register') !== purpose) return { ok: false, error: 'Invalid CAPTCHA.' };
  if (!data.exp || Date.now() > data.exp) return { ok: false, error: 'CAPTCHA expired - please retry.' };
  if (usedNonces.has(data.nonce)) return { ok: false, error: 'CAPTCHA already used.' };
  const digest = createHash('sha256').update(`${data.nonce}:${solution}`).digest();
  if (!(data.difficulty >= MIN_BITS[purpose]) || leadingZeroBits(digest) < data.difficulty) return { ok: false, error: 'CAPTCHA not solved.' };
  usedNonces.set(data.nonce, data.exp);
  return { ok: true };
}
