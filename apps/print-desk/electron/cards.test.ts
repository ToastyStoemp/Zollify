import { describe, expect, it } from 'vitest';
import type { DiscountRule, Product } from '@zollify/shared';
import { A4, DEFAULT_FORMAT, DEFAULT_THEMES, cardFor, cardLayout, cardRows, cardUnits, eventPricing, cardState, cardTexts, changedTexts, cutMarks, formatPrice, packSheets, sheetCommands, shownRows, withoutCard } from './cards.js';

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

describe('withoutCard', () => {
  it('lists the listed products for sale no card prices yet, and makes a card for one', () => {
    const cards = [{ source: { types: ['Keychain'], items: [] } }, { source: { types: [], items: ['sticker:'] } }];
    expect(withoutCard(cards, products).map((p) => p.id)).toEqual(['bag', 'wallet', 'fsticker']);
    const card = cardFor(products.find((p) => p.id === 'bag')!, 'sky', 'c1');
    expect(card).toMatchObject({ id: 'c1', title: 'Bag', theme: 'sky', source: { types: [], items: ['bag:'] } });
    expect(withoutCard([...cards, card], products).map((p) => p.id)).toEqual(['wallet', 'fsticker']);
  });
});

describe('event prices', () => {
  const sek = { id: 'e', name: 'Narcon', currency: 'EUR', localCurrency: 'sek', exchangeRate: 11.06, roundingIncrement: 20 };
  it('charges in the event currency: converted and rounded as the till does, pinned prices as set', () => {
    const local = eventPricing({ ...sek, localPriceOverrides: { 'zodiac:a': 130, flower: 125 } })!;
    expect(local.currency).toBe('SEK');
    const prices = cardUnits({ types: ['Keychain'], items: [] }, products, local).map((u) => [u.key, u.price]);
    // 12 EUR is 132.72 SEK, to the nearest 20: 140. Aries is pinned by "pid:vid", Flower by the older plain "pid".
    expect(prices).toEqual([['zodiac:a', 130], ['zodiac:b', 140], ['flower:', 125]]);
  });
  it('takes pinned bundle totals by their place in the rule, before the tiers are sorted', () => {
    const local = eventPricing({ ...sek, localTierOverrides: { 'kb:1': 200 } })!;
    const rows = cardRows(def(['Keychain']), products, discounts, today, local);
    // kb lists 3 for 30 first, then 2 for 20: tier 1 is the 2 for 20, pinned at 200; 30 EUR converts to 340.
    expect(rows.filter((r) => r.kind === 'deal').map((r) => r.kind === 'deal' && [r.qty, r.price])).toEqual([[2, 200], [3, 340]]);
  });
  it('makes a combo from the members at the event prices, less its discount there', () => {
    const rows = cardRows(def(['Bear']), products, discounts, today, eventPricing({ ...sek, localTierOverrides: { 'bear:combo': 100 } }));
    // Wallet 55 EUR is 600 SEK, Bag 90 EUR is 1000 SEK: 1600 less the pinned 100.
    expect(rows.find((r) => r.id === 'bundle:bear')).toMatchObject({ price: 1500 });
  });
  it('has no local prices for an event that charges in the catalogue currency', () => {
    expect(eventPricing({ id: 'x', name: 'Facts', currency: 'EUR' })).toBeNull();
    expect(eventPricing({ ...sek, localCurrency: 'EUR' })).toBeNull();
    expect(eventPricing({ ...sek, exchangeRate: 0 })).toBeNull();
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
  it('leaves the heading of a strip off when asked, the title then only naming the card', () => {
    const bare = cardLayout({ ...art, title: 'Kyoto', style: 'strip', noHeading: true }, DEFAULT_FORMAT);
    expect(bare.commands.some(([, p]) => p.name === 'Title')).toBe(false);
    expect(bare.layout).toBe('strip|noheading|line:a|line:b');
    expect(bare.height).toBeLessThan(cardLayout({ ...art, style: 'strip' }, DEFAULT_FORMAT).height);
    expect(Object.keys(cardTexts({ ...art, title: 'Kyoto', style: 'strip', noHeading: true }, DEFAULT_FORMAT))).not.toContain('Title');
  });
});

describe('numberShift', () => {
  it('centres a price on its number: what the format adds after it hangs right, before it left', () => {
    const price = [{ id: 'price', kind: 'price' as const, price: 35 }];
    const art = { title: 'Cap', subtitle: '', rows: price, theme: DEFAULT_THEMES[1]!, mascot: null };
    const x = (fmt: typeof DEFAULT_FORMAT, centreNumber?: boolean): number => Number(cardLayout({ ...art, centreNumber }, fmt).commands.find(([, p]) => p.name === 'price')![1].x);
    expect(x(DEFAULT_FORMAT, true)).toBeGreaterThan(x(DEFAULT_FORMAT));
    expect(x({ ...DEFAULT_FORMAT, pattern: '€{n}' }, true)).toBeLessThan(x({ ...DEFAULT_FORMAT, pattern: '€{n}' }));
    expect(x({ ...DEFAULT_FORMAT, pattern: '{n}' }, true)).toBe(x({ ...DEFAULT_FORMAT, pattern: '{n}' }));
    expect(cardLayout({ ...art, centreNumber: true }, DEFAULT_FORMAT).layout).toBe('centred|price');
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
  it('packs tight: fills gaps on earlier sheets and lets strips share a sheet with half cards', () => {
    const half = [1800, 1700, 1600, 1500, 600].map((height, i) => ({ key: `h${i}`, width: 1240, height }));
    const strips = ['a', 'b', 'c'].map((key) => ({ key, width: 826, height: 300 }));
    const inOrder = packSheets([...half, ...strips]);
    const tight = packSheets([...half, ...strips], { tight: true });
    const pages = (p: ReturnType<typeof packSheets>): number => new Set(p.map((x) => x.page)).size;
    expect(pages(tight)).toBeLessThan(pages(inOrder));
    // Every card on a sheet, inside it, none overlapping another.
    for (const p of tight) expect(p.x + p.width <= A4.width && p.y + p.height <= A4.height).toBe(true);
    for (const p of tight) for (const q of tight) if (p !== q && p.page === q.page) expect(p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y).toBe(true);
    expect(tight.filter((p) => p.width === 826).every((p) => p.page === tight.find((q) => q.key === 'h4')!.page)).toBe(true);
  });
  it('keeps cards of one theme together in a column', () => {
    const cards = ['peach', 'sky', 'peach', 'sky', 'peach', 'sky'].map((group, i) => ({ key: String(i), width: 1240, height: 1000, group }));
    const tight = packSheets(cards, { tight: true });
    const columns = new Map<string, Set<string>>();
    for (const p of tight) {
      const k = `${p.page}|${p.x}`;
      columns.set(k, (columns.get(k) ?? new Set()).add(cards.find((c) => c.key === p.key)!.group));
    }
    expect([...columns.values()].every((g) => g.size === 1)).toBe(true);
  });
  it("puts a colour's leftover with another's, not into a column of a third colour", () => {
    // Peach fills two columns and a bit, blue just fits two, one cocoa card: the peach leftover goes
    // with the cocoa card, and blue keeps a sheet of its own.
    const card = (key: string, group: string, height: number) => ({ key, width: 1240, height, group });
    const cards = [
      ...[1700, 1700, 1700, 1700].map((h, i) => card(`p${i}`, 'peach', h)),
      card('coin', 'peach', 860),
      ...[1150, 1150, 1000, 1000, 860, 860].map((h, i) => card(`s${i}`, 'sky', h)),
      card('mat', 'cocoa', 1010),
    ];
    const tight = packSheets(cards, { tight: true });
    const at = (key: string) => tight.find((p) => p.key === key)!;
    expect(new Set(tight.map((p) => p.page)).size).toBe(3);
    expect(new Set(['s0', 's1', 's2', 's3', 's4', 's5'].map((k) => at(k).page)).size).toBe(1);
    expect(at('coin').page).toBe(at('mat').page);
    expect(at('coin').x).toBe(at('mat').x);
    expect(at('s0').page).not.toBe(at('coin').page);
  });
  it('draws a cut mark once at every card corner', () => {
    const placed = [
      { key: 'a', page: 0, x: 0, y: 0, width: 1240, height: 1000 },
      { key: 'b', page: 0, x: 0, y: 1000, width: 1240, height: 800 },
    ];
    const [, p] = cutMarks(placed)!;
    expect((p.path as { subpaths: unknown[] }).subpaths).toHaveLength(6 * 2);
    expect(sheetCommands(placed.map((x) => ({ ...x, file: 'f.psd' })), true).at(-1)![1].name).toBe('Cut marks');
    expect(sheetCommands(placed.map((x) => ({ ...x, file: 'f.psd' }))).some(([, q]) => q.name === 'Cut marks')).toBe(false);
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
