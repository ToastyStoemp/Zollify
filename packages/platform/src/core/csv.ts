import type { Transaction } from '@zollify/shared';

/**
 * CSV export of recorded sales, for handing to an accountant or a spreadsheet.
 *
 * One row per line item rather than per sale: that is the shape anyone doing
 * revenue analysis actually wants, and collapsing a basket into one row throws
 * away what was sold.
 */

/**
 * Quotes a field for CSV.
 *
 * Excel and Sheets both treat a leading `=`, `+`, `-` or `@` as a formula, so a
 * product genuinely named "=Sale" would execute on open. Prefixing an
 * apostrophe is the standard defence and is invisible in the cell.
 */
function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

const HEADERS = [
  'sale_id',
  'timestamp',
  'event_id',
  'device_id',
  'product_id',
  'variant_id',
  'title',
  'qty',
  'unit_price',
  'line_total',
  'currency',
  'base_currency',
  'base_total',
  'exchange_rate',
  'payment_method',
  'payment_provider',
  'tx_ref',
  'sale_total',
  'reverted_at',
] as const;

export function transactionsToCsv(transactions: Transaction[]): string {
  const rows: string[] = [HEADERS.join(',')];

  // Oldest first: a ledger reads forwards, unlike the History screen.
  const ordered = [...transactions].sort((a, b) => a.timestamp - b.timestamp);

  for (const tx of ordered) {
    const leg = tx.payments[0];
    for (const item of tx.items) {
      rows.push(
        [
          tx.id,
          new Date(tx.timestamp).toISOString(),
          tx.eventId,
          tx.deviceId,
          item.pid,
          item.vid ?? '',
          item.title,
          item.qty,
          item.unitPrice,
          item.lineTotal,
          tx.currency,
          tx.baseCurrency ?? '',
          tx.baseTotal ?? '',
          tx.exchangeRate ?? '',
          tx.method,
          leg?.provider ?? '',
          leg?.txRef ?? '',
          tx.total,
          // Kept in the export rather than filtered out: an accountant needs to
          // see the refund, not a gap where a sale used to be.
          tx.revertedAt ? new Date(tx.revertedAt).toISOString() : '',
        ]
          .map(escape)
          .join(','),
      );
    }
  }

  return rows.join('\r\n');
}

/** Filename that sorts chronologically and says what it covers. */
export function csvFilename(eventName: string | null): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const scope = (eventName ?? 'all-events').replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase();
  return `zollify-sales-${scope}-${stamp}.csv`;
}
