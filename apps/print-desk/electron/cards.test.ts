import { describe, expect, it } from 'vitest';
import type { DiscountRule, Product } from '@zollify/shared';
import { A4, DEFAULT_FORMAT, DEFAULT_THEMES, cardLayout, cardRows, cardState, cardTexts, changedTexts, formatPrice, packSheets, shownRows } from './cards.js';

const product = (p: Partial<Product> & { id: string }): Product => ({ title: p.id, forSale: true, unlisted: false, price: 0, variants: [], updatedAt: 1, ...p }) as Product;
const rule = (r: Partial<DiscountRule> & { id: string; type: DiscountRule['type'] }): DiscountRule => ({ name: r.id, productIds: [], variantIds: [], updatedAt: 1, ...r }) as DiscountRule;

const products = [
  product({ id: 'zodiac', title: 'Keychain - Zodiac', type: 'Keychain', price: 12, variants: [{ id: 'a', name: 'Aries' }, { id: 'b', name: 'Leo' }] }),
  product({ id: 'flower', title: 'Keychain - Flower', type: 'Keychain', price: 12 }),
  product({ id: 'double', title: 'Keychain Double Sided', type: 'Keychain', price: 15, unlisted: true }),
  product({ id: 'sticker', title: 'Sticker', type: 'Sticker', price: 3, priceNote: 'Waterproof vinyl' }),
  product({ id: 'fsticker', title: 'Flower sticker', type: 'Sticker', price: 4 }),
  product({ id: 'bag', title: 'Bag', type: 'Bear', price: 90 }),
  product({ id: 'wallet', title: 'Wallet', type: 'Bear', price: 60, variants: [{ id: 'w', name: 'Blue', price: 55 }] }),
];
const discounts = [
  rule({ id: 'kb', type: 'tiered', productTypes: ['Keychain'], tiers: [{ qty: 3, total: 30 }, { qty: 2, total: 20 }] }),
  rule({ id: 'old', type: 'tiered', productTypes: ['Keychain'], tiers: [{ qty: 2, total: 1 }], validUntil: '2020-01-01' }),
  rule({ id: 'bear', type: 'combo', productIds: ['bag', 'wallet'], comboDiscountAmount: 10 }),
  rule({ id: 'gone', type: 'bxgy', productTypes: ['Sticker'], deletedAt: 5 }),
];
const today = '2026-10-30';
const def = (types: string[], items: string[] = []) => ({ source: { types, items }, notes: null });

describe('cardRows', () => {
  it('prices a whole type at one price, with its live tiered deals in order', () => {
    expect(cardRows(def(['Keychain']), products, discounts, today)).toEqual([
      { id: 'price', kind: 'price', price: 12 },
      { id: 'deal:kb:2', kind: 'deal', qty: 2, price: 20 },
      { id: 'deal:kb:3', kind: 'deal', qty: 3, price: 30 },
    ]);
  });
  it('gives one line per price, named after the item and not the price, and the price notes', () => {
    expect(cardRows(def([], ['sticker:', 'fsticker:']), products, discounts, today)).toEqual([
      { id: 'line:sticker:', kind: 'line', label: 'Sticker', price: 3 },
      { id: 'line:fsticker:', kind: 'line', label: 'Flower sticker', price: 4 },
      { id: 'note:0', kind: 'note', text: 'Waterproof vinyl' },
    ]);
  });
  it('adds a combo as a Bundle line at the cheapest member prices less the discount', () => {
    const rows = cardRows(def(['Bear']), products, discounts, today);
    expect(rows.map((r) => [r.id, r.kind === 'line' ? `${r.label} ${r.price}` : ''])).toEqual([
      ['line:wallet:w', 'Wallet 55'],
      ['line:bag:', 'Bag 90'],
      ['bundle:bear', 'Bundle 135'],
    ]);
  });
  it("takes a card's own lines over the price notes, and its labels and hidden rows", () => {
    const rows = cardRows({ source: { types: ['Sticker'], items: [] }, notes: ['4 random stickers'] }, products, discounts, today);
    expect(rows.find((r) => r.kind === 'note')).toEqual({ id: 'note:0', kind: 'note', text: '4 random stickers' });
    const shown = shownRows({ labels: { 'line:fsticker:': 'Flower' }, hidden: ['note:0'] }, rows);
    expect(shown.map((r) => (r.kind === 'line' ? r.label : r.id))).toEqual(['Sticker', 'Flower']);
  });
  it('names a line after a size the products share, and many products after their type', () => {
    const prints = [
      product({ id: 'kyoto', title: 'Kyoto', type: 'Art Print', variants: [{ id: '3', name: 'A3', price: 40 }, { id: '4', name: 'A4', price: 25 }] }),
      product({ id: 'oslo', title: 'Oslo', type: 'Art Print', variants: [{ id: '3', name: 'A3', price: 40 }, { id: '4', name: 'A4', price: 25 }] }),
      product({ id: 'thanks', title: 'Thank you', type: 'Art Print', price: 50 }),
      ...['Cow', 'Shiba', 'Bear', 'Charm'].map((t) => product({ id: t, title: t, type: 'Enamel', price: 12 })),
      product({ id: 'cat', title: 'Cat', type: 'Enamel', price: 15 }),
    ];
    expect(cardRows(def(['Art Print']), prints, [], today).map((r) => (r.kind === 'line' ? r.label : ''))).toEqual(['A4', 'A3', 'Thank you']);
    expect(cardRows(def(['Enamel']), prints, [], today).map((r) => (r.kind === 'line' ? r.label : ''))).toEqual(['Enamel', 'Cat']);
  });
  it('is empty when the card prices nothing for sale', () => {
    expect(cardRows(def([], ['double:']), products, discounts, today)).toEqual([]);
  });
});

describe('formatPrice', () => {
  it('fills the pattern, converts and rounds, and keeps cents only when there are some', () => {
    expect(formatPrice(15, DEFAULT_FORMAT)).toBe('15.-');
    expect(formatPrice(12.5, { pattern: '€{n}', rate: 1, rounding: 0 })).toBe('€12.50');
    expect(formatPrice(12, { pattern: '{n} kr', rate: 7.46, rounding: 5 })).toBe('90 kr');
  });
});

describe('cardLayout', () => {
  const art = (rows: ReturnType<typeof cardRows>) => ({ title: 'Keychain', subtitle: '', rows, theme: DEFAULT_THEMES[0]!, mascot: null });
  it('grows with its rows and names every text layer after its row', () => {
    const one = cardLayout(art([{ id: 'price', kind: 'price', price: 12 }]), DEFAULT_FORMAT);
    const two = cardLayout(art([{ id: 'price', kind: 'price', price: 12 }, { id: 'deal:kb:2', kind: 'deal', qty: 2, price: 20 }]), DEFAULT_FORMAT);
    expect(two.height).toBeGreaterThan(one.height);
    expect(one.height % 2).toBe(0);
    expect(two.layout).toBe('price|deal:kb:2');
    const names = two.commands.filter(([id]) => id === 'type.create').map(([, p]) => p.name);
    expect(names).toEqual(['price', 'deal:kb:2 qty', 'deal:kb:2 for', 'deal:kb:2 price', 'Title']);
    expect(cardTexts(art([{ id: 'deal:kb:2', kind: 'deal', qty: 2, price: 20 }]), DEFAULT_FORMAT)).toEqual({ Title: 'KEYCHAIN', 'deal:kb:2 qty': '2', 'deal:kb:2 price': '20.-' });
  });
});

describe('cardState', () => {
  it('tells a new price, which goes into the PSD in place, from a new row, which needs a redraw', () => {
    const rows: ReturnType<typeof cardRows> = [{ id: 'price', kind: 'price', price: 12 }];
    const drawn = { id: 'c', title: 'Keychain', subtitle: '', theme: 'peach', mascot: '', source: { types: [], items: [] }, labels: {}, hidden: [], notes: null, file: 'k.psd', layout: 'price', texts: { Title: 'KEYCHAIN', price: '12.-' } };
    expect(cardState(drawn, rows, DEFAULT_FORMAT)).toBe('current');
    expect(cardState(drawn, [{ id: 'price', kind: 'price', price: 13 }], DEFAULT_FORMAT)).toBe('prices');
    expect(changedTexts(drawn, [{ id: 'price', kind: 'price', price: 13 }], DEFAULT_FORMAT)).toEqual([['price', '13.-']]);
    expect(cardState(drawn, [...rows, { id: 'note:0', kind: 'note', text: 'Vinyl' }], DEFAULT_FORMAT)).toBe('layout');
    expect(cardState({ ...drawn, file: undefined }, rows, DEFAULT_FORMAT)).toBe('new');
    expect(cardState(drawn, [], DEFAULT_FORMAT)).toBe('empty');
  });
});

describe('packSheets', () => {
  it('fills the column that ends highest and starts a page when a card fits in neither', () => {
    const cards = [1200, 1000, 1300, 1100, 1300, 900].map((height, i) => ({ key: String(i), width: 1240, height }));
    expect(packSheets(cards).map((p) => [p.key, p.page, p.x, p.y])).toEqual([
      ['0', 0, 0, 0],
      ['1', 0, 1240, 0],
      ['2', 0, 1240, 1000],
      ['3', 0, 0, 1200],
      ['4', 1, 0, 0],
      ['5', 1, 1240, 0],
    ]);
    expect(A4.height).toBe(3508);
  });
});
