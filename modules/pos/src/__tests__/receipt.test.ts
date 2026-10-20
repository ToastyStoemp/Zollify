import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zollify/shared';
import { RECEIPT_FIELD_DEFAULTS, buildReceiptLines, paymentLabel, receiptFields, resolveVatNumber, sellerLines } from '../receipt';

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

describe('optional header fields', () => {
  const artist = { companyName: 'Phuong Ninjin', fullName: 'Phuong Nguyen', street: 'Buckower Damm 93', postCodeCity: '12349 Berlin', countryOfOrigin: 'Germany', phone: '+49 176 0000000', email: 'shop@example.com', vatNumber: 'DE357138076' };
  const text = (fields?: Parameters<typeof buildReceiptLines>[2]['fields']) =>
    buildReceiptLines(sale(), 'Herofest', { artist, logoB64: '', footerText: '', fields }).map((l) => l.text ?? '').join('\n');

  it('prints the bare minimum by default: no phone or email', () => {
    const t = text();
    for (const s of ['Phuong Ninjin', 'Phuong Nguyen', 'Buckower Damm 93', '12349 Berlin, Germany', 'DE357138076']) expect(t).toContain(s);
    expect(t).not.toContain('+49 176');
    expect(t).not.toContain('shop@example.com');
    expect(RECEIPT_FIELD_DEFAULTS).toMatchObject({ phone: false, email: false, vatNumber: true });
  });

  it('prints or hides each optional field as ticked', () => {
    const t = text({ phone: true, email: true, country: false, vatNumber: false, fullName: false });
    expect(t).toContain('+49 176');
    expect(t).toContain('shop@example.com');
    expect(t).toContain('12349 Berlin\n');
    expect(t).not.toContain('Germany');
    expect(t).not.toContain('DE357138076');
    expect(t).not.toContain('Phuong Nguyen');
  });

  it('always prints the full name when it is the only name', () => {
    const t = buildReceiptLines(sale(), 'Herofest', { artist: { ...artist, companyName: '' }, logoB64: '', footerText: '', fields: { fullName: false } }).map((l) => l.text ?? '').join('\n');
    expect(t).toContain('Phuong Nguyen');
  });

  it('reads stored choices over the defaults, ignoring junk', () => {
    expect(receiptFields({ phone: true, email: 'yes' })).toEqual({ ...RECEIPT_FIELD_DEFAULTS, phone: true });
    expect(receiptFields(null)).toEqual(RECEIPT_FIELD_DEFAULTS);
  });
});

describe('resolveVatNumber', () => {
  it('matches a country by name or code alike', () => {
    const artist = { vatNumber: 'BE0123456789', vatNumbers: [{ country: 'NL', vatNumber: 'NL123B01' }, { country: 'Germany', vatNumber: 'DE999' }] };
    expect(resolveVatNumber(artist, 'Netherlands')).toBe('NL123B01');
    expect(resolveVatNumber(artist, 'DE')).toBe('DE999');
    expect(resolveVatNumber(artist, 'France')).toBe('BE0123456789');
  });
});

describe('seller block', () => {
  const artist = { companyName: 'Lena Draws', fullName: 'Lena Hartmann', street: 'Karl-Liebknecht-Str. 12', postCodeCity: '04107 Leipzig', countryOfOrigin: 'Germany', vatNumber: 'DE123456789' };

  it('is the same block the printed copy carries, in order', () => {
    const block = sellerLines(sale({ currency: 'EUR' }), { artist }).map((s) => s.text);
    expect(block).toEqual(['Lena Draws', 'Lena Hartmann', 'Karl-Liebknecht-Str. 12', '04107 Leipzig, Germany', 'USt-IdNr.: DE123456789']);
    const printed = buildReceiptLines(sale({ currency: 'EUR' }), 'Con', { artist, logoB64: '', footerText: '' }).slice(0, block.length).map((l) => l.text);
    expect(printed).toEqual(block);
  });

  it('marks the business name as the heading', () => {
    expect(sellerLines(sale(), { artist })[0]).toEqual({ text: 'Lena Draws', heading: true });
  });

  it('names a Swedish seller\'s organisationsnummer on an exempt sale, read from the Swedish VAT number', () => {
    const se = { ...artist, countryOfOrigin: 'Sweden', vatNumber: 'SE556016272701' };
    const exempt = sale({ currency: 'SEK', tax: { country: 'SE', exempt: true, rates: [null, null], note: 'Momsbefriad' } });
    expect(sellerLines(exempt, { artist: se }).map((s) => s.text)).toContain('Org.nr: 556016-2727');
    expect(sellerLines(exempt, { artist: se }).map((s) => s.text).join('\n')).not.toContain('Momsreg');
    // Taxable: the Momsreg.nr line already holds it.
    expect(sellerLines(sale({ currency: 'SEK', tax: { country: 'SE', exempt: false, rates: [25, 25] } }), { artist: se }).map((s) => s.text)).toContain('Momsreg.nr: SE556016272701');
    // Not Swedish: nothing added.
    expect(sellerLines(sale({ tax: { country: 'DE', exempt: true, rates: [null, null] } }), { artist }).map((s) => s.text).join('\n')).not.toContain('Org.nr');
  });

  it('leaves the VAT number off an exempt sale - the exemption line stands in for it', () => {
    const block = sellerLines(sale({ tax: { country: 'DE', exempt: true, rates: [null, null], note: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.' } }), { artist }).map((s) => s.text);
    expect(block.join('\n')).not.toContain('DE123456789');
    expect(block).toContain('04107 Leipzig, Germany');
  });

  it('is empty when nothing about the seller is known', () => {
    expect(sellerLines(sale(), { artist: {} })).toEqual([]);
  });
});

describe('payment label', () => {
  it('names the method, never the terminal driver', () => {
    expect(paymentLabel({ method: 'card' }, { kind: 'card', provider: 'manual' })).toBe('Card');
    expect(paymentLabel({ method: 'card' }, { kind: 'card', provider: 'mypos-go2' })).toBe('Card');
    expect(paymentLabel({ method: 'cash' }, { kind: 'cash', provider: 'manual' })).toBe('Cash');
    expect(paymentLabel({ method: 'split' }, { kind: 'card', provider: 'sumup' })).toBe('Card');
  });

  it("keeps the booth's own method name", () => {
    expect(paymentLabel({ method: 'TWINT' }, { kind: 'card', provider: 'TWINT' })).toBe('TWINT');
  });

  it('prints "Card" on the paper copy for a card recorded by hand', () => {
    const lines = text(sale({ method: 'card', payments: [{ kind: 'card', amount: 45, provider: 'manual' }] }));
    expect(amountOn(lines, 'Card')).toBe('CHF 45.00');
    expect(lines.join('\n')).not.toContain('manual');
  });
});
