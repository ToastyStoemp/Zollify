import { describe, expect, it } from 'vitest';
import { BackupParseError, dropDeleted, planImport } from '../import';

function backup(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    exportedAt: '2026-01-01T00:00:00Z',
    events: [],
    products: [],
    eventStock: [],
    transactions: [],
    discounts: [],
    ...over,
  };
}

const product = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Product ${id}`,
  price: 10,
  forSale: true,
  unlisted: false,
  updatedAt: 1,
  ...over,
});

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Event ${id}`,
  venue: {},
  currency: 'CHF',
  status: 'planned',
  updatedAt: 1,
  ...over,
});

describe('planImport — rejecting the wrong file', () => {
  it('refuses something that is not an object', () => {
    expect(() => planImport('nope')).toThrow(BackupParseError);
  });

  it('refuses a backup version it does not understand', () => {
    // Better to stop than to guess at a layout that may have moved fields.
    expect(() => planImport(backup({ version: 3 }))).toThrow(/version 2/i);
  });
});

describe('planImport — what comes across', () => {
  it('carries products, events and stock', () => {
    const plan = planImport(
      backup({
        products: [product('p1')],
        events: [event('e1')],
        eventStock: [{ eventId: 'e1', productId: 'p1', variantId: '', broughtQty: 5, updatedAt: 1 }],
      }),
    );

    expect(plan.products).toHaveLength(1);
    expect(plan.events).toHaveLength(1);
    expect(plan.eventStock).toHaveLength(1);
  });

  it('drops rows that were already deleted rather than resurrecting them', () => {
    // Clearing the tombstone would bring back something deliberately removed;
    // keeping it would import a row that exists only to be invisible.
    const plan = planImport(
      backup({
        products: [product('p1'), product('p2', { deletedAt: 999 })],
        events: [event('e1', { deletedAt: 999 })],
      }),
    );

    expect(plan.products.map((p) => p.id)).toEqual(['p1']);
    expect(plan.events).toHaveLength(0);
    expect(plan.warnings.join(' ')).toMatch(/already deleted/i);
  });

  it('drops stock pointing at a product or event that is not in the file', () => {
    const plan = planImport(
      backup({
        products: [product('p1')],
        events: [event('e1')],
        eventStock: [
          { eventId: 'e1', productId: 'p1', variantId: '', broughtQty: 1, updatedAt: 1 },
          { eventId: 'missing', productId: 'p1', variantId: '', broughtQty: 1, updatedAt: 1 },
        ],
      }),
    );

    expect(plan.eventStock).toHaveLength(1);
    expect(plan.warnings.join(' ')).toMatch(/missing event or product/i);
  });

  it('normalises a null variantId to the empty string', () => {
    // IndexedDB compound keys cannot hold null, which is why the shared type
    // documents '' as the product-level marker.
    const plan = planImport(
      backup({
        products: [product('p1')],
        events: [event('e1')],
        eventStock: [{ eventId: 'e1', productId: 'p1', variantId: null, broughtQty: 1, updatedAt: 1 }],
      }),
    );

    expect(plan.eventStock[0]?.variantId).toBe('');
  });

  it('skips malformed rows without failing the whole import', () => {
    const plan = planImport(backup({ products: [product('p1'), { title: 'no id' }] }));

    expect(plan.products).toHaveLength(1);
    expect(plan.warnings.join(' ')).toMatch(/without an id/i);
  });
});

describe('planImport — what is deliberately left behind', () => {
  it('reports transactions as skipped with a reason', () => {
    const plan = planImport(backup({ transactions: [{ id: 't1' }, { id: 't2' }] }));

    const entry = plan.skipped.find((s) => s.what === 'Past transactions');
    expect(entry?.count).toBe(2);
    // Running both systems in parallel is expected, so importing history would
    // double-count revenue.
    expect(entry?.why).toMatch(/double-count/i);
  });

  it('reports discounts and images as skipped', () => {
    const plan = planImport(
      backup({ discounts: [{ id: 'd1' }], images: [{ id: 'i1', productId: 'p1', updatedAt: 1 }] }),
    );

    expect(plan.skipped.map((s) => s.what)).toEqual(
      expect.arrayContaining(['Discount rules', 'Product images']),
    );
  });

  it('says nothing about categories the file did not contain', () => {
    const plan = planImport(backup());
    expect(plan.skipped).toHaveLength(0);
  });
});

describe('dropDeleted', () => {
  it('keeps only live rows', () => {
    expect(dropDeleted([{ id: 'a' }, { id: 'b', deletedAt: 1 }])).toEqual([{ id: 'a' }]);
  });
});
