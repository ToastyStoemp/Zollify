import { describe, expect, it } from 'vitest';
import { matchCatalogs, tokenize } from './match';
import type { SavedMatches, ShopProduct, ZtProduct } from './types';

function zt(id: string, extra: Partial<ZtProduct> = {}): ZtProduct {
  return { id, title: `Product ${id}`, price: 20, variants: [], updatedAt: 1, ...extra };
}
function shop(id: string, title: string, opts: { type?: string; variants: { sku?: string; price?: string; title?: string }[] }): ShopProduct {
  return {
    id: `gid://shopify/Product/${id}`,
    title,
    handle: title.toLowerCase().replace(/\s+/g, '-'),
    productType: opts.type ?? '',
    images: [],
    variants: opts.variants.map((v, i) => ({
      id: `gid://variant/${id}-${i}`,
      title: v.title ?? 'Default Title',
      sku: v.sku ?? '',
      price: v.price ?? '20.00',
    })),
  };
}

describe('tokenize', () => {
  it('lowercases, strips punctuation, folds plurals, drops filler', () => {
    expect(tokenize('Hats & Caps')).toEqual(['hat', 'cap']);
    expect(tokenize('Default Title')).toEqual([]); // both are stopwords
  });
});

describe('matchCatalogs - variant level', () => {
  it('matches a variant by exact SKU regardless of name', () => {
    const zts = [zt('a', { title: 'Nothing Alike', variants: [{ id: 'v1', name: 'X', sku: 'SKU-1' }] })];
    const shops = [shop('1', 'Completely Different', { variants: [{ sku: 'SKU-1' }] })];
    const m = matchCatalogs(zts, shops);
    expect(m[0]!.variants[0]!.kind).toBe('sku');
    expect(m[0]!.variants[0]!.shop?.sku).toBe('SKU-1');
  });

  it('spreads one product\'s variants across several Shopify products by distinctive words', () => {
    // ZollTool "Hats" with 4 variants; Shopify splits them into two products.
    const zts = [zt('hats', {
      title: 'Hats',
      type: 'Headwear',
      variants: [
        { id: 'v1', name: 'Cats Black' },
        { id: 'v2', name: 'Cats White' },
        { id: 'v3', name: 'Sakura' },
        { id: 'v4', name: 'Ginkgo' },
      ],
    })];
    const shops = [
      shop('cap1', 'Baseball Cap Cats', { type: 'Headwear', variants: [{ title: 'Black' }, { title: 'White' }] }),
      shop('cap2', 'Sakura & Ginkgo Baseball Cap', { type: 'Headwear', variants: [{ title: 'Sakura' }, { title: 'Ginkgo' }] }),
    ];
    const m = matchCatalogs(zts, shops);
    const byName = Object.fromEntries(m[0]!.variants.map((v) => [v.ztVariantName, v.shop]));
    expect(byName['Sakura']?.productTitle).toBe('Sakura & Ginkgo Baseball Cap');
    expect(byName['Ginkgo']?.productTitle).toBe('Sakura & Ginkgo Baseball Cap');
    expect(byName['Cats Black']?.productTitle).toBe('Baseball Cap Cats');
    expect(byName['Cats White']?.productTitle).toBe('Baseball Cap Cats');
    // Each Shopify variant is claimed at most once.
    const claimed = m[0]!.variants.map((v) => v.shop?.variantId).filter(Boolean);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('uses SKU content (not just exact SKU) to auto-match via shared tokens', () => {
    // Names give no signal; the shared "cats" token lives only in the SKUs.
    const zts = [zt('a', { title: 'Item', variants: [{ id: 'v1', name: 'One', sku: 'ZT-CATS-01' }] })];
    const shops = [
      shop('1', 'Thing', { variants: [{ title: 'A', sku: 'SHOP-CATS-99' }] }),
      shop('2', 'Other', { variants: [{ title: 'B', sku: 'SHOP-DOGS-99' }] }),
    ];
    const m = matchCatalogs(zts, shops);
    expect(m[0]!.variants[0]!.kind).toBe('fuzzy');
    expect(m[0]!.variants[0]!.shop?.sku).toBe('SHOP-CATS-99');
  });

  it('treats a variant-less product as its own unit', () => {
    const zts = [zt('p', { title: 'Blue Poster', variants: [] })];
    const shops = [shop('1', 'Blue Poster', { variants: [{ sku: 'BP' }] })];
    const m = matchCatalogs(zts, shops);
    expect(m[0]!.variants).toHaveLength(1);
    expect(m[0]!.variants[0]!.ztVariantId).toBe('');
    expect(m[0]!.variants[0]!.shop?.productTitle).toBe('Blue Poster');
  });

  it('leaves a variant unmatched when nothing is similar enough', () => {
    const zts = [zt('a', { title: 'Zorblax', variants: [{ id: 'v1', name: 'Qux' }] })];
    const shops = [shop('1', 'Sunset Print', { variants: [{ title: 'A4' }] })];
    const m = matchCatalogs(zts, shops);
    expect(m[0]!.variants[0]!.kind).toBe('none');
    expect(m[0]!.variants[0]!.shop).toBeNull();
  });

  it('applies a saved manual override over the auto match', () => {
    const zts = [zt('a', { title: 'Poster', variants: [{ id: 'v1', name: 'A4' }] })];
    const shops = [
      shop('1', 'Poster A4', { variants: [{ title: 'A4' }] }),
      shop('2', 'Unrelated', { variants: [{ title: 'Solo' }] }),
    ];
    const saved: SavedMatches = {
      a: { shopProductId: 'gid://shopify/Product/2', variants: { v1: { productId: 'gid://shopify/Product/2', variantId: 'gid://variant/2-0' } } },
    };
    const m = matchCatalogs(zts, shops, saved);
    expect(m[0]!.variants[0]!.kind).toBe('manual');
    expect(m[0]!.variants[0]!.shop?.productTitle).toBe('Unrelated');
    expect(m[0]!.shopProductId).toBe('gid://shopify/Product/2');
  });

  it('picks the most-referenced Shopify product as the product-level match', () => {
    const zts = [zt('hats', {
      title: 'Hats',
      variants: [{ id: 'v1', name: 'Cats Black' }, { id: 'v2', name: 'Cats White' }, { id: 'v3', name: 'Sakura' }],
    })];
    const shops = [
      shop('cap1', 'Baseball Cap Cats', { variants: [{ title: 'Black' }, { title: 'White' }] }),
      shop('cap2', 'Sakura Cap', { variants: [{ title: 'Sakura' }] }),
    ];
    const m = matchCatalogs(zts, shops);
    expect(m[0]!.shopProductId).toBe('gid://shopify/Product/cap1'); // 2 variants vs 1
  });
});
