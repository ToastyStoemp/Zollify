import { describe, expect, it } from 'vitest';
import type { Transaction } from '@zollify/shared';
import { vatByEvent } from '../ledger-vat';

const sale = (eventId: string, total: number, tax: Transaction['tax'], extra: Partial<Transaction> = {}): Transaction =>
  ({
    id: `${eventId}-${total}`,
    eventId,
    deviceId: 'd',
    timestamp: 0,
    method: 'card',
    payments: [],
    items: [{ pid: 'p', vid: null, title: 't', qty: 1, unitPrice: total, lineTotal: total }],
    discounts: [],
    total,
    currency: 'EUR',
    ...(tax ? { tax } : {}),
    ...extra,
  }) as Transaction;

describe('vatByEvent', () => {
  it('adds up the VAT inside charged sales, nothing for exempt ones', () => {
    const vat = vatByEvent([
      sale('cph', 98, { country: 'DK', exempt: false, rates: [25] }),
      sale('cph', 50, { country: 'DK', exempt: false, rates: [25] }),
      sale('ams', 71, { country: 'NL', exempt: true, rates: [null] }),
      sale('old', 30, undefined),
    ]);
    expect(vat).toEqual({ cph: 29.6 });
  });

  it('leaves reverted sales out and scales converted ones to the book currency', () => {
    const vat = vatByEvent([
      sale('cph', 98, { country: 'DK', exempt: false, rates: [25] }, { revertedBy: 'x' }),
      sale('zrh', 108.1, { country: 'CH', exempt: false, rates: [8.1] }, { currency: 'CHF', baseCurrency: 'EUR', baseTotal: 54.05 }),
    ]);
    expect(vat).toEqual({ zrh: 4.05 });
  });
});
