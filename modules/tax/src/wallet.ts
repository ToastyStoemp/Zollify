import { api } from './api';

/**
 * Card payments from the phone's notifications (Google Wallet). The Android side reads only
 * Google Wallet's notifications and holds their text until this takes them (`takePending`).
 * This reads the amount, currency, merchant and last four digits out of the text, drops the
 * personal cards' payments before anything is sent, and sends the rest to the server. The
 * wording of the notifications differs by bank and language, so the patterns below are a first
 * set to tune against real examples.
 */

export interface WalletNotice {
  /** The notification's key on the phone: with `at`, the same notice sent twice has one id. */
  key: string;
  /** When it was posted, in ms. */
  at: number;
  /** Its title and text, joined. */
  text: string;
}
export interface ParsedPayment {
  amount: number;
  currency: string;
  merchant: string;
  last4: string;
}

const SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', CHF: 'CHF', EUR: 'EUR', USD: 'USD', GBP: 'GBP', SEK: 'SEK', DKK: 'DKK', NOK: 'NOK' };
const CURRENCY = '(€|\\$|£|CHF|EUR|USD|GBP|SEK|DKK|NOK)';
const NUMBER = '(\\d{1,3}(?:[.,\\s]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
/** "€12.50", "12,50 €", "EUR 12.50", "12.50 EUR". */
const AMOUNT_BEFORE = new RegExp(`${CURRENCY}\\s?${NUMBER}`);
const AMOUNT_AFTER = new RegExp(`${NUMBER}\\s?${CURRENCY}`);
/** "ending in 4242", "ending 4242", "•••• 4242", "**** 4242", "x4242". */
const LAST4 = /(?:ending(?: in)?|••••|\*{3,}|x{3,}|xxxx)\s*(\d{4})\b/i;
/** The merchant after "at" or "bei" (German), up to the rest of the sentence. */
const MERCHANT = /\b(?:at|bei|chez)\s+(.+?)(?=\s+(?:with|using|mit|ending|card|karte|for|für|on|am)\b|\s+[•*|·]|\s[-–—]\s|[.,;·|•]|\s{2,}|$)/i;

/** Reads one payment out of a Google Wallet notification's text; null when it is not a payment. */
export function parseWalletText(text: string): ParsedPayment | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  const before = AMOUNT_BEFORE.exec(clean);
  const after = before ? null : AMOUNT_AFTER.exec(clean);
  if (!before && !after) return null;
  // The pattern says which group is the currency: before the amount, or after it.
  const currencyText = before ? before[1]! : after![2]!;
  const numberText = before ? before[2]! : after![1]!;
  const amount = toAmount(numberText);
  const currency = SYMBOLS[currencyText.toUpperCase()] ?? SYMBOLS[currencyText];
  if (!(amount > 0) || !currency) return null;
  const merchant = (MERCHANT.exec(clean)?.[1] ?? '').trim().slice(0, 120);
  const last4 = LAST4.exec(clean)?.[1] ?? '';
  return { amount, currency, merchant, last4 };
}

/** "1.234,50" and "1,234.50" and "12,50" and "12.50" all read as the decimal figure. */
export function toAmount(text: string): number {
  const compact = text.replace(/\s/g, '');
  const lastSep = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
  const decimals = lastSep >= 0 && compact.length - lastSep - 1 <= 2 ? compact.slice(lastSep + 1) : '';
  const whole = (lastSep >= 0 && decimals ? compact.slice(0, lastSep) : compact).replace(/[.,]/g, '');
  return Number(`${whole}.${decimals || '0'}`);
}

/** A stable id for a notice, so sending it again - a retry, a second open - counts once. */
export function walletId(n: WalletNotice): string {
  return `wallet-${`${n.key}-${n.at}`.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 72)}`;
}

interface WalletPlugin {
  status(): Promise<{ listening: boolean }>;
  openAccess(): Promise<void>;
  takePending(): Promise<{ items: WalletNotice[] }>;
}

/** The Android plugin, on the native app only; null in a browser. */
function plugin(): WalletPlugin | null {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;
  return (cap.Plugins?.WalletPayments as WalletPlugin | undefined) ?? null;
}

export const walletAccess = {
  /** Whether the phone lets Zollify read Google Wallet's notifications. */
  async listening(): Promise<boolean | null> {
    const p = plugin();
    return p ? (await p.status()).listening : null;
  },
  async openSettings(): Promise<void> {
    await plugin()?.openAccess();
  },
};

/**
 * Takes what the phone has seen since last time and sends the payments to the server. Personal
 * cards are dropped here, before anything leaves the phone. Returns how many were sent.
 */
export async function syncWalletPayments(): Promise<number> {
  const p = plugin();
  if (!p) return 0;
  const { items } = await p.takePending();
  if (!items.length) return 0;
  const personal = new Set((await api.cards()).cards.filter((c) => c.role === 'personal').map((c) => c.last4));
  let sent = 0;
  for (const n of items) {
    const parsed = parseWalletText(n.text);
    if (!parsed || (parsed.last4 && personal.has(parsed.last4))) continue;
    const res = await api.sendCardPayment({ id: walletId(n), at: n.at, amount: parsed.amount, currency: parsed.currency, merchant: parsed.merchant, last4: parsed.last4 });
    if (res.stored) sent += 1;
  }
  return sent;
}
