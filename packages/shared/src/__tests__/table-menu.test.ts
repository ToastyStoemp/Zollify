import { describe, expect, it } from 'vitest';
import type { DiscountRule, EventStock, Product, SalesEvent } from '../types';
import { tableEvent, tableMenu } from '../table-menu';

/** The public menu: which event, what is on the table, at the booth's prices - and nothing from the books. */

const ev = (id: string, extra: Partial<SalesEvent> = {}): SalesEvent => ({ id, name: id, venue: {}, currency: 'EUR', status: 'active', dateStart: '2026-05-01', dateEnd: '2026-05-03', updatedAt: 1, ...extra });
const product = (id: string, extra: Partial<Product> = {}): Product => ({ id, title: id, forSale: true, unlisted: false, price: 10, variants: [], sortOrder: 0, updatedAt: 1, ...extra });
const claim = (eventId: string, productId: string, variantId = '', broughtQty = 5): EventStock => ({ eventId, productId, variantId, broughtQty, updatedAt: 1 });

const products = [
  product('harbour', { title: 'Harbour', type: 'Prints', sortOrder: 2, imageId: 'img-h', variants: [{ id: 'a4', name: 'A4', price: 25 }, { id: 'a3', name: 'A3', price: 40 }, { id: 'a2', name: 'A2', price: 60, unlisted: true }] }),
  product('pin', { title: 'Fox pin', type: 'Pins', price: 8, sortOrder: 1, variants: [{ id: 'gold', name: 'Gold', imageId: 'img-pin-gold' }] }),
  product('sticker', { title: 'Sticker', price: 2, sortOrder: 3 }),
  product('secret', { title: 'Secret print', type: 'Prints', unlisted: true }),
  product('gone', { title: 'Gone', deletedAt: 1 }),
  product('display', { title: 'Display only', forSale: false }),
];
const deals: DiscountRule[] = [{ id: 'd', name: '3 prints', type: 'tiered', productIds: [], variantIds: [], productTypes: ['Prints'], tiers: [{ qty: 3, total: 60 }, { qty: 5, total: 90 }], updatedAt: 1 }];
const base = { products, discounts: deals, stock: [] as EventStock[], currency: 'EUR', today: '2026-05-02' };

describe('tableEvent', () => {
  it('takes the open event running today, else the open one that started last; never a store, a test event or a planned one', () => {
    expect(tableEvent([ev('later', { dateStart: '2026-06-01', dateEnd: '2026-06-02' }), ev('now')], '2026-05-02')?.id).toBe('now');
    expect(tableEvent([ev('april', { dateStart: '2026-04-01', dateEnd: '2026-04-02' }), ev('june', { dateStart: '2026-06-01', dateEnd: '2026-06-02' })], '2026-05-02')?.id).toBe('june');
    expect(tableEvent([ev('shop', { kind: 'store' }), ev('rehearsal', { test: true }), ev('planned', { status: 'planned' }), ev('done', { status: 'closed' })], '2026-05-02')).toBeNull();
  });
});

describe('tableMenu', () => {
  it('lists the whole catalogue, listed and for sale only, grouped by type with the untyped last, when nothing is claimed', () => {
    const m = tableMenu({ ...base, events: [ev('con')] });
    expect(m.scope).toBe('catalogue');
    expect(m.event).toMatchObject({ id: 'con', name: 'con', start: '2026-05-01', end: '2026-05-03' });
    expect(m.currency).toBe('EUR');
    expect(m.groups.map((g) => [g.type, g.items.map((i) => i.title)])).toEqual([
      ['Pins', ['Fox pin']],
      ['Prints', ['Harbour']],
      ['', ['Sticker']],
    ]);
    expect(m.count).toBe(3);
    const harbour = m.groups[1]!.items[0]!;
    expect(harbour.imageId).toBe('img-h');
    expect(harbour.lines).toEqual([
      { variantId: 'a4', name: 'A4', text: '€25.00', amount: 25, deal: '3 for €60 · 5 for €90' },
      { variantId: 'a3', name: 'A3', text: '€40.00', amount: 40, deal: '3 for €60 · 5 for €90' },
    ]);
    // A variant's photo stands in for a product without one; a single-price product is one unnamed line.
    expect(m.groups[0]!.items[0]).toMatchObject({ imageId: 'img-pin-gold', lines: [{ variantId: 'gold', name: 'Gold', text: '€8.00', deal: '' }] });
    expect(m.groups[2]!.items[0]!.lines).toEqual([{ variantId: '', name: '', text: '€2.00', amount: 2, deal: '' }]);
  });

  it('shows what the open event claimed, and only that', () => {
    const stock = [claim('con', 'harbour', 'a3'), claim('con', 'sticker'), claim('con', 'pin', 'gold', 0), claim('other', 'pin', 'gold')];
    const m = tableMenu({ ...base, events: [ev('con'), ev('other', { status: 'closed' })], stock });
    expect(m.scope).toBe('table');
    expect(m.count).toBe(2);
    expect(m.groups.map((g) => g.items.map((i) => [i.title, i.lines.map((l) => l.name)]))).toEqual([[['Harbour', ['A3']]], [['Sticker', ['']]]]);
  });

  it('prices as the booth charges there: the local currency, its rounding, and a typed-over price', () => {
    const se = ev('se', { localCurrency: 'SEK', exchangeRate: 11, roundingIncrement: 10, localPriceOverrides: { 'harbour:a3': 450, sticker: 25 } });
    const m = tableMenu({ ...base, events: [se], stock: [claim('se', 'harbour', 'a4'), claim('se', 'harbour', 'a3'), claim('se', 'sticker')] });
    expect(m.currency).toBe('SEK');
    const harbour = m.groups.find((g) => g.type === 'Prints')!.items[0]!;
    expect(harbour.lines.map((l) => [l.name, l.text, l.amount])).toEqual([
      ['A4', '280 kr', 280],
      ['A3', '450 kr', 450],
    ]);
    expect(harbour.lines[0]!.deal).toBe('3 for 660 kr · 5 for 990 kr');
    expect(m.groups.find((g) => g.type === '')!.items[0]!.lines[0]).toMatchObject({ text: '25 kr', amount: 25 });
  });

  it('falls back to the catalogue in the account currency with no open event', () => {
    const m = tableMenu({ ...base, events: [ev('done', { status: 'closed' })], currency: 'CHF' });
    expect(m.event).toBeNull();
    expect(m.scope).toBe('catalogue');
    expect(m.currency).toBe('CHF');
    expect(m.groups[0]!.items[0]!.lines[0]!.text).toBe('CHF 8.00');
  });
});
