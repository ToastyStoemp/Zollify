import { z } from 'zod';
import { csvCell } from './csv';
import type { ArtistReportRow, ReportPeriod } from './consignment-books';

/**
 * Consignment bookkeeping: the invoice a store issues each artist for a
 * period (self-billing - the store writes it on the artist's behalf), the
 * ISO 20022 payment file that pays what they are owed, and a journal CSV for
 * the bookkeeping package (e-conomic and the like). Pure, like the rest of
 * consignment: the server numbers and stores the invoices, the tests pin the
 * arithmetic and the XML.
 *
 * The payment file is pain.001.001.03 (customer credit transfer initiation),
 * the version the Nordic and SEPA banks and e-conomic's payment import all
 * accept. Each transfer's EndToEndId is the invoice number, so the camt.053
 * bank statement that comes back carries it and matches the invoice.
 */

const toMinor = (n: number): number => Math.round(n * 100);

// ── Bank details ────────────────────────────────────────────────────────────

export const normalizeIban = (s: string): string => s.replace(/\s+/g, '').toUpperCase();

/** IBAN structure and the mod-97 check (ISO 13616). Empty is not valid. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export const isValidBic = (s: string): boolean => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s.trim().toUpperCase());

/** Empty, or a valid IBAN (stored without spaces, upper case). */
export const IbanSchema = z
  .string()
  .trim()
  .max(42)
  .default('')
  .transform(normalizeIban)
  .refine((v) => v === '' || isValidIban(v), 'Not a valid IBAN.');
export const BicSchema = z
  .string()
  .trim()
  .max(11)
  .default('')
  .transform((v) => v.toUpperCase())
  .refine((v) => v === '' || isValidBic(v), 'Not a valid BIC.');

/** The store's own details for paying out and booking. */
export const AccountingSettingsSchema = z.object({
  /** Name on the account the payouts leave from. */
  payerName: z.string().trim().max(70).default(''),
  payerIban: IbanSchema,
  payerBic: BicSchema,
  /** Invoice numbers read `<prefix>-<year>-<sequence>`. */
  invoicePrefix: z.string().trim().regex(/^[A-Za-z0-9]{0,8}$/).default('SB'),
  /** Ledger account numbers in the bookkeeping package; blank leaves the column empty. */
  accountArtistPayable: z.string().trim().max(20).default(''),
  accountCommission: z.string().trim().max(20).default(''),
  accountFees: z.string().trim().max(20).default(''),
  accountRent: z.string().trim().max(20).default(''),
  accountCardCosts: z.string().trim().max(20).default(''),
});
export type AccountingSettings = z.infer<typeof AccountingSettingsSchema>;
export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = AccountingSettingsSchema.parse({});

// ── Invoices ────────────────────────────────────────────────────────────────

export interface InvoiceLine {
  kind: 'sales' | 'commission' | 'card_costs' | 'rent' | 'fees';
  text: string;
  /** Signed from the artist's side: what they earn is positive, what comes off is negative. */
  amount: number;
}

export interface ArtistInvoice {
  number: string;
  /** The day the period closed. */
  date: string;
  period: ReportPeriod;
  consignorId: string;
  consignorName: string;
  currency: string;
  lines: InvoiceLine[];
  /** What the period earned the artist: the lines summed. */
  total: number;
  issuedAt: number;
}

/**
 * The invoice for one artist's report row - null when the period left
 * nothing to bill (no sales, rent, fees or card costs). The artist's share is
 * the sale less the commission, so the lines show the sale and take the
 * commission off, which is how a self-billed invoice reads to the artist.
 */
export function invoiceLines(row: Pick<ArtistReportRow, 'gross' | 'discounts' | 'commission' | 'artistShare' | 'cardFees' | 'rent' | 'fees'>): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  if (toMinor(row.artistShare) !== 0 || toMinor(row.commission) !== 0) {
    lines.push({ kind: 'sales', text: 'Sales of your work', amount: (toMinor(row.artistShare) + toMinor(row.commission)) / 100 });
    lines.push({ kind: 'commission', text: 'Store commission', amount: -toMinor(row.commission) / 100 });
  }
  if (toMinor(row.cardFees) !== 0) lines.push({ kind: 'card_costs', text: 'Card costs carried', amount: -toMinor(row.cardFees) / 100 });
  if (toMinor(row.rent) !== 0) lines.push({ kind: 'rent', text: 'Space rent', amount: -toMinor(row.rent) / 100 });
  if (toMinor(row.fees) !== 0) lines.push({ kind: 'fees', text: 'Fees', amount: -toMinor(row.fees) / 100 });
  return lines;
}

export const invoiceTotal = (lines: Pick<InvoiceLine, 'amount'>[]): number => lines.reduce((s, l) => s + toMinor(l.amount), 0) / 100;

/** `SB-2026-00042`: the year the invoice is dated, then a gap-free sequence. */
export function invoiceNumber(prefix: string, date: string, seq: number): string {
  return `${prefix ? `${prefix}-` : ''}${date.slice(0, 4)}-${String(seq).padStart(5, '0')}`;
}

/** The journal as CSV: one row per invoice line, plus the balancing row on the payable account. */
export function journalCsv(invoices: ArtistInvoice[], s: AccountingSettings): string {
  const account: Record<InvoiceLine['kind'], string> = {
    sales: s.accountArtistPayable,
    commission: s.accountCommission,
    card_costs: s.accountCardCosts,
    rent: s.accountRent,
    fees: s.accountFees,
  };
  const cell = (v: string | number): string => (typeof v === 'number' ? v.toFixed(2) : csvCell(v));
  const out = [['Date', 'Voucher', 'Text', 'Account', 'Contra account', 'Amount', 'Currency'].join(',')];
  for (const inv of invoices) {
    for (const l of inv.lines) {
      // Bookkeeping reads from the store's side: commission and fees are income, the artist's share is owed.
      const amount = l.kind === 'sales' ? l.amount : -l.amount;
      out.push([inv.date, inv.number, `${l.text} - ${inv.consignorName}`, account[l.kind], l.kind === 'sales' ? '' : s.accountArtistPayable, amount, inv.currency].map(cell).join(','));
    }
  }
  return out.join('\n') + '\n';
}

// ── ISO 20022 pain.001.001.03 ───────────────────────────────────────────────

export interface Pain001Payment {
  /** Becomes EndToEndId; the invoice number when there is one. */
  reference: string;
  name: string;
  iban: string;
  bic?: string;
  amount: number;
  currency: string;
  /** Free text for the artist's bank statement. */
  remittance: string;
}

export interface Pain001Input {
  messageId: string;
  /** When the file was made. */
  createdAt: Date;
  /** The day the bank should pay, yyyy-mm-dd. */
  executionDate: string;
  debtor: { name: string; iban: string; bic?: string };
  payments: Pain001Payment[];
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Text the way ISO 20022 payment files in the SEPA character set carry it: accents folded, the rest dropped. */
export function sepaText(s: string, max: number): string {
  const folded = s
    .replace(/ß/g, 'ss')
    .replace(/[Ææ]/g, (c) => (c === 'Æ' ? 'AE' : 'ae'))
    .replace(/[Øø]/g, (c) => (c === 'Ø' ? 'O' : 'o'))
    .replace(/[Åå]/g, (c) => (c === 'Å' ? 'A' : 'a'))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9/?:().,'+\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return folded.slice(0, max).trim();
}

const amountText = (minor: number): string => (minor / 100).toFixed(2);
const tag = (name: string, inner: string): string => `<${name}>${inner}</${name}>`;

/**
 * A customer credit transfer file: one payment information block per
 * currency (a block has one debit account and one currency), each transfer
 * carrying its own reference. Throws when something a bank would reject is
 * missing, so a bad file is never offered for download.
 */
export function pain001(input: Pain001Input): string {
  const { debtor } = input;
  if (!isValidIban(debtor.iban)) throw new Error('The store needs a valid IBAN to pay from.');
  if (!debtor.name.trim()) throw new Error('The store needs a name on its payout account.');
  if (!input.payments.length) throw new Error('Nothing to pay.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executionDate)) throw new Error('The execution date must be yyyy-mm-dd.');
  for (const p of input.payments) {
    if (!isValidIban(p.iban)) throw new Error(`${p.name} has no valid IBAN.`);
    if (!/^[A-Z]{3}$/.test(p.currency)) throw new Error(`${p.name}: unknown currency.`);
    if (!(toMinor(p.amount) > 0)) throw new Error(`${p.name}: nothing to pay.`);
  }

  const byCurrency = new Map<string, Pain001Payment[]>();
  for (const p of input.payments) byCurrency.set(p.currency, [...(byCurrency.get(p.currency) ?? []), p]);
  const sum = (ps: Pain001Payment[]): number => ps.reduce((s, p) => s + toMinor(p.amount), 0);
  const debtorName = sepaText(debtor.name, 70);
  const created = input.createdAt.toISOString().replace(/\.\d{3}Z$/, '');
  const msgId = sepaText(input.messageId, 35);

  const blocks = [...byCurrency.entries()].map(([currency, ps], i) =>
    tag(
      'PmtInf',
      [
        tag('PmtInfId', xmlEscape(sepaText(`${input.messageId}-${i + 1}`, 35))),
        tag('PmtMtd', 'TRF'),
        tag('BtchBookg', 'true'),
        tag('NbOfTxs', String(ps.length)),
        tag('CtrlSum', amountText(sum(ps))),
        // SEPA payments are euro credit transfers; anything else is an ordinary one.
        ...(currency === 'EUR' ? [tag('PmtTpInf', tag('SvcLvl', tag('Cd', 'SEPA')))] : []),
        tag('ReqdExctnDt', input.executionDate),
        tag('Dbtr', tag('Nm', xmlEscape(debtorName))),
        tag('DbtrAcct', tag('Id', tag('IBAN', normalizeIban(debtor.iban)))),
        tag('DbtrAgt', tag('FinInstnId', debtor.bic ? tag('BIC', debtor.bic.toUpperCase()) : tag('Othr', tag('Id', 'NOTPROVIDED')))),
        tag('ChrgBr', 'SLEV'),
        ...ps.map((p, j) =>
          tag(
            'CdtTrfTxInf',
            [
              tag('PmtId', tag('InstrId', xmlEscape(sepaText(`${i + 1}-${j + 1}`, 35))) + tag('EndToEndId', xmlEscape(sepaText(p.reference, 35) || 'NOTPROVIDED'))),
              tag('Amt', `<InstdAmt Ccy="${currency}">${amountText(toMinor(p.amount))}</InstdAmt>`),
              ...(p.bic ? [tag('CdtrAgt', tag('FinInstnId', tag('BIC', p.bic.toUpperCase())))] : []),
              tag('Cdtr', tag('Nm', xmlEscape(sepaText(p.name, 70) || 'Artist'))),
              tag('CdtrAcct', tag('Id', tag('IBAN', normalizeIban(p.iban)))),
              ...(sepaText(p.remittance, 140) ? [tag('RmtInf', tag('Ustrd', xmlEscape(sepaText(p.remittance, 140))))] : []),
            ].join(''),
          ),
        ),
      ].join(''),
    ),
  );

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    tag(
      'CstmrCdtTrfInitn',
      tag('GrpHdr', [tag('MsgId', xmlEscape(msgId)), tag('CreDtTm', created), tag('NbOfTxs', String(input.payments.length)), tag('CtrlSum', amountText(sum(input.payments))), tag('InitgPty', tag('Nm', xmlEscape(debtorName)))].join('')) +
        blocks.join(''),
    ) +
    '</Document>\n'
  );
}
