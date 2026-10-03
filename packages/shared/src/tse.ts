import { paidLineTotals } from './charged-lines';
import type { Transaction } from './types';

/**
 * KassenSichV: what a German till's technical security device (TSE) signs,
 * and what of it a receipt must carry.
 *
 * The formats are the Federal Ministry of Finance's, from the DSFinV-K
 * (version 2.4, chapter on processType/processData and the receipt QR code).
 * They are pure functions here so the till, the receipt and the tests all
 * agree on every character - a signature over different bytes is worthless.
 */

export const TSE_PROCESS_TYPE = 'Kassenbeleg-V1';

/** One signed transaction, as the TSE returned it. Stored on the sale and printed on its receipt. */
export interface TseSignature {
  /** The till's serial number as registered with the TSE (DSFinV-K "Kassen-Seriennummer" / client id). */
  clientId: string;
  /** The TSE's serial number: hex SHA-256 of its public key. */
  serial: string;
  transactionNumber: number;
  signatureCounter: number;
  /** Log time of StartTransaction / FinishTransaction, ISO "YYYY-MM-DDThh:mm:ss.fffZ". */
  start: string;
  finish: string;
  /** e.g. "ecdsa-plain-SHA384". */
  algorithm: string;
  /** e.g. "unixTime" or "utcTime". */
  timeFormat: string;
  /** Base64. */
  signature: string;
  /** Base64. */
  publicKey: string;
  processType: string;
  processData: string;
  /** A development TSE that is not certified - receipts say so. */
  test?: boolean;
}

/**
 * The TSE outcome of a sale: signed, or not signed because the TSE failed.
 * A failure must not stop the sale, but it has to be visible - on the
 * receipt and in the records - so it is kept rather than dropped.
 */
export type SaleTse = { signed: TseSignature } | { failed: { reason: string; at: number } };

/**
 * A TSE transaction started at a sale's first item, to be finished when it is
 * paid - or why it could not start. `via`: the main TSE device it was started
 * on, when the till signs through one.
 */
export type TseHandle = { number: number; start: number; via?: string } | { failed: string };

/** DSFinV-K transaction types used here. A cancellation with a TSE is a new "Beleg" with negative amounts. */
export type Vorgangstyp = 'Beleg' | 'AVBelegabbruch' | 'AVTraining';

/**
 * Which of the five fixed DSFinV-K VAT slots a German rate goes in:
 * general (19, historically 16), reduced (7, historically 5), the two
 * agricultural average rates, and 0% - where VAT-exempt sales go too.
 */
function vatSlot(rate: number | null): number | null {
  if (rate == null || rate === 0) return 4;
  if (rate === 19 || rate === 16) return 0;
  if (rate === 7 || rate === 5) return 1;
  if (rate === 10.7) return 2;
  if (rate === 5.5) return 3;
  return null;
}

/** DSFinV-K number format: '.' decimal, exactly two places, '-' for negatives, no '+'. */
function amount(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const toMinor = (n: number): number => Math.round(n * 100);

export class TseDataError extends Error {}

/**
 * processData for a sale ("Kassenbeleg-V1"): <Vorgangstyp>^<gross per VAT
 * slot>^<payments>. Gross amounts are what each line cost after discounts -
 * the same figures the receipt prints. `sign` -1 gives the cancelling
 * receipt for a reverted sale.
 *
 * Throws TseDataError when a sale carries a VAT rate German law does not
 * have: such a sale cannot be described to a German TSE, and signing it
 * anyway would sign something false.
 */
export function kassenbelegData(
  tx: Pick<Transaction, 'items' | 'total' | 'currency' | 'baseCurrency' | 'baseTotal' | 'discounts' | 'asCharged' | 'tax' | 'payments'>,
  vorgangstyp: Vorgangstyp = 'Beleg',
  sign: 1 | -1 = 1,
): string {
  const slots = [0, 0, 0, 0, 0];
  if (vorgangstyp !== 'AVBelegabbruch') {
    if (!tx.tax) throw new TseDataError('The sale has no VAT data - set the event country.');
    // The gross amounts are always in EUR (DSFinV-K); a German sale in another currency cannot be described.
    if ((tx.currency || '').toUpperCase() !== 'EUR') throw new TseDataError(`Sales in Germany are signed in EUR, this one is in ${tx.currency}.`);
    const paid = paidLineTotals(tx);
    tx.items.forEach((_, i) => {
      const rate = tx.tax!.exempt ? null : (tx.tax!.rates[i] ?? null);
      const slot = vatSlot(rate);
      if (slot == null) throw new TseDataError(`${rate}% is not a German VAT rate.`);
      slots[slot]! += toMinor(paid[i] ?? 0);
    });
  }
  const gross = slots.map((m) => amount(sign * m)).join('_');

  // Bar/Unbar per currency; EUR has no code; zero amounts are left out.
  const byKey = new Map<string, number>();
  if (vorgangstyp !== 'AVBelegabbruch') {
    for (const leg of tx.payments ?? []) {
      const kind = leg.kind === 'cash' ? 'Bar' : 'Unbar';
      const cur = (tx.currency || 'EUR').toUpperCase();
      const key = `${kind}:${cur}`;
      byKey.set(key, (byKey.get(key) ?? 0) + sign * toMinor(leg.amount));
    }
  }
  const order = (key: string): string => {
    const [kind, cur] = key.split(':') as [string, string];
    return `${kind === 'Bar' ? 0 : 1}${cur === 'EUR' ? 0 : 1}${cur}`;
  };
  const payments = [...byKey.entries()]
    .filter(([, m]) => m !== 0)
    .sort((a, b) => order(a[0]).localeCompare(order(b[0])))
    .map(([key, m]) => {
      const [kind, cur] = key.split(':') as [string, string];
      return `${amount(m)}:${kind}${cur === 'EUR' ? '' : `:${cur}`}`;
    })
    .join('_');

  return `${vorgangstyp}^${gross}^${payments}`;
}

/** The receipt QR code's content (DSFinV-K "V0"), carrying everything a tax inspector needs to verify the signature. */
export function tseQrPayload(sig: TseSignature): string {
  return [
    'V0',
    sig.clientId,
    sig.processType,
    sig.processData,
    sig.transactionNumber,
    sig.signatureCounter,
    sig.start,
    sig.finish,
    sig.algorithm,
    sig.timeFormat,
    sig.signature,
    sig.publicKey,
  ].join(';');
}

/** TSE log time as DSFinV-K wants it on the receipt: "YYYY-MM-DDThh:mm:ss.fffZ". */
export function tseTime(ms: number): string {
  return new Date(ms).toISOString();
}
