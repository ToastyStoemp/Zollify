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

  it('prints what the card was charged when it settled in another currency', () => {
    const lines = text(sale({ method: 'card', total: 30, payments: [{ kind: 'card', amount: 30, settled: { amount: 32.15, currency: 'EUR', rate: 0.9331 } }] }));
    expect(amountOn(lines, 'Card')).toBe('CHF 30.00');
    expect(amountOn(lines, 'charged')).toBe('EUR 32.15');
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
});

describe('printed footer links', () => {
  const lines = (linkLines?: string[]): string[] =>
    buildReceiptLines(sale(), 'Con', { artist: {}, logoB64: '', footerText: 'Thanks!', linkLines })
      .filter((l) => l.kind === 'text')
      .map((l) => l.text ?? '');

  it('prints nothing extra by default', () => {
    expect(lines()).toEqual(lines([]));
    expect(lines().join('\n')).not.toContain('Webstore');
  });

  it('prints each link as centred plain text within the paper width', () => {
    const out = lines(['Webstore: shop.example.com', 'Instagram: www.instagram.com/harbourprints']);
    expect(out.some((l) => l.includes('Webstore: shop.example.com'))).toBe(true);
    expect(out.every((l) => l.length <= 32)).toBe(true);
    expect(out.indexOf('Thanks!')).toBeLessThan(out.findIndex((l) => l.includes('Webstore')));
  });
});
