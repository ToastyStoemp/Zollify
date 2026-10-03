import type { Transaction } from '@zollify/shared';
import { getSetting } from './lib/settings';
import * as shared from '@zollify/shared';
import { fmtPrice } from '@zollify/shared';
import { CarbonPayment, ThermalPrinter, hasNativePlugin } from './native/plugins';
import { qrPng, receiptQrPng } from './lib/after-sale';
import { serverBranding } from './lib/branding';
import { sdk } from './runtime';

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
  /** Flattened onto white for thermal printing - see processLogoFile. */
  logoB64: 'receipt.logoB64',
  /** Same source image, transparency preserved - for on-screen use (customer display). */
  logoScreenB64: 'receipt.logoScreenB64',
  footerText: 'receipt.footerText',
  autoPrint: 'receipt.autoPrint',
  /** Print a QR code linking to the customer's online receipt (default on). */
  printQr: 'receipt.printQr',
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

/**
 * The TSE block a German receipt must carry: transaction number, signature
 * counter, start and end, the TSE's and the till's serial numbers, and the
 * signature - as the DSFinV-K QR code, which holds all of it for checking.
 */
function tseLines(tse: NonNullable<Transaction['tse']>, qrB64: string | undefined, title?: string): ReceiptLine[] {
  const out: ReceiptLine[] = [{ kind: 'text', text: DIVIDER }];
  const center = (text: string): ReceiptLine => ({ kind: 'text', text, align: 'center' });
  if (title) out.push(center(title));
  if ('failed' in tse) {
    out.push(center('TSE ausgefallen'));
    out.push(center('Beleg ohne TSE-Signatur'));
    for (const part of wrap(tse.failed.reason, WIDTH)) out.push(center(part));
    return out;
  }
  const s = tse.signed;
  if (s.test) out.push(center('TEST-TSE - NICHT ZERTIFIZIERT'));
  out.push({ kind: 'text', text: row('TSE-Transaktion', String(s.transactionNumber)) });
  out.push({ kind: 'text', text: row('Signaturzaehler', String(s.signatureCounter)) });
  out.push({ kind: 'text', text: row('Start', s.start.replace('T', ' ').replace(/\.\d+Z$/, '')) });
  out.push({ kind: 'text', text: row('Ende', s.finish.replace('T', ' ').replace(/\.\d+Z$/, '')) });
  out.push({ kind: 'text', text: row('Kasse', s.clientId) });
  out.push({ kind: 'text', text: 'TSE-Seriennummer:' });
  for (let i = 0; i < s.serial.length; i += WIDTH) out.push({ kind: 'text', text: s.serial.slice(i, i + WIDTH) });
  if (qrB64) {
    out.push({ kind: 'image', imageB64: qrB64 });
    out.push(center('TSE-Signatur'));
  } else {
    out.push({ kind: 'text', text: 'Signatur:' });
    for (let i = 0; i < s.signature.length; i += WIDTH) out.push({ kind: 'text', text: s.signature.slice(i, i + WIDTH) });
  }
  return out;
}

/** The DSFinV-K QR for a signed TSE outcome; none for a failure or on an older shell. */
async function tseQr(tse: Transaction['tse']): Promise<string | undefined> {
  if (!tse || !('signed' in tse)) return undefined;
  const payload = (shared as Record<string, unknown>).tseQrPayload as typeof shared.tseQrPayload | undefined;
  // Wider than the receipt-link code: it carries the whole signature and public key.
  return payload ? qrPng(payload(tse.signed), 360) : undefined;
}

/** VAT per rate for a sale (see vatBreakdown in @zollify/shared); none on an older shell or an untaxed sale. */
export function receiptVat(tx: Transaction): shared.VatRow[] {
  const fn = (shared as Record<string, unknown>).vatBreakdown as typeof shared.vatBreakdown | undefined;
  return fn && tx.tax ? fn(tx) : [];
}

export function vatRateLabel(rate: number): string {
  const fn = (shared as Record<string, unknown>).fmtRate as typeof shared.fmtRate | undefined;
  return fn ? fn(rate) : `${rate}%`;
}

/** Word-wraps text to the paper width. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Lines and discounts as a receipt lists them (see receiptBreakdown in
 * @zollify/shared). Looked up at runtime: this bundle may run on an older
 * shell whose @zollify/shared predates it, and a named import of a missing
 * export would stop the whole POS from loading there - which gets the
 * receipt as it used to print instead.
 */
export function receiptAmounts(tx: Transaction): shared.ReceiptBreakdown {
  const fn = (shared as Record<string, unknown>).receiptBreakdown as ((t: Transaction) => shared.ReceiptBreakdown) | undefined;
  return fn ? fn(tx) : { lines: tx.items.map((i) => i.lineTotal), discounts: tx.discounts.map((d) => ({ name: d.name, amount: d.amount })) };
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
  printQr: boolean;
}> {
  return {
    artist: (await getSetting<ArtistInfo>(RECEIPT_KEYS.artist)) ?? {},
    logoB64: (await getSetting<string>(RECEIPT_KEYS.logoB64)) ?? '',
    logoScreenB64: (await getSetting<string>(RECEIPT_KEYS.logoScreenB64)) ?? '',
    footerText: (await getSetting<string>(RECEIPT_KEYS.footerText)) ?? '',
    autoPrint: (await getSetting<boolean>(RECEIPT_KEYS.autoPrint)) ?? false,
    printQr: (await getSetting<boolean>(RECEIPT_KEYS.printQr)) ?? true,
  };
}

export function buildReceiptLines(
  tx: Transaction,
  eventName: string,
  config: {
    artist: ArtistInfo;
    logoB64: string;
    footerText: string;
    /** Online-receipt QR, full paper width. */
    qrB64?: string;
    /** KassenSichV: the TSE signature as a QR (DSFinV-K V0), and the cancellation's when reverted. */
    tseQrB64?: string;
    revertTseQrB64?: string;
  },
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
  // An exempt sale prints its exemption instead (see the VAT block below).
  const vat = tx.tax?.exempt ? '' : resolveVatNumber(artist, eventCountry);
  if (vat) lines.push(center(`VAT: ${vat}`));

  lines.push({ kind: 'text', text: DIVIDER });
  const when = new Date(tx.timestamp);
  lines.push({ kind: 'text', text: row(eventName, when.toLocaleDateString('de-CH')) });
  lines.push({ kind: 'text', text: row('', when.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })) });
  lines.push({ kind: 'text', text: DIVIDER });

  // ── Items ──
  // Lines at the price on the till, then each discount, in what the customer
  // paid - see receiptBreakdown. (A converted sale stores its lines in the
  // book currency; printing those under the charged currency was wrong, and
  // discounts spread into the lines made a line disagree with its own "à".)
  const breakdown = receiptAmounts(tx);
  // With more than one VAT rate on a sale, each line is marked with its
  // rate's letter, so it is clear which items carry which rate.
  const vatRows = receiptVat(tx);
  const letterOf = new Map(vatRows.map((r) => [r.rate, r.letter]));
  const marked = vatRows.length > 1;
  tx.items.forEach((item, n) => {
    const name = item.variantLabel ? `${item.title} (${item.variantLabel})` : item.title;
    const amount = breakdown.lines[n] ?? item.lineTotal;
    const rate = tx.tax?.rates[n];
    const letter = marked && rate != null ? ` ${letterOf.get(rate) ?? ''}` : '';
    lines.push({ kind: 'text', text: row(`${item.qty} x ${name}`, `${fmtPrice(amount, tx.currency)}${letter}`) });
    if (item.qty > 1) lines.push({ kind: 'text', text: `   à ${fmtPrice(Math.round((amount / item.qty) * 100) / 100, tx.currency)}` });
  });
  if (breakdown.discounts.length) {
    lines.push({ kind: 'text', text: DIVIDER });
    const subtotal = breakdown.lines.reduce((s, a) => s + Math.round(a * 100), 0) / 100;
    lines.push({ kind: 'text', text: row('Subtotal', fmtPrice(subtotal, tx.currency)) });
    for (const d of breakdown.discounts) {
      lines.push({ kind: 'text', text: row(d.name, `-${fmtPrice(d.amount, tx.currency)}`) });
    }
  }

  lines.push({ kind: 'text', text: DIVIDER });
  lines.push({ kind: 'text', text: row('TOTAL', fmtPrice(tx.total, tx.currency)), doubleHeight: true });

  // ── VAT ──
  // Prices are gross: the VAT inside the total, per rate, with the net.
  for (const r of vatRows) {
    lines.push({ kind: 'text', text: row(`${marked ? `${r.letter} ` : ''}incl. VAT ${vatRateLabel(r.rate)}`, fmtPrice(r.vat, tx.currency)) });
    lines.push({ kind: 'text', text: row('   net', fmtPrice(r.net, tx.currency)) });
  }
  if (tx.tax?.exempt) {
    if (tx.tax.note) for (const part of wrap(tx.tax.note, WIDTH)) lines.push(center(part));
    if (tx.tax.exNumber) lines.push(center(`EX: ${tx.tax.exNumber}`));
  }

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
    // The card processor's transaction reference (e.g. myPOS transaction ID) -
    // handy for reconciliation and refunds.
    if (leg.txRef) lines.push({ kind: 'text', text: `  Txn ${leg.txRef}` });
  }

  // ── TSE (KassenSichV) ──
  if (tx.tse) lines.push(...tseLines(tx.tse, config.tseQrB64));
  if (tx.revertTse) lines.push(...tseLines(tx.revertTse, config.revertTseQrB64, 'STORNO - cancelled'));

  // ── Footer ──
  lines.push({ kind: 'space' });
  if (footerText) {
    for (const part of footerText.split('\n')) lines.push(center(part));
  }
  if (config.qrB64) {
    lines.push({ kind: 'image', imageB64: config.qrB64 });
    lines.push(center('Scan for your receipt online'));
    lines.push({ kind: 'space' });
  }
  lines.push(center(`Receipt ${tx.id.slice(-8)}`));
  lines.push({ kind: 'space' });
  lines.push({ kind: 'space' });

  return lines;
}

/**
 * The receipt as this device prints it: the saved receipt settings, plus the
 * online-receipt QR when that is switched on and the sale has a link.
 */
export async function printableReceipt(tx: Transaction, eventName: string, eventCountry?: string): Promise<ReceiptLine[]> {
  const config = await loadReceiptConfig();
  const [qrB64, logoB64, branding, tseQrB64, revertTseQrB64] = await Promise.all([
    // A cancelled sale's link only says so; no point printing it.
    config.printQr && !tx.revertedAt ? receiptQrPng(tx.receiptToken) : Promise.resolve(undefined),
    config.logoB64 ? Promise.resolve(config.logoB64) : sharedPrintLogo(),
    config.footerText ? Promise.resolve(null) : serverBranding(),
    tseQr(tx.tse),
    tseQr(tx.revertTse),
  ]);
  return buildReceiptLines(
    tx,
    eventName,
    { ...config, artist: withProfileFallback(config.artist), logoB64: logoB64 ?? '', footerText: config.footerText || branding?.footer || '', qrB64, tseQrB64, revertTseQrB64 },
    eventCountry,
  );
}

/**
 * A device that was never set up under Receipts still prints a branded
 * receipt: blank artist fields fall back to the booth profile (as the
 * settings form already promises), and a missing logo or footer to the ones
 * shared through the server.
 */
function withProfileFallback(artist: ArtistInfo): ArtistInfo {
  const profile = sdk().account()?.profile.artist;
  if (!profile) return artist;
  const out: ArtistInfo = { ...artist };
  for (const k of ['companyName', 'fullName', 'street', 'postCodeCity', 'countryOfOrigin', 'phone', 'email'] as const) out[k] = artist[k] || profile[k] || '';
  out.vatNumber = artist.vatNumber || profile.vatId || '';
  return out;
}

/** Decoded by hand: the page's CSP keeps fetch() off data: URLs. */
function pngBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

let sharedLogo: Promise<string | undefined> | null = null;
/** The account's logo, flattened onto white for the printer. Worked out once per session. */
function sharedPrintLogo(): Promise<string | undefined> {
  sharedLogo ??= serverBranding()
    .then((b) => (b?.logo ? processLogoFile(pngBlob(b.logo)) : undefined))
    .catch(() => undefined)
    .then((logo) => {
      if (!logo) sharedLogo = null; // try again next time, e.g. once back online
      return logo;
    });
  return sharedLogo;
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
 * down but with transparency preserved, unlike processLogoFile - a light or
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
