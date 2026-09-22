import { shortBarcode, type Product } from '@zollify/shared';

/** Ported from ZollTool: exact SKU / title / variant wins, else a unique partial match. */

export interface SearchMatch {
  productId: string;
  variantId: string | null;
  label: string;
}
export type SearchResult = SearchMatch | { ambiguous: true; count: number } | null;

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();
const text = (p: Product, v?: Product['variants'][number]): string =>
  [p.title, p.sku, p.type, v?.name, v?.sku].filter(Boolean).join(' ').toLowerCase();

export function findSearchMatch(products: Product[], query: string): SearchResult {
  const needle = norm(query);
  if (!needle) return null;
  const partial: SearchMatch[] = [];
  for (const p of products) {
    if (p.forSale === false) continue;
    const label = p.title || '(untitled)';
    // Printed labels can encode a short derived code instead of the SKU
    // (see shortBarcode() / @zollify/label-printer) - a camera or gun scan
    // decodes to that code, not the SKU, so it needs the same exact-match
    // treatment right alongside it.
    if (
      (norm(p.sku) && norm(p.sku) === needle) ||
      norm(p.title) === needle ||
      (p.variants.length === 0 && norm(shortBarcode(p.type, p.id)) === needle)
    ) {
      return { productId: p.id, variantId: null, label };
    }
    for (const v of p.variants ?? []) {
      const vLabel = `${label} - ${v.name || v.sku || 'variant'}`;
      if (
        (norm(v.sku) && norm(v.sku) === needle) ||
        (norm(v.name) && norm(v.name) === needle) ||
        norm(`${p.title} ${v.name}`) === needle ||
        norm(shortBarcode(p.type, p.id, v.id)) === needle
      ) {
        return { productId: p.id, variantId: v.id, label: vLabel };
      }
      if (text(p, v).includes(needle)) partial.push({ productId: p.id, variantId: v.id, label: vLabel });
    }
    if (text(p).includes(needle)) partial.push({ productId: p.id, variantId: null, label });
  }
  const seen = new Set<string>();
  const unique = partial.filter((m) => {
    const key = `${m.productId}:${m.variantId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return { ambiguous: true, count: unique.length };
  return null;
}

export { typeColor } from '@zollify/ui';
