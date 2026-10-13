import { describe, expect, it, vi } from 'vitest';

vi.mock('@zollify/platform', () => ({ allProducts: { value: [] }, deleteImage: vi.fn(), deleteProduct: vi.fn(), saveProductImage: vi.fn(), setOnHand: vi.fn(), upsertProduct: vi.fn() }));
const { EXAMPLES, EXAMPLE_PREFIX, isExample } = await import('../example-products');

describe('example products', () => {
  it('each has a picture, a price, a type and customs details', () => {
    for (const e of EXAMPLES) {
      expect(typeof e.art).toBe('function');
      expect(e.price).toBeGreaterThan(0);
      expect(e.type).toBeTruthy();
      expect(e.tariffNo).toMatch(/^\d{4}\.\d{4}$/);
      expect(e.material).toBeTruthy();
      expect(e.sku).toMatch(/^EX-/);
    }
  });

  it('ids are stable and unique, so adding twice replaces rather than duplicates', () => {
    const ids = EXAMPLES.flatMap((e) => [`${EXAMPLE_PREFIX}${e.slug}`, ...(e.variants ?? []).map((v) => v.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(EXAMPLE_PREFIX)).toBe(true);
    const skus = EXAMPLES.flatMap((e) => [e.sku, ...(e.variants ?? []).map((v) => v.sku)]);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('tells an example from a real product by its id only', () => {
    expect(isExample({ id: 'example-fox-print' })).toBe(true);
    expect(isExample({ id: 'e1b2c3' })).toBe(false);
  });
});
