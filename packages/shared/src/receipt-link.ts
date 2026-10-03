/**
 * Online receipts - the link a customer scans after paying.
 *
 * The link carries a random token, never the sale id: 128 bits from the
 * platform CSPRNG, so receipts cannot be found by guessing or counting. The
 * token sits in the URL fragment (`#...`), which browsers never send to a
 * server, write into a Referer header or put in access logs - the page's own
 * script reads it and asks for the receipt in a POST body.
 */

/** 16 random bytes, base64url without padding: always 22 characters. */
export const RECEIPT_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Where the public receipt page lives, relative to the server origin. */
export const RECEIPT_PATH = '/p/pos/r';

export function newReceiptToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isReceiptToken(value: unknown): value is string {
  return typeof value === 'string' && RECEIPT_TOKEN_RE.test(value);
}

/** The full link for a QR code; `origin` is the server's, e.g. https://zollify.example. */
export function receiptLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${RECEIPT_PATH}#${token}`;
}
