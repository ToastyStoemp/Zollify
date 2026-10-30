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
  it('says which items a deal on some of them is for, and names mixed products by how they start', () => {
    const shop = [
      product({ id: 'sky', title: 'Deskmat - Sky', type: 'Desk Mat', price: 45 }),
      product({ id: 'valley', title: 'Deskmat - Valley', type: 'Desk Mat', price: 45 }),
      product({ id: 'cat', title: 'Mousepad - Cat', type: 'Desk Mat', price: 15 }),
      product({ id: 'sushi', title: 'Mousepad - Sushi', type: 'Desk Mat', price: 15 }),
      product({ id: 'kyoto', title: 'Kyoto', type: 'Art Print', variants: [{ id: '3', name: 'A3', price: 40 }, { id: '4', name: 'A4', price: 25 }] }),
      product({ id: 'oslo', title: 'Oslo', type: 'Art Print', variants: [{ id: '3', name: 'A3', price: 40 }, { id: '4', name: 'A4', price: 25 }] }),
    ];
    const rules = [
      rule({ id: 'mats', type: 'tiered', productIds: ['sky', 'valley'], tiers: [{ qty: 2, total: 80 }] }),
      rule({ id: 'a4', type: 'tiered', variantIds: ['kyoto:4', 'oslo:4'], tiers: [{ qty: 3, total: 65 }] }),
      rule({ id: 'pads', type: 'bxgy', productIds: ['cat', 'sushi'], buyQty: 2, freeQty: 1 }),
    ];
    const label = (r: ReturnType<typeof cardRows>[number]): string => (r.kind === 'line' ? `${r.label} ${r.price}` : r.kind === 'note' ? r.text : r.kind);
    expect(cardRows(def(['Desk Mat']), shop, rules, today).map(label)).toEqual(['Mousepad 15', 'Deskmat 45', '2 × Deskmat 80', 'Mousepad: buy 2, get 1 free']);
    expect(cardRows(def(['Art Print']), shop, rules, today).map(label)).toEqual(['A4 25', 'A3 40', '3 × A4 65']);
  });
  it('leaves unlisted products off a whole type, but not when picked by name', () => {
    expect(cardRows(def(['Keychain']), products, [], today)).toEqual([{ id: 'price', kind: 'price', price: 12 }]);
    expect(cardRows(def([], ['double:']), products, [], today)).toEqual([{ id: 'price', kind: 'price', price: 15 }]);
    const peach = product({ id: 'peach', title: 'Peach', price: 35, variants: [{ id: 's', name: '30x30cm' }, { id: 'o', name: 'Original', price: 250, unlisted: true }] });
    // One size of one print says which size it is.
    expect(cardRows(def([], ['peach:']), [peach], [], today)).toEqual([{ id: 'line:peach:s', kind: 'line', label: '30x30cm', price: 35 }]);
    expect(cardRows(def([], ['peach:', 'peach:o']), [peach], [], today).map((r) => r.kind === 'line' && r.label)).toEqual(['30x30cm', 'Original']);
  });
  it('is empty when the card prices nothing for sale', () => {
    expect(cardRows(def([], ['gone:']), [...products, product({ id: 'gone', forSale: false })], discounts, today)).toEqual([]);
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

describe('sizes and strips', () => {
  const rows: ReturnType<typeof cardRows> = [{ id: 'line:a', kind: 'line', label: 'A4', price: 25 }, { id: 'line:b', kind: 'line', label: 'A3', price: 40 }];
  const art = { title: 'Available in:', subtitle: '', rows, theme: DEFAULT_THEMES[0]!, mascot: null };
  it('draws a third-wide card as the master at two thirds, everything in proportion', () => {
    const half = cardLayout(art, DEFAULT_FORMAT);
    const third = cardLayout({ ...art, size: 'third' }, DEFAULT_FORMAT);
    expect([half.width, third.width]).toEqual([1240, 826]);
    expect(Math.abs(third.height - (half.height * 826) / 1240)).toBeLessThan(2);
    const size = (l: typeof half): unknown => l.commands.find(([, p]) => p.name === 'line:a price')![1].size;
    expect(size(third)).toBeCloseTo((Number(size(half)) * 826) / 1240, 1);
    expect(third.layout).toBe('third|line:a|line:b');
  });
  it('lays a strip out as a heading as typed with the sizes side by side', () => {
    const strip = cardLayout({ ...art, style: 'strip' }, DEFAULT_FORMAT);
    const at = (name: string): Record<string, unknown> => strip.commands.find(([, p]) => p.name === name)![1];
    expect(at('Title').text).toBe('Available in:');
    expect(at('line:a label').y).toBe(at('line:b label').y);
    expect(Number(at('line:a label').x)).toBeLessThan(Number(at('line:b label').x));
    expect(strip.layout).toBe('strip|line:a|line:b');
    expect(strip.height).toBeLessThan(cardLayout(art, DEFAULT_FORMAT).height);
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
  it('gives third-wide cards pages of their own, three across', () => {
    const cards = [{ key: 'h', width: 1240, height: 1000 }, ...['a', 'b', 'c', 'd'].map((key) => ({ key, width: 826, height: 400 }))];
    expect(packSheets(cards).map((p) => [p.key, p.page, p.x, p.y])).toEqual([
      ['h', 0, 0, 0],
      ['a', 1, 0, 0],
      ['b', 1, 826, 0],
      ['c', 1, 1652, 0],
      ['d', 1, 0, 400],
    ]);
  });
});
