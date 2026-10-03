import { describe, expect, it } from 'vitest';
import type { CashClosing, SalesEvent, Transaction, TseSignature } from '@zollify/shared';
import { COLUMNS, buildDsfinvk, type DsfinvkInput } from '../modules/dsfinvk/build';

/**
 * The DSFinV-K export: files, columns and formats as the official index.xml
 * says, and the bookkeeping of a German till - a closing with its receipts,
 * a cancellation as a negative receipt that points to the original, VAT by
 * key, payments, and each receipt's TSE signature.
 */

const sig = (over: Partial<TseSignature> = {}): TseSignature => ({
  clientId: 'ZOLLIFY-TILL1',
  serial: 'ab'.repeat(32),
  transactionNumber: 7,
  signatureCounter: 15,
  start: '2026-09-12T10:00:01.000Z',
  finish: '2026-09-12T10:00:09.000Z',
  algorithm: 'ecdsa-plain-SHA384',
  timeFormat: 'unixTime',
  signature: 'SIG==',
  publicKey: 'PUB==',
  processType: 'Kassenbeleg-V1',
  processData: 'Beleg^40.00_10.70_0.00_0.00_0.00^50.70:Bar',
  ...over,
});

const at = Date.parse('2026-09-12T10:00:09Z');

/** A sale of two prints (19%) and an artbook (7%) with 4 off the whole, paid cash. */
const sale: Transaction = {
  id: 'tx-1',
  eventId: 'ev-de',
  deviceId: 'dev-1',
  timestamp: at,
  method: 'cash',
  payments: [{ kind: 'cash', amount: 46.7 }],
  items: [
    { pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36 },
    { pid: 'p2', vid: null, title: 'Artbook', qty: 1, unitPrice: 10.7, lineTotal: 10.7 },
  ],
  discounts: [],
  total: 46.7,
  currency: 'EUR',
  asCharged: { listTotals: [40, 10.7], discounts: [{ name: 'Bundle', amount: 4 }] },
  tax: { country: 'DE', exempt: false, rates: [19, 7] },
  receipt: { till: 'ZOLLIFY-TILL1', number: 1 },
  tse: { signed: sig() },
  // Cancelled the same day, as receipt 3.
  revertedAt: at + 60_000,
  revertedBy: 'op-r',
  revertReceipt: { till: 'ZOLLIFY-TILL1', number: 3 },
  revertTse: { signed: sig({ transactionNumber: 9, signatureCounter: 19, processData: 'Beleg^-40.00_-10.70_0.00_0.00_0.00^-50.70:Bar' }) },
};

/** A card sale exempt under the small-business scheme, TSE out. */
const exempt: Transaction = {
  id: 'tx-2',
  eventId: 'ev-de',
  deviceId: 'dev-1',
  timestamp: at + 30_000,
  method: 'card',
  payments: [{ kind: 'card', amount: 12, provider: 'mypos' }],
  items: [{ pid: 'p3', vid: 'v1', variantLabel: 'Large', title: 'Sticker', qty: 3, unitPrice: 4, lineTotal: 12 }],
  discounts: [],
  total: 12,
  currency: 'EUR',
  tax: { country: 'DE', exempt: true, rates: [null], note: 'VAT exempt under the EU SME scheme', exNumber: 'BE0123456789EX' },
  receipt: { till: 'ZOLLIFY-TILL1', number: 2 },
  tse: { failed: { reason: 'TSE not responding', at: 1 } },
};

const closing: CashClosing = {
  id: 'cl-1',
  till: 'ZOLLIFY-TILL1',
  number: 1,
  createdAt: Date.parse('2026-09-12T22:00:00Z'),
  businessDay: '2026-09-12',
  firstReceipt: 1,
  lastReceipt: 3,
  eventId: 'ev-de',
  currency: 'EUR',
  deviceId: 'dev-1',
  device: { brand: 'myPOS', model: 'Carbon', software: 'Zollify', version: '1.2.3' },
  receipts: 3,
  total: 12,
  cash: 0,
};

const events: SalesEvent[] = [
  { id: 'ev-de', name: 'Leipzig Comic Con', venue: { street: 'Messe-Allee 1', postcode: '04356', city: 'Leipzig', country: 'Germany' }, currency: 'EUR', status: 'active', updatedAt: 1 } as SalesEvent,
  { id: 'ev-ch', name: 'Fantasy Basel', venue: { city: 'Basel', country: 'Switzerland' }, currency: 'CHF', status: 'active', updatedAt: 1 } as SalesEvent,
];

const input = (over: Partial<DsfinvkInput> = {}): DsfinvkInput => ({
  closings: [closing],
  transactions: [sale, exempt],
  events,
  seller: { name: 'Harbour Prints', street: 'Kade 1', postCodeCity: '2000 Antwerpen', country: 'Belgium', vatId: 'BE 0123.456.789' },
  from: '2026-09-01',
  to: '2026-09-30',
  germanyOnly: true,
  ...over,
});

/** A file's rows as objects keyed by the header. */
function table(files: Record<string, string>, name: string): Record<string, string>[] {
  const [head, ...rows] = files[name]!.split('\r\n').filter(Boolean);
  const cols = head!.split(';');
  return rows.map((r) => Object.fromEntries(r.split(';').map((v, i) => [cols[i], v])));
}

describe('DSFinV-K export', () => {
  const out = buildDsfinvk(input());

  it('has every file the official index.xml lists, with its columns in order, CRLF and a header', () => {
    expect(Object.keys(COLUMNS)).toHaveLength(20);
    for (const [file, cols] of Object.entries(COLUMNS)) {
      expect(out.files[file]!.split('\r\n')[0]).toBe(cols.join(';'));
      expect(out.files[file]!.endsWith('\r\n')).toBe(true);
    }
    expect(COLUMNS['transactions.csv']!.slice(0, 7)).toEqual(['Z_KASSE_ID', 'Z_ERSTELLUNG', 'Z_NR', 'BON_ID', 'BON_NR', 'BON_TYP', 'BON_NAME']);
    expect(out.files['index.xml']).toContain('<URL>transactions_tse.csv</URL>');
    expect(out.files['gdpdu-01-09-2004.dtd']).toContain('<!ELEMENT DataSet');
  });

  it('lists each receipt of the closing; the cancellation negative, flagged and pointing to the original', () => {
    const heads = table(out.files, 'transactions.csv');
    expect(heads.map((h) => [h.BON_ID, h.BON_NR, h.BON_TYP, h.BON_STORNO, h.UMS_BRUTTO])).toEqual([
      ['1', '1', 'Beleg', '0', '46,70'],
      ['2', '2', 'Beleg', '0', '12,00'],
      ['3', '3', 'Beleg', '1', '-46,70'],
    ]);
    expect(heads[0]).toMatchObject({ Z_KASSE_ID: 'ZOLLIFY-TILL1', Z_ERSTELLUNG: '2026-09-12T22:00:00Z', Z_NR: '1', BON_START: '2026-09-12T10:00:01Z', BON_ENDE: '2026-09-12T10:00:09Z' });
    expect(table(out.files, 'references.csv')).toEqual([
      expect.objectContaining({ BON_ID: '3', REF_TYP: 'Transaktion', REF_Z_KASSE_ID: 'ZOLLIFY-TILL1', REF_Z_NR: '1', REF_BON_ID: '1', REF_DATUM: '2026-09-12T22:00:00Z' }),
    ]);
  });

  it('gives VAT per key as printed, lines after discount with the list price and the discount beside', () => {
    expect(table(out.files, 'transactions_vat.csv').filter((r) => r.BON_ID === '1').map((r) => [r.UST_SCHLUESSEL, r.BON_BRUTTO, r.BON_NETTO, r.BON_UST])).toEqual([
      // The bundle discount is spread over the whole sale, as the receipt prints it.
      ['1', '36,84000', '30,96000', '5,88000'],
      ['2', '9,86000', '9,21000', '0,65000'],
    ]);
    const lines = table(out.files, 'lines.csv').filter((r) => r.BON_ID === '1');
    expect(lines.map((l) => [l.POS_ZEILE, l.ARTIKELTEXT, l.GV_TYP, l.MENGE, l.STK_BR])).toEqual([
      ['1', 'Print', 'Umsatz', '2,000', '20,00000'],
      ['2', 'Artbook', 'Umsatz', '1,000', '10,70000'],
    ]);
    expect(table(out.files, 'lines_vat.csv').find((r) => r.BON_ID === '1' && r.POS_ZEILE === '1')).toMatchObject({ UST_SCHLUESSEL: '1', POS_BRUTTO: '36,84000', POS_NETTO: '30,96000', POS_UST: '5,88000' });
    expect(table(out.files, 'itemamounts.csv').filter((r) => r.BON_ID === '1' && r.POS_ZEILE === '1').map((r) => [r.TYP, r.PF_BRUTTO])).toEqual([
      ['base_amount', '40,00000'],
      ['discount', '-3,16000'],
    ]);
    // The cancellation reverses it all.
    expect(table(out.files, 'lines.csv').filter((r) => r.BON_ID === '3').map((l) => l.MENGE)).toEqual(['-2,000', '-1,000']);
  });

  it('books a small-business sale as VAT-free (key 6), and says when the TSE was out', () => {
    expect(table(out.files, 'transactions_vat.csv').filter((r) => r.BON_ID === '2')).toEqual([expect.objectContaining({ UST_SCHLUESSEL: '6', BON_BRUTTO: '12,00000', BON_UST: '0,00000' })]);
    expect(table(out.files, 'lines.csv').find((r) => r.BON_ID === '2')).toMatchObject({ ARTIKELTEXT: 'Sticker (Large)', ART_NR: 'p3:v1', MENGE: '3,000', STK_BR: '4,00000' });
    expect(table(out.files, 'vat.csv').map((r) => [r.UST_SCHLUESSEL, r.UST_SATZ])).toEqual([
      ['1', '19,00'],
      ['2', '7,00'],
      ['6', '0,00'],
    ]);
    expect(table(out.files, 'transactions_tse.csv').find((r) => r.BON_ID === '2')).toMatchObject({ TSE_TA_FEHLER: 'TSE ausgefallen: TSE not responding', TSE_TANR: '' });
  });

  it('carries each signature, and the TSE once per closing', () => {
    const tse = table(out.files, 'transactions_tse.csv');
    expect(tse.find((r) => r.BON_ID === '1')).toMatchObject({ TSE_ID: '1', TSE_TANR: '7', TSE_TA_START: '2026-09-12T10:00:01.000Z', TSE_TA_SIGZ: '15', TSE_TA_SIG: 'SIG==', TSE_TA_VORGANGSART: 'Kassenbeleg-V1', TSE_VORGANGSDATEN: 'Beleg^40.00_10.70_0.00_0.00_0.00^50.70:Bar' });
    expect(tse.find((r) => r.BON_ID === '3')).toMatchObject({ TSE_ID: '1', TSE_TANR: '9' });
    expect(table(out.files, 'tse.csv')).toEqual([expect.objectContaining({ TSE_ID: '1', TSE_SERIAL: 'ab'.repeat(32), TSE_SIG_ALGO: 'ecdsa-plain-SHA384', TSE_ZEITFORMAT: 'unixTime', TSE_PD_ENCODING: 'UTF-8', TSE_PUBLIC_KEY: 'PUB==' })]);
  });

  it('sums the closing: business cases by VAT key, payments, cash, and the master data', () => {
    expect(table(out.files, 'businesscases.csv').map((r) => [r.GV_TYP, r.UST_SCHLUESSEL, r.Z_UMS_BRUTTO, r.Z_UMS_NETTO, r.Z_UST])).toEqual([
      ['Umsatz', '1', '0,00000', '0,00000', '0,00000'],
      ['Umsatz', '2', '0,00000', '0,00000', '0,00000'],
      ['Umsatz', '6', '12,00000', '12,00000', '0,00000'],
    ]);
    expect(table(out.files, 'payment.csv').map((r) => [r.ZAHLART_TYP, r.ZAHLART_NAME, r.Z_ZAHLART_BETRAG])).toEqual([
      ['Bar', 'Bar', '0,00'],
      ['Unbar', 'mypos', '12,00'],
    ]);
    expect(table(out.files, 'cash_per_currency.csv')).toEqual([expect.objectContaining({ ZAHLART_WAEH: 'EUR', ZAHLART_BETRAG_WAEH: '0,00' })]);
    expect(table(out.files, 'cashpointclosing.csv')[0]).toMatchObject({
      TAXONOMIE_VERSION: '2.4',
      Z_START_ID: '1',
      Z_ENDE_ID: '3',
      NAME: 'Harbour Prints',
      PLZ: '2000',
      ORT: 'Antwerpen',
      LAND: 'BEL',
      USTID: 'BE0123.456.789',
      Z_SE_ZAHLUNGEN: '12,00',
      Z_SE_BARZAHLUNGEN: '0,00',
    });
    expect(table(out.files, 'location.csv')[0]).toMatchObject({ LOC_NAME: 'Leipzig Comic Con', LOC_STRASSE: 'Messe-Allee 1', LOC_PLZ: '04356', LOC_ORT: 'Leipzig', LOC_LAND: 'DEU' });
    expect(table(out.files, 'cashregister.csv')[0]).toMatchObject({ KASSE_BRAND: 'myPOS', KASSE_MODELL: 'Carbon', KASSE_SERIENNR: 'ZOLLIFY-TILL1', KASSE_SW_BRAND: 'Zollify', KASSE_SW_VERSION: '1.2.3', KASSE_BASISWAEH_CODE: 'EUR', KEINE_UST_ZUORDNUNG: '0' });
    expect(out).toMatchObject({ closings: 1, receipts: 3 });
  });

  it('keeps to the range and to Germany, and warns about what an inspector would miss', () => {
    const swiss: CashClosing = { ...closing, id: 'cl-2', number: 2, eventId: 'ev-ch', currency: 'CHF', firstReceipt: 4, lastReceipt: 4 };
    expect(buildDsfinvk(input({ closings: [closing, swiss] })).closings).toBe(1);
    expect(buildDsfinvk(input({ closings: [closing, swiss], germanyOnly: false })).closings).toBe(2);
    expect(buildDsfinvk(input({ from: '2026-10-01', to: '2026-10-31' })).closings).toBe(0);
    // Receipt 2 never synced, and receipts taken after the closing.
    const late: Transaction = { ...exempt, id: 'tx-3', receipt: { till: 'ZOLLIFY-TILL1', number: 4 } };
    const w = buildDsfinvk(input({ transactions: [sale, late] })).warnings;
    expect(w).toContain('Till ZOLLIFY-TILL1: receipt 2 (closing 1) is not on the server - the device that took it may not have synced.');
    expect(w.some((x) => x.includes('1 receipt(s) not closed yet'))).toBe(true);
  });

  it('writes every value as its column in index.xml says: places, lengths', () => {
    // Amounts in five-place columns carry five places, rounded to the cent; text is cut to its length.
    expect(table(out.files, 'transactions_vat.csv')[0]!.BON_BRUTTO).toMatch(/^-?\d+,\d{5}$/);
    expect(table(out.files, 'transactions.csv')[0]!.UMS_BRUTTO).toMatch(/^-?\d+,\d{2}$/);
    const long: Transaction = { ...exempt, tse: { failed: { reason: 'x'.repeat(500), at: 1 } } };
    const tse = table(buildDsfinvk(input({ transactions: [sale, long] })).files, 'transactions_tse.csv');
    expect(tse.find((r) => r.BON_ID === '2')!.TSE_TA_FEHLER).toHaveLength(200);
  });

  it('quotes text that would break a line, and nothing else', () => {
    const odd: Transaction = { ...exempt, items: [{ ...exempt.items[0]!, title: 'Print; "A3"', variantLabel: undefined }] };
    const files = buildDsfinvk(input({ transactions: [sale, odd] })).files;
    expect(files['lines.csv']).toContain(';"Print; ""A3""";');
  });
});
