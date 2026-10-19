import { describe, expect, it } from 'vitest';
import { catalogRows } from './reduce.js';
import { printParams } from './shared.js';

describe('catalogRows', () => {
  it('reduces products, variants, deletes and inventory with last writer wins', () => {
    const rows = catalogRows([
      { type: 'product.upsert', payload: { id: 'p1', title: 'Old', type: 'Art Print', variants: [], updatedAt: 1 } },
      { type: 'product.upsert', payload: { id: 'p1', title: 'Poster', type: 'Art Print', sku: 'POS', variants: [{ id: 'a', name: 'A3', sku: 'POS-A3' }, { id: 'b', name: 'A4' }], updatedAt: 2 } },
      { type: 'product.upsert', payload: { id: 'p2', title: 'Sticker', type: 'Art Print', variants: [], updatedAt: 1 } },
      { type: 'product.delete', payload: { id: 'p2', deletedAt: 5 } },
      { type: 'inventory.set', payload: { productId: 'p1', variantId: 'a', onHand: 9, updatedAt: 3 } },
      { type: 'inventory.set', payload: { productId: 'p1', variantId: 'a', onHand: 4, updatedAt: 2 } },
    ]);
    expect(rows.map((r) => [r.key, r.title, r.variant, r.sku, r.onHand])).toEqual([
      ['p1:a', 'Poster', 'A3', 'POS-A3', 9],
      ['p1:b', 'Poster', 'A4', 'POS', 0],
    ]);
  });
});

describe('art prints only', () => {
  it('keeps any spelling of Art Print and drops other types and untyped products', () => {
    const product = (id: string, type?: string) => ({ type: 'product.upsert', payload: { id, title: id, type, variants: [], updatedAt: 1 } });
    const rows = catalogRows([product('a', 'Art Print'), product('b', ' art prints '), product('c', 'ArtPrint'), product('d', 'Sticker'), product('e', 'Art Print Frame'), product('f')]);
    expect(rows.map((r) => r.productId)).toEqual(['a', 'b', 'c']);
  });
});

describe('printParams', () => {
  it('keeps the link settings, sets copies and never dry-runs or writes a PDF', () => {
    expect(printParams({ file: 'x.psd', params: { printer: 'Epson', paper: 'a4', output: 'x.pdf', dryRun: true } }, 1200)).toEqual({ printer: 'Epson', paper: 'a4', copies: 999, send: true });
  });
});
