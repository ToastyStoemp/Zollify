import { createSign } from 'node:crypto';

/**
 * Google Wallet's loyalty passes, as far as the loyalty module needs them:
 * one loyalty class per account (the programme), one loyalty object per
 * member (their card), a "Save to Google Wallet" link, and a balance update
 * after each sale. Talks to the Wallet Objects API with a service account:
 * the key signs a JWT bearer grant for an access token, and signs the save
 * link itself. Everything goes through `fetchFn`, so the tests stand in a
 * pretend Google.
 *
 * Google asks for a logo on a loyalty class; without one the class may be
 * refused, so the settings take a logo URL and the error says so.
 */

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}
export interface WalletConfig extends ServiceAccount {
  /** The issuer id from the Google Pay & Wallet console. */
  issuerId: string;
  /** A public PNG/JPEG for the pass; Google requires one on the class. */
  logoUrl: string;
}
export interface WalletCard {
  memberId: string;
  /** A QR with the card's link, or a Code 128 of the code for a handheld scanner. */
  barcodeType: 'QR_CODE' | 'CODE_128';
  /** What the barcode holds (the card's URL, or the code alone) and what is printed under it (the code). */
  barcodeValue: string;
  code: string;
  holder: string;
  balance: number;
  unit: string;
  rewards: number;
  nextText: string;
  cardUrl: string;
}
export interface WalletProgramme {
  accountId: string;
  issuerName: string;
  programme: string;
  rewardText: string;
}

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class WalletError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

/** The service account JSON from the Google Cloud console, as the two fields used. */
export function parseServiceAccount(json: string): ServiceAccount {
  let doc: { client_email?: unknown; private_key?: unknown };
  try {
    doc = JSON.parse(json) as typeof doc;
  } catch {
    throw new WalletError('That is not the service account JSON file.');
  }
  if (typeof doc.client_email !== 'string' || typeof doc.private_key !== 'string' || !doc.private_key.includes('PRIVATE KEY')) {
    throw new WalletError('The file needs a client_email and a private_key.');
  }
  return { clientEmail: doc.client_email, privateKey: doc.private_key };
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An RS256 JWT, as Google's APIs take them. */
export function signJwt(payload: Record<string, unknown>, privateKey: string): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).end().sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Ids on Google's side: the issuer id, a dot, and something of ours with only the characters it allows. */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '-');
export const classIdFor = (issuerId: string, accountId: string): string => `${issuerId}.${safe(`card-${accountId}`)}`;
export const objectIdFor = (issuerId: string, memberId: string): string => `${issuerId}.${safe(memberId)}`;

const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(sa: ServiceAccount, fetchFn: FetchFn): Promise<string> {
  const cached = tokens.get(sa.clientEmail);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = signJwt({ iss: sa.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }, sa.privateKey);
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new WalletError(`Google did not accept the service account (${res.status}).`, res.status);
  tokens.set(sa.clientEmail, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function call(cfg: WalletConfig, fetchFn: FetchFn, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await accessToken(cfg, fetchFn);
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

const failure = (what: string, r: { status: number; body: Record<string, unknown> }): WalletError => {
  const err = r.body.error as { message?: string } | undefined;
  return new WalletError(`${what}: Google answered ${r.status}${err?.message ? ` - ${err.message.slice(0, 160)}` : ''}.`, r.status);
};

/** The programme on Google's side, made or brought up to date. */
export async function ensureClass(cfg: WalletConfig, p: WalletProgramme, fetchFn: FetchFn): Promise<string> {
  const id = classIdFor(cfg.issuerId, p.accountId);
  const cls = {
    id,
    issuerName: p.issuerName.slice(0, 60) || 'Zollify',
    programName: p.programme.slice(0, 60) || 'Loyalty card',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: '#0e7c66',
    ...(cfg.logoUrl ? { programLogo: { sourceUri: { uri: cfg.logoUrl } } } : {}),
    textModulesData: [{ id: 'reward', header: 'Reward', body: p.rewardText.slice(0, 200) }],
  };
  const made = await call(cfg, fetchFn, 'POST', '/loyaltyClass', cls);
  if (made.status === 200) return id;
  if (made.status !== 409) throw failure(cfg.logoUrl ? 'Could not make the pass' : 'Could not make the pass (Google wants a logo URL)', made);
  const updated = await call(cfg, fetchFn, 'PUT', `/loyaltyClass/${encodeURIComponent(id)}`, cls);
  if (updated.status !== 200) throw failure('Could not update the pass', updated);
  return id;
}

/** A member's pass as Google holds it. */
export function objectFor(cfg: WalletConfig, p: WalletProgramme, card: WalletCard) {
  return {
    id: objectIdFor(cfg.issuerId, card.memberId),
    classId: classIdFor(cfg.issuerId, p.accountId),
    state: 'ACTIVE',
    accountId: card.code,
    accountName: card.holder.slice(0, 60) || 'Member',
    loyaltyPoints: { label: card.unit.slice(0, 1).toUpperCase() + card.unit.slice(1), balance: { int: card.balance } },
    secondaryLoyaltyPoints: { label: 'Rewards', balance: { int: card.rewards } },
    barcode: { type: card.barcodeType, value: card.barcodeValue, alternateText: card.code },
    textModulesData: [{ id: 'next', header: 'Next reward', body: card.nextText.slice(0, 200) }],
    linksModuleData: { uris: [{ uri: card.cardUrl, description: 'Your card' }] },
  };
}

/** The member's pass made or brought up to date - after each sale that earned or spent. */
export async function upsertObject(cfg: WalletConfig, p: WalletProgramme, card: WalletCard, fetchFn: FetchFn): Promise<void> {
  const obj = objectFor(cfg, p, card);
  const have = await call(cfg, fetchFn, 'GET', `/loyaltyObject/${encodeURIComponent(obj.id)}`);
  if (have.status === 404) {
    const made = await call(cfg, fetchFn, 'POST', '/loyaltyObject', obj);
    if (made.status !== 200) throw failure('Could not make the card', made);
    return;
  }
  if (have.status !== 200) throw failure('Could not read the card', have);
  const { loyaltyPoints, secondaryLoyaltyPoints, textModulesData, accountName, state } = obj;
  const patched = await call(cfg, fetchFn, 'PATCH', `/loyaltyObject/${encodeURIComponent(obj.id)}`, { loyaltyPoints, secondaryLoyaltyPoints, textModulesData, accountName, state });
  if (patched.status !== 200) throw failure('Could not update the card', patched);
}

/**
 * The "Add to Google Wallet" link: a JWT signed with the service account
 * that carries the whole object, so the pass saves even before the API has
 * seen it. `origin` is where the link is shown, which Google checks.
 */
export function saveLink(cfg: WalletConfig, p: WalletProgramme, card: WalletCard, origin: string): string {
  const jwt = signJwt(
    {
      iss: cfg.clientEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      origins: [origin],
      payload: { loyaltyObjects: [objectFor(cfg, p, card)] },
    },
    cfg.privateKey,
  );
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

/** For tests: forget cached access tokens. */
export function resetWalletTokens(): void {
  tokens.clear();
}
