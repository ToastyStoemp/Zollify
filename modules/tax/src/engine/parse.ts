import { rid, type Txn } from './types';

/**
 * Turns a spreadsheet (already read to rows) into transactions. Detects the
 * format from the header row: a myPOS transaction export, a myPOS monthly
 * statement, a Shopify orders export or a Wise transfer history.
 *
 * Ported from ZollTax. The parsers are pure so a fixture row set can be
 * tested without a file.
 */

type Row = Record<string, unknown>;

/** Terminal id → friendly name, learned from a transaction export so a later statement can name its TIDs. */
export type TidNames = Record<string, string>;

export function parseDate(v: unknown): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s || s === 'NaN' || s === 'null' || s === 'undefined') return null;
  const m1 = s.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if (m1) return new Date(+m1[3]!, +m1[2]! - 1, +m1[1]!, +m1[4]!, +m1[5]!);
  const m3 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m3) return new Date(+m3[3]!, +m3[2]! - 1, +m3[1]!, 12, 0);
  const m2 = s.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
  if (m2) return new Date(m2[1]!.replace(' ', 'T'));
  return null;
}

function col(r: Row, ...names: string[]): unknown {
  for (const n of names) {
    const v = r[n];
    if (v !== undefined && v !== null && v !== '' && String(v).toLowerCase() !== 'nan') return v;
  }
  return '';
}
const s = (v: unknown): string => String(v ?? '').trim();
const money = (v: unknown): number => parseFloat(s(v).replace(',', '.')) || 0;

export type ParsedFormat = 'mypos-export' | 'mypos-statement' | 'shopify' | 'wise';

export class ParseError extends Error {}

/**
 * `raw` is the sheet as an array of rows (arrays of cells). The header row is
 * found by its known column names; anything above it is a title block.
 */
export function parseSheet(raw: unknown[][], tidNames: TidNames): { format: ParsedFormat; txns: Txn[] } {
  const hi = raw.findIndex((r) =>
    r.some((c) => {
      const t = String(c).trim().toLowerCase().replace(/^"|"$/g, '');
      return t === 'type' || t === 'financial status' || t === 'direction' || t === 'status';
    }),
  );
  if (hi < 0) throw new ParseError('Cannot recognise this file — none of the expected column headers are present.');
  const headers = raw[hi]!.map((h) => String(h).trim().replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, '_'));
  const rows: Row[] = raw
    .slice(hi + 1)
    .filter((r) => !r.every((c) => c === '' || c == null))
    .map((r) => Object.fromEntries(headers.map((h, j) => [h, typeof r[j] === 'string' ? (r[j] as string).replace(/^"|"$/g, '') : r[j]])));

  const isShopify = headers.includes('financial_status') && headers.includes('paid_at') && headers.includes('lineitem_name');
  const isStatement = !isShopify && headers.includes('credit') && headers.includes('debit') && headers.includes('tid');
  const isWise = !isShopify && !isStatement && headers.includes('direction') && headers.includes('target_amount_(after_fees)');

  if (isShopify) return { format: 'shopify', txns: parseShopify(rows) };
  if (isStatement) return { format: 'mypos-statement', txns: parseStatement(rows, tidNames) };
  if (isWise) return { format: 'wise', txns: parseWise(rows) };
  return { format: 'mypos-export', txns: parseExport(rows, tidNames) };
}

export function parseExport(rows: Row[], tidNames: TidNames): Txn[] {
  return rows
    .map((r): Txn | null => {
      const date = parseDate(col(r, 'date_initiated', 'date initiated')) ?? parseDate(col(r, 'date_settled', 'date settled'));
      const amount = money(col(r, 'amount'));
      const terminal = s(col(r, 'terminal_name'));
      const tm = s(col(r, 'description')).match(/TID\s+(\d+)/);
      if (tm?.[1] && terminal) tidNames[tm[1]] ??= terminal;
      // In the account export, fees are Payment rows with a negative amount.
      const rawType = s(col(r, 'type'));
      const type = rawType === 'Payment' && amount < 0 ? 'Fee' : rawType;
      if (!date || (type !== 'Payment' && type !== 'Fee') || !terminal) return null;
      return {
        id: rid(),
        at: date.getTime(),
        type,
        amount,
        currency: s(col(r, 'currency')) || 'EUR',
        terminal,
        card: s(col(r, 'payment_from_card')),
        ref: s(col(r, 'transaction_reference', 'transaction reference')),
        desc: s(col(r, 'description')),
        source: 'mypos',
      };
    })
    .filter((t): t is Txn => t !== null);
}

export function parseStatement(rows: Row[], tidNames: TidNames): Txn[] {
  const txns = rows
    .map((r): Txn | null => {
      const type = s(col(r, 'type'));
      const via = s(col(r, 'ordered_via'));
      if (!['Payment', 'Fee'].includes(type) || !['myPOS', 'System'].includes(via)) return null;
      const tid = String(Math.round(Number(col(r, 'tid'))));
      if (!tid || tid === 'NaN' || tid === '0') return null;
      const date = parseDate(col(r, 'value_date'));
      if (!date) return null;
      const credit = money(col(r, 'credit'));
      const debit = money(col(r, 'debit'));
      return {
        id: rid(),
        at: date.getTime(),
        type: type as 'Payment' | 'Fee',
        amount: type === 'Payment' ? credit : -debit,
        currency: 'EUR',
        terminal: tidNames[tid] ?? `TID ${tid}`,
        card: '',
        ref: s(col(r, 'mypos_reference')),
        desc: s(col(r, 'description')),
        source: 'mypos',
      };
    })
    .filter((t): t is Txn => t !== null);
  if (!txns.length) throw new ParseError('No myPOS terminal rows found in the statement.');
  return txns;
}

export function parseShopify(rows: Row[]): Txn[] {
  // One row per line item; keep the first row of each order.
  const seen = new Set<string>();
  const txns = rows
    .map((r): Txn | null => {
      const status = s(col(r, 'financial_status')).toLowerCase();
      if (!['paid', 'refunded', 'partially_refunded'].includes(status)) return null;
      const name = s(col(r, 'name'));
      if (seen.has(name)) return null;
      seen.add(name);
      const date = parseDate(col(r, 'paid_at'));
      if (!date) return null;
      const amount = money(col(r, 'total')) - money(col(r, 'refunded_amount'));
      const source = s(col(r, 'source')).toLowerCase();
      const location = s(col(r, 'location'));
      const isOnline = source ? source === 'web' || (source === 'shopify_draft_order' && /online store/i.test(location)) : !location;
      const paymentMethod = s(col(r, 'payment_method'));
      return {
        id: rid(),
        at: date.getTime(),
        type: 'Payment',
        amount,
        currency: s(col(r, 'currency')) || 'EUR',
        terminal: isOnline ? 'Shopify Online' : location || (source === 'shopify_draft_order' ? 'Shopify Draft' : 'Shopify POS'),
        card: paymentMethod,
        ref: name,
        desc: `Shopify order ${name}`,
        source: 'shopify',
        orderNum: name,
        isManual: ['manual', 'custom (pos)'].includes(paymentMethod.toLowerCase()),
        isOnline,
      };
    })
    .filter((t): t is Txn => t !== null && t.amount > 0);
  if (!txns.length) throw new ParseError('No paid Shopify orders found in this file.');
  return txns;
}

export function parseWise(rows: Row[]): Txn[] {
  const txns = rows
    .map((r): Txn | null => {
      if (s(col(r, 'status')).toUpperCase() !== 'COMPLETED' || s(col(r, 'direction')).toUpperCase() !== 'IN') return null;
      const date = parseDate(col(r, 'finished_on') || col(r, 'created_on'));
      if (!date) return null;
      const sender = s(col(r, 'source_name'));
      const note = s(col(r, 'note') || col(r, 'reference'));
      return {
        id: rid(),
        at: date.getTime(),
        type: 'Payment',
        amount: money(col(r, 'target_amount_(after_fees)')),
        currency: s(col(r, 'target_currency')) || 'EUR',
        terminal: 'Wise',
        card: sender,
        ref: s(col(r, 'id')),
        desc: note ? `Wise transfer — ${note}` : `Wise transfer from ${sender}`,
        source: 'wise',
      };
    })
    .filter((t): t is Txn => t !== null && t.amount > 0);
  if (!txns.length) throw new ParseError('No completed incoming Wise transfers found in this file.');
  return txns;
}

/** Rows pulled from the server halves already carry the normalised shape. */
export function fromSourceRow(o: { date: string; type: 'Payment' | 'Fee'; amount: number; currency: string; terminal: string; card: string; ref: string; desc: string; source: 'mypos' | 'sumup' | 'shopify'; isOnline: boolean; orderNum?: string; isManual?: boolean }): Txn {
  return {
    id: rid(),
    at: new Date(o.date).getTime(),
    type: o.type,
    amount: o.amount,
    currency: o.currency,
    terminal: o.terminal,
    card: o.card,
    ref: o.ref,
    desc: o.desc,
    source: o.source,
    isOnline: o.isOnline,
    orderNum: o.orderNum,
    isManual: o.isManual,
  };
}
