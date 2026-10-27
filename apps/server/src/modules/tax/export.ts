import { strToU8, zipSync } from 'fflate';
import { csvCell, vatBreakdown, type SalesEvent, type Transaction } from '@zollify/shared';

/**
 * A period's books as one zip for the accountant: every sale and every sale
 * line as CSV, the ledger's expenses as CSV, and the invoices attached to
 * them as files - so a year or a quarter goes out in one download instead
 * of a screen at a time. Amounts are as paid, in the sale's currency, with
 * the VAT the till collected shown beside them; a sale's book figure (what
 * it was worth in the event's currency) is there too. Reverted sales stay
 * in with their status, so the receipt numbers run without gaps.
 */

export interface ExportExpense {
  id: string;
  eventId: string;
  category: string;
  amount: number;
  currency: string;
  date: string;
  vendor: string;
  note: string;
  invoice: { filename: string } | null;
  bookedVoucherId: string | null;
  createdBy?: { email: string | null } | null;
}

export interface ExportInput {
  /** YYYY-MM-DD, both included. */
  from: string;
  to: string;
  events: SalesEvent[];
  transactions: Transaction[];
  /** Already limited to the period. */
  expenses: ExportExpense[];
  categories: readonly { id: string; label: string }[];
  /** The attached invoice's bytes, or null when there is none. */
  invoiceBytes: (expenseId: string) => Uint8Array | null;
  generatedAt?: Date;
}

export interface ExportCounts {
  sales: number;
  lines: number;
  expenses: number;
  invoices: number;
}

const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const utcTime = (ts: number): string => new Date(ts).toISOString().slice(11, 19);
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const row = (cells: unknown[]): string => cells.map(csvCell).join(',');
const slug = (s: string): string => s.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const extOf = (name: string): string => {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? `.${m[1]!.toLowerCase()}` : '.pdf';
};

export function buildBooksZip(input: ExportInput): { filename: string; bytes: Uint8Array; counts: ExportCounts } {
  const { from, to } = input;
  const events = new Map(input.events.map((e) => [e.id, e]));
  const eventName = (id: string): string => events.get(id)?.name || id;
  const eventCountry = (id: string): string => events.get(id)?.venue?.country ?? '';
  const label = new Map(input.categories.map((c) => [c.id, c.label]));

  const sales = input.transactions
    .filter((t) => {
      const d = utcDay(t.timestamp);
      return d >= from && d <= to;
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  const salesCsv = [row(['Date', 'Time (UTC)', 'Receipt', 'Event', 'Country', 'Status', 'Payment', 'Currency', 'Gross', 'VAT', 'Net', 'Book currency', 'Book total', 'Sale id'])];
  const linesCsv = [row(['Date', 'Receipt', 'Status', 'Item', 'Variant', 'Qty', 'Unit price', 'Line total', 'VAT %', 'Currency', 'Sale id'])];
  let lines = 0;
  for (const t of sales) {
    const status = t.revertedAt || t.revertedBy ? 'reverted' : 'sold';
    const vat = round2(vatBreakdown(t).reduce((s, r) => s + r.vat, 0));
    const receipt = t.receiptNumber ?? t.id.slice(-6);
    salesCsv.push(
      row([utcDay(t.timestamp), utcTime(t.timestamp), receipt, eventName(t.eventId), eventCountry(t.eventId), status, t.method, t.currency, round2(t.total), vat, round2(t.total - vat), t.baseCurrency ?? t.currency, round2(t.baseTotal ?? t.total), t.id]),
    );
    t.items.forEach((i, n) => {
      lines += 1;
      linesCsv.push(row([utcDay(t.timestamp), receipt, status, i.title, i.variantLabel ?? '', i.qty, round2(i.unitPrice), round2(i.lineTotal), t.tax && !t.tax.exempt ? (t.tax.rates[n] ?? '') : '', t.currency, t.id]));
    });
  }

  const expensesCsv = [row(['Date', 'Category', 'Vendor', 'Note', 'Amount', 'Currency', 'Event', 'Invoice file', 'Booked voucher', 'Added by', 'Expense id'])];
  const files: Record<string, Uint8Array> = {};
  let invoices = 0;
  for (const e of [...input.expenses].sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor))) {
    let path = '';
    if (e.invoice) {
      const bytes = input.invoiceBytes(e.id);
      if (bytes) {
        path = `invoices/${e.date}_${slug(e.vendor) || 'invoice'}_${e.id.slice(0, 8)}${extOf(e.invoice.filename)}`;
        files[path] = bytes;
        invoices += 1;
      }
    }
    expensesCsv.push(row([e.date, label.get(e.category) ?? e.category, e.vendor, e.note, round2(e.amount), e.currency, e.eventId ? eventName(e.eventId) : '', path, e.bookedVoucherId ?? '', e.createdBy?.email ?? '', e.id]));
  }

  const at = input.generatedAt ?? new Date();
  const readme = [
    `Zollify books, ${from} to ${to}`,
    `Made ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    `sales.csv       One row per sale (${sales.length}). Gross is what the customer paid in the sale's currency; VAT is what the till`,
    '                collected inside it; Net is gross less VAT. Book currency and total are the sale in the event\'s own currency.',
    '                Status "reverted" is a sale taken back: it is kept so receipt numbers run without gaps - leave it out of totals.',
    `sale-lines.csv  One row per item on those sales (${lines}), with the VAT rate applied to the line.`,
    `expenses.csv    The ledger's costs dated in the period (${input.expenses.length}), with the invoice file where one was attached.`,
    `invoices/       The attached invoices (${invoices}), named by date, vendor and expense id.`,
    '',
    'Dates and times are UTC. Amounts use a dot as the decimal mark.',
    '',
  ].join('\n');

  const bytes = zipSync(
    {
      'README.txt': strToU8(readme),
      'sales.csv': strToU8(`${salesCsv.join('\n')}\n`),
      'sale-lines.csv': strToU8(`${linesCsv.join('\n')}\n`),
      'expenses.csv': strToU8(`${expensesCsv.join('\n')}\n`),
      ...files,
    },
    { level: 6 },
  );
  return { filename: `zollify-books-${from}-to-${to}.zip`, bytes, counts: { sales: sales.length, lines, expenses: input.expenses.length, invoices } };
}
