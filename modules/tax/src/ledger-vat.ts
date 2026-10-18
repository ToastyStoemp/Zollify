import { toBaseFactor, vatBreakdown, type Transaction } from '@zollify/shared';

/**
 * VAT the till collected per event, in each event's book currency. The
 * ledger's revenue comes from the server as what customers paid; where VAT
 * was charged that money is owed to the tax office and is not revenue, so
 * the page takes it off and says "excl. VAT". Exempt sales carry no VAT and
 * change nothing. Converted sales (CHF at a EUR event) are scaled with the
 * same factor the revenue itself was.
 */
export function vatByEvent(txns: Transaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tx of txns) {
    if (tx.revertedBy || tx.revertedAt) continue;
    const vat = vatBreakdown(tx).reduce((s, r) => s + r.vat, 0);
    if (!vat) continue;
    const factor = toBaseFactor(tx, tx.baseCurrency ?? tx.currency);
    out[tx.eventId] = Math.round(((out[tx.eventId] ?? 0) + vat * factor) * 100) / 100;
  }
  return out;
}
