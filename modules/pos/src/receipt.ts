import type { Transaction } from '@boothly/shared';
import { getSetting } from './lib/settings';
import { fmtPrice } from '@boothly/shared';
import { CarbonPayment, ThermalPrinter, hasNativePlugin } from './native/plugins';

/**
 * Receipt building for the myPOS Carbon's built-in thermal printer (carbon
 * flavor). Lines are pre-formatted here for the 32-character paper width and
 * handed to CarbonPaymentPlugin.printReceipt, which maps them to Smart-SDK
 * PrinterCommands.
 */

export interface ReceiptLine {
  kind: 'text' | 'image' | 'space';
  text?: string;
  align?: 'left' | 'center' | 'right';
  doubleHeight?: boolean;
  imageB64?: string;
}

/** One country's VAT/UID registration, chosen by the event's country. */
export interface CountryVat {
  country: string;
  vatNumber: string;
}

/** Stored under the 'customs.artistDefaults' setting (shared with customs prefill). */
export interface ArtistInfo {
  companyName?: string;
  fullName?: string;
  street?: string;
  postCodeCity?: string;
  countryOfOrigin?: string;
  phone?: string;
  email?: string;
  /** Default VAT / UID number printed on receipts, e.g. CHE-123.456.789 MWST */
  vatNumber?: string;
  /** Per-country VAT numbers; the receipt uses the one matching the event's country. */
  vatNumbers?: CountryVat[];
}

/**
 * The VAT number to print for a sale in `country`: the country-specific
 * registration if one is set, otherwise the default `vatNumber`.
 */
export function resolveVatNumber(artist: ArtistInfo, country?: string): string {
  const c = (country ?? '').trim().toLowerCase();
  if (c && artist.vatNumbers?.length) {
    const hit = artist.vatNumbers.find((v) => v.country.trim().toLowerCase() === c && v.vatNumber.trim());
    if (hit) return hit.vatNumber.trim();
  }
  return artist.vatNumber?.trim() ?? '';
}

export const RECEIPT_KEYS = {
  artist: 'customs.artistDefaults',
  /** Flattened onto white for thermal printing — see processLogoFile. */
  logoB64: 'receipt.logoB64',
  /** Same source image, transparency preserved — for on-screen use (customer display). */
  logoScreenB64: 'receipt.logoScreenB64',
  footerText: 'receipt.footerText',
  autoPrint: 'receipt.autoPrint',
  /** MAC address + display name of a paired Bluetooth ESC/POS printer. */
  printerAddress: 'receipt.printerAddress',
  printerName: 'receipt.printerName',
} as const;

// ── Printing (routes to whichever printer this device has) ──────────────────
// On the Carbon terminal the built-in printer is used; elsewhere a paired
// Bluetooth ESC/POS printer selected in Settings. Both take the same 32-char
// line format (58mm thermal paper = 384 dots, same as the Carbon).

export async function printingAvailable(): Promise<boolean> {
  if (hasNativePlugin('CarbonPayment')) return true;
  if (!hasNativePlugin('ThermalPrinter')) return false;
  return !!(await getSetting<string>(RECEIPT_KEYS.printerAddress));
}

export async function printReceipt(lines: ReceiptLine[]): Promise<{ printed: boolean; error?: string }> {
  if (hasNativePlugin('CarbonPayment')) {
    const r = await CarbonPayment.printReceipt({ lines });
    return { printed: r.printed, error: r.error };
  }
  if (hasNativePlugin('ThermalPrinter')) {
    const address = await getSetting<string>(RECEIPT_KEYS.printerAddress);
    if (!address) return { printed: false, error: 'No printer selected in Settings' };
    const r = await ThermalPrinter.printReceipt({ address, lines });
    return { printed: r.printed, error: r.error };
  }
  return { printed: false, error: 'Printing is not available on this device' };
}

/** Printable width of the Carbon paper in characters (myPOS "Smart" format). */
const WIDTH = 32;
/** Thermal print head width in pixels. */
export const LOGO_MAX_PX = 384;

const DIVIDER = '-'.repeat(WIDTH);

/** Left+right text on one 32-char line; the right side wins when space runs out. */
function row(left: string, right: string): string {
  const space = WIDTH - right.length - 1;
  const l = left.length > space ? left.slice(0, Math.max(0, space - 1)) + '…' : left;
  return l + ' '.repeat(Math.max(1, WIDTH - l.length - right.length)) + right;
}

export async function loadReceiptConfig(): Promise<{
  artist: ArtistInfo;
  logoB64: string;
  logoScreenB64: string;
  footerText: string;
  autoPrint: boolean;
}> {
  return {
    artist: (await getSetting<ArtistInfo>(RECEIPT_KEYS.artist)) ?? {},
    logoB64: (await getSetting<string>(RECEIPT_KEYS.logoB64)) ?? '',
    logoScreenB64: (await getSetting<string>(RECEIPT_KEYS.logoScreenB64)) ?? '',
    footerText: (await getSetting<string>(RECEIPT_KEYS.footerText)) ?? '',
    autoPrint: (await getSetting<boolean>(RECEIPT_KEYS.autoPrint)) ?? false,
  };
}

export function buildReceiptLines(
  tx: Transaction,
  eventName: string,
  config: { artist: ArtistInfo; logoB64: string; footerText: string },
  eventCountry?: string,
): ReceiptLine[] {
  const { artist, logoB64, footerText } = config;
  const lines: ReceiptLine[] = [];
  const center = (text: string): ReceiptLine => ({ kind: 'text', text, align: 'center' });

  // ── Header: logo + artist block ──
  if (logoB64) lines.push({ kind: 'image', imageB64: logoB64 });
  if (artist.companyName) lines.push({ ...center(artist.companyName), doubleHeight: true });
  if (artist.fullName && artist.fullName !== artist.companyName) lines.push(center(artist.fullName));
  if (artist.street) lines.push(center(artist.street));
  const cityLine = [artist.postCodeCity, artist.countryOfOrigin].filter(Boolean).join(', ');
  if (cityLine) lines.push(center(cityLine));
  if (artist.phone) lines.push(center(artist.phone));
  if (artist.email) lines.push(center(artist.email));
  const vat = resolveVatNumber(artist, eventCountry);
  if (vat) lines.push(center(`VAT: ${vat}`));

  lines.push({ kind: 'text', text: DIVIDER });
  const when = new Date(tx.timestamp);
  lines.push({ kind: 'text', text: row(eventName, when.toLocaleDateString('de-CH')) });
  lines.push({ kind: 'text', text: row('', when.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })) });
  lines.push({ kind: 'text', text: DIVIDER });

  // ── Items ──
  for (const item of tx.items) {
    const name = item.variantLabel ? `${item.title} (${item.variantLabel})` : item.title;
    lines.push({ kind: 'text', text: row(`${item.qty} x ${name}`, fmtPrice(item.lineTotal, tx.currency)) });
    if (item.qty > 1) {
      lines.push({ kind: 'text', text: `   à ${fmtPrice(item.unitPrice, tx.currency)}` });
    }
  }
  for (const d of tx.discounts) {
    lines.push({ kind: 'text', text: row(d.name, `-${fmtPrice(d.amount, tx.currency)}`) });
  }

  lines.push({ kind: 'text', text: DIVIDER });
  lines.push({ kind: 'text', text: row('TOTAL', fmtPrice(tx.total, tx.currency)), doubleHeight: true });

  // ── Payment legs ──
  for (const leg of tx.payments) {
    const label =
      leg.kind === 'cash' ? 'Cash' : leg.provider && leg.provider !== 'card' ? leg.provider : 'Card';
    lines.push({ kind: 'text', text: row(label, fmtPrice(leg.amount, tx.currency)) });
    if (leg.cardBrand || leg.authCode) {
      lines.push({
        kind: 'text',
        text: `  ${[leg.cardBrand, leg.authCode ? `auth ${leg.authCode}` : ''].filter(Boolean).join(' · ')}`,
      });
    }
    // The card processor's transaction reference (e.g. myPOS transaction ID) —
    // handy for reconciliation and refunds.
    if (leg.txRef) lines.push({ kind: 'text', text: `  Txn ${leg.txRef}` });
  }

  // ── Footer ──
  lines.push({ kind: 'space' });
  if (footerText) {
    for (const part of footerText.split('\n')) lines.push(center(part));
  }
  lines.push(center(`Receipt ${tx.id.slice(-8)}`));
  lines.push({ kind: 'space' });
  lines.push({ kind: 'space' });

  return lines;
}

/**
 * Prepare a picked logo image for thermal printing: scale to the 384px head
 * width and flatten onto white (transparent pixels would print black).
 * Returns base64 PNG without the data: prefix.
 */
export async function processLogoFile(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LOGO_MAX_PX / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}

/**
 * Prepare the same picked logo for on-screen use (customer display): scaled
 * down but with transparency preserved, unlike processLogoFile — a light or
 * white-on-transparent logo would otherwise disappear once flattened onto
 * the white background thermal printing requires.
 */
export async function processLogoForScreen(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LOGO_MAX_PX / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png').split(',')[1] ?? '';
}
