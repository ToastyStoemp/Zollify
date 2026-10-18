import type { PaymentLeg, Transaction } from '@zollify/shared';
import { getSetting } from './lib/settings';
import * as shared from '@zollify/shared';
import { countryCodeOf, fmtPrice, printableLink, receiptDateTime, receiptFooterLinks, swedishOrgNumber, vatIdLabel } from '@zollify/shared';
import { CarbonPayment, ThermalPrinter, hasNativePlugin } from './native/plugins';
import { rasterizeReceipt } from './lib/receipt-raster';
import { receiptQrPng } from './lib/after-sale';
import { serverBranding, serverSocials } from './lib/branding';
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

/** Header fields a business may leave off its receipts. Name, street and city always print. */
export type ReceiptField = 'fullName' | 'country' | 'phone' | 'email' | 'vatNumber';

/**
 * What prints by default: the bare minimum the receipt rules ask for. The
 * owner's name (a sole trader's legal name, Germany § 33 UStDV), the country
 * (part of a full address when selling abroad) and the VAT number (Swiss UID,
 * Danish CVR) stay on; phone and email are asked for nowhere and, for a sole
 * trader, are often private - so they are off until switched on.
 */
export const RECEIPT_FIELD_DEFAULTS: Record<ReceiptField, boolean> = { fullName: true, country: true, phone: false, email: false, vatNumber: true };

/** The stored choices over the defaults; anything but a boolean falls back. */
export function receiptFields(stored: unknown): Record<ReceiptField, boolean> {
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = { ...RECEIPT_FIELD_DEFAULTS };
  for (const k of Object.keys(out) as ReceiptField[]) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  return out;
}

/**
 * The VAT number to print for a sale in `country`: the country-specific
 * registration if one is set, otherwise the default `vatNumber`.
 */
export function resolveVatNumber(artist: ArtistInfo, country?: string): string {
  return ownVatNumber(artist, country)?.vatNumber.trim() ?? artist.vatNumber?.trim() ?? '';
}

/** "Germany", "germany" and "DE" are the same country; names nobody knows still match as typed. */
function sameCountry(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? '').trim();
  const y = (b ?? '').trim();
  if (!x || !y) return false;
  const code = (s: string): string => (/^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : countryCodeOf(s));
  const cx = code(x);
  const cy = code(y);
  return cx && cy ? cx === cy : x.toLowerCase() === y.toLowerCase();
}

/** The registration for `country`, when the list has one. */
function ownVatNumber(artist: ArtistInfo, country?: string): CountryVat | undefined {
  return artist.vatNumbers?.find((v) => sameCountry(v.country, country) && v.vatNumber.trim());
}

/** The country whose registration `resolveVatNumber` prints: the event's when it has one of its own, else home. */
function vatCountry(artist: ArtistInfo, eventCountry?: string): string | undefined {
  return ownVatNumber(artist, eventCountry) ? eventCountry : artist.countryOfOrigin;
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
  /** How large the logo prints and shows: 'small' | 'medium' | 'large' - see LOGO_PRINT_WIDTH. */
  logoSize: 'receipt.logoSize',
  /** Which optional header fields print - see RECEIPT_FIELD_DEFAULTS. */
  fields: 'receipt.fields',
  /** Carbon: print the text as images at a normal line height (default on) - see lib/receipt-raster.ts. */
  compactPrint: 'receipt.compactPrint',
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
    // The Carbon's printer leaves a blank line's height between text rows; as images the rows sit close.
    const compact = (await getSetting<boolean>(RECEIPT_KEYS.compactPrint)) ?? true;
    const r = await CarbonPayment.printReceipt({ lines: compact ? rasterizeReceipt(lines) : lines });
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
  fields: Record<ReceiptField, boolean>;
}> {
  return {
    artist: (await getSetting<ArtistInfo>(RECEIPT_KEYS.artist)) ?? {},
    logoB64: (await getSetting<string>(RECEIPT_KEYS.logoB64)) ?? '',
    logoScreenB64: (await getSetting<string>(RECEIPT_KEYS.logoScreenB64)) ?? '',
    footerText: (await getSetting<string>(RECEIPT_KEYS.footerText)) ?? '',
    autoPrint: (await getSetting<boolean>(RECEIPT_KEYS.autoPrint)) ?? false,
    printQr: (await getSetting<boolean>(RECEIPT_KEYS.printQr)) ?? true,
    fields: receiptFields(await getSetting(RECEIPT_KEYS.fields)),
  };
}

/** Built-in methods; anything else in `tx.method` is a name the booth gave its own (TWINT, PayPal QR…). */
const BUILT_IN_METHODS = new Set(['cash', 'card', 'split']);

/**
 * What a receipt calls a payment: Cash, Card, or the booth's own method name.
 * Never the terminal driver's id - "manual" or "mypos-go2" is how the till
 * took the card, not what the customer paid with (that leaked as "Paid: manual").
 */
export function paymentLabel(tx: Pick<Transaction, 'method'>, leg: Pick<PaymentLeg, 'kind' | 'provider'>): string {
  if (leg.kind === 'cash') return 'Cash';
  const method = String(tx.method ?? '').trim();
  return method && !BUILT_IN_METHODS.has(method) ? method : 'Card';
}

/**
 * The seller block at the top of a receipt, one text line each: business
 * name, owner's name, street, city and country, phone, email, VAT number with
 * its country's label. Shared by the printed copy and the on-screen one, so a
 * seller on a laptop hands over the same receipt a thermal printer would.
 * An exempt sale carries its exemption instead of a VAT number (see the VAT
 * block in buildReceiptLines).
 */
export function sellerLines(
  tx: Pick<Transaction, 'tax'>,
  config: { artist: ArtistInfo; fields?: Partial<Record<ReceiptField, boolean>> },
  eventCountry?: string,
): { text: string; heading?: boolean }[] {
  const { artist } = config;
  const out: { text: string; heading?: boolean }[] = [];
  if (artist.companyName) out.push({ text: artist.companyName, heading: true });
  const show = { ...RECEIPT_FIELD_DEFAULTS, ...config.fields };
  // Without a company name the full name is the business name, and always prints.
  if (artist.fullName && artist.fullName !== artist.companyName && (show.fullName || !artist.companyName)) out.push({ text: artist.fullName });
  if (artist.street) out.push({ text: artist.street });
  const cityLine = [artist.postCodeCity, show.country ? artist.countryOfOrigin : ''].filter(Boolean).join(', ');
  if (cityLine) out.push({ text: cityLine });
  if (show.phone && artist.phone) out.push({ text: artist.phone });
  if (show.email && artist.email) out.push({ text: artist.email });
  const vat = tx.tax?.exempt || !show.vatNumber ? '' : resolveVatNumber(artist, eventCountry);
  if (vat) out.push({ text: `${vatIdLabel(vatCountry(artist, eventCountry))}: ${vat}` });
  // A Swedish seller's exempt sale still names the organisationsnummer - a
  // kassakvitto must, whatever the VAT position - read from the Swedish VAT
  // number, since nothing else on the profile holds it.
  if (tx.tax?.exempt && countryCodeOf(artist.countryOfOrigin ?? '') === 'SE') {
    const org = swedishOrgNumber(resolveVatNumber(artist, 'SE'));
    if (org) out.push({ text: `Org.nr: ${org}` });
  }
  return out;
}

/** The seller block as this device prints it: saved receipt settings, blanks filled from the business profile. */
export async function receiptSeller(tx: Pick<Transaction, 'tax'>, eventCountry?: string): Promise<{ text: string; heading?: boolean }[]> {
  const config = await loadReceiptConfig();
  return sellerLines(tx, { artist: withProfileFallback(config.artist), fields: config.fields }, eventCountry);
}

export function buildReceiptLines(
  tx: Transaction,
  eventName: string,
  config: { artist: ArtistInfo; logoB64: string; footerText: string; /** Online-receipt QR, full paper width. */ qrB64?: string; /** Plain-text link lines (webstore, socials), when the account prints them. */ linkLines?: string[]; /** Optional header fields to print; absent ones follow RECEIPT_FIELD_DEFAULTS. */ fields?: Partial<Record<ReceiptField, boolean>> },
  eventCountry?: string,
): ReceiptLine[] {
  const { logoB64, footerText } = config;
  const lines: ReceiptLine[] = [];
  const center = (text: string): ReceiptLine => ({ kind: 'text', text, align: 'center' });

  // ── Header: logo + artist block ──
  if (logoB64) lines.push({ kind: 'image', imageB64: logoB64 });
  for (const s of sellerLines(tx, config, eventCountry)) lines.push(s.heading ? { ...center(s.text), doubleHeight: true } : center(s.text));

  lines.push({ kind: 'text', text: DIVIDER });
  // In the style of the country the sale was made in (the business's own when the event has none).
  const when = receiptDateTime(tx.timestamp, eventCountry || config.artist.countryOfOrigin);
  lines.push({ kind: 'text', text: row(eventName, when.date) });
  lines.push({ kind: 'text', text: row('', when.time) });
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
    lines.push({ kind: 'text', text: row(paymentLabel(tx, leg), fmtPrice(leg.amount, tx.currency)) });
    // Charged on the card in another currency (cards in the base currency).
    if (leg.settled) lines.push({ kind: 'text', text: row('  charged', fmtPrice(leg.settled.amount, leg.settled.currency)) });
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

  // ── Footer ──
  lines.push({ kind: 'space' });
  if (footerText) {
    for (const part of footerText.split('\n')) lines.push(center(part));
  }
  if (config.linkLines?.length) {
    lines.push({ kind: 'space' });
    for (const text of config.linkLines) for (const part of wrap(text, WIDTH)) lines.push(center(part));
  }
  if (config.qrB64) {
    lines.push({ kind: 'image', imageB64: config.qrB64 });
    lines.push(center('Scan for your receipt online'));
    lines.push({ kind: 'space' });
  }
  lines.push(center(`Receipt ${tx.receiptNumber ?? tx.id.slice(-8)}`));
  lines.push({ kind: 'space' });
  lines.push({ kind: 'space' });

  return lines;
}

/**
 * The webstore and social links (kept in the business profile) as plain lines
 * for paper, when the account switched printing them on (off by default).
 * Never blocks or fails a print.
 */
async function printedLinkLines(): Promise<string[]> {
  const socials = await serverSocials();
  if (!socials?.showOnPrint) return [];
  // The links are the business profile's, which this device already holds; the server's copy covers a profile it has not synced yet.
  const links = sdk().account()?.profile.links ?? socials;
  return receiptFooterLinks(links).map((l) => `${l.label}: ${printableLink(l.url)}`);
}

/**
 * The receipt as this device prints it: the saved receipt settings, plus the
 * online-receipt QR when that is switched on and the sale has a link.
 */
export async function printableReceipt(tx: Transaction, eventName: string, eventCountry?: string): Promise<ReceiptLine[]> {
  const config = await loadReceiptConfig();
  const size = await loadLogoSize();
  const [qrB64, logoB64, shared, linkLines] = await Promise.all([
    // A cancelled sale's link only says so; no point printing it.
    config.printQr && !tx.revertedAt ? receiptQrPng(tx.receiptToken) : Promise.resolve(undefined),
    (config.logoB64 ? Promise.resolve(config.logoB64) : sharedPrintLogo()).then((b) => (b ? sizePrintLogo(b, size) : b)),
    config.footerText ? Promise.resolve(null) : serverBranding(),
    printedLinkLines(),
  ]);
  return buildReceiptLines(
    tx,
    eventName,
    { ...config, artist: withProfileFallback(config.artist), logoB64: logoB64 ?? '', footerText: config.footerText || shared?.footer || '', qrB64, linkLines },
    eventCountry,
  );
}

/**
 * A device that was never set up under Receipts still prints a branded
 * receipt: blank artist fields fall back to the business profile (as the
 * settings form already promises), and a missing logo or footer to the ones
 * shared through the server.
 */
export function withProfileFallback(artist: ArtistInfo): ArtistInfo {
  const profile = sdk().account()?.profile.artist;
  if (!profile) return artist;
  const out: ArtistInfo = { ...artist };
  for (const k of ['companyName', 'fullName', 'street', 'postCodeCity', 'countryOfOrigin', 'phone', 'email'] as const) out[k] = artist[k] || profile[k] || '';
  out.vatNumber = artist.vatNumber || profile.vatId || '';
  // The business profile's VAT numbers per country (Settings → VAT) fill in any country this device lists none for.
  const own = artist.vatNumbers ?? [];
  const fromProfile = (sdk().account()?.profile.vat?.vatNumbers ?? [])
    .filter((v) => !own.some((o) => sameCountry(o.country, v.country) && o.vatNumber.trim()))
    .map((v) => ({ country: v.country, vatNumber: v.number }));
  if (fromProfile.length) out.vatNumbers = [...own, ...fromProfile];
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
export type LogoSize = 'small' | 'medium' | 'large';
export const LOGO_SIZES: { id: LogoSize; label: string }[] = [
  { id: 'small', label: 'Small' },
  { id: 'medium', label: 'Medium' },
  { id: 'large', label: 'Large' },
];
/** Share of the paper width the printed logo takes. */
export const LOGO_PRINT_WIDTH: Record<LogoSize, number> = { small: 0.4, medium: 0.65, large: 1 };
export const asLogoSize = (v: unknown): LogoSize => (v === 'small' || v === 'large' ? v : 'medium');

/** The logo size this device uses (default medium). */
export async function loadLogoSize(): Promise<LogoSize> {
  return asLogoSize(await getSetting(RECEIPT_KEYS.logoSize));
}

/**
 * The print logo at the chosen size: centred on a paper-wide white strip, so a
 * printer that stretches images to the paper keeps the size. Large returns the
 * logo as it is. Falls back to the logo unchanged when it cannot be drawn.
 */
export async function sizePrintLogo(b64: string, size: LogoSize): Promise<string> {
  const share = LOGO_PRINT_WIDTH[size];
  if (!b64 || share >= 1 || typeof document === 'undefined') return b64;
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('logo'));
      img.src = `data:image/png;base64,${b64}`;
    });
    const w = Math.round(LOGO_MAX_PX * share);
    const h = Math.max(1, Math.round((img.naturalHeight * w) / Math.max(1, img.naturalWidth)));
    const canvas = document.createElement('canvas');
    canvas.width = LOGO_MAX_PX;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return b64;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, Math.round((LOGO_MAX_PX - w) / 2), 0, w, h);
    return canvas.toDataURL('image/png').split(',')[1] || b64;
  } catch {
    return b64;
  }
}

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
