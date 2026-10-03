import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zollify/shared';
import { buildReceiptLines } from '../receipt';

/**
 * A sale charged abroad keeps its lines in the booth's book currency and only
 * its total in what the customer paid. The paper has to be in what they paid
 * throughout - lines, total and payment alike.
 */

const sale = (extra: Partial<Transaction> = {}): Transaction => ({
  id: 'tx-0000-1234abcd',
  eventId: 'ev',
  deviceId: 'd',
  timestamp: Date.UTC(2026, 9, 3, 10, 0),
  method: 'cash',
  payments: [{ kind: 'cash', amount: 45 }],
  items: [
    { pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 40 },
    { pid: 'p2', vid: null, title: 'Sticker', qty: 1, unitPrice: 5, lineTotal: 5 },
  ],
  discounts: [],
  total: 45,
  currency: 'CHF',
  ...extra,
});

const text = (tx: Transaction): string[] =>
  buildReceiptLines(tx, 'Con', { artist: {}, logoB64: '', footerText: '' })
    .filter((l) => l.kind === 'text')
    .map((l) => l.text ?? '');

const amountOn = (lines: string[], label: string): string => lines.find((l) => l.includes(label))!.trim().split(/\s{2,}/).pop()!;

describe('printed receipt amounts', () => {
  it('prints a home-currency sale exactly as recorded', () => {
    const lines = text(sale());
    expect(amountOn(lines, '2 x Print')).toBe('CHF 40.00');
    expect(lines).toContain('   à CHF 20.00');
  });

  it('prints a converted sale in the charged currency, lines adding up to the total', () => {
    // CHF 45 of goods charged as a rounded EUR 47.
    const lines = text(sale({ currency: 'EUR', total: 47, baseCurrency: 'CHF', baseTotal: 45, exchangeRate: 1.04, payments: [{ kind: 'cash', amount: 47 }] }));
    const print = amountOn(lines, '2 x Print');
    const sticker = amountOn(lines, '1 x Sticker');
    expect(print).toBe('EUR 41.78');
    expect(sticker).toBe('EUR 5.22');
    expect(lines).toContain('   à EUR 20.89');
    expect(amountOn(lines, 'TOTAL')).toBe('EUR 47.00');
    expect(lines.join('\n')).not.toContain('CHF');
  });

  it('prints a discounted sale as the till showed it: list prices, each discount, the total', () => {
    const lines = text(
      sale({
        // The bundle discount is spread into the stored line totals.
        items: [
          { pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36.8 },
          { pid: 'p2', vid: null, title: 'Sticker', qty: 1, unitPrice: 5, lineTotal: 4.2 },
        ],
        total: 41,
        payments: [{ kind: 'cash', amount: 41 }],
        asCharged: { listTotals: [40, 5], discounts: [{ name: 'Bundle deal', amount: 4 }] },
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('CHF 40.00');
    expect(lines).toContain('   à CHF 20.00');
    expect(amountOn(lines, 'Subtotal')).toBe('CHF 45.00');
    expect(amountOn(lines, 'Bundle deal')).toBe('-CHF 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('CHF 41.00');
  });

  it('prints a discounted sale abroad at the local prices that were on screen', () => {
    const lines = text(
      sale({
        items: [{ pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36 }],
        currency: 'EUR',
        total: 38,
        baseCurrency: 'CHF',
        baseTotal: 36,
        payments: [{ kind: 'cash', amount: 38 }],
        asCharged: { listTotals: [42], discounts: [{ name: 'Weekend', amount: 4 }] },
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('EUR 42.00');
    expect(lines).toContain('   à EUR 21.00');
    expect(amountOn(lines, 'Weekend')).toBe('-EUR 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('EUR 38.00');
    expect(lines.join('\n')).not.toContain('CHF');
  });

  it('still adds up for an older discounted sale that recorded no discount names', () => {
    const lines = text(
      sale({
        items: [{ pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 36 }],
        total: 36,
        payments: [{ kind: 'cash', amount: 36 }],
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('CHF 40.00');
    expect(amountOn(lines, 'Discount')).toBe('-CHF 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('CHF 36.00');
  });

  it('prints VAT per rate, lettering the lines when a sale mixes rates', () => {
    const lines = text(
      sale({
        currency: 'EUR',
        items: [
          { pid: 'p1', vid: null, title: 'Print', qty: 2, unitPrice: 20, lineTotal: 40 },
          { pid: 'p2', vid: null, title: 'Artbook', qty: 1, unitPrice: 10.7, lineTotal: 10.7 },
        ],
        total: 50.7,
        payments: [{ kind: 'cash', amount: 50.7 }],
        tax: { country: 'DE', exempt: false, rates: [19, 7] },
      }),
    );
    expect(amountOn(lines, '2 x Print')).toBe('EUR 40.00 A');
    expect(amountOn(lines, '1 x Artbook')).toBe('EUR 10.70 B');
    expect(amountOn(lines, 'A incl. VAT 19%')).toBe('EUR 6.39');
    expect(amountOn(lines, 'B incl. VAT 7%')).toBe('EUR 0.70');
  });

  it('prints one rate without letters', () => {
    const lines = text(sale({ currency: 'EUR', tax: { country: 'DE', exempt: false, rates: [19, 19] } }));
    expect(amountOn(lines, '2 x Print')).toBe('EUR 40.00');
    expect(amountOn(lines, 'incl. VAT 19%')).toBe('EUR 7.18');
  });

  it('prints the exemption and the EX number instead of VAT, and no VAT number', () => {
    const tx = sale({ currency: 'EUR', tax: { country: 'NL', exempt: true, rates: [null, null], note: 'VAT exempt under the EU SME scheme', exNumber: 'DE123456789EX' } });
    const lines = buildReceiptLines(tx, 'Con', { artist: { companyName: 'Harbour', vatNumber: 'DE123456789' }, logoB64: '', footerText: '' })
      .filter((l) => l.kind === 'text')
      .map((l) => (l.text ?? '').trim());
    expect(lines).toContain('VAT exempt under the EU SME');
    expect(lines).toContain('EX: DE123456789EX');
    expect(lines.join('\n')).not.toContain('VAT: DE123456789');
    expect(lines.join('\n')).not.toContain('incl. VAT');
  });

  const signed = {
    signed: {
      clientId: 'ZOLLIFY-TEST1',
      serial: 'a'.repeat(64),
      transactionNumber: 13,
      signatureCounter: 44131,
      start: '2026-10-03T12:00:01.000Z',
      finish: '2026-10-03T12:00:09.000Z',
      algorithm: 'ecdsa-plain-SHA384',
      timeFormat: 'unixTime',
      signature: 'SIG'.repeat(12),
      publicKey: 'PK',
      processType: 'Kassenbeleg-V1',
      processData: 'Beleg^45.00_0.00_0.00_0.00_0.00^45.00:Bar',
      test: true,
    },
  };

  it('prints the TSE block a German receipt needs', () => {
    const lines = text(sale({ currency: 'EUR', tse: signed }));
    expect(lines).toContain('TEST-TSE - NICHT ZERTIFIZIERT');
    expect(amountOn(lines, 'TSE-Transaktion')).toBe('13');
    expect(amountOn(lines, 'Signaturzaehler')).toBe('44131');
    expect(amountOn(lines, 'Start')).toBe('2026-10-03 12:00:01');
    expect(amountOn(lines, 'Ende')).toBe('2026-10-03 12:00:09');
    expect(amountOn(lines, 'Kasse')).toBe('ZOLLIFY-TEST1');
    // Serial and (without a QR image) the signature, wrapped to the paper.
    expect(lines).toContain('a'.repeat(32));
    const at = lines.indexOf('Signatur:');
    expect(lines.slice(at + 1, at + 3).join('')).toBe('SIG'.repeat(12));
  });

  it('says plainly when the TSE was out', () => {
    const lines = text(sale({ tse: { failed: { reason: 'TSE not responding', at: 1 } } })).map((l) => l.trim());
    expect(lines).toContain('TSE ausgefallen');
    expect(lines).toContain('Beleg ohne TSE-Signatur');
    expect(lines).toContain('TSE not responding');
  });

  it('prints the receipt number and till, once', () => {
    const lines = text(sale({ currency: 'EUR', tse: signed, receipt: { till: 'ZOLLIFY-TEST1', number: 42 } }));
    expect(amountOn(lines, 'Receipt no.')).toBe('42');
    expect(amountOn(lines, 'Till')).toBe('ZOLLIFY-TEST1');
    // Named at the top already, so the TSE block leaves the till out.
    expect(lines.some((l) => l.startsWith('Kasse'))).toBe(false);
    // The old short reference is only for sales from before numbering.
    expect(lines.some((l) => l.trim().startsWith('Receipt tx-'))).toBe(false);
  });

  const reverted = sale({
    currency: 'EUR',
    tse: signed,
    receipt: { till: 'ZOLLIFY-TEST1', number: 42 },
    revertedAt: Date.UTC(2026, 9, 3, 11, 0),
    revertReceipt: { till: 'ZOLLIFY-TEST1', number: 43 },
    revertTse: { signed: { ...signed.signed, transactionNumber: 14, processData: 'Beleg^-45.00_0.00_0.00_0.00_0.00^-45.00:Bar' } },
    asCharged: { listTotals: [44, 5], discounts: [{ name: 'Bundle', amount: 4 }] },
  });

  it('points a cancelled sale’s receipt to its cancellation', () => {
    const lines = text(reverted).map((l) => l.trim());
    expect(lines).toContain('CANCELLED - receipt no. 43');
    expect(lines.filter((l) => l.startsWith('TSE-Transaktion'))).toEqual(['TSE-Transaktion               13']);
  });

  it('prints a cancellation as a receipt of its own: own number and signature, every amount negative', () => {
    const lines = buildReceiptLines(reverted, 'Con', { artist: {}, logoB64: '', footerText: '' }, undefined, true)
      .filter((l) => l.kind === 'text')
      .map((l) => l.text ?? '');
    expect(lines.map((l) => l.trim())).toContain('STORNO / CANCELLATION');
    expect(lines.map((l) => l.trim())).toContain('of receipt no. 42');
    expect(amountOn(lines, 'Receipt no.')).toBe('43');
    expect(amountOn(lines, '-2 x Print')).toBe('EUR -44.00');
    expect(amountOn(lines, 'Bundle')).toBe('+EUR 4.00');
    expect(amountOn(lines, 'TOTAL')).toBe('EUR -45.00');
    expect(amountOn(lines, 'Cash refunded')).toBe('EUR -45.00');
    expect(amountOn(lines, 'TSE-Transaktion')).toBe('14');
    expect(amountOn(lines, 'Start')).toBe('2026-10-03 12:00:01');
  });
});
