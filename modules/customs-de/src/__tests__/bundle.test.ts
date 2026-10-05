import { describe, expect, it } from 'vitest';
import type { Product, SalesEvent } from '@zollify/shared';
import { buildCustomsDeState } from '../engine/adapter';
import { germanDocuments } from '../bundle';

const event: SalesEvent = { id: 'ev1', name: 'Con', venue: {}, currency: 'EUR', status: 'active', updatedAt: 1 };
const product: Product = { id: 'p1', title: 'Thing', forSale: true, unlisted: false, price: 10, variants: [], sortOrder: 0, updatedAt: 1 };
const state = buildCustomsDeState(event, [product], [{ eventId: 'ev1', productId: 'p1', variantId: '', broughtQty: 5, updatedAt: 1 }], []);

describe('germanDocuments', () => {
  it('before: export packing list and proforma, in the event currency', () => {
    const b = germanDocuments(state, 'before', 'Con');
    expect(b.currency).toBe('EUR');
    expect(b.docs.map((d) => d.title)).toEqual(['Packing list (export)', 'Proforma invoice']);
  });

  it('after: re-import packing list and sold goods list', () => {
    const b = germanDocuments(state, 'after', 'Con');
    expect(b.docs.map((d) => d.title)).toEqual(['Packing list (re-import)', 'Sold goods list']);
    expect(b.files).toEqual([]);
  });
});
