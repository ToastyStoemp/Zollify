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

/**
 * A page a sale line points the customer to - a commission's tracking page,
 * say - printed on the receipt as a QR code and shown on the online receipt.
 *
 * Only a public page of the server that holds the sale (`/p/...`), never an
 * address a module or a synced record could pick: a receipt is something the
 * customer trusts, so it must not carry them anywhere else.
 */
export interface ReceiptLineLink {
  /** What the customer is told the code is for, e.g. "Follow your commission". */
  label: string;
  /** Server-relative: `/p/<module>/...`. */
  path: string;
}

export const RECEIPT_LINK_LABEL_MAX = 60;
/** More codes than this stops being a receipt. */
export const RECEIPT_LINKS_MAX = 3;
const LINK_PATH_RE = /^\/p\/[A-Za-z0-9][A-Za-z0-9/_.-]{0,190}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function isReceiptLineLink(value: unknown): value is ReceiptLineLink {
  if (!value || typeof value !== 'object') return false;
  const { label, path } = value as Record<string, unknown>;
  return (
    typeof label === 'string' &&
    label.trim().length > 0 &&
    label.length <= RECEIPT_LINK_LABEL_MAX &&
    !CONTROL_RE.test(label) &&
    typeof path === 'string' &&
    LINK_PATH_RE.test(path) &&
    !path.split('/').some((part) => part === '.' || part === '..')
  );
}

/** The links a sale's lines carry, valid ones only, each once, at most RECEIPT_LINKS_MAX. */
export function receiptLinksOf(items: readonly { link?: unknown }[]): ReceiptLineLink[] {
  const out: ReceiptLineLink[] = [];
  for (const item of items) {
    const link = item.link;
    if (!isReceiptLineLink(link) || out.some((l) => l.path === link.path)) continue;
    out.push({ label: link.label.trim(), path: link.path });
    if (out.length === RECEIPT_LINKS_MAX) break;
  }
  return out;
}
