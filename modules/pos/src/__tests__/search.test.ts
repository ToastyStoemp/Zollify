import { describe, expect, it } from 'vitest';
import { shortBarcode, type Product } from '@zollify/shared';
import { findSearchMatch } from '../search';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    title: 'Cow Pin',
    sku: 'PN-2508-EP-COW-02',
    type: 'Enamel',
    forSale: true,
    unlisted: false,
    price: 10,
    variants: [],
    sortOrder: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('findSearchMatch - scanned short barcode', () => {
  it('matches a plain product by its derived short code, not just its SKU', () => {
    const p = product();
    const code = shortBarcode(p.type, p.id);
    const match = findSearchMatch([p], code);
    expect(match).toEqual({ productId: 'p1', variantId: null, label: 'Cow Pin' });
  });

  it('matches the right variant by its own derived short code', () => {
    const p = product({
      variants: [
        { id: 'v1', name: 'Small', sku: 'PN-2508-EP-COW-02-S', unlisted: false },
        { id: 'v2', name: 'Large', sku: 'PN-2508-EP-COW-02-L', unlisted: false },
      ] as Product['variants'],
    });
    const code = shortBarcode(p.type, p.id, 'v2');
    const match = findSearchMatch([p], code);
    expect(match).toEqual({ productId: 'p1', variantId: 'v2', label: 'Cow Pin - Large' });
  });

  it('is case-insensitive, matching how a scanner/camera decode is normalized', () => {
    const p = product();
    const code = shortBarcode(p.type, p.id);
    expect(findSearchMatch([p], code.toLowerCase())).toEqual({ productId: 'p1', variantId: null, label: 'Cow Pin' });
  });
});
