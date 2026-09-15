import { describe, expect, it } from 'vitest';
import { BackupParseError, dropDeleted, planImport, unpackZip } from '../import';

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

describe('planImport - rejecting the wrong file', () => {
  it('refuses something that is not an object', () => {
    expect(() => planImport('nope')).toThrow(BackupParseError);
  });

  it('refuses a backup version it does not understand', () => {
    // Better to stop than to guess at a layout that may have moved fields.
    expect(() => planImport(backup({ version: 3 }))).toThrow(/version 2/i);
  });
});

describe('planImport - what comes across', () => {
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

  it('seeds an opening inventory from the largest quantity ever taken', () => {
    // ZollTool never recorded total stock owned - only what went to each event.
    // The biggest of those is the only evidence of how many existed.
    const plan = planImport(
      backup({
        products: [product('p1')],
        events: [event('e1'), event('e2')],
        eventStock: [
          { eventId: 'e1', productId: 'p1', variantId: '', broughtQty: 12, updatedAt: 1 },
          { eventId: 'e2', productId: 'p1', variantId: '', broughtQty: 30, updatedAt: 1 },
        ],
      }),
    );

    expect(plan.inventory).toHaveLength(1);
    expect(plan.inventory[0]?.onHand).toBe(30);
    // Said out loud, because it is a guess the user has to correct.
    expect(plan.warnings.join(' ')).toMatch(/recount/i);
  });

  it('seeds nothing when the file carried no stock', () => {
    const plan = planImport(backup({ products: [product('p1')] }));
    expect(plan.inventory).toHaveLength(0);
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

describe('planImport - what is deliberately left behind', () => {
  it('imports well-formed transactions and drops malformed ones with a warning', () => {
    const good = { id: 't1', eventId: 'e1', timestamp: 1, items: [] };
    const plan = planImport(backup({ transactions: [good, { id: 't2' }] }));

    expect(plan.transactions).toEqual([good]);
    expect(plan.skipped.find((s) => s.what === 'Past transactions')).toBeUndefined();
    expect(plan.warnings.join(' ')).toMatch(/1 transaction\(s\) were malformed/);
  });

  it('imports live discount rules and reports photos without bytes as skipped', () => {
    const plan = planImport(
      backup({ discounts: [{ id: 'd1', name: 'Two for one' }, { id: 'd2', name: 'Old', deletedAt: 1 }], images: [{ id: 'i1', productId: 'p1', updatedAt: 1 }] }),
    );

    expect(plan.discounts.map((d) => d.id)).toEqual(['d1']);
    expect(plan.skipped.map((s) => s.what)).toEqual(['Product images']);
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

describe('photos', () => {
  const png = new Uint8Array([137, 80, 78, 71]);

  it('brings a photo across when its bytes are in the zip', () => {
    const backup = {
      version: 2, exportedAt: 'x', events: [], eventStock: [], transactions: [], discounts: [],
      products: [product('p1', { imageId: 'img1' })],
      images: [{ id: 'img1', productId: 'p1', updatedAt: 5 }],
    };
    const files = {
      'backup.json': new TextEncoder().encode(JSON.stringify(backup)),
      'images/img1.full': png,
      'images/img1.thumb': png,
    };
    const { json, images } = unpackZip(files);
    const plan = planImport(json, images);
    expect(plan.images).toHaveLength(1);
    expect(plan.images[0]).toMatchObject({ id: 'img1', productId: 'p1', updatedAt: 5 });
    expect(plan.images[0]!.full.type).toBe('image/jpeg');
    expect(plan.images[0]!.thumb.type).toBe('image/webp');
    expect(plan.skipped.find((s) => s.what === 'Product images')).toBeUndefined();
  });

  it('skips metadata-only photos and says why', () => {
    const plan = planImport(backup({ products: [product('p1')], images: [{ id: 'img1', productId: 'p1', updatedAt: 1 }] }));
    expect(plan.images).toHaveLength(0);
    expect(plan.skipped.find((s) => s.what === 'Product images')?.why).toMatch(/\.zip/);
  });

  it('drops a photo whose product was deleted', () => {
    const backup2 = {
      version: 2, exportedAt: 'x', events: [], eventStock: [], transactions: [], discounts: [],
      products: [product('gone', { deletedAt: 9 })],
      images: [{ id: 'img1', productId: 'gone', updatedAt: 5 }],
    };
    const files = { 'backup.json': new TextEncoder().encode(JSON.stringify(backup2)), 'images/img1.full': png, 'images/img1.thumb': png };
    const { json, images } = unpackZip(files);
    expect(planImport(json, images).images).toHaveLength(0);
  });

  it('refuses a zip with no backup inside', () => {
    expect(() => unpackZip({ 'readme.txt': png })).toThrow(BackupParseError);
  });
});
